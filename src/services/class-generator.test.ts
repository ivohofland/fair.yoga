import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { startOfLocalDay } from '@/lib/timezone';
import {
  getNextOccurrences,
  generateClassInstances,
  generateInstancesForTemplate,
  claimTemplateForGeneration,
} from './class-generator';
import { archiveOrUnarchiveTemplate } from './class-template-lifecycle';

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

    afterEach(async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isActive: true, isArchived: false },
      });
    });

    it('claims a live template', async () => {
      expect(await claim(templateId)).toBe(true);
    });

    it('refuses an archived template', async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isArchived: true },
      });
      expect(await claim(templateId)).toBe(false);
    });

    it('refuses a paused template', async () => {
      await prisma.classTemplate.update({
        where: { id: templateId },
        data: { isActive: false },
      });
      expect(await claim(templateId)).toBe(false);
    });

    it('refuses a template that no longer exists', async () => {
      expect(await claim('00000000-0000-0000-0000-000000000000')).toBe(false);
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
          expect(await claimTemplateForGeneration(tx, templateId)).toBe(true);
          await held;
        },
        { timeout: 15_000 },
      );

      // Let the claim acquire the lock before the archive contends for it.
      await new Promise((r) => setTimeout(r, 100));

      let archiveSettled = false;
      const archiving = archiveOrUnarchiveTemplate(prisma, templateId, teacherId).then((r) => {
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
            expect(await claimTemplateForGeneration(tx, templateId)).toBe(true);
            await held;
          },
          { timeout: 15_000 },
        );

        // Let the claim acquire the lock before the archive contends for it.
        await new Promise((r) => setTimeout(r, 100));

        const archiving = archiveOrUnarchiveTemplate(prisma, templateId, teacherId);

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
          expect(await claimTemplateForGeneration(tx, template.id)).toBe(true);
          return generateInstancesForTemplate(tx, template, today);
        });
        expect(created).toBe(4);

        const beforeArchive = await prisma.class.findMany({
          where: { templateId: template.id },
          orderBy: { date: 'asc' },
        });
        expect(beforeArchive).toHaveLength(4);
        expect(beforeArchive[0]!.date.toISOString()).toBe(today.toISOString());

        // 2. Archive, straight after the commit — no concurrency involved.
        const result = await archiveOrUnarchiveTemplate(prisma, template.id, teacherId);
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
      classTemplate: { findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1'), tmpl('C', 't1')] },
      class: {
        findFirst: async () => null,
        create: async ({ data }: { data: { templateId: string } }) => {
          if (data.templateId === 'A') throw new Error('boom-A');
          if (data.templateId === 'C') throw new Error('boom-C');
          created.push(data.templateId);
          return {};
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
