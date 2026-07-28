import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { log } from '@/lib/log';
import { generateStudioClassInstances, claimStudioTemplateForGeneration } from './studio-class-generator';
import { archiveOrUnarchiveStudioTemplate } from './studio-class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('generateStudioClassInstances (DB)', () => {
  let teacherId: string;
  let templateId: string;
  /** Archived but active — the state the PATCH route used to allow. */
  let shelvedTemplateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'StudioGen',
        lastName: 'Teacher',
        email: `studiogen-${uniqueSuffix}@test.local`,
        account: { create: { email: `studiogen-${uniqueSuffix}@test.local` } },
        bio: 'Studio generator tests',
        pageSlug: `studiogen-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const template = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Hatha',
        location: 'Studio Gen Test',
        dayOfWeek: 1,
        startTime: '10:00',
        durationMinutes: 60,
        hourlyRate: 45,
        isActive: true,
      },
    });
    templateId = template.id;

    // Defence in depth, mirroring class-generator.ts: the route now refuses to
    // activate an archived template, but if that invariant ever slips the
    // generator must not materialise classes for something the teacher shelved.
    // This row is written directly because the route no longer permits it.
    const shelved = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Shelved',
        location: 'Studio Gen Test',
        dayOfWeek: 2,
        startTime: '11:00',
        durationMinutes: 60,
        hourlyRate: 45,
        isActive: true,
        isArchived: true,
      },
    });
    shelvedTemplateId = shelved.id;
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({
      where: { templateId: { in: [templateId, shelvedTemplateId] } },
    });
    await prisma.studioClassTemplate.deleteMany({
      where: { id: { in: [templateId, shelvedTemplateId] } },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('creates 4 weeks of instances and is idempotent across runs', async () => {
    // The generator sweeps every active template (other test files create
    // their own), so all assertions are scoped to this test's template.
    const from = new Date('2099-01-01T00:00:00Z');

    await generateStudioClassInstances(prisma, from);
    const afterFirst = await prisma.studioClass.count({ where: { templateId } });
    expect(afterFirst).toBeGreaterThanOrEqual(3); // rolling 4-week window

    await generateStudioClassInstances(prisma, from);
    const afterSecond = await prisma.studioClass.count({ where: { templateId } });
    expect(afterSecond).toBe(afterFirst);
  });

  it('never creates duplicates under concurrent runs (unique constraint)', async () => {
    const from = new Date('2099-03-01T00:00:00Z');

    await Promise.all([
      generateStudioClassInstances(prisma, from),
      generateStudioClassInstances(prisma, from),
    ]);

    // The two runs may split the work between them, but every date must
    // exist exactly once — the unique constraint absorbs the race.
    const instances = await prisma.studioClass.findMany({
      where: { templateId, date: { gte: from } },
      select: { date: true },
    });
    const dates = instances.map((i) => i.date.toISOString());
    expect(dates.length).toBeGreaterThanOrEqual(3);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it('skips an archived template even when it is still flagged active', async () => {
    await generateStudioClassInstances(prisma);

    expect(await prisma.studioClass.count({ where: { templateId: shelvedTemplateId } })).toBe(0);
  });

  describe('claimStudioTemplateForGeneration', () => {
    const claim = (id: string) =>
      prisma.$transaction((tx) => claimStudioTemplateForGeneration(tx, id));

    afterEach(async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: true, isArchived: false },
      });
    });

    it('claims a live template', async () => {
      expect(await claim(templateId)).toBe(true);
    });

    it('refuses an archived template', async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isArchived: true },
      });
      expect(await claim(templateId)).toBe(false);
    });

    it('refuses a paused template', async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: false },
      });
      expect(await claim(templateId)).toBe(false);
    });

    it('refuses a template that no longer exists', async () => {
      expect(await claim('00000000-0000-0000-0000-000000000000')).toBe(false);
    });

    /**
     * The other interleaving. The mid-sweep test below covers "archive holds the
     * lock, generator waits"; this covers "generator holds it, archive waits".
     * The predicate cases above pass with or without `FOR UPDATE` — these two do
     * not.
     */
    it('makes a concurrent archive wait until the claim transaction commits', async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const claiming = prisma.$transaction(
        async (tx) => {
          expect(await claimStudioTemplateForGeneration(tx, templateId)).toBe(true);
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      let archiveSettled = false;
      const archiving = archiveOrUnarchiveStudioTemplate(prisma, templateId, teacherId).then((r) => {
        archiveSettled = true;
        return r;
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(archiveSettled).toBe(false);

      release();
      await claiming;
      const result = await archiving;
      expect(result.ok).toBe(true);
    });

    /**
     * Regression guard for `archiveOrUnarchiveStudioTemplate`'s own
     * `{ timeout: 10_000 }` — the studio side of review round 1's finding 1,
     * which `class-generator.test.ts`'s equivalent test closed for the class
     * family. That fix is on the *Prisma* transaction timeout on the archive
     * side, a different axis from the claim's 2s Postgres `lock_timeout` the
     * test above and the mid-sweep race test both stay well under (~300-400ms
     * of headroom) — neither of those can tell a 10s budget from Prisma's
     * unset 5s default, because neither holds the lock anywhere near either
     * number. This test has to actually cross 5s, or deleting
     * `{ timeout: 10_000 }` from `archiveOrUnarchiveStudioTemplate` leaves the
     * whole suite green.
     *
     * Deliberately slow (~5.5s, on top of everything else in this file) —
     * that's the cost of a guard that means something. Do not shorten the
     * hold below 5s: it has to clear Prisma's default, not brush it.
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
            expect(await claimStudioTemplateForGeneration(tx, templateId)).toBe(true);
            await held;
          },
          { timeout: 15_000 },
        );

        // Let the claim acquire the lock before the archive contends for it.
        await new Promise((r) => setTimeout(r, 100));

        const archiving = archiveOrUnarchiveStudioTemplate(prisma, templateId, teacherId);

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

  describe('generateStudioClassInstances — archive mid-sweep', () => {
    afterEach(async () => {
      await prisma.studioClass.deleteMany({ where: { templateId } });
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: true, isArchived: false },
      });
    });

    /**
     * The studio half of the #95 race. Same lever as the class family's test:
     * an uncommitted archive is invisible to the sweep's own `findMany`, so the
     * template enters the loop and the claim is what has to stop it.
     */
    it('does not generate for a template archived after the list was read', async () => {
      // Task 1 hit this on the class side: a preceding pre-existing test can
      // leave stray rows for this templateId, which fails the baseline
      // assertion below for reasons unrelated to the lock. Clear first — the
      // final assertion still carries the teeth.
      await prisma.studioClass.deleteMany({ where: { templateId } });
      expect(await prisma.studioClass.count({ where: { templateId } })).toBe(0);

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      const archiving = prisma.$transaction(
        async (tx) => {
          await tx.studioClassTemplate.update({
            where: { id: templateId },
            data: { isArchived: true, isActive: false },
          });
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      let sweepSettled = false;
      const sweeping = generateStudioClassInstances(prisma).then((n) => {
        sweepSettled = true;
        return n;
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(sweepSettled).toBe(false);

      commit();
      await archiving;
      await sweeping;

      expect(await prisma.studioClass.count({ where: { templateId } })).toBe(0);
    });
  });
});

// ===========================================================================
// Per-template isolation — stubbed db, no real DB
// ===========================================================================

describe('generateStudioClassInstances (per-template isolation)', () => {
  function tmpl(id: string, teacherId: string) {
    return {
      id,
      teacherId,
      dayOfWeek: 0,
      startTime: '09:00',
      classType: 'Hatha',
      durationMinutes: 60,
      location: 'Stub Studio',
      hourlyRate: 45,
    };
  }

  it('a failing template does not abort the others, and the error is rethrown', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z'); // deterministic future window
    const stub = {
      studioClassTemplate: { findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1'), tmpl('C', 't1')] },
      studioClass: {
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

    await expect(generateStudioClassInstances(stub, from)).rejects.toThrow('boom-A');
    expect(created).toContain('B'); // B generated despite A failing before and C failing after

    // Both failing templates are logged, not just the one that's rethrown.
    const loggedTemplateIds = spy.mock.calls.map((c) => (c[0] as { templateId?: string }).templateId);
    expect(loggedTemplateIds).toContain('A');
    expect(loggedTemplateIds).toContain('C');
    spy.mockRestore();
  });
});
