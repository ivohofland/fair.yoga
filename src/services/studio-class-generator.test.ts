import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { log } from '@/lib/log';
import {
  generateStudioClassInstances,
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';
import {
  archiveOrUnarchiveStudioTemplate,
  pauseOrResumeStudioTemplate,
} from './studio-class-template-lifecycle';
// The studio family shares the class family's date maths (#94), so the tests
// compute candidate dates the same way the generator does rather than
// hardcoding them — a window-logic change then fails loudly instead of drifting.
import { getNextOccurrences } from './class-generator';
import { classStartInstant } from '@/lib/timezone';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';

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
  let templateScheduleRuleId: string;
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
        scheduleRule: {
          create: {
            teacherId, kind: 'studio', classType: 'Hatha', dayOfWeek: 1,
            startTime: hhmmToTime('10:00'), durationMinutes: 60, isActive: true,
          },
        },
        location: 'Studio Gen Test',
        hourlyRate: 45,
      },
    });
    templateId = template.id;
    templateScheduleRuleId = template.scheduleRuleId;

    // Defence in depth, mirroring class-generator.ts: the route now refuses to
    // activate an archived template, but if that invariant ever slips the
    // generator must not materialise classes for something the teacher shelved.
    // This row is written directly because the route no longer permits it.
    const shelved = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'studio', classType: 'Shelved', dayOfWeek: 2,
            startTime: hhmmToTime('11:00'), durationMinutes: 60, isActive: true, isArchived: true,
          },
        },
        location: 'Studio Gen Test',
        hourlyRate: 45,
      },
    });
    shelvedTemplateId = shelved.id;
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({
      where: { templateId: { in: [templateId, shelvedTemplateId] } },
    });
    // `StudioClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
    // 298), so deleting the rules removes the templates with them.
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('creates 4 weeks of instances and is idempotent across runs', async () => {
    // The generator sweeps every active template (other test files create
    // their own), so all assertions are scoped to this test's template.
    const from = new Date('2099-01-01T00:00:00Z');

    await generateStudioClassInstances(prisma, from);
    const afterFirst = await prisma.studioClass.count({ where: { templateId } });
    // Exactly the rolling 4-week window, not "at least most of it". The loose
    // bound this replaces would wave through a window that comes back a week
    // short. Note what it does *not* pin: this fixture's filter never drops
    // anything — the template is `dayOfWeek: 1` and `from` is a Thursday, so
    // the first occurrence is always a future Tuesday — so the
    // `DEFAULT_WEEKS + 1` → `DEFAULT_WEEKS` regression is caught by the
    // per-template tests below, not here. What `toBe(4)` catches here is a
    // window that shortens for any *other* reason, e.g. `DEFAULT_WEEKS` itself
    // changing.
    expect(afterFirst).toBe(4);

    await generateStudioClassInstances(prisma, from);
    const afterSecond = await prisma.studioClass.count({ where: { templateId } });
    expect(afterSecond).toBe(afterFirst);
  });

  /**
   * Named for what it can see, which is not the row lock. This used to be
   * called "never creates duplicates under concurrent runs (row lock
   * serialises the sweeps)", and the distinctness assertion below cannot
   * fail for any implementation: `@@unique([templateId, date])` makes a
   * duplicate date unrepresentable, so even a build where both sweeps
   * genuinely generated at once would arrive here with a distinct set.
   * Measured rather than assumed — removing `FOR UPDATE` from
   * `claimStudioTemplateForGeneration` leaves this test green while failing
   * three others in this file.
   *
   * What it does pin is that two overlapping sweeps both resolve, and that
   * the window they leave is the full four weeks. Those are real: a build
   * where the two genuinely interleaved would collide on `@@unique` inside an
   * interactive transaction, and a `catch` there leaves Postgres with an
   * aborted transaction that fails the next statement with 25P02 rather than
   * skipping cleanly — which `generateStudioClassInstances` rethrows.
   *
   * The lock is pinned by the three tests in this file that can observe it,
   * all of them below: "makes a concurrent archive wait until the claim
   * transaction commits", "does not generate for a template archived after the
   * list was read", and "writes the values committed while the sweep was
   * waiting, not the ones it read". All three park a competing
   * transaction on the row and assert nothing settles until it commits; each
   * one fails without `FOR UPDATE`. A fourth here would buy another few
   * hundred milliseconds of sleep in every run and no new coverage — the same
   * trade the `{ timeout: 10_000 }` test below spells out for its own case.
   */
  it('two concurrent sweeps both resolve, leaving one class per date', async () => {
    const from = new Date('2099-03-01T00:00:00Z');

    await Promise.all([
      generateStudioClassInstances(prisma, from),
      generateStudioClassInstances(prisma, from),
    ]);

    const instances = await prisma.studioClass.findMany({
      where: { templateId, date: { gte: from } },
      select: { date: true },
    });
    const dates = instances.map((i) => i.date.toISOString());
    // Exactly the window, for the same reason as the test above — and with the
    // same caveat: this fixture's `from` is a Sunday against a `dayOfWeek: 1`
    // template, so the filter never drops anything here either.
    expect(dates.length).toBe(4);
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
      const t = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: templateScheduleRuleId } });
      originalStartTime = timeToHHmm(t.startTime);
    });

    afterEach(async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isActive: true, isArchived: false, startTime: hhmmToTime(originalStartTime) },
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

      const claimed = await prisma.$transaction((tx) => claimStudioTemplateForGeneration(tx, templateId));

      expect(timeToHHmm(before.startTime)).not.toBe('21:15');
      expect(claimed ? timeToHHmm(claimed.scheduleRule.startTime) : claimed).toBe('21:15');
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
     * (mirroring the class family's version), so paying for it twice bought
     * nothing but 5.5 more seconds in every run of this file. The
     * family-specific half — that the archive path takes a lock the sweep can
     * contend for at all — is already covered above by the ~400ms
     * mutual-exclusion test.
     *
     * This paragraph used to defer to the class family's 5.5s test by name for
     * the end-to-end half. That test no longer exists: the 2s `lock_timeout`
     * made its premise unwritable and it was re-pointed at the bound, so the
     * reference named a deleted test for a proof that had been removed
     * deliberately. The class family now pins its own budget the same cheap
     * way this test does.
     *
     * What this pins instead: that `archiveOrUnarchiveStudioTemplate` still
     * passes `{ timeout: 10_000 }` as its transaction's options, so a future
     * edit can't silently drop it back to Prisma's 5s default and have this
     * file stay green. It does not prove that the option changes Prisma's
     * behaviour, and nothing does any more: both families once had a test that
     * crossed the 5s boundary end to end — this one, replaced by the spy
     * above, and the class family's, re-pointed at the bound — and the 2s
     * `lock_timeout` made that proof unwritable in either. What survives is
     * the literal, pinned. `spyingClient` is
     * a `Proxy` around the real client that
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

    /**
     * The studio half of the bound. The class family's equivalent
     * (`class-generator.test.ts`'s `answers busy when the generation claim
     * holds the row past the lock timeout`) proves the same mechanism, but
     * this is not a duplicate of it: the two functions have separate
     * transactions, separate catches and separate result unions, so a bound
     * dropped from one leaves the other's test green.
     *
     * The timing assertions carry it, the same way the twin's docblock
     * explains in full: the lower bound proves the archive waited, the upper
     * proves it answered near the 2s bound. Removing the bound does not slide
     * that answer later — it stops the archive settling at all, so the test
     * dies on its own 20s timeout (mutation record, Task 2).
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
            expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
        try {
          const startedAt = Date.now();
          const result = await archiveOrUnarchiveStudioTemplate(
            prisma,
            templateId,
            teacherId,
            'archived',
          );
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

          // See the class family's twin for why the log line is asserted
          // rather than assumed: it is the only server-side trace a returned
          // failure leaves.
          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId, target: 'archived' }),
            'studio class archive lost the template lock race',
          );
        } finally {
          release();
          await claiming.catch(() => {});
          warn.mockRestore();
        }
      },
      20_000,
    );

    /**
     * The site the issue never names. Unlike its three siblings this function
     * had no `catch` whatsoever, so a lost lock race propagated raw.
     *
     * The PAUSE arm, for the reason its class-family twin records in full:
     * `claimStudioTemplateForGeneration` selects `WHERE isActive = true`, a
     * resume only runs on a paused template, and the two sets are disjoint —
     * so a resume cannot lose to the claim.
     *
     * One consequence worth stating, because it is a coverage gap rather than
     * a non-issue: the pause arm does NOT take the generation claim (only the
     * active arm does), so this test does not exercise the claim re-issuing
     * the same 2s bound partway through the transaction. That re-issue is
     * safe by `setLockTimeout`'s own documented overwrite semantics, and the
     * bound the CAS waits under is the one set at the top either way — but
     * nothing here proves it.
     */
    it(
      'answers busy when a studio pause loses the row to the generation claim',
      async () => {
        // The sweep claims only an ACTIVE template, so this test needs one.
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
            expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
        try {
          const startedAt = Date.now();
          const result = await pauseOrResumeStudioTemplate(prisma, templateId, teacherId, 'paused');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          expect(waited).toBeGreaterThanOrEqual(1_800);
          expect(waited).toBeLessThan(5_000);

          expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({ templateId, teacherId, target: 'paused' }),
            'studio class pause/resume lost the template lock race',
          );
        } finally {
          release();
          await claiming.catch(() => {});
          warn.mockRestore();
          // A local restatement, not the guarantee — this block's `afterEach`
          // already restores `isActive`/`isArchived`/`startTime`. Kept, and
          // moved into the `finally` where it actually runs, so a mutation run
          // that let the pause COMMIT could not leak a paused template into
          // the next test. Worth stating plainly that the recorded mutations
          // never produced that commit: with the bound removed the pause does
          // not win the row, it never settles at all (mutations file, Task 4).
          await prisma.scheduleRule.update({
            where: { id: templateScheduleRuleId },
            data: { isActive: true },
          });
        }
      },
      20_000,
    );
  });

  describe('generateStudioClassInstances — archive mid-sweep', () => {
    afterEach(async () => {
      await prisma.studioClass.deleteMany({ where: { templateId } });
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
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

      // Takes the child's row lock first — the same statement
      // `archiveOrUnarchiveStudioTemplate` takes as its own first statement
      // (issue 298 / #315) — then writes `ScheduleRule`, invisible to others
      // until commit.
      const archiving = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
          await tx.scheduleRule.update({
            where: { id: templateScheduleRuleId },
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
      // Without the child lock above, the sweep sails past the claim and has
      // already created the window by now.
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
      const t = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: templateScheduleRuleId } });
      original = { dayOfWeek: t.dayOfWeek, startTime: timeToHHmm(t.startTime) };
    });

    afterEach(async () => {
      await prisma.studioClass.deleteMany({ where: { templateId } });
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

      // 1. Edit, uncommitted. Takes the child's row lock first — the same
      //    statement `updateStudioClassTemplate` takes as its own first
      //    statement (issue 298 / #315) — then writes `ScheduleRule`,
      //    invisible to the sweep until commit.
      const editing = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
          await tx.scheduleRule.update({
            where: { id: templateScheduleRuleId },
            data: { dayOfWeek: 5, startTime: hhmmToTime('18:45') },
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
  // Two teachers 25 hours apart. Not because a UTC-only fixture cannot see
  // the "already started" filter at all — it can: give a UTC teacher a `from`
  // of noon and a 09:00 template, and the filter drops an occurrence an
  // unfiltered build would create. What a UTC fixture cannot see is *which
  // zone* the filter compares in, because at UTC the teacher-zone comparison
  // and a plain UTC comparison are the same instant on every input, so both
  // implementations agree everywhere. Telling those two apart is what these
  // zones are for, and the "decides 'already started' in the teacher zone,
  // not in UTC" test below is what does it.
  const EAST = 'Pacific/Kiritimati'; // UTC+14
  const WEST = 'Pacific/Niue'; // UTC-11

  let eastTeacherId: string;
  let westTeacherId: string;
  let eastAccountId: string;
  let westAccountId: string;
  const templateIds: string[] = [];
  /** #296's cross-family fixtures need a `Class`, which needs a room. */
  let eastRoomId: string;
  let eastTeacherRoomId: string;

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
    // Captured alongside the teacher id: `account: { create }` above makes a
    // matching Account row, which nothing but this teardown ever deletes.
    return { teacherId: teacher.id, accountId: teacher.accountId };
  };

  const makeTemplate = async (teacherId: string, dayOfWeek: number, startTime: string) => {
    const t = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'studio', classType: 'Per Template', dayOfWeek,
            startTime: hhmmToTime(startTime), durationMinutes: 60, isActive: true,
          },
        },
        location: 'Studio Per Template',
        hourlyRate: 45,
      },
    });
    templateIds.push(t.id);
    return t.id;
  };

  /** Loads a template in the shape the generator takes. */
  const withZone = (id: string) =>
    prisma.studioClassTemplate.findUniqueOrThrow({
      where: { id },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });

  const datesFor = (templateId: string) =>
    prisma.studioClass.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

  // Slot-reporting tests generate and hand-cancel rows under these teachers.
  // Without this, one test's leftover classes occupy the next test's slots —
  // the generator's occupancy check is scoped per teacher (mirroring #196).
  afterEach(async () => {
    await prisma.studioClass.deleteMany({
      where: { teacherId: { in: [eastTeacherId, westTeacherId] } },
    });
    // #296: the cross-family cases create `Class` rows, and a leftover one
    // occupies the next test's slot exactly the way a leftover StudioClass
    // does — the whole point of the reason being added is that the generator
    // now reads that table too.
    await prisma.class.deleteMany({
      where: { teacherId: { in: [eastTeacherId, westTeacherId] } },
    });
  });

  beforeAll(async () => {
    const east = await seedTeacher('east', EAST);
    eastTeacherId = east.teacherId;
    eastAccountId = east.accountId;

    const west = await seedTeacher('west', WEST);
    westTeacherId = west.teacherId;
    westAccountId = west.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Studio Gen Cross Venue',
        address: `${uniqueSuffix} Cross Street`,
        city: 'Amsterdam',
        postcode: '1011AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 12,
        isPublic: false,
        createdById: eastTeacherId,
      },
    });
    eastRoomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: eastTeacherId, roomId: eastRoomId, rentalRate: 20, capacityOverride: 12 },
    });
    eastTeacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { templateId: { in: templateIds } } });
    await prisma.studioClassTemplate.deleteMany({ where: { id: { in: templateIds } } });
    await prisma.class.deleteMany({ where: { teacherId: { in: [eastTeacherId, westTeacherId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: eastTeacherId } });
    await prisma.room.deleteMany({ where: { createdById: eastTeacherId } });
    await prisma.teacher.deleteMany({ where: { id: { in: [eastTeacherId, westTeacherId] } } });
    // Teacher.accountId is a required FK into Account, so the teacher rows
    // above must be gone before these accounts can be deleted without
    // violating it — and only this teardown ever deletes them, since
    // `account: { create }` in seedTeacher is the only thing that makes them.
    await prisma.account.deleteMany({ where: { id: { in: [eastAccountId, westAccountId] } } });
  });

  it('creates the four-week window and is idempotent on a second run', async () => {
    const id = await makeTemplate(eastTeacherId, 3, '09:00');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl);
    const second = await generateStudioInstancesForTemplate(prisma, tpl);

    expect(first.created).toBe(4);
    expect(second.created).toBe(0);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });

  /**
   * The parity case. `from` is an explicit instant so this does not depend on
   * when the suite runs: it is 14:00 in the teacher's own zone on a day that
   * matches the template's `dayOfWeek`, with the template starting at 09:00
   * — the same 14:00 the inline comment below the fixture names.
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

    expect(created.created).toBe(4);
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

  /**
   * The occupancy read is scoped `where: { teacherId }`, and dropping that
   * scope passed the entire suite — the spec's §4.1 asymmetry, in the direction
   * it calls the only real defect: a pre-check *stricter* than the index
   * silently under-fills a window and nothing raises.
   *
   * Two teachers, same weekday, same start time. The other teacher's class must
   * be invisible here: #196's slot key is `(teacherId, date, startTime)`, so it
   * can never block this one. Unscoped, every one of these dates reads
   * `slot_taken` and this teacher's window comes back empty — with a log line
   * naming the wrong teacher's schedule.
   */
  it('ignores another teacher holding the same weekday and time', async () => {
    const now = new Date();
    const otherId = await makeTemplate(westTeacherId, 5, '16:45');
    const other = await generateStudioInstancesForTemplate(prisma, await withZone(otherId), now);
    expect(other.created).toBe(4);

    const mineId = await makeTemplate(eastTeacherId, 5, '16:45');
    const mine = await generateStudioInstancesForTemplate(prisma, await withZone(mineId), now);

    expect(mine.created).toBe(4);
    expect(mine.skipped).toEqual([]);
  });

  /**
   * The studio twin of the class family's `raced` test. Without it, deleting
   * the `landed` diff loop in this file passes — the ledger's row 6 mutated
   * only the class generator, so half of that guard was untested.
   *
   * Same lever: the holder's row is in flight, so the occupancy read cannot see
   * it while its pending unique entry already blocks the insert.
   */
  it('names a date lost to a concurrent insert as raced, not as filled', async () => {
    const now = new Date();
    const id = await makeTemplate(eastTeacherId, 6, '07:30');
    const tpl = await withZone(id);
    const dates = getNextOccurrences(6, now, 5)
      .filter((d) => classStartInstant(d, '07:30', tpl.scheduleRule.teacher.defaultTimezone) > now)
      .slice(0, 4);
    const collide = dates[2]!;

    const holder = new PrismaClient();
    let release!: () => void;
    let parkedResolve!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { parkedResolve = r; });

    const holding = holder.$transaction(
      async (tx) => {
        await tx.studioClass.create({
          data: {
            teacherId: eastTeacherId,
            // `null`, deliberately, not this template's own id: with the
            // template's `templateId` the holder also collides on the
            // pre-existing `@@unique([templateId, date])`, so this test
            // would pass byte-identically with
            // `StudioClass_teacher_slot_unique` dropped. `null` isolates the
            // collision to the slot key — and is the production shape too: a
            // standalone class racing the nightly
            // `api/cron/generate-classes` sweep onto a template's slot.
            templateId: null,
            classType: 'Holder',
            date: collide,
            startTime: '07:30',
            durationMinutes: 60,
            location: 'Elsewhere',
            hourlyRate: 40,
          },
        });
        parkedResolve();
        await released;
      },
      { timeout: 20_000 },
    );

    await parked;
    const generating = generateStudioInstancesForTemplate(prisma, tpl, now);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holding;
    const result = await generating;
    await holder.$disconnect();

    expect(result.created).toBe(3);
    expect(result.skipped).toEqual([{ date: collide, reason: 'raced' }]);
  });

  it('accepts a transaction client, so a caller can compose it', async () => {
    const id = await makeTemplate(westTeacherId, 4, '08:00');
    const tpl = await withZone(id);

    const created = await prisma.$transaction(
      async (tx) => generateStudioInstancesForTemplate(tx, tpl),
      { timeout: 10_000 },
    );

    expect(created.created).toBe(4);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });

  /**
   * The studio twin of the class family's log test, and a coverage regression
   * this branch caused before it was noticed: `main` carried a
   * `vi.spyOn(log, 'warn')` test here for the P2002 hedge, which was deleted
   * with the hedge and replaced with nothing. So the family whose issue (#192)
   * is entirely about operator visibility had no assertion on its log line at
   * all, while the class family had one.
   *
   * The silence half is the load-bearing one: it is what keeps the noise answer
   * true on an hourly sweep, where every steady-state template would otherwise
   * emit a line per run forever.
   */
  it('logs blocked dates once per call, and stays silent for plain idempotency', async () => {
    const now = new Date();
    const id = await makeTemplate(eastTeacherId, 3, '11:15');
    const tpl = await withZone(id);
    const spy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    try {
      await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(spy).not.toHaveBeenCalled(); // four fresh creates — nothing to say

      await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(spy).not.toHaveBeenCalled(); // four already_generated — the noise rule

      const rows = await prisma.studioClass.findMany({
        where: { templateId: id },
        orderBy: { date: 'asc' },
        select: { id: true, date: true },
      });
      await prisma.studioClass.update({
        where: { id: rows[1]!.id },
        data: { cancelledAt: new Date() },
      });

      await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(spy).toHaveBeenCalledTimes(1);
      // The date, not only the reason: an operator greps this line to find
      // which date is short, and a `new Date()` here instead of `s.date` would
      // name today on every run.
      expect(spy.mock.calls[0]![0]).toMatchObject({
        templateId: id,
        skipped: [{ date: rows[1]!.date.toISOString().slice(0, 10), reason: 'blocked_by_cancelled' }],
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('names a cancelled own instance as blocked_by_cancelled', async () => {
    const now = new Date();
    // 12:15, not 09:00: the earlier "creates the four-week window..." and
    // "logs blocked dates..." tests above leave their own dayOfWeek-3
    // templates behind (this describe's afterEach only clears StudioClass
    // rows, not templates), and `ScheduleRule_teacher_slot_excl` (issue 298)
    // excludes on RANGE overlap, not exact `startTime` match, so a slot here
    // has to clear the full hour those templates occupy (09:00-10:00,
    // 11:15-12:15), not just land on a distinct minute. This test's meaning
    // is indifferent to the exact time — it only reads back the dates the
    // generator itself creates.
    const id = await makeTemplate(eastTeacherId, 3, '12:15');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(first.created).toBe(4);
    expect(first.skipped).toEqual([]);

    const rows = await prisma.studioClass.findMany({
      where: { templateId: tpl.id },
      orderBy: { date: 'asc' },
      select: { id: true, date: true },
    });
    await prisma.studioClass.update({
      where: { id: rows[1]!.id },
      data: { cancelledAt: new Date() },
    });

    const again = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(again.created).toBe(0);
    expect(again.skipped).toContainEqual({
      date: rows[1]!.date,
      reason: 'blocked_by_cancelled',
    });
  });

  it('skips only the slot another studio class occupies', async () => {
    const now = new Date();
    // 13:15: see the comment on the same slot in the "names a cancelled own
    // instance" test above — spaced a full hour past its 12:15 slot, and past
    // the 09:00 and 11:15 ones before it, so the RANGE this template occupies
    // clears all three.
    const id = await makeTemplate(eastTeacherId, 3, '13:15');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
    const dates = (
      await prisma.studioClass.findMany({
        where: { templateId: tpl.id },
        orderBy: { date: 'asc' },
        select: { date: true },
      })
    ).map((r) => r.date);
    expect(first.created).toBe(4);
    await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

    await prisma.studioClass.create({
      data: {
        teacherId: tpl.scheduleRule.teacherId,
        templateId: null,
        classType: 'Manual',
        date: dates[1]!,
        startTime: timeToHHmm(tpl.scheduleRule.startTime),
        durationMinutes: 60,
        location: 'Elsewhere',
        hourlyRate: 50,
      },
    });

    const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(result.created).toBe(3);
    expect(result.skipped).toEqual([{ date: dates[1]!, reason: 'slot_taken' }]);
  });

  /**
   * #296. The other family holds the slot — a `Class`, not a `StudioClass` —
   * so `slot_taken` is the WRONG answer here even though both mean "occupied".
   * The remedy differs: `slot_taken` is answered among the teacher's studio
   * classes, this one sends them to the other half of their schedule.
   *
   * Asserts the skipped DATE as well as the reason. A count alone passes if the
   * generator blocks the wrong date, which the mutation of the pre-check would
   * not catch either.
   */
  it('skips a date held by a live class from the other family', async () => {
    const now = new Date();
    // 14:15: `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE
    // overlap, so this has to clear the four dayOfWeek-3 templates this
    // describe's earlier tests leave behind (09:00, 11:15, 12:15, 13:15),
    // each an hour wide — see the comment on "names a cancelled own instance"
    // above for why they're never cleaned up mid-describe.
    const id = await makeTemplate(eastTeacherId, 3, '14:15');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
    const dates = (
      await prisma.studioClass.findMany({
        where: { templateId: tpl.id },
        orderBy: { date: 'asc' },
        select: { date: true },
      })
    ).map((r) => r.date);
    expect(first.created).toBe(4);
    await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

    await prisma.class.create({
      data: {
        teacherId: tpl.scheduleRule.teacherId,
        teacherRoomId: eastTeacherRoomId,
        classType: 'Cross Family',
        date: dates[1]!,
        startTime: timeToHHmm(tpl.scheduleRule.startTime),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 30,
        targetRate: 60,
        minStudents: 3,
        maxStudents: 10,
      },
    });

    const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(result.created).toBe(3);
    expect(result.skipped).toEqual([{ date: dates[1]!, reason: 'blocked_by_other_family' }]);
  });

  it('does not skip a date held by a CANCELLED class from the other family', async () => {
    // The mirror of the same-family cancelled case below, and it pins the same
    // predicate the trigger carries (`status <> 'cancelled'`). Widen the
    // pre-check past liveness and this goes red.
    const now = new Date();
    // 15:15: one more hour past the "skips a date held by a live class..."
    // test's 14:15 — see its comment for why this describe's dayOfWeek-3
    // slots have to stack an hour apart rather than a minute apart.
    const id = await makeTemplate(eastTeacherId, 3, '15:15');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
    const dates = (
      await prisma.studioClass.findMany({
        where: { templateId: tpl.id },
        orderBy: { date: 'asc' },
        select: { date: true },
      })
    ).map((r) => r.date);
    expect(first.created).toBe(4);
    await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

    await prisma.class.create({
      data: {
        teacherId: tpl.scheduleRule.teacherId,
        teacherRoomId: eastTeacherRoomId,
        classType: 'Cross Family Cancelled',
        date: dates[1]!,
        startTime: timeToHHmm(tpl.scheduleRule.startTime),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 30,
        targetRate: 60,
        minStudents: 3,
        maxStudents: 10,
        status: 'cancelled',
      },
    });

    const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(result.created).toBe(4);
    expect(result.skipped.map((slot) => slot.reason)).not.toContain('blocked_by_other_family');
  });

  it('does not treat a cancelled neighbour as occupying the slot', async () => {
    const now = new Date();
    // 16:15: see the comment on the same slot in the "names a cancelled own
    // instance" test above — the last of this describe's dayOfWeek-3 slots,
    // an hour past the 15:15 one before it.
    const id = await makeTemplate(eastTeacherId, 3, '16:15');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
    const dates = (
      await prisma.studioClass.findMany({
        where: { templateId: tpl.id },
        orderBy: { date: 'asc' },
        select: { date: true },
      })
    ).map((r) => r.date);
    expect(first.created).toBe(4);
    await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

    await prisma.studioClass.create({
      data: {
        teacherId: tpl.scheduleRule.teacherId,
        templateId: null,
        classType: 'Manual',
        date: dates[1]!,
        startTime: timeToHHmm(tpl.scheduleRule.startTime),
        durationMinutes: 60,
        location: 'Elsewhere',
        hourlyRate: 50,
        cancelledAt: new Date(),
      },
    });

    // #196's studio index carries `WHERE "cancelledAt" IS NULL`.
    const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
    expect(result.created).toBe(4);
    expect(result.skipped).toEqual([]);
  });
});

// ===========================================================================
// Per-template isolation — stubbed db, no real DB
// ===========================================================================

describe('generateStudioClassInstances (per-template isolation)', () => {
  function tmpl(id: string, teacherId: string) {
    return {
      id,
      location: 'Stub Studio',
      hourlyRate: 45,
      scheduleRule: {
        teacherId,
        dayOfWeek: 0,
        startTime: hhmmToTime('09:00'),
        classType: 'Hatha',
        durationMinutes: 60,
        // generateStudioInstancesForTemplate (#94) now reads
        // template.scheduleRule.teacher.defaultTimezone to decide whether
        // today's occurrence has already started; UTC keeps that decision
        // equal to plain instant comparison so it doesn't interact with this
        // test's own fixture dates.
        teacher: { defaultTimezone: 'UTC' },
        // The claim's own re-check (`claimTemplateForGeneration`'s docblock,
        // class-generator.ts) reads these off this same fixture — omitting
        // them would make every claim in this test come back ineligible and
        // defeat it.
        isActive: true,
        isArchived: false,
      },
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
      // #296: the generator now reads the OTHER family's occupancy too. Empty,
      // because this test is about error isolation between templates and not
      // about occupancy — but it has to EXIST, or every template fails on
      // `Cannot read properties of undefined (reading 'findMany')` and the test
      // passes its `rejects.toThrow` for a reason that has nothing to do with
      // what it pins.
      class: {
        findMany: async () => [],
      },
      studioClass: {
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

    await expect(generateStudioClassInstances(stub, from)).rejects.toThrow('boom-A');
    expect(created).toContain('B'); // B generated despite A failing before and C failing after

    // Both failing templates are logged, not just the one that's rethrown.
    const loggedTemplateIds = spy.mock.calls.map((c) => (c[0] as { templateId?: string }).templateId);
    expect(loggedTemplateIds).toContain('A');
    expect(loggedTemplateIds).toContain('C');
    spy.mockRestore();
  });
});
