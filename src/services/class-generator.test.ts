import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { classStartInstant, startOfLocalDay } from '@/lib/timezone';
import {
  getNextOccurrences,
  generateClassInstances,
  generateInstancesForTemplate,
  claimTemplateForGeneration,
} from './class-generator';
import { archiveOrUnarchiveTemplate, pauseOrResumeTemplate } from './class-template-lifecycle';

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

    beforeAll(async () => {
      const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      originalStartTime = t.startTime;
    });

    afterEach(async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isActive: true, isArchived: false, startTime: originalStartTime },
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
     * Regression guard for `archiveOrUnarchiveTemplate`'s own
     * `{ timeout: 10_000 }` (review round 1, finding 1). That fix is on the
     * *Prisma* transaction timeout on the archive side, which is a different
     * axis from the claim's 2s Postgres `lock_timeout` the test above and the
     * mid-sweep race test both stay well under (~300-400ms of headroom) —
     * neither of those can tell a 10s budget from Prisma's unset 5s default,
     * because neither holds the lock anywhere near either number. This test
     * has to actually cross 5s, or deleting `{ timeout: 10_000 }` from
     * `archiveOrUnarchiveTemplate` leaves the whole suite green.
     *
     * Deliberately slow (~5.5s, on top of everything else in this file) —
     * that's the cost of a guard that means something. Do not shorten the
     * hold below 5s: it has to clear Prisma's default, not brush it.
     *
     * This is now the one place in either family that proves the timeout
     * actually does something end to end. The studio side used to pay for an
     * identical ~5.5s hold to prove the same mechanism a second time — since
     * Prisma's `$transaction` timeout isn't family-specific, that bought
     * nothing but 5.5 more seconds per run, so its test was replaced with a
     * cheap assertion that `archiveOrUnarchiveStudioTemplate` still passes
     * `{ timeout: 10_000 }` (`studio-class-generator.test.ts`'s `opens its
     * transaction with { timeout: 10_000 }`). That leaves this test as the
     * only one actually exercising the 5s boundary — do not delete it under
     * the assumption the studio side still covers it.
     */
    it(
      'lets a concurrent archive outlive its own transaction default once the claim holds past it',
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

        const archiving = archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');

        // Hold past Prisma's 5s default on the archive side — comfortably
        // above it (5.5s), not just brushing it, so this doesn't flake right
        // at the boundary it exists to cross.
        await new Promise((r) => setTimeout(r, 5_500));

        release();
        await claiming;

        // With { timeout: 10_000 } on the archive's transaction, it waited
        // out the lock and succeeded. Without it, Prisma would have aborted
        // the archive's transaction with P2028 around the 5s mark, and this
        // `await` would reject instead of resolving `ok: true`.
        const result = await archiving;
        expect(result.ok).toBe(true);
      },
      15_000,
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
              templateId,
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
     * Loses the race the old generator could not survive. The holder inserts
     * the colliding row and holds it UNCOMMITTED, so the resume's pre-check
     * (a plain read under READ COMMITTED — an uncommitted row is invisible)
     * still calls that date free, and the resume's own insert then parks on
     * the holder's *pending* unique-index entry for `(templateId, date)`.
     *
     * That pending-entry wait is the parking — no `FOR UPDATE` on the FK
     * target is needed. Postgres performs an INSERT's unique-index check
     * before its FK checks, so a same-key insert always sees the other
     * transaction's pending entry and waits for it. The first design of this
     * test instead held the `TeacherRoom` row `FOR UPDATE` and let the
     * holder write its row afterwards, as the plan's lever described; that
     * makes each inserter wait on the other — the resume's pending entry
     * against the holder's `FOR UPDATE` — and deadlocks on *both* the old
     * and the fixed generator (measured: 40P01, both tests, both versions).
     * The row the resume parks on must be in flight when its insert runs,
     * and the holder must not be waiting on anything the resume holds.
     */
    async function raceResumeAgainst(collide: Date): Promise<void> {
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

      // The holder's row is now in flight: invisible to the resume's
      // pre-check, yet its pending unique entry already blocks the resume's
      // insert. Start the resume and give it time to reach that insert.
      await parked;
      const resuming = pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holding;
      await resuming;
      await holder.$disconnect();
    }

    it('leaves isActive committed when the clash lands on the last free date', async () => {
      const now = new Date();
      const dates = candidates(now);
      // Only the last date is free, so the resume issues exactly one insert.
      for (const d of dates.slice(0, 3)) await prisma.class.create({ data: classRow(d) });

      await raceResumeAgainst(dates[3]!);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });

    it('still fills the other free date when the clash lands on the first', async () => {
      const now = new Date();
      const dates = candidates(now);
      for (const d of dates.slice(0, 2)) await prisma.class.create({ data: classRow(d) });

      await raceResumeAgainst(dates[2]!);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      // dates[3] is the one nothing collided with — it must exist.
      expect(await prisma.class.count({ where: { templateId, date: dates[3]! } })).toBe(1);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });
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
