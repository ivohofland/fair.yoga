import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { classStartInstant, startOfLocalDay } from '@/lib/timezone';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import {
  generateClassInstances,
  generateInstancesForTemplate,
  claimTemplateForGeneration,
} from './class-generator';
import { getNextOccurrences } from './entry-generation';
import {
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
  updateClassTemplate,
} from './class-template-lifecycle';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';
import { anyBlocked, countSkipReasons } from '@/lib/generation';

type TransactionOptions = NonNullable<Parameters<PrismaClient['$transaction']>[1]>;

// ===========================================================================
// Integration tests — generateClassInstances
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = `gen-${Date.now()}`;

describe('generateClassInstances (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let templateId: string;
  let templateScheduleRuleId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Generator',
        lastName: 'Teacher',
        email: `generator-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `generator-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for generator tests',
        pageSlug: `generator-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Generator Studio',
        address: `${uniqueSuffix} Generator St`,
        city: 'Amsterdam',
        postcode: '1234GN',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 40,
      },
    });
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Vinyasa', dayOfWeek: 1, // Tuesday in schema convention
            startTime: hhmmToTime('09:00'), durationMinutes: 75, isActive: true,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        description: 'Tuesday morning flow',
        roomCost: 40,
        minRate: 15,
        targetRate: 30,
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
      },
    });
    templateId = template.id;
    templateScheduleRuleId = template.scheduleRuleId;
  });

  afterAll(async () => {
    // Clean up in dependency order. `ClassTemplate` is `onDelete: Cascade`
    // from `ScheduleRule` (issue 298), so the rule delete removes the
    // template with it.
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    await prisma.scheduleRule.delete({ where: { id: templateScheduleRuleId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });

    await prisma.$disconnect();
  });

  it('generates 4 class instances from a template', async () => {
    // Use Monday 2026-04-06 as the starting date
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(4);

    const classes = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });

    expect(classes).toHaveLength(4);

    for (const cls of classes) {
      expect(cls.calendarEntry.classType).toBe('Vinyasa');
      expect(cls.status).toBe('open');
      expect(Number(cls.roomCost)).toBe(40);
      expect(Number(cls.minRate)).toBe(15);
      expect(Number(cls.targetRate)).toBe(30);
      expect(cls.minStudents).toBe(4);
      expect(cls.maxStudents).toBe(12);
      expect(cls.calendarEntry.teacherId).toBe(teacherId);
      expect(cls.teacherRoomId).toBe(teacherRoomId);
      expect(cls.calendarEntry.scheduleRuleId).toBe(templateScheduleRuleId);
      expect(cls.description).toBe('Tuesday morning flow');
      expect(timeToHHmm(cls.calendarEntry.startTime)).toBe('09:00');
      expect(cls.calendarEntry.durationMinutes).toBe(75);
      expect(cls.cancelDeadline).toBe('HOURS_24');
      expect(cls.autoCancelCheck).toBe('HOURS_2');
    }
  });

  it('is idempotent — running again creates no duplicates', async () => {
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, include: { calendarEntry: true } });
    expect(classes).toHaveLength(4);
  });

  it('skips inactive templates', async () => {
    // Deactivate template and delete existing classes
    await prisma.scheduleRule.update({
      where: { id: templateScheduleRuleId },
      data: { isActive: false },
    });
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, include: { calendarEntry: true } });
    expect(classes).toHaveLength(0);

    // Re-activate for potential further tests
    await prisma.scheduleRule.update({
      where: { id: templateScheduleRuleId },
      data: { isActive: true },
    });
  });

  it('skips archived templates even when isActive is stale-true', async () => {
    // Defense in depth: the routes keep archived templates inactive, but
    // a slipped invariant must not let the sweep materialize classes for
    // something the teacher shelved.
    await prisma.scheduleRule.update({
      where: { id: templateScheduleRuleId },
      data: { isActive: true, isArchived: true },
    });
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(0);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(0);

    // Restore for the tests that follow
    await prisma.scheduleRule.update({
      where: { id: templateScheduleRuleId },
      data: { isActive: true, isArchived: false },
    });
  });

  it("skips today's occurrence when its start has already passed", async () => {
    // Tuesday 2026-04-07 at 18:00 UTC — hours after the template's 09:00
    // Amsterdam start. The run must not create a class earlier the same
    // day; the window slides to the next four Tuesdays instead.
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    const from = new Date('2026-04-07T18:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(classes.map((c) => c.calendarEntry.date.toISOString())).toEqual([
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      '2026-05-05T00:00:00.000Z',
    ]);
  });

  it("includes today's occurrence while its start is still ahead", async () => {
    // Tuesday 2026-04-07 at 05:00 UTC — before the 09:00 Amsterdam start.
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    const from = new Date('2026-04-07T05:00:00.000Z');
    const count = await generateClassInstances(prisma, from, teacherId);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
    expect(classes.map((c) => c.calendarEntry.date.toISOString())).toEqual([
      '2026-04-07T00:00:00.000Z',
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
    ]);
  });

  describe('claimTemplateForGeneration', () => {
    const claim = (id: string) =>
      prisma.$transaction((tx) => claimTemplateForGeneration(tx, id));

    // Captured, not hardcoded — same reason as the mid-sweep describe below:
    // other tests in this file assert the fixture's own startTime, so a
    // guessed restore value would corrupt them.
    let originalStartTime: string;
    // Captured alongside `startTime` because two `it`s in this `describe`
    // commit real edits through `updateClassTemplate` — the budget pin writes
    // `description`, the `busy` test writes `classType`. Restoring only the
    // three fields the older tests touched left the fixture mutated for
    // anything added after them; today nothing reads those two columns later
    // in file order, which makes it latent rather than broken, and latent is
    // exactly how this `afterEach` earns its keep. (The edits used to reach
    // the template's future instances too, via `syncTemplateInstances`. #194
    // deleted that, so the restore is now genuinely only about these
    // columns.)
    let originalClassType: string;
    let originalDescription: string | null;

    beforeAll(async () => {
      const t = await prisma.classTemplate.findUniqueOrThrow({
        where: { id: templateId },
        include: { scheduleRule: true },
      });
      originalStartTime = timeToHHmm(t.scheduleRule.startTime);
      originalClassType = t.scheduleRule.classType;
      originalDescription = t.description;
    });

    afterEach(async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: {
          isActive: true,
          isArchived: false,
          startTime: hhmmToTime(originalStartTime),
          classType: originalClassType,
        },
      });
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { description: originalDescription },
      });
    });

    it('claims a live template', async () => {
      expect(await claim(templateId)).not.toBeNull();
    });

    it('refuses an archived template', async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isArchived: true },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a paused template', async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isActive: false },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a template that no longer exists', async () => {
      expect(await claim('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('returns values committed after the caller read the row', async () => {
      const before = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: templateScheduleRuleId } });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { startTime: hhmmToTime('21:15') },
      });

      const claimed = await prisma.$transaction((tx) => claimTemplateForGeneration(tx, templateId));

      expect(timeToHHmm(before.startTime)).not.toBe('21:15');
      expect(claimed ? timeToHHmm(claimed.scheduleRule.startTime) : claimed).toBe('21:15');
    });

    /**
     * The predicate cases above pass with or without `FOR UPDATE` — they never
     * run concurrently with anything. This is the one that pins the lock.
     */
    it('makes a concurrent archive wait until the claim transaction commits', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const claiming = prisma.$transaction(
        async (tx) => {
          expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
          await held;
        },
        { timeout: 15_000 },
      );

      // Let the claim acquire the lock before the archive contends for it.
      await new Promise((r) => setTimeout(r, 100));

      let archiveSettled = false;
      const archiving = archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived').then((r) => {
        archiveSettled = true;
        return r;
      });

      await new Promise((r) => setTimeout(r, 300));
      // Without FOR UPDATE the archive's UPDATE is unobstructed and this is true.
      expect(archiveSettled).toBe(false);

      release();
      await claiming;
      const result = await archiving;
      expect(result.ok).toBe(true);
    });

    /**
     * The class family's `{ timeout: 10_000 }` pin, and it exists because this
     * branch removed the only other one. The 5.5s test below used to prove the
     * budget end to end by outlasting Prisma's 5s default; under a 2s
     * `lock_timeout` no archive can wait that long, so that proof became
     * unwritable and the test was re-pointed at the bound. The docblock that
     * replaced it then claimed `studio-class-generator.test.ts`'s `opens its
     * transaction with { timeout: 10_000 }` still covered this. It does not —
     * that test proxies `archiveOrUnarchiveStudioTemplate`, a different
     * function in a different module — so between the re-point and this test,
     * deleting the literal from either class-family function left the whole
     * suite green.
     *
     * Cheap where the old proof was expensive: the Proxy records the options
     * argument and delegates to the real `$transaction`, so nothing has to
     * cross a five-second boundary to observe it.
     */
    it('opens the archive transaction with { timeout: 10_000 }', async () => {
      let recordedOptions: TransactionOptions | undefined;
      const spyingClient = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (
              fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options?: TransactionOptions,
            ) => {
              recordedOptions = options;
              return target.$transaction(fn, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const result = await archiveOrUnarchiveTemplate(
        spyingClient,
        templateId,
        teacherId,
        'archived',
      );

      expect(result.ok).toBe(true);
      expect(recordedOptions).toEqual({ timeout: 10_000 });
    });

    /**
     * `pauseOrResumeTemplate` carries the same budget and had never been
     * pinned at all — the deleted 5.5s test only ever exercised the archive.
     *
     * `'paused'` rather than `'active'`, and that is forced: the function
     * returns `unchanged` before opening any transaction when the template is
     * already in the requested state, and this block's `afterEach` leaves it
     * active. The pause arm then returns inside the transaction before
     * generation, so the option is observable without four inserts running.
     */
    it('opens the pause/resume transaction with { timeout: 10_000 }', async () => {
      let recordedOptions: TransactionOptions | undefined;
      const spyingClient = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (
              fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options?: TransactionOptions,
            ) => {
              recordedOptions = options;
              return target.$transaction(fn, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const result = await pauseOrResumeTemplate(spyingClient, templateId, teacherId, 'paused');

      expect(result.ok).toBe(true);
      expect(recordedOptions).toEqual({ timeout: 10_000 });
    });

    /**
     * Replaces a test that held the claim for 5.5s and asserted the archive
     * still resolved `ok: true`, proving `{ timeout: 10_000 }` beat Prisma's
     * 5s default. That proof is now unwritable: the archive takes a 2s
     * `lock_timeout`, so it can no longer wait 5.5s for a row under any
     * budget. The 10s budget still matters — it now covers the archive's own
     * work rather than its wait — and the two `opens the … transaction with
     * { timeout: 10_000 }` tests above pin that it is still passed.
     *
     * Those two exist because an earlier draft of this docblock pointed at
     * `studio-class-generator.test.ts`'s spy instead, which proxies
     * `archiveOrUnarchiveStudioTemplate` — a different function in a different
     * module. For the interval between the re-point and those tests, this
     * family's budget was pinned by nothing at all while a comment said
     * otherwise.
     *
     * What this pins instead is the bound itself, and the timing assertions
     * are how. Without the `lock_timeout` the archive does not fail later —
     * it does not settle at all: the claim holds the row until `release()`,
     * `release()` only runs after the archive settles, and the transaction
     * budget cannot break that tie, because Prisma checks it at statement
     * boundaries and a statement blocked inside Postgres never reaches one
     * (`src/lib/db-locks.ts` says so; the mutation record's Task 1 measured
     * it as a 20s test timeout). So the lower bound proves the archive really
     * waited rather than failing instantly for an unrelated reason, and the
     * upper bound proves it answered well inside the 10s budget rather than at
     * it. Neither pins the bound's exact value — `db-locks.test.ts` does that.
     */
    it(
      'answers busy when the generation claim holds the row past the lock timeout',
      async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        // Let the claim acquire the lock before the archive contends for it.
        await new Promise((r) => setTimeout(r, 100));

        const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
        try {
          const startedAt = Date.now();
          const result = await archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });

          // The 2s lock_timeout produced this. The lower bound proves the
          // archive really waited rather than failing instantly for some
          // unrelated reason. There is deliberately no upper bound on `waited`
          // (#323, waitlist.test.ts:525-555): the 2s value is pinned by
          // `db-locks.test.ts`, and a wall-clock ceiling flakes under parallel
          // CPU contention.
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // Asserted, not assumed. Returning instead of throwing is what
          // removes `withErrorHandler`'s automatic line, so this `log.warn` is
          // the entire server-side trace of a lost race — and until this
          // assertion existed, deleting it left every test green.
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId, target: 'archived' }),
            'recurring class archive lost the template lock race',
          );
        } finally {
          // In a `finally`, so a failure above fails this test alone. Without
          // it the claim holds the row for its full 15s, this block's
          // `afterEach` queues behind it, and one broken guard reports as a
          // test timeout plus a hook timeout with the real cause buried.
          release();
          // Swallowed deliberately: if the claim itself failed, the assertions
          // above have already said so more precisely, and a throwing
          // `finally` would replace that message with this one.
          await claiming.catch(() => {});
          warn.mockRestore();
        }
      },
      20_000,
    );

    /**
     * Pause/resume takes the same row as the archive, in the same kind of
     * transaction, against the same sweep — so it had the same unbounded
     * wait. Its own union carries `busy` separately, and a bound dropped
     * here would leave the archive's test green.
     *
     * The PAUSE arm, not the resume. The plan's first draft called the resume
     * with the template paused first; that cannot work, because the claim
     * refuses paused templates (`WHERE "isActive" = true`), so the claim
     * returned null and the test died at its own setup assertion — the
     * plan's predicted failure ("the resume waits the claim out and resolves
     * `ok: true`") was unreachable. A resume can never lose this race: the
     * claim only locks active templates, and a resume only runs on a paused
     * one. The arm that genuinely contends with the sweep is the pause —
     * active template, claim holds the row, the pause's update blocks on it.
     * Recorded in the mutations file under Task 3.
     */
    it(
      'answers busy when a pause loses the row to the generation claim',
      async () => {
        // The sweep claims only an ACTIVE template, so this test needs one.
        // This describe's `afterEach` restores exactly this state, so the row
        // is already active in an ordinary run — stated here anyway so the
        // precondition the claim below asserts on is owned by the test that
        // depends on it, matching the studio twin.
        await prisma.scheduleRule.update({
          where: { id: templateScheduleRuleId },
          data: { isActive: true, isArchived: false },
        });

        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
        try {
          const startedAt = Date.now();
          const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'paused');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323, waitlist.test.ts:525-555).
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // `target` is asserted because the message cannot carry it: one
          // function serves both directions, and both reach the same route
          // with the same method and path.
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId, target: 'paused' }),
            'recurring class pause/resume lost the template lock race',
          );
        } finally {
          release();
          await claiming.catch(() => {});
          warn.mockRestore();
          // A local restatement, not the guarantee — this block's `afterEach`
          // restores `isActive`/`isArchived`/`startTime` unconditionally. Kept,
          // and moved into the `finally` where it actually runs, so a mutation
          // run that lets the pause COMMIT cannot leak a paused template into
          // the next test even when the assertions above throw.
          await prisma.scheduleRule.update({
            where: { id: templateScheduleRuleId },
            data: { isActive: true },
          });
        }
      },
      20_000,
    );

    /**
     * `updateClassTemplate`'s own budget (`class-template-lifecycle.ts`),
     * pinned the same way the two transactions above pin theirs. Derived, not
     * arbitrary, and re-derived here rather than scaled: ONE statement in that
     * transaction can wait on the lock timeout at 2s — `classTemplate.update`,
     * the template write (an unconditional update by primary key, NOT a CAS;
     * this file uses that term for the archive's and pause/resume's
     * conditional writes). `setLockTimeout` is not a second — it issues `SET
     * LOCAL lock_timeout`, which can never wait on a lock — and the
     * transaction has no third statement at all.
     *
     * Spec §2.4 derived FIVE, and 15s from them: the write, the sync's
     * ordered `FOR UPDATE OF c` pre-lock, its wrong-day `class.deleteMany`
     * (which cascades onto `WaitlistEntry` children the pre-lock did not
     * cover), its same-day `class.updateMany` (a real index-entry wait on
     * `Class_teacher_slot_unique`) and the refill's `createManyAndReturn`
     * (the same index again). #194 deleted the sync, taking the last four with
     * it. 10s against one 2s wait is generous rather than tight, and that is
     * deliberate — the budget is not the lock bound, and shrinking it further
     * would buy nothing while risking a slow-connection false `busy`.
     *
     * The transaction is kept for `SET LOCAL lock_timeout`, which is a no-op
     * outside one; this pin is what fails if someone reads it as vestigial
     * and unwraps it, because there would then be no options object to record.
     *
     * `description`, not `classType` like the busy test below: this call is
     * expected to actually commit, and a distinct field keeps the two tests'
     * writes from reading as the same edit if one of their assertions ever
     * needs the other's payload for comparison.
     */
    it('opens the template-edit transaction with { timeout: 10_000 }', async () => {
      let recordedOptions: TransactionOptions | undefined;
      const spyingClient = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (
              fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
              options?: TransactionOptions,
            ) => {
              recordedOptions = options;
              return target.$transaction(fn, options);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const result = await updateClassTemplate(spyingClient, templateId, teacherId, {
        description: 'template-edit budget pin',
      });

      expect(result.ok).toBe(true);
      expect(recordedOptions).toEqual({ timeout: 10_000 });
    });

    /**
     * `updateClassTemplate`'s own contention race, matching the two above.
     * Its `classTemplate.update` contends for the same ROW the generation
     * claim holds — not in the same MODE, the distinction #125/#126 exist to
     * keep straight: an `update` touching no key column takes `FOR NO KEY
     * UPDATE`, the claim takes `FOR UPDATE`. The two conflict with each
     * other, which is all this test needs; they differ against a third party,
     * an inserting row's `FOR KEY SHARE` FK check, which only `FOR UPDATE`
     * blocks. That contention always existed, and it is not what task 7
     * added. What task 7 added is the BOUND: `setLockTimeout(tx)` hoisted to
     * be the transaction's first statement (the archive and the pause/resume
     * already had theirs), so the edit now gives up at 2s and answers `busy` instead
     * of waiting the holder out. `setLockTimeout` takes no lock itself — it
     * issues `SET LOCAL lock_timeout`, as this file's own budget derivation
     * says a few lines above.
     *
     * Named for the edit specifically. Its two siblings in this `describe`
     * cover the archive and the pause/resume, and an unqualified name here
     * made the failure header ambiguous between them under mutation and made
     * `vitest -t` unable to select one.
     */
    it(
      'answers busy when the generation claim holds the row past the lock timeout (template edit)',
      async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        // Let the claim acquire the lock before the edit contends for it.
        await new Promise((r) => setTimeout(r, 100));

        const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
        try {
          const startedAt = Date.now();
          const result = await updateClassTemplate(prisma, templateId, teacherId, {
            classType: 'Yin',
          });
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });

          // Same reasoning as the archive's test above: the lower bound proves
          // it really waited. The 2s value is pinned by `db-locks.test.ts`.
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // A RETURNED failure never reaches `withErrorHandler`, and
          // `respondError` does not log — so without this line the race is
          // silent.
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId }),
            'recurring class edit lost a lock race — nothing committed',
          );
        } finally {
          // In a `finally`, matching the archive/pause busy tests above: a
          // failure in the assertions must not leave the claim holding the
          // row for its own full 15s (the CLAIM's budget, set inline above —
          // not the edit's, which is 10s).
          release();
          await claiming.catch(() => {});
          warn.mockRestore();
        }
      },
      20_000,
    );
  });

  describe('generateClassInstances — archive mid-sweep', () => {
    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isActive: true, isArchived: false },
      });
    });

    /**
     * The actual #95 race, reproduced deterministically and with no test-only
     * hook in production code. Uncommitted writes are invisible to other
     * transactions under READ COMMITTED, which is the lever: the sweep's own
     * `findMany` still sees the template as live, so it enters the loop with
     * exactly the stale list the bug is about.
     */
    it('does not generate for a template archived after the list was read', async () => {
      // Earlier tests in this file leave their own classes behind for this
      // template (they assert on them, then move on) — clear the slate so
      // this test's counts reflect only what happens below.
      await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(0);

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // 1. Archive, but do not commit. Takes the child's row lock first —
      //    the same statement `archiveOrUnarchiveTemplate` takes as its own
      //    first statement (issue 298 / #315) — then writes `ScheduleRule`,
      //    invisible to others until commit.
      const archiving = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
          await tx.scheduleRule.update({
            where: { id: templateScheduleRuleId },
            data: { isArchived: true, isActive: false },
          });
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      // 2. Sweep. Its findMany reads the pre-archive row and includes the
      //    template; its claim then blocks on the child row lock above.
      let sweepSettled = false;
      const sweeping = generateClassInstances(prisma, undefined, teacherId).then((n) => {
        sweepSettled = true;
        return n;
      });

      await new Promise((r) => setTimeout(r, 300));
      // Without the child lock above, the sweep sails past the claim and has
      // already created the window by now.
      expect(sweepSettled).toBe(false);

      // 3. Commit the archive; the claim unblocks and sees isArchived: true.
      commit();
      await archiving;
      await sweeping;

      // 4. Nothing was materialised for a template the teacher shelved.
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(0);
    });
  });

  describe('generateClassInstances — edit mid-sweep', () => {
    // Captured, not hardcoded: other tests in this file assert the fixture's own
    // startTime, so restoring a guessed value would corrupt them.
    let original: { dayOfWeek: number; startTime: string };

    beforeAll(async () => {
      const t = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: templateScheduleRuleId } });
      original = { dayOfWeek: t.dayOfWeek, startTime: timeToHHmm(t.startTime) };
    });

    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: {
          dayOfWeek: original.dayOfWeek,
          startTime: hhmmToTime(original.startTime),
          isActive: true,
          isArchived: false,
        },
      });
    });

    /**
     * #102. The claim locks the row, so a concurrent edit cannot commit while we
     * generate — but before this fix the sweep still generated from the object
     * its outer `findMany` read, so it wrote the pre-edit values anyway.
     *
     * Deterministic by the same lever as the archive race: an uncommitted write
     * is invisible under READ COMMITTED, so the sweep's list read genuinely sees
     * the old values and the template genuinely enters the loop.
     */
    it('writes the values committed while the sweep was waiting, not the ones it read', async () => {
      await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // 1. Edit, uncommitted. Takes the child's row lock first — the same
      //    statement `updateClassTemplate` takes as its own first statement
      //    (issue 298 / #315) — then writes `ScheduleRule`, invisible to the
      //    sweep until commit.
      const editing = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
          await tx.scheduleRule.update({
            where: { id: templateScheduleRuleId },
            data: { dayOfWeek: 5, startTime: hhmmToTime('18:45') },
          });
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      // 2. Sweep. Its findMany reads the pre-edit row; its claim then blocks
      //    on the child row lock above.
      let sweepSettled = false;
      const sweeping = generateClassInstances(prisma, undefined, teacherId).then((n) => {
        sweepSettled = true;
        return n;
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(sweepSettled).toBe(false);

      // 3. Commit. The claim unblocks and re-reads under its own lock.
      commit();
      await editing;
      await sweeping;

      // 4. Everything it created carries the post-edit values.
      const created = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, select: { calendarEntry: { select: { date: true, startTime: true } } } });
      expect(created.length).toBeGreaterThan(0);
      for (const c of created) {
        expect(timeToHHmm(c.calendarEntry.startTime)).toBe('18:45');
        // dayOfWeek 5 in this schema's convention (0=Mon) is Saturday,
        // which is getUTCDay() === 6.
        expect(c.calendarEntry.date.getUTCDay()).toBe(6);
      }
    });
  });

  describe('claim-first interleaving — archive right after a committed generation', () => {
    /**
     * The interleaving `claimTemplateForGeneration`'s docstring describes as
     * "claim first": the sweep claims the row, generates, and commits before
     * an archive ever runs. This is ordering, not timing — the claim
     * transaction is fully committed before the archive starts, so no lock
     * hold or sleep is needed to reproduce it, unlike the concurrent races
     * above.
     *
     * What the docstring used to get wrong: it isn't a clean handoff where
     * the archive's `deleteMany` withdraws everything the claim just made.
     * That delete's boundary is `gt: today` (`scheduledWhere` in
     * `class-template-lifecycle.ts`) — the same spare-today carve-out applied
     * everywhere else, because a class hours from starting should not vanish
     * out from under students who already see it as open. So when the claim
     * generates a class dated today, that one class survives the archive that
     * follows, and `remaining`'s `gte` boundary reports it honestly rather
     * than a total that quietly excludes it. This test builds exactly that
     * shape — one of the four generated classes dated today, three dated in
     * later weeks — and asserts the survivor.
     */
    it("spares the class generated for today; withdraws the three generated for later weeks", async () => {
      const timeZone = 'Europe/Amsterdam';
      const today = startOfLocalDay(new Date(), timeZone);
      // Schema convention 0=Monday..6=Sunday; JS getUTCDay() 0=Sunday..6=Saturday.
      const dayOfWeek = (today.getUTCDay() + 6) % 7;

      const template = await prisma.classTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId, kind: 'regular', classType: 'Vinyasa', dayOfWeek,
              // Comfortably after `today` (UTC midnight) once interpreted in
              // Amsterdam time, at any DST offset — guarantees today's occurrence
              // clears generateInstancesForTemplate's "start still ahead" filter
              // regardless of what time of day this test happens to run.
              startTime: hhmmToTime('23:59'), durationMinutes: 60, isActive: true,
            },
          },
          teacherRoom: { connect: { id: teacherRoomId } },
          description: 'Claim-first interleaving fixture',
          roomCost: 10,
          minRate: 10,
          targetRate: 20,
          minStudents: 1,
          maxStudents: 8,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
        },
        include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
      });

      try {
        // 1. Claim, generate, and commit — the "claim first" arm.
        const created = await prisma.$transaction(async (tx) => {
          expect(await claimTemplateForGeneration(tx, template.id)).not.toBeNull();
          return (await generateInstancesForTemplate(tx, template, today)).created;
        });
        expect(created).toBe(4);

        const beforeArchive = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, include: { calendarEntry: true } });
        expect(beforeArchive).toHaveLength(4);
        expect(beforeArchive[0]!.calendarEntry.date.toISOString()).toBe(today.toISOString());

        // 2. Archive, straight after the commit — no concurrency involved.
        const result = await archiveOrUnarchiveTemplate(prisma, template.id, teacherId, 'archived');
        if (!result.ok) throw new Error('archive should have succeeded');
        if (result.action !== 'archived') throw new Error('expected an archive, not an unarchive');

        // 3. Exactly the outcome the corrected docstring describes: today's
        //    class survives, the three later-week ones do not.
        expect(result.deleted).toBe(3);
        expect(result.remaining).toBe(1);

        const afterArchive = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } }, include: { calendarEntry: true } });
        expect(afterArchive).toHaveLength(1);
        expect(afterArchive[0]!.calendarEntry.date.toISOString()).toBe(today.toISOString());
        expect(afterArchive[0]!.status).toBe('open'); // still publicly bookable
      } finally {
        await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: template.id } } } },
    });
        // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
        // 298) — deleting the child directly here would orphan its rule row.
        await prisma.scheduleRule.delete({ where: { id: template.scheduleRuleId } });
      }
    });
  });

  describe('generateInstancesForTemplate — slot reporting', () => {
    /** The same four dates the generator will choose, computed the same way. */
    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant({ date: d, startTime: hhmmToTime('09:00') }, 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      // #296: the cross-family cases create `StudioClass` rows, and the
      // generator now READS that table — so a leftover one occupies the next
      // test's slot exactly the way a leftover `Class` does. Without this line
      // the two new cases turn eight later tests in this block red.
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    });

    it('reports an already-generated date rather than counting it', async () => {
      const now = new Date();
      const first = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(first.created).toBe(4);
      expect(first.skipped).toEqual([]);

      const second = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(second.created).toBe(0);
      expect(second.skipped.map((s) => s.reason)).toEqual([
        'already_generated',
        'already_generated',
        'already_generated',
        'already_generated',
      ]);
    });

    it('names a cancelled own instance as blocked_by_cancelled, not as idempotency', async () => {
      const now = new Date();
      const dates = candidates(now);
      const blocked = dates[1]!;
      await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      await prisma.calendarEntry.updateMany({ where: { scheduleRule: { classTemplates: { some: { id: templateId } } }, date: blocked }, data: { cancelledAt: new Date() } });

      const again = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(again.created).toBe(0);
      expect(again.skipped).toContainEqual({ date: blocked, reason: 'blocked_by_cancelled' });
    });

    it('skips only the slot a manually created class occupies, and still fills the rest', async () => {
      const now = new Date();
      const dates = candidates(now);
      const taken = dates[1]!;
      // templateId: null — a class the teacher created by hand. The old probe
      // checked {templateId, date} and so could not see this at all.
      await createClassFixture(prisma, {
          teacherId,
          teacherRoomId,
          scheduleRuleId: null,
          classType: 'Manual',
          date: taken,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
        });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: taken, reason: 'slot_taken' }]);
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(3);
    });

    /**
     * #296, the mirror of the studio generator's pair. The other family holds
     * the slot — a `StudioClass`, not a `Class` — so `slot_taken` is the wrong
     * answer even though both mean "occupied": that one is answered among the
     * teacher's own classes, this one sends them to the studio half of their
     * schedule.
     *
     * Asserts the skipped DATE as well as the reason. A count alone passes if
     * the generator blocks the wrong date.
     */
    it('skips a date held by a live class from the other family', async () => {
      const now = new Date();
      const dates = candidates(now);
      const blocked = dates[1]!;
      await createStudioClassFixture(prisma, {
          teacherId,
          scheduleRuleId: null,
          classType: 'Cross Family',
          date: blocked,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 50,
        });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: blocked, reason: 'blocked_by_overlap' }]);
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(3);
    });

    it('does not skip a date held by a CANCELLED class from the other family', async () => {
      // Pins the same predicate the trigger carries on this side
      // (`cancelledAt IS NULL`). Widen the pre-check past liveness and this
      // goes red — the mutation the task report records.
      const now = new Date();
      const dates = candidates(now);
      const notBlocked = dates[1]!;
      await createStudioClassFixture(prisma, {
          teacherId,
          scheduleRuleId: null,
          classType: 'Cross Family Cancelled',
          date: notBlocked,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 50,
          cancelledAt: new Date(),
        });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(4);
      expect(result.skipped.map((slot) => slot.reason)).not.toContain('blocked_by_overlap');
    });

    /**
     * The occupancy read is scoped `where: { teacherId }`, and dropping that
     * scope passed the entire suite — this file's fixture has one teacher, so
     * nothing here could have failed. It is §4.1's asymmetry in the direction
     * the spec calls the only real defect: a pre-check *stricter* than the
     * index silently under-fills a window and nothing raises.
     *
     * `CalendarEntry_teacher_slot_excl` is scoped per teacher (`"teacherId"
     * WITH =`), so another teacher's class can never block this one. Unscoped, every candidate date here reads
     * `slot_taken`, this teacher's window comes back empty, and the log line
     * names the wrong teacher's schedule.
     */
    /**
     * PR #300 review, G6 — the cross-family twin of the case below, and the
     * same omission it exists to close, reintroduced one table over.
     *
     * That case seeds another teacher's `Class` rows, so it exercises the
     * SAME-family `occupants` read only. Nothing seeded another teacher's
     * `StudioClass`, so dropping `teacherId` from the new `foreign` read
     * (`class-generator.ts`) left the whole suite green — while every
     * candidate date another teacher happened to hold read
     * `blocked_by_overlap`, this teacher's window came back short, and
     * nothing raised. §4.1 calls a pre-check STRICTER than the guard the only
     * real defect, and this is that direction.
     *
     * The docblock on that read warns about exactly this ("Widen or narrow one
     * without the other…") and had no test behind the warning.
     */
    it('ignores another teacher holding the same slot in the other family', async () => {
      const now = new Date();
      const dates = candidates(now);

      const other = await prisma.teacher.create({
        data: {
          firstName: 'OtherCross',
          lastName: 'Teacher',
          email: `other-cross-${uniqueSuffix}@test.local`,
          account: { create: { email: `other-cross-${uniqueSuffix}@test.local` } },
          bio: 'second teacher for the cross-family scoping guard',
          pageSlug: `other-cross-${uniqueSuffix}`,
        },
      });

      try {
        for (const date of dates) {
          await createStudioClassFixture(prisma, {
              teacherId: other.id,
              scheduleRuleId: null,
              classType: 'Someone else, studio',
              date,
              startTime: hhmmToTime('09:00'),
              durationMinutes: 60,
              location: 'Their studio',
              hourlyRate: 50,
            });
        }

        const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

        expect(result.created).toBe(4);
        expect(result.skipped).toEqual([]);
      } finally {
        await prisma.calendarEntry.deleteMany({ where: { teacherId: other.id } });
        await prisma.teacher.delete({ where: { id: other.id } });
        await prisma.account.delete({ where: { id: other.accountId } });
      }
    });

    it('ignores another teacher holding the same date and time', async () => {
      const now = new Date();
      const dates = candidates(now);

      const other = await prisma.teacher.create({
        data: {
          firstName: 'Other',
          lastName: 'Teacher',
          email: `other-gen-${uniqueSuffix}@test.local`,
          account: { create: { email: `other-gen-${uniqueSuffix}@test.local` } },
          bio: 'second teacher for the scoping guard',
          pageSlug: `other-gen-${uniqueSuffix}`,
        },
      });
      const otherRoom = await prisma.teacherRoom.create({
        data: { teacherId: other.id, roomId, capacityOverride: 10, rentalRate: 30 },
      });

      try {
        // The other teacher occupies every candidate slot, same date and time.
        for (const date of dates) {
          await createClassFixture(prisma, {
              teacherId: other.id,
              teacherRoomId: otherRoom.id,
              scheduleRuleId: null,
              classType: 'Someone else',
              date,
              startTime: hhmmToTime('09:00'),
              durationMinutes: 60,
              roomCost: 40,
              minRate: 15,
              targetRate: 30,
              minStudents: 4,
              maxStudents: 12,
              cancelDeadline: 'HOURS_24',
              autoCancelCheck: 'HOURS_2',
              status: 'open',
            });
        }

        const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

        expect(result.created).toBe(4);
        expect(result.skipped).toEqual([]);
      } finally {
        await prisma.calendarEntry.deleteMany({ where: { teacherId: other.id } });
        await prisma.teacherRoom.delete({ where: { id: otherRoom.id } });
        await prisma.teacher.delete({ where: { id: other.id } });
        await prisma.account.deleteMany({
          where: { email: `other-gen-${uniqueSuffix}@test.local` },
        });
      }
    });

    it('does not treat a cancelled neighbour as occupying the slot', async () => {
      const now = new Date();
      const dates = candidates(now);
      const free = dates[1]!;
      await createClassFixture(prisma, {
          teacherId,
          teacherRoomId,
          scheduleRuleId: null,
          classType: 'Manual',
          date: free,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
          cancelledAt: new Date(),
        });

      // `CalendarEntry_teacher_slot_excl` is partial on `"cancelledAt" IS
      // NULL`, so a cancelled neighbour does not occupy the slot and must not
      // block generation.
      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(result.created).toBe(4);
      expect(result.skipped).toEqual([]);
    });

    it('logs blocked dates once per call, and stays silent for plain idempotency', async () => {
      const now = new Date();
      const spy = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).not.toHaveBeenCalled(); // 4 fresh creates — nothing to say

        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).not.toHaveBeenCalled(); // 4 already_generated — the noise rule

        await prisma.calendarEntry.updateMany({ where: { scheduleRule: { classTemplates: { some: { id: templateId } } }, date: candidates(now)[1]! }, data: { cancelledAt: new Date() } });
        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![0]).toMatchObject({
          templateId,
          skipped: [{ reason: 'blocked_by_cancelled' }],
        });
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * THE TWO HALVES, JOINED. `calendar-entry.test.ts` pins that
     * `CalendarEntry_teacher_slot_excl` catches a collision ACROSS MIDNIGHT;
     * the case below pins what a generator reports when it does. Nothing
     * connected them, and the gap was a live user-facing defect.
     *
     * The chain: the generator reads occupancy as `date: { in: dates }` and
     * compares with `spansOverlap`, which is minutes-since-midnight on ONE date.
     * A neighbour carried into a candidate from the previous calendar date is
     * therefore invisible to the pre-check; the date goes to `free`; the
     * constraint refuses the insert; `ON CONFLICT DO NOTHING` absorbs it; and
     * the date came back as `raced` — one of the two reasons
     * `countSkipReasons` DROPS. `anyBlocked` reduces over `SkipCounts` only, so
     * `template-form.tsx` took its `router.push` and navigated the teacher away
     * from a window that generated nothing, saying nothing. Not once: the
     * pre-check says free forever and the constraint refuses forever, so every
     * hourly sweep reproduced it.
     *
     * The assertions run the whole chain rather than stopping at the reason,
     * because the reason was never the defect — `raced` was a truthful label
     * for a date nobody would ever be told about. `countSkipReasons` and
     * `anyBlocked` are the two hops between the generator and the gate.
     *
     * 22:00 + 700 minutes = 09:40 the next day, against a template at
     * 09:00 + 75. The CONTROL below cuts the neighbour to 660 minutes — 09:00
     * exactly, back-to-back — and all four dates fill, which is what says this
     * fixture blocks by overlapping rather than by existing.
     */
    it('names a date blocked by a neighbour spilling past midnight, which the pre-check cannot see', async () => {
      const now = new Date();
      const dates = candidates(now);
      const collide = dates[1]!;
      const eve = new Date(collide.getTime() - 24 * 60 * 60 * 1000);

      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId: null,
        classType: 'Late night, spilling over',
        date: eve,
        startTime: hhmmToTime('22:00'),
        durationMinutes: 700,
        roomCost: 40,
        minRate: 15,
        targetRate: 30,
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      });

      // The pre-check's own read cannot have seen it: the neighbour is not on
      // any candidate date. Asserted rather than assumed, because a fixture
      // that accidentally landed ON a candidate would pass every line below
      // for the ordinary same-date reason and prove nothing about midnight.
      expect(dates.map((d) => d.getTime())).not.toContain(eve.getTime());

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: collide, reason: 'blocked_by_overlap' }]);

      // The two hops that decide whether a teacher hears about it at all.
      const counts = countSkipReasons(result.skipped);
      expect(counts.blockedByOverlap).toBe(1);
      expect(anyBlocked(counts)).toBe(true);
    });

    it('fills every date when the spilling neighbour ends exactly at the start — the half-open bound', async () => {
      const now = new Date();
      const dates = candidates(now);
      const eve = new Date(dates[1]!.getTime() - 24 * 60 * 60 * 1000);

      // 22:00 + 660 = 09:00, the template's own start. `[)` on both sides, so
      // this touches without overlapping and the constraint admits it.
      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        scheduleRuleId: null,
        classType: 'Late night, ending on the hour',
        date: eve,
        startTime: hhmmToTime('22:00'),
        durationMinutes: 660,
        roomCost: 40,
        minRate: 15,
        targetRate: 30,
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(4);
      expect(result.skipped).toEqual([]);
    });

    /**
     * A lost race whose winner IS STILL THERE — reported for what still holds
     * the date, not as transient.
     *
     * The reason moved with #327's second look. The `ON CONFLICT DO NOTHING`
     * skip is the same one it always was; what changed is that the generator
     * now re-asks the database whether anything live still overlaps the short
     * date, and here something does — the holder committed and is sitting on
     * the slot. `raced` used to be the answer, and `countSkipReasons` drops it,
     * so the date reached no teacher at all. The case below it is the `raced`
     * pin now: a short date nothing live overlaps.
     *
     * The coarseness is deliberate and bounded. A fresh pre-check would call
     * this holder `slot_taken` — same family, same minute — and the probe does
     * not distinguish. It cannot arise except from a race, because the
     * pre-check sees every committed same-minute neighbour; see the note above
     * `landed` in `class-generator.ts`.
     */
    it('names a date lost to a concurrent insert by what still holds it', async () => {
      const now = new Date();
      const dates = candidates(now);
      const collide = dates[1]!;

      // The holder inserts the colliding row and holds it UNCOMMITTED, so the
      // generator's occupancy read (a plain read under READ COMMITTED) still
      // calls that date free, and the generator's own insert then parks on the
      // holder's pending unique-index entry and loses the race when the holder
      // commits — the same lever the #164 resume tests use.
      const holder = new PrismaClient();
      let release!: () => void;
      let collided!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const parked = new Promise<void>((r) => { collided = r; });
      const holding = holder.$transaction(
        async (tx) => {
          await createClassFixture(tx, {
              teacherId,
              teacherRoomId,
              // `null`, deliberately, not this rule's own id: with the
              // rule's `scheduleRuleId` the holder also collides on the
              // pre-existing `@@unique([scheduleRuleId, date])`, so this test
              // would pass byte-identically with
              // `CalendarEntry_teacher_slot_excl` dropped. `null` isolates the
              // collision to the slot constraint — and is the production shape
              // too: a standalone class racing the nightly
              // `api/cron/generate-classes` sweep onto a template's slot.
              scheduleRuleId: null,
              classType: 'Vinyasa',
              date: collide,
              startTime: hhmmToTime('09:00'),
              durationMinutes: 60,
              roomCost: 40,
              minRate: 15,
              targetRate: 30,
              minStudents: 4,
              maxStudents: 12,
              cancelDeadline: 'HOURS_24',
              autoCancelCheck: 'HOURS_2',
              status: 'open',
            });
          collided();
          await released;
        },
        { timeout: 20_000 },
      );

      // The generator starts with the holder's row in flight, so its occupancy
      // read cannot see the colliding date and its insert parks on the pending
      // entry; the other three dates insert cleanly.
      await parked;
      const generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holding;
      const result = await generating;
      await holder.$disconnect();

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: collide, reason: 'blocked_by_overlap' }]);
    });

    /**
     * `raced`, and the only shape left that produces it: a short date nothing
     * live overlaps.
     *
     * `CalendarEntry_scheduleRuleId_date_key` is what refuses here, not the
     * slot exclusion — the holder takes this rule's own `(scheduleRuleId,
     * date)` pair at a start time 5 hours clear of the template's. So the
     * insert is refused, `ON CONFLICT DO NOTHING` absorbs it, and the second
     * look finds no overlapping live entry, which is exactly the transience
     * `countSkipReasons`'s exclusion of `raced` assumes.
     *
     * `14:00` against the template's `09:00 + 75`, deliberately far apart:
     * anything overlapping would be answered `blocked_by_overlap` by the case
     * above and this test would pass for the wrong reason.
     */
    it('names a short date nothing live overlaps as raced', async () => {
      const now = new Date();
      const dates = candidates(now);
      const collide = dates[1]!;

      const holder = new PrismaClient();
      let release!: () => void;
      let collided!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const parked = new Promise<void>((r) => { collided = r; });
      const holding = holder.$transaction(
        async (tx) => {
          await createClassFixture(tx, {
              teacherId,
              teacherRoomId,
              // This rule's own id, which is what makes the rule-date key the
              // constraint that refuses. The slot exclusion cannot: 14:00 is
              // nowhere near 09:00-10:15.
              scheduleRuleId: templateScheduleRuleId,
              classType: 'Same rule, other hour',
              date: collide,
              startTime: hhmmToTime('14:00'),
              durationMinutes: 60,
              roomCost: 40,
              minRate: 15,
              targetRate: 30,
              minStudents: 4,
              maxStudents: 12,
              cancelDeadline: 'HOURS_24',
              autoCancelCheck: 'HOURS_2',
              status: 'open',
            });
          collided();
          await released;
        },
        { timeout: 20_000 },
      );

      await parked;
      const generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holding;
      const result = await generating;
      await holder.$disconnect();

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: collide, reason: 'raced' }]);
    });
  });

  describe('generateInstancesForTemplate — week-keyed generation (#194)', () => {
    // A template is a stamp, not a live link. The sync that used to rewrite
    // already-generated classes is gone (#194), so the only thing standing
    // between a day edit and a doubled schedule is this: no second class into
    // a week this template already occupies.
    //
    // Monday 2026-04-06 is the anchor because the four Tuesdays that follow
    // (Apr 7/14/21/28) and the four Thursdays (Apr 9/16/23/30) pair up
    // one-for-one inside the same four Monday-anchored weeks — Apr 6, 13, 20,
    // 27. That pairing IS the fixture: pick an anchor where the new day falls
    // BEFORE the old one and the fourth candidate lands in a fifth week the
    // old window never reached, which is a legitimate create and would make
    // these assertions wrong rather than failing.
    //
    // A fixed `from` rather than the slot-reporting describe's `new Date()`,
    // deliberately: these assertions name calendar weeks, and a run that
    // straddled a Sunday/Monday boundary would move which Monday a candidate
    // belongs to. The suite pins `TZ=America/New_York` (`vitest.config.ts`) —
    // west of UTC, the direction in which reading one of these UTC-midnight
    // `@db.Date` values with a local accessor moves the calendar day back one
    // and a Monday back a whole week. So the weeks below are load-bearing.
    const from = new Date('2026-04-06T00:00:00.000Z');
    const TUESDAY = 1; // schema convention: 0=Mon, 1=Tue, ..., 6=Sun
    const THURSDAY = 3;
    const TUESDAYS = [
      '2026-04-07T00:00:00.000Z',
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
    ];

    /** Every date this template holds, oldest first — cancelled ones included. */
    async function heldDates(): Promise<string[]> {
      const rows = await prisma.class.findMany({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'asc' } }, select: { calendarEntry: { select: { date: true } } } });
      return rows.map((c) => c.calendarEntry.date.toISOString());
    }

    beforeEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { dayOfWeek: TUESDAY },
      });
      // The window every test here starts from. Asserted rather than assumed:
      // a seed that quietly created three would make `created: 0` below mean
      // something other than what it claims.
      const seeded = await generateInstancesForTemplate(prisma, await freshTemplate(), from);
      expect(seeded.created).toBe(4);
    });

    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      // Restored, not left on Thursday: `templateId` is the file's shared
      // fixture and several tests above assert its Tuesday window by date.
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { dayOfWeek: TUESDAY },
      });
    });

    it('does not generate into a week that already holds a class from this template', async () => {
      // Window generated on Tuesday, then the template moves to Thursday.
      // Every candidate Thursday falls in a week a Tuesday class already holds.
      expect(await heldDates()).toEqual(TUESDAYS);

      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { dayOfWeek: THURSDAY },
      });
      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), from);

      expect(result.created).toBe(0);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        'already_this_week',
        'already_this_week',
        'already_this_week',
        'already_this_week',
      ]);

      // The whole issue in one assertion: four classes on the schedule, not
      // the eight a per-DATE key produces, and still the Tuesdays.
      expect(await heldDates()).toEqual(TUESDAYS);
    });

    it('a CANCELLED class still holds its week', async () => {
      // Spec §3.2. Cancel one Tuesday, move to Thursday: that week must stay
      // empty rather than flipping to the new day for one week and back.
      // This is the one place this codebase does NOT read cancelled as free —
      // `CalendarEntry_teacher_slot_excl` is partial on `"cancelledAt" IS
      // NULL` and does, and the sibling test above ("does not treat a
      // cancelled neighbour as occupying the slot") pins that. With a
      // `cancelledAt: null` filter on the week read — which is keyed
      // `scheduleRuleId` and deliberately carries none — week 2 alone would
      // move to Thursday while weeks 1, 3 and 4 stayed Tuesday.
      const cancelled = new Date(TUESDAYS[1]!);
      await prisma.calendarEntry.updateMany({ where: { scheduleRule: { classTemplates: { some: { id: templateId } } }, date: cancelled }, data: { cancelledAt: new Date() } });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { dayOfWeek: THURSDAY },
      });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), from);

      expect(result.created).toBe(0);
      // Length before `every`, which is vacuously true on a short array: the
      // status-filtered variant does not mis-label week 2, it CREATES week 2
      // and that date never reaches `skipped` at all.
      expect(result.skipped).toHaveLength(4);
      expect(result.skipped.every((s) => s.reason === 'already_this_week')).toBe(true);
      expect(await heldDates()).toEqual(TUESDAYS);
    });

    it('still reports already_generated, not already_this_week, on a steady-state re-run', async () => {
      // Evaluation order (spec §3.4): the week set contains the candidate's OWN
      // week, so a week-first check would mask already_generated on every re-run.
      // Not cosmetic — `countSkipReasons` counts `already_this_week` into the
      // resume sentence the teacher reads (`resumeMessage`, "N dates are still
      // held by classes on your previous day") and deliberately ignores
      // `already_generated`, so week-first would report four blocked weeks
      // after a run that did exactly what it was supposed to do.
      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), from);

      expect(result.created).toBe(0);
      expect(result.skipped.map((s) => s.reason)).toEqual([
        'already_generated',
        'already_generated',
        'already_generated',
        'already_generated',
      ]);
    });
  });

  /** The template with the `teacher.defaultTimezone` join the generator requires. */
  async function freshTemplate() {
    return prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });
  }

  describe('generateInstancesForTemplate — the empty-window guard', () => {
    /**
     * The guard's comment used to say this branch "today it cannot be — the
     * filter above can only drop the first of five". It can be, and this is
     * how: `classStartInstant` (`@/lib/timezone`) fails SOFT on an unreadable
     * `startTime`, returning `new Date(NaN)` rather than throwing, and
     * `NaN > startDate` is `false` for every candidate rather than for one.
     *
     * NOT a live defect, and this case is not written as one. Every route that
     * writes a template's `startTime` validates it with `timeHHmm`
     * (`@/lib/schemas`), so no stored row can carry a value this cannot read —
     * which is why the bad value is passed in memory here rather than written.
     * The argument is the whole reachable surface, and inventing a migration
     * that could produce such a row in order to test the guard would be
     * inventing the defect.
     *
     * What is pinned is that the branch is ACTIONABLE if the write path is
     * ever widened. `classStartInstant`'s own warn carries `{ startTime }` and
     * nothing else, so an operator reading it learns that A template was
     * unreadable and never which one.
     */
    it('names the template when an unreadable startTime empties the window', async () => {
      const base = await freshTemplate();
      const spy = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const result = await generateInstancesForTemplate(prisma, {
          ...base,
          // `timeToHHmm` renders an Invalid Date as `"NaN:NaN"`, which
          // `classStartInstant` treats the same way it treats any unreadable
          // `startTime` string.
          scheduleRule: { ...base.scheduleRule, startTime: new Date(NaN) },
        });

        // All five dropped, so there is no window at all — not four candidates
        // that each got a reason. `skipped` is empty for the same reason
        // `created` is 0: the function returns before the loop that would have
        // classified anything.
        expect(result).toEqual({ created: 0, skipped: [] });

        // Once per call, and the one line that identifies the template. The
        // other calls on this spy are `classStartInstant`'s own, one per
        // unreadable occurrence, which is why this filters by message rather
        // than counting the spy.
        const guardCalls = spy.mock.calls.filter(
          ([, msg]) => typeof msg === 'string' && msg.includes('no candidate dates'),
        );
        expect(guardCalls).toHaveLength(1);
        expect(guardCalls[0]![0]).toMatchObject({
          templateId,
          teacherId,
          startTime: 'NaN:NaN',
        });
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('pauseOrResumeTemplate — a clash during generation (#164)', () => {
    beforeEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.scheduleRule.update({ where: { id: templateScheduleRuleId }, data: { isActive: false } });
    });

    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.scheduleRule.update({ where: { id: templateScheduleRuleId }, data: { isActive: true } });
    });

    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant({ date: d, startTime: hhmmToTime('09:00') }, 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    const classRow = (date: Date) => ({
      teacherId,
      teacherRoomId,
      // The RULE, not the template: the entry is what carries the key the
      // generator collides on, and it hangs off `ScheduleRule` (#327).
      scheduleRuleId: templateScheduleRuleId,
      classType: 'Vinyasa',
      date,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 75,
      roomCost: 40,
      minRate: 15,
      targetRate: 30,
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24' as const,
      autoCancelCheck: 'HOURS_2' as const,
      status: 'open' as const,
    });

    /**
     * Runs the race and reports what the resume saw.
     *
     * WHERE THE RESUME WAITS MOVED THREE TIMES, and the observable outcome
     * moved with it. The holder inserts its colliding row and holds it
     * UNCOMMITTED, so its row never appears in a READ COMMITTED query until it
     * commits.
     *
     * PRE-#116: the resume reached its own insert and parked on the holder's
     * pending unique entry, resuming once the holder committed.
     *
     * #116–#327: the in-flight class insert ALSO took `FOR KEY SHARE` on the
     * `ClassTemplate` row, for the FK a `Class` carried through `templateId`.
     * `claimTemplateForGeneration`'s `FOR UPDATE` conflicts with that mode, so
     * the resume blocked at the CLAIM, waited out the holder, and then saw the
     * colliding row committed and visible — `already_generated`, not `raced`.
     * The claim converted a lost race into a wait, and an empty `racedDates`
     * is what said so.
     *
     * `Class.templateId` is gone. A class hangs off a `CalendarEntry` and the
     * entry's FK reaches `ScheduleRule`, so an in-flight class insert no
     * longer touches the `ClassTemplate` row the claim holds. The resume
     * therefore walked past the claim and met the holder at its OWN insert,
     * parking on the pending entry and finally taking an `ON CONFLICT DO
     * NOTHING` skip — the pre-#116 behaviour, restored by a schema change
     * rather than by a code change. That is a real loss of coupling and is
     * asserted rather than hidden: `collidedDates` named the collided date.
     *
     * #272 MOVED IT BACK ONE STATEMENT AGAIN, to the CAS. `ScheduleRule` now
     * carries the generated `live` column, and the composite key it backs
     * (`ScheduleRule_id_kind_live_key`) is what
     * `ClassTemplate_scheduleRuleId_kind_ruleLive_fkey` references. Postgres
     * upgrades an UPDATE of a referenced key column from `FOR NO KEY UPDATE`
     * to `FOR UPDATE` — the same mode it applies to `isActive` when a rule
     * row is PATCHed — so the resume's CAS conflicts with the holder's
     * `FOR KEY SHARE` (the entry's FK check on `scheduleRuleId`) and blocks
     * for the whole hold. Measured with `pg_stat_activity` while the holder
     * was parked: the resume sat in `Lock:transactionid` on
     * `UPDATE "ScheduleRule" SET "isActive" = $1 …` for ~400ms. The holder
     * then commits, the CAS proceeds, and the resume's occupancy read — now
     * AFTER the commit — sees the colliding row as its own and reports the
     * date `already_generated`: the outcome the #327 note below already
     * predicted for a fresh pre-check, reached by a lock edge rather than by
     * a refinement.
     *
     * WHAT #164 IS ACTUALLY ABOUT SURVIVES, and it is what the two callers
     * below assert: the transaction is not poisoned, `isActive` stays
     * committed, and a collision costs only its own date. What changed is who
     * waits and therefore what the date is named when the collision is
     * absorbed — the clashed date now classifies `already_generated` (the
     * holder is this rule's own row), and `collidedDates` is empty.
     *
     * WHICH REASON it is named under moved twice. Inside #327 the skip was
     * reported `blocked_by_overlap`, because the generator started re-asking
     * the database about a short date and the holder had COMMITTED and sat on
     * the slot by then — coarser than the truth (the holder is this rule's own
     * row, so a fresh pre-check would say `already_generated`) and
     * deliberately not refined. #272 made that prediction the outcome: the
     * date is consumed by the pre-check itself as `already_generated`, never
     * reaching the `short` list or the probe. The filter below takes every
     * reason but `already_generated`, which is what `logSkippedEntries`
     * (`entry-generation.ts`) logs, so
     * a clash now yields an empty `collidedDates` — the two callers assert
     * that instead of a name, and the count assertions carry the load the name
     * used to.
     *
     * What #164 is actually about survives untouched, and it is what the two
     * callers below assert: the transaction is not poisoned, `isActive` stays
     * committed, and a collision costs only its own date.
     *
     * Note the direction, because an earlier version of this docblock had it
     * backwards: the holder is never blocked. It inserts first and holds; the
     * RESUME is the party that waits. Pushing the hold past the 2s
     * `setLockTimeout` bound turns that wait into `busy`, which is what the
     * third test in this block pins — unchanged, because the bound reaches
     * whichever statement does the waiting. Since #272 that statement is the
     * CAS, and the third test's comment says so.
     *
     * `waitedMs` is what says a race happened at all; without it these tests
     * pass against a pre-committed collision and prove nothing — measured.
     *
     * `waitedMs` is returned because it is the only evidence the two
     * transactions actually overlapped. An empty `racedDates` is equally true
     * of a world where the holder committed before the resume ever started —
     * measured, with the collision pre-committed both callers below passed
     * unchanged — so the callers assert the wait as well.
     */
    async function raceResumeAgainst(collide: Date): Promise<{
      collidedDates: string[];
      resumed: Awaited<ReturnType<typeof pauseOrResumeTemplate>>;
      waitedMs: number;
      holderCommitted: boolean;
      holderError: unknown;
    }> {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      const holder = new PrismaClient();
      let release!: () => void;
      let collided!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      const parked = new Promise<void>((r) => { collided = r; });

      const holding = holder.$transaction(
        async (tx) => {
          await createClassFixture(tx, classRow(collide));
          collided();
          await released;
        },
        { timeout: 20_000 },
      );

      // `try`/`finally` around everything after the holder is in flight. The
      // resume can reject, and without this a rejection would skip
      // `warn.mockRestore()` — leaving the `log.warn` spy installed for every
      // later test in this file and silently emptying their `racedDates`. The
      // `busy` test below already wraps its body this way; this helper did
      // not. `release()` is in the `finally` too, so a rejection cannot leave
      // the holder parked for its full 20s budget.
      try {
        // Deterministic, not a sleep: `parked` resolves only once the holder's
        // insert has actually returned, so its `FOR KEY SHARE` is held before
        // the resume asks for `FOR UPDATE`. A fixed delay here would sometimes
        // start the resume first, and the holder would then hit a unique
        // violation instead of the interleaving this function exists to build.
        await parked;
        // Stamped when the resume's own promise settles, NOT after the sleep
        // below — otherwise `waitedMs` would always include the 400ms hold and
        // could never tell a blocked resume from an unblocked one. (Measured:
        // with the naive stamp, pre-committing the collision still "waited"
        // 400ms and the assertion passed.)
        const startedAt = Date.now();
        let settledAt = 0;
        const resuming = pauseOrResumeTemplate(prisma, templateId, teacherId, 'active').then(
          (r) => {
            settledAt = Date.now();
            return r;
          },
        );
        await new Promise((r) => setTimeout(r, 400));
        release();
        // Not swallowed, and the REASON is kept: a holder killed by `40P01`
        // and one killed by `P2028` are different failures behind the same
        // boolean, on a helper whose whole subject is lock contention.
        // Returning only `false` reports both as `expected false to be true`
        // with no cause, so the callers assert `holderError` is null and the
        // message reaches the failure output.
        let holderError: unknown = null;
        const holderCommitted = await holding.then(
          () => true,
          (e) => {
            holderError = e;
            return false;
          },
        );
        const resumed = await resuming;
        const waitedMs = settledAt - startedAt;

        const collidedDates = warn.mock.calls.flatMap((call) => {
          const payload = call[0] as { skipped?: Array<{ date: string; reason: string }> };
          return (payload.skipped ?? [])
            .filter((s) => s.reason !== 'already_generated')
            .map((s) => s.date);
        });
        return { collidedDates, resumed, waitedMs, holderCommitted, holderError };
      } finally {
        release();
        warn.mockRestore();
        await holder.$disconnect();
      }
    }

    /**
     * The hold is 400ms and the resume is blocked for all of it, so anything
     * at or above 300ms proves the two overlapped. Without that, this test and
     * its sibling pass against a pre-committed collision and prove nothing —
     * which is exactly how they were measured to behave.
     */
    const HELD_FOR_MS = 300;

    it('leaves isActive committed when the clash lands on the last free date', async () => {
      const now = new Date();
      const dates = candidates(now);
      // Only the last date is free, so the resume issues exactly one insert.
      for (const d of dates.slice(0, 3)) await createClassFixture(prisma, classRow(d));

      const { collidedDates, resumed, waitedMs, holderCommitted, holderError } =
        await raceResumeAgainst(dates[3]!);

      expect(holderError).toBeNull();
      expect(holderCommitted).toBe(true);
      // The resume blocked until the holder committed. This is the assertion
      // that says a race happened at all. Since #272 the block is at the CAS,
      // not at the resume's insert — see the helper's docblock — so the
      // clashed date reads back as this rule's own committed row and is
      // classified `already_generated`, which the `collidedDates` filter
      // drops.
      expect(waitedMs).toBeGreaterThanOrEqual(HELD_FOR_MS);
      expect(collidedDates).toEqual([]);
      // The action asserted, then narrowed — not narrowed and silently
      // skipped. `if (resumed.ok && resumed.action === 'active')` guarding the
      // only count assertion means an `unchanged` answer passes this test
      // without ever checking a count.
      expect(resumed.ok).toBe(true);
      expect(resumed.ok && resumed.action).toBe('active');
      // The last free date was the clashed one, so the collision cost the
      // window its only class — a date, not the window (#164).
      if (resumed.ok && resumed.action === 'active') expect(resumed.added).toBe(0);

      const after = await prisma.classTemplate.findUniqueOrThrow({
        where: { id: templateId },
        include: { scheduleRule: true },
      });
      expect(after.scheduleRule.isActive).toBe(true);
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(4);
    });

    it('still fills the other free date when the clash lands on the first', async () => {
      const now = new Date();
      const dates = candidates(now);
      for (const d of dates.slice(0, 2)) await createClassFixture(prisma, classRow(d));

      const { collidedDates, resumed, waitedMs, holderCommitted, holderError } =
        await raceResumeAgainst(dates[2]!);

      expect(holderError).toBeNull();
      expect(holderCommitted).toBe(true);
      expect(waitedMs).toBeGreaterThanOrEqual(HELD_FOR_MS);
      // The clashed date classifies `already_generated` since the CAS wait
      // (#272) moves the occupancy read past the holder's commit — same empty
      // `collidedDates` as its sibling, for the same reason.
      expect(collidedDates).toEqual([]);
      expect(resumed.ok).toBe(true);
      expect(resumed.ok && resumed.action).toBe('active');
      // dates[3] is the one nothing collided with — the resume still filled it
      // after its wait, so the clash cost a date nothing.
      if (resumed.ok && resumed.action === 'active') expect(resumed.added).toBe(1);

      const after = await prisma.classTemplate.findUniqueOrThrow({
        where: { id: templateId },
        include: { scheduleRule: true },
      });
      expect(after.scheduleRule.isActive).toBe(true);
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } }, date: dates[3]! } } })).toBe(1);
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(4);
    });

    /**
     * The bound reaches past the CAS, and this is where that stops being
     * academic. `SET LOCAL lock_timeout` governs every statement left in the
     * transaction — the claim and generation's insert among them — so #164's
     * contract holds only while the colliding writer commits inside 2s. Past
     * that, the resume does not report the date as `raced`; the whole
     * transaction rolls back and the answer is `busy`.
     *
     * Since #272 the statement that gives up is the CAS, not the claim or the
     * insert: the CAS's `UPDATE ScheduleRule` now has to block on the
     * `FOR KEY SHARE` the holder's in-flight insert takes, because Postgres
     * upgrades an UPDATE of a FK-referenced key column to `FOR UPDATE` (the
     * `live` generated column backs
     * `ClassTemplate_scheduleRuleId_kind_ruleLive_fkey`). Same bound, same
     * verdict, one statement earlier than #116's claim — see the inline note
     * below, which carries the measured stack.
     *
     * The two tests above hold for 400ms and cannot see this. Written because
     * nothing in the branch that added the bound acknowledged it reached this
     * far — the four contention tests all stop at the CAS.
     */
    it(
      'answers busy when the clash outlives the lock timeout, instead of reporting it raced',
      async () => {
        const now = new Date();
        const dates = candidates(now);
        for (const d of dates.slice(0, 3)) await createClassFixture(prisma, classRow(d));

        const holder = new PrismaClient();
        let release!: () => void;
        let collided!: () => void;
        const released = new Promise<void>((r) => {
          release = r;
        });
        const parked = new Promise<void>((r) => {
          collided = r;
        });

        const holding = holder.$transaction(
          async (tx) => {
            await createClassFixture(tx, classRow(dates[3]!));
            collided();
            await released;
          },
          { timeout: 20_000 },
        );

        try {
          // Same interleaving as `raceResumeAgainst`: the holder's row is in
          // flight, so it holds `FOR KEY SHARE` on the template row and the
          // resume blocks. The difference is that nothing releases it before
          // the bound fires.
          //
          // The wait is at the CAS — `pauseOrResumeTemplate`'s
          // `updateMany`, whose `FOR UPDATE` (upgrade for the FK-referenced
          // `live` key, #272) now conflicts with the holder's hold — not at
          // the claim or at the resume's own insert. Measured with
          // `pg_stat_activity` on the four-contention block above: the resume
          // sat in `Lock:transactionid` on `UPDATE "ScheduleRule" SET
          // "isActive" = $1 …` for the whole hold. Same 2s bound, same
          // `busy`, one statement earlier than #116's claim. Under #327 the
          // wait sat at the insert instead; without #272 that is where this
          // test's bound would still bite.
          await parked;
          const startedAt = Date.now();
          const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323, waitlist.test.ts:525-555).
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // The rollback took the flag with it: a resume that answers `busy`
          // must not leave the template live with a half-filled window.
          const after = await prisma.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
            include: { scheduleRule: true },
          });
          expect(after.scheduleRule.isActive).toBe(false);
        } finally {
          release();
          await holding.catch(() => {});
          await holder.$disconnect();
        }
      },
      20_000,
    );
  });

  /**
   * The archive transaction is bounded by the same `SET LOCAL`, and the
   * writer it can lose to is not the sweep — it is an ordinary booking.
   * `POST /api/registrations` holds its `Class` row `FOR UPDATE` for the length
   * of its transaction, and it is the HOLD that does the damage here: #104
   * bounded how long that route WAITS for the row (it takes the lock through
   * `lockClassRow` now, not an inline statement), and bounded nothing about
   * how long it keeps it. So "teacher archives a recurring class while a
   * student is booking one of its instances" ends in `busy` at 2s where it
   * used to wait. That trade is deliberate; it was also untested.
   *
   * This used to say the booking was "one of the five deliberately unbounded
   * sites `db-locks.ts` lists". Wrong three ways after #104: that list is gone
   * (the helpers are the convention now), the route's wait is bounded, and the
   * count had already been stale since #237. Only the hold survives, and the
   * hold is the part this test is about.
   *
   * Named for the `deleteMany` originally, back when that was the only
   * statement in this transaction that could contend for a `Class` row it
   * did not already hold. Issue 180 task 4 added an ordered pre-lock ahead of
   * it, over a superset of the `Class` rows the `deleteMany` can match, so
   * the pre-lock is now what blocks in THIS test's scenario — a booking
   * holding one of those rows. This test still measures the same guarantee:
   * the 2s bound reaches an ordinary booking, not just the generation sweep.
   *
   * Not the stronger claim an earlier version of this docblock made. The
   * `deleteMany` is not immune to waiting — it cascades onto `Registration`
   * and `WaitlistEntry` children (`onDelete: Cascade`) that no `Class`
   * pre-lock covers, and its predicate is re-evaluated at execution time, so
   * a row moved into scope after the pre-lock ran is not held either. See the
   * pre-lock's own comment in `class-template-lifecycle.ts`. What changed is
   * which statement blocks HERE, not that the delete can no longer block.
   *
   * The evidence for that was observed during issue 180 task 4 by reading the
   * logged error, and this test does not assert it: it installs no log spy
   * and inspects no error text — its assertions are the returned result, the
   * elapsed time, and three DB read-backs. Stated as provenance, not as
   * something the committed artifact checks.
   */
  describe('archiveOrUnarchiveTemplate — the bound reaches its pre-lock', () => {
    beforeEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    });

    afterEach(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isActive: true, isArchived: false, archivedAt: null, withdrawnCount: 0 },
      });
    });

    it(
      'answers busy when a held class row outlives the lock timeout',
      async () => {
        const generated = await generateInstancesForTemplate(prisma, await freshTemplate(), new Date());
        expect(generated.created).toBeGreaterThan(0);

        // The furthest-out instance, deliberately: the archive's `deleteMany`
        // is scoped `gt: today`, so today's class — which generation keeps
        // while its start is still ahead — is not one of the rows it locks.
        const victim = await prisma.class.findFirstOrThrow({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } }, orderBy: { calendarEntry: { date: 'desc' } }, include: { calendarEntry: true } });

        // Captured rather than assumed null: earlier tests in this file archive
        // this same fixture successfully, and their `afterEach` restores
        // `isArchived` without clearing the stamp. "Nothing changed" is a claim
        // about this transaction, so it is measured against what was there.
        const before = await prisma.classTemplate.findUniqueOrThrow({
          where: { id: templateId },
          include: { scheduleRule: true },
        });

        const holder = new PrismaClient();
        let release!: () => void;
        const released = new Promise<void>((r) => {
          release = r;
        });
        const holding = holder.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${victim.id} FOR UPDATE`;
            await released;
          },
          { timeout: 20_000 },
        );
        await new Promise((r) => setTimeout(r, 100));

        try {
          const startedAt = Date.now();
          const result = await archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323, waitlist.test.ts:525-555).
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // The CAS had already succeeded when the pre-lock blocked (issue
          // 180 task 4 — the `deleteMany` never runs; see this describe's own
          // updated docblock), so this also pins that the rollback took the
          // flag back with it — otherwise the teacher is told nothing changed
          // while the template sits archived.
          const after = await prisma.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
            include: { scheduleRule: true },
          });
          expect(after.scheduleRule.isArchived).toBe(false);
          expect(after.scheduleRule.archivedAt).toEqual(before.scheduleRule.archivedAt);
          expect(after.scheduleRule.withdrawnCount).toBe(before.scheduleRule.withdrawnCount);

          // And the window it was about to withdraw is still there.
          expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(generated.created);
        } finally {
          release();
          await holding.catch(() => {});
          await holder.$disconnect();
        }
      },
      20_000,
    );
  });
});

// ===========================================================================
// Per-template isolation — stubbed db, no real DB
// ===========================================================================

describe('generateClassInstances (per-template isolation)', () => {
  function tmpl(id: string, teacherId: string) {
    return {
      id, scheduleRuleId: `rule-${id}`, teacherRoomId: 'tr', description: null,
      roomCost: 10, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 8,
      cancelDeadline: 120, autoCancelCheck: 120,
      scheduleRule: {
        teacherId, dayOfWeek: 0, startTime: hhmmToTime('09:00'),
        classType: 'Flow', durationMinutes: 60,
        // The claim's own re-check (`claimTemplateForGeneration`'s docblock)
        // reads these off this same fixture — omitting them would make every
        // claim in this test come back ineligible and defeat it.
        isActive: true, isArchived: false,
        teacher: { defaultTimezone: 'UTC' },
      },
    };
  }

  it('a failing template does not abort the others, and the error is rethrown', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z'); // deterministic future window
    const stub = {
      classTemplate: {
        findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1'), tmpl('C', 't1')],
        // The claim re-reads under its own lock (#102) — this stub has no real
        // row to re-read, so it just hands back the same fixture the findMany
        // above already produced, keyed by the id the claim was given.
        findUniqueOrThrow: async ({ where: { id } }: { where: { id: string } }) => tmpl(id, 't1'),
      },
      // #327: occupancy is ONE read over `CalendarEntry` for both families
      // (the separate `studioClass` read this replaced is gone). Empty,
      // because this test is about error isolation between templates and not
      // about occupancy — but it has to EXIST, or every template fails on
      // `Cannot read properties of undefined (reading 'findMany')` and the
      // test passes its `rejects.toThrow` for a reason unrelated to what it
      // pins.
      //
      // The ENTRY is also what the generator creates now, keyed by
      // `scheduleRuleId` rather than by a template id — so this is where the
      // per-template failure is staged.
      calendarEntry: {
        findMany: async () => [],
        createManyAndReturn: async ({
          data,
        }: {
          data: Array<{ scheduleRuleId: string; date: Date }>;
        }) => {
          for (const row of data) {
            if (row.scheduleRuleId === 'rule-A') throw new Error('boom-A');
            if (row.scheduleRuleId === 'rule-C') throw new Error('boom-C');
            created.push(row.scheduleRuleId.replace('rule-', ''));
          }
          return data.map((row) => ({ id: `entry-${row.scheduleRuleId}`, date: row.date }));
        },
      },
      class: {
        createMany: async () => ({ count: 0 }),
      },
      // The sweep now claims each template inside its own transaction before
      // generating. This stub has no real lock semantics to exercise (the DB
      // tests above cover that) — it only needs the claim to always succeed
      // so error isolation between templates is still what's under test.
      $executeRawUnsafe: async () => 0,
      $queryRaw: async () => [{ id: 'stub' }],
      $transaction: async (fn: (tx: unknown) => Promise<number>) => fn(stub),
    } as unknown as import('@prisma/client').PrismaClient;

    const spy = vi.spyOn(log, 'error').mockImplementation(() => log);

    await expect(generateClassInstances(stub, from)).rejects.toThrow('boom-A');
    expect(created).toContain('B'); // B generated despite A failing before and C failing after

    // Both failing templates are logged, not just the one that's rethrown.
    const loggedTemplateIds = spy.mock.calls.map((c) => (c[0] as { templateId?: string }).templateId);
    expect(loggedTemplateIds).toContain('A');
    expect(loggedTemplateIds).toContain('C');
    spy.mockRestore();
  });

  it('does not rethrow when a template fails with a 55P03 lock timeout, but logs at warn and generates others', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z');
    const lockTimeoutError = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "55P03", message: "canceling statement due to lock timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
      { clientVersion: 'test' },
    );
    const stub = {
      classTemplate: {
        findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1')],
        findUniqueOrThrow: async ({ where: { id } }: { where: { id: string } }) => tmpl(id, 't1'),
      },
      calendarEntry: {
        findMany: async () => [],
        createManyAndReturn: async ({
          data,
        }: {
          data: Array<{ scheduleRuleId: string; date: Date }>;
        }) => {
          for (const row of data) {
            if (row.scheduleRuleId === 'rule-A') throw lockTimeoutError;
            created.push(row.scheduleRuleId.replace('rule-', ''));
          }
          return data.map((row) => ({ id: `entry-${row.scheduleRuleId}`, date: row.date }));
        },
      },
      class: {
        createMany: async () => ({ count: 0 }),
      },
      $executeRawUnsafe: async () => 0,
      $queryRaw: async () => [{ id: 'stub' }],
      $transaction: async (fn: (tx: unknown) => Promise<number>) => fn(stub),
    } as unknown as import('@prisma/client').PrismaClient;

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);

    const count = await generateClassInstances(stub, from);

    expect(count).toBe(4);
    expect(created).toContain('B');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'A', teacherId: 't1' }),
      'recurring class generation skipped template due to lock contention',
    );
    expect(errorSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

