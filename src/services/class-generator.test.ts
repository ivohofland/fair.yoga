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
      // Copied from the room's own state (issue 339), not the Prisma
      // default — this fixture's room is never archived, so the copy and
      // the default agree here; `roomArchived on generated classes (#339)`
      // below is what actually distinguishes the two.
      expect(cls.roomArchived).toBe(false);
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

    // Captured, not hardcoded: other tests in this file assert the fixture's
    // own startTime, so a guessed restore value would corrupt them.
    let originalStartTime: string;
    // Captured alongside `startTime` because the budget pin below commits a
    // real edit through `updateClassTemplate`, writing `description`. Nothing
    // later in file order reads that column off this fixture, so an
    // unrestored edit is latent rather than broken — and latent is exactly
    // how this `afterEach` earns its keep. (The edits used to reach the
    // template's future instances too, via `syncTemplateInstances`. #194
    // deleted that, so the restore is now genuinely only about these
    // columns.)
    let originalDescription: string | null;

    beforeAll(async () => {
      const t = await prisma.classTemplate.findUniqueOrThrow({
        where: { id: templateId },
        include: { scheduleRule: true },
      });
      originalStartTime = timeToHHmm(t.scheduleRule.startTime);
      originalDescription = t.description;
    });

    afterEach(async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: {
          isActive: true,
          isArchived: false,
          startTime: hhmmToTime(originalStartTime),
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
     * The class family's `{ timeout: 10_000 }` pin, and it exists because this
     * branch removed the only other one. The 5.5s test that is now `answers
     * busy when the generation claim holds the row past the lock timeout`
     * (`class-generator-lock-order.test.ts`) used to prove the budget end to
     * end by outlasting Prisma's 5s default; under a 2s
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
     * `updateClassTemplate`'s own budget (`class-template-lifecycle.ts`),
     * pinned the same way the two transactions above pin theirs. Derived, not
     * arbitrary, and re-derived here rather than scaled: ONE statement in that
     * transaction can wait on the lock timeout at 2s — `classTemplate.update`,
     * the template write (an unconditional update by primary key, not the
     * conditional write the archive and the pause/resume each make).
     * `setLockTimeout` is not a second — it issues `SET
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
     * `description`, not the `classType` written by `answers busy when the
     * generation claim holds the row past the lock timeout (template edit)`
     * (`class-generator-lock-order.test.ts`): this call is expected to
     * actually commit, and a distinct field keeps the two writes from reading
     * as the same edit if either one's assertions ever need the other's
     * payload for comparison.
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
  });

  describe('claim-first interleaving — archive right after a committed generation', () => {
    /**
     * The interleaving `claimTemplateForGeneration`'s docstring describes as
     * "claim first": the sweep claims the row, generates, and commits before
     * an archive ever runs. This is ordering, not timing — the claim
     * transaction is fully committed before the archive starts, so no lock
     * hold or sleep is needed to reproduce it, unlike the staged races in
     * `class-generator-lock-order.test.ts`.
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
      // One statement sweeps both families: since #327 a `StudioClass` hangs
      // off a `CalendarEntry` exactly as a `Class` does, and this describe's
      // cross-family cases (#296) create rows the generator now READS — so a
      // leftover studio entry occupies the next test's slot the way a leftover
      // class one does. Unswept, their leftovers turn the cases after them in
      // this block red.
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

  describe('roomArchived on generated classes (#339)', () => {
    /**
     * The safe half of the pairing (issue 339): a PAUSED template's `ruleLive`
     * is `false`, so `ACTIVE_TEMPLATE_WHERE` never selects it regardless of
     * what its room does. Archiving that room is legal precisely because no
     * live template sits on it (`ClassTemplate_live_needs_open_room`), and
     * this pins that the sweep still runs clean afterward rather than, say,
     * throwing on a template it was never going to touch.
     *
     * A dedicated teacher, room and rule rather than the file's shared
     * fixture: the point is a room genuinely archived with nothing but a
     * paused template on it, and the shared `teacherRoomId` is never
     * archived anywhere else in this file.
     */
    it('archiving a room holding a PAUSED template does not disturb the sweep', async () => {
      const other = await prisma.teacher.create({
        data: {
          firstName: 'PausedRoom',
          lastName: 'Teacher',
          email: `paused-room-${uniqueSuffix}@test.local`,
          account: { create: { email: `paused-room-${uniqueSuffix}@test.local` } },
          bio: 'archived-room paused-template fixture (#339)',
          pageSlug: `paused-room-${uniqueSuffix}`,
        },
      });
      try {
        const room = await prisma.room.create({
          data: {
            venueName: 'Paused Studio',
            address: `${uniqueSuffix} Paused St`,
            city: 'Amsterdam',
            postcode: '1234PR',
            floor: '1',
            roomName: 'Paused',
            maxCapacity: 10,
            createdById: other.id,
          },
        });
        const teacherRoom = await prisma.teacherRoom.create({
          data: { teacherId: other.id, roomId: room.id, capacityOverride: 5, rentalRate: 10 },
        });
        const rule = await prisma.scheduleRule.create({
          data: {
            teacherId: other.id, kind: 'regular', classType: 'Paused',
            dayOfWeek: 1, startTime: hhmmToTime('06:00'), durationMinutes: 30, isActive: false,
          },
        });
        const template = await prisma.classTemplate.create({
          data: {
            scheduleRuleId: rule.id, kind: 'regular', teacherRoomId: teacherRoom.id,
            ruleLive: false, roomCost: 5, minRate: 5, targetRate: 10, minStudents: 1, maxStudents: 5,
            cancelDeadline: 'HOURS_24', autoCancelCheck: 'HOURS_2',
          },
        });

        // Legal: only a paused template sits on this room.
        const archived = await prisma.teacherRoom.update({
          where: { id: teacherRoom.id },
          data: { isArchived: true },
        });
        expect(archived.isArchived).toBe(true);

        const count = await generateClassInstances(prisma, new Date('2026-04-06T00:00:00.000Z'), other.id);
        expect(count).toBe(0);
        expect(
          await prisma.class.count({
            where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } },
          }),
        ).toBe(0);
      } finally {
        await prisma.calendarEntry.deleteMany({ where: { teacherId: other.id } });
        await prisma.scheduleRule.deleteMany({ where: { teacherId: other.id } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId: other.id } });
        await prisma.room.deleteMany({ where: { createdById: other.id } });
        await prisma.teacher.delete({ where: { id: other.id } });
        await prisma.account.deleteMany({ where: { email: `paused-room-${uniqueSuffix}@test.local` } });
      }
    });

    /**
     * The case the mutation actually reddens. `template.roomArchived` is
     * `false` for every template `ACTIVE_TEMPLATE_WHERE` can ever select —
     * `ClassTemplate_live_needs_open_room` forbids a live template from
     * carrying `roomArchived: true`, so no real row can ever hand
     * `createChildren` anything but `false`, and a test built on a real live
     * template cannot tell "copied" apart from "hardcoded false".
     *
     * So this inspects the value `createChildren` passes to `class.createMany`
     * directly, on a fabricated template object whose `roomArchived: true` is
     * a lie no real row can tell — the same technique the empty-window guard
     * test above uses for an unreadable `startTime`: the argument is the
     * whole reachable surface, and no write path can produce this exact row,
     * so the DB is bypassed rather than asked to hold an impossible one.
     * `Class.createMany` is intercepted rather than left to run for real,
     * because a genuinely archived room paired with the `status: 'open'`
     * `createChildren` always writes would trip `Class_live_needs_open_room`
     * regardless of which value this test is trying to tell apart.
     *
     * Mutating `roomArchived: template.roomArchived` to `roomArchived: false`
     * in `class-generator.ts` turns every captured value `false` and reddens
     * this test alone — the sibling above is unaffected either way, because
     * its template never reaches `createChildren` at all.
     */
    it('copies roomArchived from the template rather than assuming it is false', async () => {
      await prisma.calendarEntry.deleteMany({
        where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
      });

      const base = await freshTemplate();
      const fabricated = { ...base, roomArchived: true };

      const captured: boolean[] = [];
      const spyingDb = new Proxy(prisma, {
        get(target, prop, receiver) {
          if (prop === 'class') {
            return new Proxy(target.class, {
              get(classTarget, classProp, classReceiver) {
                if (classProp === 'createMany') {
                  return (args: { data: { roomArchived: boolean }[] }) => {
                    captured.push(...args.data.map((d) => d.roomArchived));
                    return Promise.resolve({ count: args.data.length });
                  };
                }
                return Reflect.get(classTarget, classProp, classReceiver);
              },
            });
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as unknown as PrismaClient;

      try {
        const now = new Date('2026-04-06T00:00:00.000Z');
        const result = await generateInstancesForTemplate(spyingDb, fabricated, now);
        expect(result.created).toBe(4);
      } finally {
        // The Proxy intercepted `Class`, so only `CalendarEntry` rows
        // actually landed — cleaned up directly rather than through the
        // `Class` relation the mock never populated.
        await prisma.calendarEntry.deleteMany({
          where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
        });
      }

      expect(captured).toHaveLength(4);
      expect(captured.every((v) => v === true)).toBe(true);
    });
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
      // generating. This stub has no real lock semantics to exercise
      // (`class-generator-lock-order.test.ts` stages those against the real
      // database) — it only needs the claim to always succeed so error
      // isolation between templates is still what's under test.
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

