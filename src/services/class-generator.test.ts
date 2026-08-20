import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { classStartInstant, startOfLocalDay, mondayOf } from '@/lib/timezone';
import {
  getNextOccurrences,
  firstFreeWeek,
  generateClassInstances,
  generateInstancesForTemplate,
  claimTemplateForGeneration,
} from './class-generator';
import {
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
  updateClassTemplate,
} from './class-template-lifecycle';

type TransactionOptions = NonNullable<Parameters<PrismaClient['$transaction']>[1]>;

// ===========================================================================
// Pure logic tests — getNextOccurrences
// ===========================================================================

describe('getNextOccurrences', () => {
  it('returns 4 dates for dayOfWeek=1 (Tuesday) starting from Monday 2026-04-06', () => {
    // Monday 2026-04-06, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-06T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });

  it('includes today if today matches the day (Tuesday 2026-04-07, dayOfWeek=1)', () => {
    // Tuesday 2026-04-07, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-07T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });
});

describe('firstFreeWeek', () => {
  const d = (iso: string) => new Date(iso);
  // Four consecutive Thursdays.
  const thursdays = [
    d('2026-09-24T00:00:00.000Z'),
    d('2026-10-01T00:00:00.000Z'),
    d('2026-10-08T00:00:00.000Z'),
    d('2026-10-15T00:00:00.000Z'),
  ];

  it('returns the first candidate when nothing is held', () => {
    expect(firstFreeWeek(thursdays, new Set())?.toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('skips candidates whose week is held and returns the first free one', () => {
    // Hold the weeks of the first two Thursdays, via the MONDAY of each —
    // which is what a Tuesday class from the same template would produce.
    const held = new Set([
      mondayOf(d('2026-09-22T00:00:00.000Z')), // Tue, week of Sep 21
      mondayOf(d('2026-09-29T00:00:00.000Z')), // Tue, week of Sep 28
    ]);
    expect(firstFreeWeek(thursdays, held)?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('returns null when every candidate week is held', () => {
    const held = new Set(thursdays.map((t) => mondayOf(t)));
    expect(firstFreeWeek(thursdays, held)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(firstFreeWeek([], new Set())).toBeNull();
  });
});

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
  /** IDs of other active templates deactivated during setup, restored in teardown. */
  let deactivatedTemplateIds: string[] = [];

  beforeAll(async () => {
    // Deactivate any pre-existing active templates so they don't interfere
    const existingActive = await prisma.classTemplate.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    deactivatedTemplateIds = existingActive.map((t) => t.id);
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: false },
      });
    }

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
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        description: 'Tuesday morning flow',
        dayOfWeek: 1, // Tuesday in schema convention
        startTime: '09:00',
        durationMinutes: 75,
        roomCost: 40,
        minRate: 15,
        targetRate: 30,
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        isActive: true,
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    // Clean up in dependency order
    await prisma.class.deleteMany({ where: { templateId } });
    await prisma.classTemplate.delete({ where: { id: templateId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });

    // Restore previously active templates
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: true },
      });
    }

    await prisma.$disconnect();
  });

  it('generates 4 class instances from a template', async () => {
    // Use Monday 2026-04-06 as the starting date
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);

    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });

    expect(classes).toHaveLength(4);

    for (const cls of classes) {
      expect(cls.classType).toBe('Vinyasa');
      expect(cls.status).toBe('open');
      expect(Number(cls.roomCost)).toBe(40);
      expect(Number(cls.minRate)).toBe(15);
      expect(Number(cls.targetRate)).toBe(30);
      expect(cls.minStudents).toBe(4);
      expect(cls.maxStudents).toBe(12);
      expect(cls.teacherId).toBe(teacherId);
      expect(cls.teacherRoomId).toBe(teacherRoomId);
      expect(cls.templateId).toBe(templateId);
      expect(cls.description).toBe('Tuesday morning flow');
      expect(cls.startTime).toBe('09:00');
      expect(cls.durationMinutes).toBe(75);
      expect(cls.cancelDeadline).toBe('HOURS_24');
      expect(cls.autoCancelCheck).toBe('HOURS_2');
    }
  });

  it('is idempotent — running again creates no duplicates', async () => {
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({
      where: { templateId },
    });
    expect(classes).toHaveLength(4);
  });

  it('skips inactive templates', async () => {
    // Deactivate template and delete existing classes
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });
    await prisma.class.deleteMany({ where: { templateId } });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({
      where: { templateId },
    });
    expect(classes).toHaveLength(0);

    // Re-activate for potential further tests
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true },
    });
  });

  it('skips archived templates even when isActive is stale-true', async () => {
    // Defense in depth: the routes keep archived templates inactive, but
    // a slipped invariant must not let the sweep materialize classes for
    // something the teacher shelved.
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: true },
    });
    await prisma.class.deleteMany({ where: { templateId } });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);
    expect(await prisma.class.count({ where: { templateId } })).toBe(0);

    // Restore for the tests that follow
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  it("skips today's occurrence when its start has already passed", async () => {
    // Tuesday 2026-04-07 at 18:00 UTC — hours after the template's 09:00
    // Amsterdam start. The run must not create a class earlier the same
    // day; the window slides to the next four Tuesdays instead.
    await prisma.class.deleteMany({ where: { templateId } });
    const from = new Date('2026-04-07T18:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    expect(classes.map((c) => c.date.toISOString())).toEqual([
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      '2026-05-05T00:00:00.000Z',
    ]);
  });

  it("includes today's occurrence while its start is still ahead", async () => {
    // Tuesday 2026-04-07 at 05:00 UTC — before the 09:00 Amsterdam start.
    await prisma.class.deleteMany({ where: { templateId } });
    const from = new Date('2026-04-07T05:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    expect(classes.map((c) => c.date.toISOString())).toEqual([
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
    // now commit real edits through `updateClassTemplate` — the budget pin
    // writes `description`, the `busy` test writes `classType` — and both
    // propagate onto this template's future instances via
    // `syncTemplateInstances`. Restoring only the three fields the older
    // tests touched left the fixture mutated for anything added after them;
    // today nothing reads those two columns later in file order, which makes
    // it latent rather than broken, and latent is exactly how this `afterEach`
    // earns its keep.
    let originalClassType: string;
    let originalDescription: string | null;

    beforeAll(async () => {
      const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      originalStartTime = t.startTime;
      originalClassType = t.classType;
      originalDescription = t.description;
    });

    afterEach(async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: {
          isActive: true,
          isArchived: false,
          startTime: originalStartTime,
          classType: originalClassType,
          description: originalDescription,
        },
      });
    });

    it('claims a live template', async () => {
      expect(await claim(templateId)).not.toBeNull();
    });

    it('refuses an archived template', async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isArchived: true },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a paused template', async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isActive: false },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a template that no longer exists', async () => {
      expect(await claim('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('returns values committed after the caller read the row', async () => {
      const before = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { startTime: '21:15' },
      });

      const claimed = await prisma.$transaction((tx) => claimTemplateForGeneration(tx, templateId));

      expect(before.startTime).not.toBe('21:15');
      expect(claimed?.startTime).toBe('21:15');
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
          // unrelated reason; the upper bound proves it answered well inside
          // the 10s budget. Neither is a tight pin on the bound's VALUE —
          // widening `LOCK_TIMEOUT_SQL` to '3s' or '4s' still passes both.
          // `db-locks.test.ts` pins the literal exactly; this pins that the
          // literal is what governs the wait.
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

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
        await prisma.classTemplate.update({
          where: { id: templateId },
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
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

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
          await prisma.classTemplate.update({
            where: { id: templateId },
            data: { isActive: true },
          });
        }
      },
      20_000,
    );

    /**
     * `updateClassTemplate`'s own budget (`class-template-lifecycle.ts`),
     * pinned the same way the two transactions above pin theirs. Derived, not
     * arbitrary — spec §2.4: five statements in that transaction can each
     * wait on the lock timeout at 2s. `setLockTimeout` itself is not one of
     * them — it issues `SET LOCAL lock_timeout`, which can never wait on a
     * lock. The five that can: `classTemplate.update` (the template write —
     * an unconditional update by primary key, NOT a CAS; this file uses that
     * term for the archive's and pause/resume's conditional writes, and spec
     * §2.4 calls this row plainly `classTemplate.update`), the ordered
     * `FOR UPDATE OF c` pre-lock, `class.deleteMany` (the wrong-day delete —
     * it cascades onto `WaitlistEntry` children the pre-lock does not cover,
     * so the delete itself can still wait on one), `class.updateMany`
     * (the same-day propagation, a real index-entry wait on
     * `Class_teacher_slot_unique`), and the refill's `createManyAndReturn`
     * (also a real index-entry wait, same index). Conservative, since
     * `wrongDay` and `sameDay` are near-mutually-exclusive in practice — an
     * earlier version of this comment named `setLockTimeout` as one of the
     * five and omitted the refill; the total of five was right by
     * coincidence, not by this derivation. (That retraction previously also
     * disowned "`syncTemplateInstances`'s own pre-lock", which was never the
     * error: the ordered `FOR UPDATE OF c` above IS that pre-lock —
     * `updateClassTemplate` has no other — and spec §2.4 lists it as row 2.)
     *
     * `description`, not `classType` like the busy test below: this call is
     * expected to actually commit, and a distinct field keeps the two tests'
     * writes from reading as the same edit if one of their assertions ever
     * needs the other's payload for comparison.
     */
    it('opens the template-edit transaction with { timeout: 15_000 }', async () => {
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
      expect(recordedOptions).toEqual({ timeout: 15_000 });
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
     * issues `SET LOCAL lock_timeout`, as this file's own 15s derivation says
     * a few lines above.
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

          // Same bounds and same reasoning as the archive's test above: the
          // lower bound proves it really waited, the upper that it answered
          // well inside the 15s budget. Neither pins the bound's VALUE —
          // `db-locks.test.ts` does that.
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

          // A RETURNED failure never reaches `withErrorHandler`, and
          // `respondError` does not log — so without this line the race is
          // silent.
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId }),
            'recurring class edit lost a lock race (template row or one of its instances) — nothing committed',
          );
        } finally {
          // In a `finally`, matching the archive/pause busy tests above: a
          // failure in the assertions must not leave the claim holding the
          // row for its full 15s.
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
      await prisma.class.deleteMany({ where: { templateId } });
      await prisma.classTemplate.update({
        where: { id: templateId },
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
      await prisma.class.deleteMany({ where: { templateId } });
      expect(await prisma.class.count({ where: { templateId } })).toBe(0);

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // 1. Archive, but do not commit. Holds the row lock; invisible to others.
      const archiving = prisma.$transaction(
        async (tx) => {
          await tx.classTemplate.update({
            where: { id: templateId },
            data: { isArchived: true, isActive: false },
          });
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      // 2. Sweep. Its findMany reads the pre-archive row and includes the
      //    template; its claim then blocks on the lock.
      let sweepSettled = false;
      const sweeping = generateClassInstances(prisma).then((n) => {
        sweepSettled = true;
        return n;
      });

      await new Promise((r) => setTimeout(r, 300));
      // Without FOR UPDATE the sweep sails past the claim and has already
      // created the window by now.
      expect(sweepSettled).toBe(false);

      // 3. Commit the archive; the claim unblocks and sees isArchived: true.
      commit();
      await archiving;
      await sweeping;

      // 4. Nothing was materialised for a template the teacher shelved.
      expect(await prisma.class.count({ where: { templateId } })).toBe(0);
    });
  });

  describe('generateClassInstances — edit mid-sweep', () => {
    // Captured, not hardcoded: other tests in this file assert the fixture's own
    // startTime, so restoring a guessed value would corrupt them.
    let original: { dayOfWeek: number; startTime: string };

    beforeAll(async () => {
      const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      original = { dayOfWeek: t.dayOfWeek, startTime: t.startTime };
    });

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { templateId } });
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { ...original, isActive: true, isArchived: false },
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
      await prisma.class.deleteMany({ where: { templateId } });

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // 1. Edit, uncommitted. Holds the row lock; invisible to the sweep.
      const editing = prisma.$transaction(
        async (tx) => {
          await tx.classTemplate.update({
            where: { id: templateId },
            data: { dayOfWeek: 5, startTime: '18:45' },
          });
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      // 2. Sweep. Its findMany reads the pre-edit row; its claim then blocks.
      let sweepSettled = false;
      const sweeping = generateClassInstances(prisma).then((n) => {
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
      const created = await prisma.class.findMany({
        where: { templateId },
        select: { date: true, startTime: true },
      });
      expect(created.length).toBeGreaterThan(0);
      for (const c of created) {
        expect(c.startTime).toBe('18:45');
        // dayOfWeek 5 in this schema's convention (0=Mon) is Saturday,
        // which is getUTCDay() === 6.
        expect(c.date.getUTCDay()).toBe(6);
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
          teacherId,
          teacherRoomId,
          classType: 'Vinyasa',
          description: 'Claim-first interleaving fixture',
          dayOfWeek,
          // Comfortably after `today` (UTC midnight) once interpreted in
          // Amsterdam time, at any DST offset — guarantees today's occurrence
          // clears generateInstancesForTemplate's "start still ahead" filter
          // regardless of what time of day this test happens to run.
          startTime: '23:59',
          durationMinutes: 60,
          roomCost: 10,
          minRate: 10,
          targetRate: 20,
          minStudents: 1,
          maxStudents: 8,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          isActive: true,
        },
        include: { teacher: { select: { defaultTimezone: true } } },
      });

      try {
        // 1. Claim, generate, and commit — the "claim first" arm.
        const created = await prisma.$transaction(async (tx) => {
          expect(await claimTemplateForGeneration(tx, template.id)).not.toBeNull();
          return (await generateInstancesForTemplate(tx, template, today)).created;
        });
        expect(created).toBe(4);

        const beforeArchive = await prisma.class.findMany({
          where: { templateId: template.id },
          orderBy: { date: 'asc' },
        });
        expect(beforeArchive).toHaveLength(4);
        expect(beforeArchive[0]!.date.toISOString()).toBe(today.toISOString());

        // 2. Archive, straight after the commit — no concurrency involved.
        const result = await archiveOrUnarchiveTemplate(prisma, template.id, teacherId, 'archived');
        if (!result.ok) throw new Error('archive should have succeeded');
        if (result.action !== 'archived') throw new Error('expected an archive, not an unarchive');

        // 3. Exactly the outcome the corrected docstring describes: today's
        //    class survives, the three later-week ones do not.
        expect(result.deleted).toBe(3);
        expect(result.remaining).toBe(1);

        const afterArchive = await prisma.class.findMany({ where: { templateId: template.id } });
        expect(afterArchive).toHaveLength(1);
        expect(afterArchive[0]!.date.toISOString()).toBe(today.toISOString());
        expect(afterArchive[0]!.status).toBe('open'); // still publicly bookable
      } finally {
        await prisma.class.deleteMany({ where: { templateId: template.id } });
        await prisma.classTemplate.delete({ where: { id: template.id } });
      }
    });
  });

  describe('generateInstancesForTemplate — slot reporting', () => {
    /** The same four dates the generator will choose, computed the same way. */
    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant(d, '09:00', 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
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
      await prisma.class.updateMany({
        where: { templateId, date: blocked },
        data: { status: 'cancelled' },
      });

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
      await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          templateId: null,
          classType: 'Manual',
          date: taken,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
        },
      });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: taken, reason: 'slot_taken' }]);
      expect(await prisma.class.count({ where: { templateId } })).toBe(3);
    });

    /**
     * The occupancy read is scoped `where: { teacherId }`, and dropping that
     * scope passed the entire suite — this file's fixture has one teacher, so
     * nothing here could have failed. It is §4.1's asymmetry in the direction
     * the spec calls the only real defect: a pre-check *stricter* than the
     * index silently under-fills a window and nothing raises.
     *
     * #196's slot key is `(teacherId, date, startTime)`, so another teacher's
     * class can never block this one. Unscoped, every candidate date here reads
     * `slot_taken`, this teacher's window comes back empty, and the log line
     * names the wrong teacher's schedule.
     */
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
          await prisma.class.create({
            data: {
              teacherId: other.id,
              teacherRoomId: otherRoom.id,
              templateId: null,
              classType: 'Someone else',
              date,
              startTime: '09:00',
              durationMinutes: 60,
              roomCost: 40,
              minRate: 15,
              targetRate: 30,
              minStudents: 4,
              maxStudents: 12,
              cancelDeadline: 'HOURS_24',
              autoCancelCheck: 'HOURS_2',
              status: 'open',
            },
          });
        }

        const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

        expect(result.created).toBe(4);
        expect(result.skipped).toEqual([]);
      } finally {
        await prisma.class.deleteMany({ where: { teacherId: other.id } });
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
      await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          templateId: null,
          classType: 'Manual',
          date: free,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'cancelled',
        },
      });

      // #196's index carries `WHERE "status" <> 'cancelled'`, so a cancelled
      // neighbour does not occupy the slot and must not block generation.
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

        await prisma.class.updateMany({
          where: { templateId, date: candidates(now)[1]! },
          data: { status: 'cancelled' },
        });
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

    it('names a date lost to a concurrent insert as raced, not as filled', async () => {
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
          await tx.class.create({
            data: {
              teacherId,
              teacherRoomId,
              // `null`, deliberately, not this template's own id: with the
              // template's `templateId` the holder also collides on the
              // pre-existing `@@unique([templateId, date])`, so this test
              // would pass byte-identically with `Class_teacher_slot_unique`
              // dropped. `null` isolates the collision to the slot key —
              // and is the production shape too: a standalone class racing
              // the nightly `api/cron/generate-classes` sweep onto a
              // template's slot.
              templateId: null,
              classType: 'Vinyasa',
              date: collide,
              startTime: '09:00',
              durationMinutes: 60,
              roomCost: 40,
              minRate: 15,
              targetRate: 30,
              minStudents: 4,
              maxStudents: 12,
              cancelDeadline: 'HOURS_24',
              autoCancelCheck: 'HOURS_2',
              status: 'open',
            },
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
      expect(result.skipped).toEqual([{ date: collide, reason: 'raced' }]);
    });
  });

  /** The template with the `teacher.defaultTimezone` join the generator requires. */
  async function freshTemplate() {
    return prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
  }

  describe('pauseOrResumeTemplate — a clash during generation (#164)', () => {
    beforeEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: false } });
    });

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: true } });
    });

    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant(d, '09:00', 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    const classRow = (date: Date) => ({
      teacherId,
      teacherRoomId,
      templateId,
      classType: 'Vinyasa',
      date,
      startTime: '09:00',
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
     * What the claim changed. The holder inserts its colliding row and holds
     * it UNCOMMITTED, which takes `FOR KEY SHARE` on the template row for the
     * FK check and leaves a pending unique-index entry on `(templateId,
     * date)`. Before #116 the resume walked straight past that lock — its
     * write was a plain `update({ where: { id } })`, which takes `FOR NO KEY
     * UPDATE` and does not conflict with `FOR KEY SHARE`; there was no CAS
     * here to credit, the CAS arrived on the same branch as the claim — and it
     * only met the holder at its own insert, parking on the pending
     * entry and finally taking an `ON CONFLICT DO NOTHING` skip classified
     * `raced`. That is what `racedDates` was written to capture.
     *
     * With the claim, the resume never gets that far.
     * `claimTemplateForGeneration` takes `FOR UPDATE`, which DOES conflict
     * with the holder's `FOR KEY SHARE`, so the resume blocks there and stays
     * blocked until the holder commits. By the time it generates, the
     * colliding row is committed and visible: the date reads as
     * `already_generated`, not `raced`. The claim converts a lost race into a
     * wait.
     *
     * Note the direction, because an earlier version of this docblock had it
     * backwards: the holder is never blocked. It inserts first and holds; the
     * RESUME is the party that waits. Measured — the wait appears at
     * `claimTemplateForGeneration` (`class-generator.ts`), and pushing the
     * hold past the 2s `setLockTimeout` bound turns it into `busy`, which is
     * what the third test in this block pins.
     *
     * That the wait is at the CLAIM is measured, not asserted. `waitedMs`
     * below proves only that the resume stayed blocked until the holder
     * committed — remove the claim and it still clears the floor, because the
     * resume then waits at its own insert instead. `racedDates` is what
     * separates those two worlds. Read the pair together: the wait says a race
     * happened at all, the empty `racedDates` says the claim is what absorbed
     * it.
     *
     * `waitedMs` is returned because it is the only evidence the two
     * transactions actually overlapped. An empty `racedDates` is equally true
     * of a world where the holder committed before the resume ever started —
     * measured, with the collision pre-committed both callers below passed
     * unchanged — so the callers assert the wait as well.
     */
    async function raceResumeAgainst(collide: Date): Promise<{
      racedDates: string[];
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
          await tx.class.create({ data: classRow(collide) });
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

        const racedDates = warn.mock.calls.flatMap((call) => {
          const payload = call[0] as { skipped?: Array<{ date: string; reason: string }> };
          return (payload.skipped ?? [])
            .filter((s) => s.reason === 'raced')
            .map((s) => s.date);
        });
        return { racedDates, resumed, waitedMs, holderCommitted, holderError };
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
      for (const d of dates.slice(0, 3)) await prisma.class.create({ data: classRow(d) });

      const { racedDates, resumed, waitedMs, holderCommitted, holderError } =
        await raceResumeAgainst(dates[3]!);

      expect(holderError).toBeNull();
      expect(holderCommitted).toBe(true);
      // The resume blocked at the claim until the holder committed. This is
      // the assertion that says a race happened at all.
      expect(waitedMs).toBeGreaterThanOrEqual(HELD_FOR_MS);
      // And having waited, it found the date committed rather than losing it:
      // `already_generated`, which `logSkippedSlots` deliberately never logs.
      expect(racedDates).toEqual([]);
      // The action asserted, then narrowed — not narrowed and silently
      // skipped. `if (resumed.ok && resumed.action === 'active')` guarding the
      // only count assertion means an `unchanged` answer passes this test
      // without ever checking a count.
      expect(resumed.ok).toBe(true);
      expect(resumed.ok && resumed.action).toBe('active');
      if (resumed.ok && resumed.action === 'active') expect(resumed.added).toBe(0);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });

    it('still fills the other free date when the clash lands on the first', async () => {
      const now = new Date();
      const dates = candidates(now);
      for (const d of dates.slice(0, 2)) await prisma.class.create({ data: classRow(d) });

      const { racedDates, resumed, waitedMs, holderCommitted, holderError } =
        await raceResumeAgainst(dates[2]!);

      expect(holderError).toBeNull();
      expect(holderCommitted).toBe(true);
      expect(waitedMs).toBeGreaterThanOrEqual(HELD_FOR_MS);
      expect(racedDates).toEqual([]);
      expect(resumed.ok).toBe(true);
      expect(resumed.ok && resumed.action).toBe('active');
      // dates[3] is the one nothing collided with — the resume still filled it
      // after its wait, so the claim cost a date nothing.
      if (resumed.ok && resumed.action === 'active') expect(resumed.added).toBe(1);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      expect(await prisma.class.count({ where: { templateId, date: dates[3]! } })).toBe(1);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });

    /**
     * The bound reaches past the CAS, and this is where that stops being
     * academic. `SET LOCAL lock_timeout` governs every statement left in the
     * transaction — the claim and generation's insert among them — so #164's
     * contract holds only while the colliding writer commits inside 2s. Past
     * that, the resume does not report the date as `raced`; the whole
     * transaction rolls back and the answer is `busy`.
     *
     * Since #116 the statement that gives up is the CLAIM, not the insert:
     * `claimTemplateForGeneration`'s `FOR UPDATE` conflicts with the
     * `FOR KEY SHARE` the holder's in-flight insert took for its FK check, so
     * the resume never reaches its own insert to park on the pending unique
     * entry. Same bound, same verdict, one statement earlier — see the inline
     * note below, which carries the measured stack.
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
        for (const d of dates.slice(0, 3)) await prisma.class.create({ data: classRow(d) });

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
            await tx.class.create({ data: classRow(dates[3]!) });
            collided();
            await released;
          },
          { timeout: 20_000 },
        );

        try {
          // Same interleaving as `raceResumeAgainst`: the holder's row is in
          // flight, so it holds `FOR KEY SHARE` on the template row and the
          // resume blocks asking for the claim's `FOR UPDATE`. The difference
          // is that nothing releases it before the bound fires.
          //
          // The wait is at `claimTemplateForGeneration`, not at the resume's
          // own insert — measured, and worth naming because it moved: before
          // #116 the resume reached its insert and parked on the holder's
          // pending unique-index entry instead. Same 2s bound, same `busy`,
          // one statement earlier.
          await parked;
          const startedAt = Date.now();
          const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

          // The rollback took the flag with it: a resume that answers `busy`
          // must not leave the template live with a half-filled window.
          const after = await prisma.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
          });
          expect(after.isActive).toBe(false);
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
      await prisma.class.deleteMany({ where: { teacherId } });
    });

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.update({
        where: { id: templateId },
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
        const victim = await prisma.class.findFirstOrThrow({
          where: { templateId },
          orderBy: { date: 'desc' },
        });

        // Captured rather than assumed null: earlier tests in this file archive
        // this same fixture successfully, and their `afterEach` restores
        // `isArchived` without clearing the stamp. "Nothing changed" is a claim
        // about this transaction, so it is measured against what was there.
        const before = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });

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
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

          // The CAS had already succeeded when the pre-lock blocked (issue
          // 180 task 4 — the `deleteMany` never runs; see this describe's own
          // updated docblock), so this also pins that the rollback took the
          // flag back with it — otherwise the teacher is told nothing changed
          // while the template sits archived.
          const after = await prisma.classTemplate.findUniqueOrThrow({
            where: { id: templateId },
          });
          expect(after.isArchived).toBe(false);
          expect(after.archivedAt).toEqual(before.archivedAt);
          expect(after.withdrawnCount).toBe(before.withdrawnCount);

          // And the window it was about to withdraw is still there.
          expect(await prisma.class.count({ where: { templateId } })).toBe(generated.created);
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
      id, teacherId, teacherRoomId: 'tr', dayOfWeek: 0, startTime: '09:00',
      classType: 'Flow', description: null, durationMinutes: 60,
      roomCost: 10, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 8,
      cancelDeadline: 120, autoCancelCheck: 120,
      teacher: { defaultTimezone: 'UTC' },
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
      class: {
        // The generator reads the whole window in one query; an empty result
        // means every candidate date is free to create.
        findMany: async () => [],
        createManyAndReturn: async ({
          data,
        }: {
          data: Array<{ templateId: string; date: Date }>;
        }) => {
          for (const row of data) {
            if (row.templateId === 'A') throw new Error('boom-A');
            if (row.templateId === 'C') throw new Error('boom-C');
            created.push(row.templateId);
          }
          return data.map((row) => ({ date: row.date }));
        },
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
});
