import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { log } from '@/lib/log';
import {
  generateStudioClassInstances,
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';
import { archiveOrUnarchiveStudioTemplate } from './studio-class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * `$transaction`'s options parameter, lifted from `PrismaClient` itself
 * rather than hand-declared — `Parameters<>` on an overloaded method resolves
 * to the last overload, which for `$transaction` is the callback form this
 * codebase actually uses (the array form is first and irrelevant here).
 */
type TransactionOptions = NonNullable<Parameters<PrismaClient['$transaction']>[1]>;

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

  it('never creates duplicates under concurrent runs (row lock serialises the sweeps)', async () => {
    const from = new Date('2099-03-01T00:00:00Z');

    await Promise.all([
      generateStudioClassInstances(prisma, from),
      generateStudioClassInstances(prisma, from),
    ]);

    // Every date exists exactly once, but not because the unique constraint
    // absorbed a collision — `claimStudioTemplateForGeneration`'s `FOR UPDATE`
    // means these two sweeps never actually generate concurrently for this
    // template. One claims the row and runs to completion (claim, generate,
    // commit) before the other's claim can even acquire the lock; by the time
    // the second sweep gets in, its own `studioClass.findFirst` pre-check
    // already finds every date the first sweep created and skips it, so no
    // insert — and no P2002 — ever happens on the second pass. The row lock
    // is what serialises the two sweeps; the constraint is a backstop that
    // never gets exercised here.
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

    // Captured, not hardcoded — same reason as the mid-sweep describe below:
    // other tests in this file assert the fixture's own startTime, so a
    // guessed restore value would corrupt them.
    let originalStartTime: string;

    beforeAll(async () => {
      const t = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
      originalStartTime = t.startTime;
    });

    afterEach(async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: true, isArchived: false, startTime: originalStartTime },
      });
    });

    it('claims a live template', async () => {
      expect(await claim(templateId)).not.toBeNull();
    });

    it('refuses an archived template', async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isArchived: true },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a paused template', async () => {
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: false },
      });
      expect(await claim(templateId)).toBeNull();
    });

    it('refuses a template that no longer exists', async () => {
      expect(await claim('00000000-0000-0000-0000-000000000000')).toBeNull();
    });

    it('returns values committed after the caller read the row', async () => {
      const before = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { startTime: '21:15' },
      });

      const claimed = await prisma.$transaction((tx) => claimStudioTemplateForGeneration(tx, templateId));

      expect(before.startTime).not.toBe('21:15');
      expect(claimed?.startTime).toBe('21:15');
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
          expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      let archiveSettled = false;
      const archiving = archiveOrUnarchiveStudioTemplate(prisma, templateId, teacherId, 'archived').then((r) => {
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
     * `{ timeout: 10_000 }` — the studio side of review round 1's finding 1.
     * This used to be a ~5.5s test that held the claim's lock past Prisma's
     * 5s default and asserted the archive still resolved instead of P2028'ing
     * (mirroring the class family's version). That end-to-end proof already
     * exists on the class side
     * (`class-generator.test.ts`'s `lets a concurrent archive outlive its own
     * transaction default once the claim holds past it`) — the mechanism it
     * proves, Prisma's `$transaction` timeout actually extending the wait
     * budget, is not family-specific, so paying for it twice bought nothing
     * but 5.5 more seconds in every run of this file. The family-specific
     * half — that the archive path takes a lock the sweep can contend for at
     * all — is already covered above by the ~400ms mutual-exclusion test.
     *
     * What this pins instead: that `archiveOrUnarchiveStudioTemplate` still
     * passes `{ timeout: 10_000 }` as its transaction's options, so a future
     * edit can't silently drop it back to Prisma's 5s default and have this
     * file stay green. It does not re-prove that the option changes Prisma's
     * behaviour — that's the sibling test's job — only that the option is
     * still there. `spyingClient` is a `Proxy` around the real client that
     * intercepts `$transaction` to record its `options` argument and then
     * delegates to the real call, so the archive still runs for real.
     */
    it('opens its transaction with { timeout: 10_000 }', async () => {
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

      const result = await archiveOrUnarchiveStudioTemplate(spyingClient, templateId, teacherId, 'archived');

      expect(result.ok).toBe(true);
      expect(recordedOptions).toEqual({ timeout: 10_000 });
    });
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

  describe('generateStudioClassInstances — edit mid-sweep', () => {
    // Captured, not hardcoded: other tests in this file assert the fixture's
    // own dayOfWeek/startTime, so restoring a guessed value would corrupt them.
    let original: { dayOfWeek: number; startTime: string };

    beforeAll(async () => {
      const t = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
      original = { dayOfWeek: t.dayOfWeek, startTime: t.startTime };
    });

    afterEach(async () => {
      await prisma.studioClass.deleteMany({ where: { templateId } });
      await prisma.studioClassTemplate.update({
        where: { id: templateId },
        data: { ...original, isActive: true, isArchived: false },
      });
    });

    /**
     * #102, studio side. The claim locks the row, so a concurrent edit cannot
     * commit while we generate — but before this fix the sweep still
     * generated from the object its outer `findMany` read, so it wrote the
     * pre-edit values anyway.
     *
     * Deterministic by the same lever as the archive race: an uncommitted write
     * is invisible under READ COMMITTED, so the sweep's list read genuinely sees
     * the old values and the template genuinely enters the loop.
     */
    it('writes the values committed while the sweep was waiting, not the ones it read', async () => {
      await prisma.studioClass.deleteMany({ where: { templateId } });

      let commit!: () => void;
      const held = new Promise<void>((resolve) => {
        commit = resolve;
      });

      // 1. Edit, uncommitted. Holds the row lock; invisible to the sweep.
      const editing = prisma.$transaction(
        async (tx) => {
          await tx.studioClassTemplate.update({
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
      const sweeping = generateStudioClassInstances(prisma).then((n) => {
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
      const created = await prisma.studioClass.findMany({
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
});

describe('generateStudioInstancesForTemplate (DB)', () => {
  // Two teachers 25 hours apart. A UTC-only fixture cannot tell the
  // "already started" filter from its absence, because at UTC the local
  // start time and the UTC start time are the same instant.
  const EAST = 'Pacific/Kiritimati'; // UTC+14
  const WEST = 'Pacific/Niue'; // UTC-11

  let eastTeacherId: string;
  let westTeacherId: string;
  const templateIds: string[] = [];

  const seedTeacher = async (label: string, defaultTimezone: string) => {
    const email = `studio-pertpl-${label}-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: label,
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: `Per-template studio generation, ${label}`,
        pageSlug: `studio-pertpl-${label}-${uniqueSuffix}`,
        defaultTimezone,
      },
    });
    return teacher.id;
  };

  const makeTemplate = async (teacherId: string, dayOfWeek: number, startTime: string) => {
    const t = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Per Template',
        location: 'Studio Per Template',
        dayOfWeek,
        startTime,
        durationMinutes: 60,
        hourlyRate: 45,
        isActive: true,
      },
    });
    templateIds.push(t.id);
    return t.id;
  };

  /** Loads a template in the shape the generator takes. */
  const withZone = (id: string) =>
    prisma.studioClassTemplate.findUniqueOrThrow({
      where: { id },
      include: { teacher: { select: { defaultTimezone: true } } },
    });

  const datesFor = (templateId: string) =>
    prisma.studioClass.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

  beforeAll(async () => {
    eastTeacherId = await seedTeacher('east', EAST);
    westTeacherId = await seedTeacher('west', WEST);
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { templateId: { in: templateIds } } });
    await prisma.studioClassTemplate.deleteMany({ where: { id: { in: templateIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: [eastTeacherId, westTeacherId] } } });
  });

  it('creates the four-week window and is idempotent on a second run', async () => {
    const id = await makeTemplate(eastTeacherId, 3, '09:00');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl);
    const second = await generateStudioInstancesForTemplate(prisma, tpl);

    expect(first).toBe(4);
    expect(second).toBe(0);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });

  /**
   * The parity case. `from` is an explicit instant so this does not depend on
   * when the suite runs: it is noon in the teacher's own zone on a day that
   * matches the template's `dayOfWeek`, with the template starting at 09:00.
   * Today's occurrence has therefore already started and must be skipped, and
   * the window must slide a week rather than come back one short.
   */
  it('skips an occurrence whose start time has already passed, and still creates four', async () => {
    // 2026-08-05T00:00:00Z is a Wednesday. In Kiritimati (UTC+14) that instant
    // is 14:00 the same Wednesday — after a 09:00 start.
    const from = new Date('2026-08-05T00:00:00.000Z');
    const dayOfWeek = (from.getUTCDay() + 6) % 7; // schema convention: 0 = Monday
    const id = await makeTemplate(eastTeacherId, dayOfWeek, '09:00');
    const tpl = await withZone(id);

    const created = await generateStudioInstancesForTemplate(prisma, tpl, from);

    expect(created).toBe(4);
    const dates = (await datesFor(id)).map((d) => d.date.toISOString().slice(0, 10));
    expect(dates).not.toContain('2026-08-05');
    expect(dates[0]).toBe('2026-08-12');
  });

  /**
   * The same instant and the same template shape, read from two zones 25 hours
   * apart, must disagree about whether today's class is still ahead. If this
   * passes with the filter deleted, the filter is not being exercised.
   */
  it('decides "already started" in the teacher zone, not in UTC', async () => {
    // 20:00Z on a Wednesday. Kiritimati (UTC+14) is already Thursday 10:00, so
    // Wednesday is long gone. Niue (UTC-11) is still Wednesday 09:00 — an hour
    // before a 10:00 start, so Wednesday is still ahead.
    const from = new Date('2026-08-05T20:00:00.000Z');
    const dayOfWeek = (new Date('2026-08-05T00:00:00.000Z').getUTCDay() + 6) % 7;

    const eastId = await makeTemplate(eastTeacherId, dayOfWeek, '10:00');
    const westId = await makeTemplate(westTeacherId, dayOfWeek, '10:00');

    await generateStudioInstancesForTemplate(prisma, await withZone(eastId), from);
    await generateStudioInstancesForTemplate(prisma, await withZone(westId), from);

    const east = (await datesFor(eastId)).map((d) => d.date.toISOString().slice(0, 10));
    const west = (await datesFor(westId)).map((d) => d.date.toISOString().slice(0, 10));

    expect(east).not.toContain('2026-08-05');
    expect(west).toContain('2026-08-05');
  });

  it('accepts a transaction client, so a caller can compose it', async () => {
    const id = await makeTemplate(westTeacherId, 4, '08:00');
    const tpl = await withZone(id);

    const created = await prisma.$transaction(
      async (tx) => generateStudioInstancesForTemplate(tx, tpl),
      { timeout: 10_000 },
    );

    expect(created).toBe(4);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
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
      // generateStudioInstancesForTemplate (#94) now reads
      // template.teacher.defaultTimezone to decide whether today's occurrence
      // has already started; UTC keeps that decision equal to plain instant
      // comparison so it doesn't interact with this test's own fixture dates.
      teacher: { defaultTimezone: 'UTC' },
    };
  }

  it('a failing template does not abort the others, and the error is rethrown', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z'); // deterministic future window
    const stub = {
      studioClassTemplate: {
        findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1'), tmpl('C', 't1')],
        // The claim re-reads under its own lock (#102) — this stub has no real
        // row to re-read, so it just hands back the same fixture the findMany
        // above already produced, keyed by the id the claim was given.
        findUniqueOrThrow: async ({ where: { id } }: { where: { id: string } }) => tmpl(id, 't1'),
      },
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
