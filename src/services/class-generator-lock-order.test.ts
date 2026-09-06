/**
 * @serial-tier lock-contention — every case here stages a two-party wait and
 * then asserts how it came out, and the staging is built out of wall-clock
 * intervals: a 100ms handshake before the second party starts, a 300-400ms
 * hold, a 300ms look at whether the queued party has settled. Those intervals
 * are what a parallel tier-mate stretches. Which way a case breaks when they
 * stretch depends on what it does with the hold, and the shapes below are told
 * apart by that rather than by name — a case added here belongs to whichever
 * one its own staging matches.
 *
 * THE ONES THAT RELEASE BEFORE THE QUEUED VERB'S BOUND EXPIRES, and assert the
 * answer it gives once it finally takes the row. Their unsettled flags
 * (`archiveSettled`, `sweepSettled`) and their `waitedMs` floor cannot be
 * broken by lateness; a slower tier only keeps the queued party queued
 * longer. The margin at risk is the one AFTER the release: the queued
 * archive, pause or sweep still has to take the row inside the 2s
 * `lock_timeout` `setLockTimeout` (`db-locks.ts`) puts on it, and staging the
 * race already spends 400-500ms of that on purpose. Stretch the release path
 * — the sleep resolving, `release()`/`commit()`, the holder's `COMMIT` — past
 * what is left and the queued party answers `busy` where a case of this shape
 * asserts an `ok`.
 *
 * Within that shape, a case whose closing assertion is that nothing was
 * MATERIALISED goes wrong QUIETLY, and that is the sharpest reason this file
 * is not in the parallel tier: a sweep whose claim gave up at the bound
 * materialises nothing either, because `generateClassInstances` swallows a
 * per-template `55P03` as a warn and carries on to the next template. Lateness
 * therefore leaves such a case GREEN while proving nothing about the mid-sweep
 * write it exists to prove is seen. A case asserting that something WAS
 * created goes red in the same circumstance. Same shape, opposite directions,
 * and the silent one is why an assertion of ABSENCE here cannot live in a
 * parallel tier even where its loud counterpart could.
 *
 * THE ONES THAT HOLD PAST THE BOUND ON PURPOSE, asserting the `busy` the
 * queued verb gives up with and a `waited >= 1_800` floor lateness can only
 * raise. What such a case stands to lose is the SHAPE of the answer against an
 * OUTER ceiling: the Prisma `{ timeout: … }` budget on the holder itself, tens
 * of seconds here, and the vitest budget on the case. Stretch the span from
 * opening the holder to releasing it past the holder's budget and Prisma
 * aborts the holder — which frees the row, lets the queued verb commit, and
 * returns the `ok` that reads as a missing guard. No CEILING on `waited` is
 * asserted anywhere here (#323 took the wall-clock ceilings off this repo's
 * lock-timeout cases), so a widened bound is not something this shape can
 * catch; `db-locks.test.ts` is where that value is pinned.
 *
 * THE ONES THAT RACE AN INDEX ENTRY RATHER THAN A ROW. A second client holds
 * an uncommitted colliding INSERT, so the generator's occupancy pre-check (a
 * plain read under READ COMMITTED) cannot see it and the generator's own
 * insert parks on the holder's pending index entry. Nothing in this shape
 * waits on a bound at all — `generateInstancesForTemplate` issues no
 * `SET LOCAL lock_timeout` — so lateness cannot time anything out. What it can
 * do is invert the ORDER such a case needs: each asserts the reason a LOST
 * race produces (`blocked_by_overlap`, `raced`), and a pre-check that runs
 * after the holder's release instead sees a committed neighbour and answers
 * `slot_taken` or `already_generated`. The reason is the whole assertion, so
 * such a case fails having never staged its race.
 *
 * WHAT THIS FILE COSTS THE TIER, as against what the tier costs it: the holds
 * run for seconds, several cases open a second `PrismaClient` to take them,
 * and the index-entry races keep a pending `CalendarEntry` row alive,
 * uncommitted, across the hold.
 * Every row is this file's own — one teacher, minted under the suffix below —
 * so no tier-mate can collide with one; what it spends is the tier's
 * contention budget, which is the trigger `vitest.tiers.ts` names rather than
 * any single call site.
 *
 * WHY A SEPARATE FILE RATHER THAN AN ENTRY FOR `class-generator.test.ts`
 * (#468). Listing a path on `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`)
 * decides the tier for everything that filename will ever hold, not just for
 * what is in it today — so the next person writing an ordinary case about
 * candidate dates or skip reasons would pay for a property their test has
 * nothing to do with. That file is the general suite for the generator's two
 * entry points and grows steadily; this one grows only when someone stages
 * another race. What the two arrangements cost in seconds was measured, and
 * came out close enough to decide nothing —
 * `docs/superpowers/specs/2026-09-06-lock-contention-rest-design.md` §2.1
 * carries the per-file figures.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { classStartInstant } from '@/lib/timezone';
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
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
// PREFIXED rather than left as a bare clock read: this file shares one test
// database with `class-generator.test.ts`, which it was split from, and with
// its serial tier-mates, and they all mint their fixtures from a clock value,
// so two clock reads are not a namespace. The prefix is spelled from this
// file's own name rather than from the shared subject, which makes the
// namespaces disjoint by construction rather than by luck, and the `afterAll`
// below deletes by this file's own `teacherId` and nothing wider.
const uniqueSuffix = `genlock-${Date.now()}`;

describe('the class generator under staged lock contention (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let templateId: string;
  let templateScheduleRuleId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'GeneratorLock',
        lastName: 'Teacher',
        email: `generator-lock-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `generator-lock-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for the generator lock races',
        pageSlug: `generator-lock-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Generator Lock Studio',
        address: `${uniqueSuffix} Generator Lock St`,
        city: 'Amsterdam',
        postcode: '1234GL',
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

    // 09:00 on schema weekday 1 (Tuesday), 75 minutes. Both numbers are
    // load-bearing rather than decorative: `candidates` asks
    // `getNextOccurrences` for weekday 1 and filters on a 09:00 start, and
    // `classRow` collides with the generator by inserting at the same minute,
    // so a fixture on another day or hour makes those helpers select and
    // collide with nothing.
    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId, kind: 'regular', classType: 'Vinyasa', dayOfWeek: 1,
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
    // Keyed on this file's own `teacherId` throughout: the sibling suite's
    // fixture lives in the same database, and a sweep scoped any wider would
    // reach into it. Dependency order — entries first (each takes its `Class`
    // child with it), then the rules (each takes its `ClassTemplate`,
    // `onDelete: Cascade` since #298), then the room link, the room, the
    // teacher and the account that owns its identity.
    //
    // In a `finally`, so a failed delete cannot also leak the connection pool
    // — the convention `0c0f43b7` set for these files.
    try {
      const { accountId } = await prisma.teacher.findUniqueOrThrow({
        where: { id: teacherId },
        select: { accountId: true },
      });
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.scheduleRule.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
      await prisma.room.delete({ where: { id: roomId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: accountId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  /** The template with the `teacher.defaultTimezone` join the generator requires. */
  async function freshTemplate() {
    return prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    });
  }

  describe('claimTemplateForGeneration', () => {
    // The archive case below commits for real, leaving `isArchived: true` and
    // `isActive: false` on the fixture every later describe needs live again.
    // The `busy` cases are meant to roll their own writes back instead — but
    // "rolls back" is the thing under test, and the edit one aims
    // `classType` at the row, so a bound that stopped working would leave that
    // column written for whatever is added here next. Captured rather than
    // hardcoded because the value belongs to the fixture above.
    //
    // `archivedAt` is deliberately left where it lands: the archive pre-lock
    // case at the bottom of this file measures "nothing changed" against what
    // it finds rather than against null, and says so.
    let originalClassType: string;

    beforeAll(async () => {
      const rule = await prisma.scheduleRule.findUniqueOrThrow({
        where: { id: templateScheduleRuleId },
      });
      originalClassType = rule.classType;
    });

    afterEach(async () => {
      await prisma.scheduleRule.update({
        where: { id: templateScheduleRuleId },
        data: { isActive: true, isArchived: false, classType: originalClassType },
      });
    });

    /**
     * The case that pins the claim's `FOR UPDATE`. The predicate cases in
     * `class-generator.test.ts` — archived, paused, gone, committed after the
     * caller's read — pass with or without it, because not one of them runs
     * concurrently with anything.
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
      try {
        // Without FOR UPDATE the archive's UPDATE is unobstructed and this is true.
        expect(archiveSettled).toBe(false);
      } finally {
        // Releases the claim's `FOR UPDATE` on this template's `ClassTemplate`
        // row. In a `finally`, so a failure above fails this test alone
        // instead of parking that row for the claim's full
        // `{ timeout: 15_000 }` budget. `archiving` is joined here rather than
        // below because it writes the `isActive`/`isArchived` columns this
        // block's `afterEach` restores — unjoined it commits after the
        // restore and hands whatever runs next an archived fixture.
        release();
        await claiming;
        await archiving;
      }

      const result = await archiving;
      expect(result.ok).toBe(true);
    });

    /**
     * Replaces a test that held the claim for 5.5s and asserted the archive
     * still resolved `ok: true`, proving `{ timeout: 10_000 }` beat Prisma's
     * 5s default. That proof is now unwritable: the archive takes a 2s
     * `lock_timeout`, so it can no longer wait 5.5s for a row under any
     * budget. The 10s budget still matters — it now covers the archive's own
     * work rather than its wait — and what pins that it is still passed is
     * `class-generator.test.ts`'s `opens the … transaction with
     * { timeout: 10_000 }` tests — one beside each template mutation that has
     * to beat the claim, each spying on this family's own client.
     * Not `studio-class-generator.test.ts`'s spy, which proxies
     * `archiveOrUnarchiveStudioTemplate` — a different function in a different
     * module, and no evidence about this one.
     *
     * What this pins instead is the bound itself, and the timing assertions
     * are how. Without the `lock_timeout` the archive does not fail later —
     * it does not settle at all: the claim holds the row until `release()`,
     * `release()` only runs after the archive settles, and the transaction
     * budget cannot break that tie, because Prisma checks it at statement
     * boundaries and a statement blocked inside Postgres never reaches one
     * (`src/lib/db-locks.ts` says so; the mutation record's Task 1 measured
     * it as a 20s test timeout). So the lower bound proves the archive really
     * waited rather than failing instantly for an unrelated reason. It is the
     * only bound asserted, for the reason the body's own comment gives, and it
     * pins nothing about the bound's exact value — `db-locks.test.ts` does
     * that.
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
          // (#323, `waitlist-lock-order.test.ts`'s "gives up on the 2s bound
          // when another transaction holds the class row" docblock): the 2s
          // value is pinned by `db-locks.test.ts`, and a wall-clock ceiling
          // flakes under parallel CPU contention.
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
     * The PAUSE arm, not the resume, and the asymmetry is structural: a resume
     * can never lose this race, because the claim only locks ACTIVE templates
     * (`WHERE "isActive" = true`) and a resume only ever runs on a paused one,
     * so there is no row for the two to contend over. The arm that genuinely
     * contends with the sweep is the pause — active template, claim holds the
     * row, the pause's update blocks on it. Recorded in the mutations file
     * under Task 3.
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
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323,
          // `waitlist-lock-order.test.ts`'s "gives up on the 2s bound when another
          // transaction holds the class row" docblock).
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
          // restores `isActive`/`isArchived`/`classType` unconditionally. Kept,
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
     * issues `SET LOCAL lock_timeout`, which is why the derivation beside
     * `class-generator.test.ts`'s `opens the template-edit transaction with
     * { timeout: 10_000 }` counts one waitable statement in that transaction
     * and not two.
     *
     * Named for the edit specifically. `answers busy when the generation claim
     * holds the row past the lock timeout`, in this same `describe`, is the
     * archive's version of it — so without the suffix the two carried one
     * title, the failure header was ambiguous between them under mutation, and
     * `vitest -t` could select neither.
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
      // Nothing earlier in this file generates for this template, and the
      // closing assertion is still a count of ZERO — so the baseline is
      // cleared and asserted here rather than inherited, and a row left
      // behind by anything else would read as a generation this test never
      // triggered.
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
      try {
        // Without the child lock above, the sweep sails past the claim and has
        // already created the window by now.
        expect(sweepSettled).toBe(false);
      } finally {
        // Releases the staged archive, which holds this template's
        // `ClassTemplate` row lock and the uncommitted `ScheduleRule` write
        // above it. In a `finally`, so a failure above fails this test alone
        // instead of holding both for the transaction's full
        // `{ timeout: 15_000 }` budget: this block's `afterEach` updates that
        // same `ScheduleRule` row and would block behind it. `sweeping` is
        // joined here rather than below because it runs on the shared `prisma`
        // client and is still creating the `CalendarEntry` rows that same
        // `afterEach` deletes.
        //
        // 3. Commit the archive; the claim unblocks and sees isArchived: true.
        commit();
        await archiving;
        await sweeping;
      }

      // 4. Nothing was materialised for a template the teacher shelved.
      expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: templateId } } } } } })).toBe(0);
    });
  });

  describe('generateClassInstances — edit mid-sweep', () => {
    // Captured, not hardcoded: the fixture's Tuesday 09:00 slot is what
    // `candidates` asks `getNextOccurrences` for and what `classRow` collides
    // with further down, so a guessed restore value would leave those helpers
    // selecting and colliding with nothing.
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
      try {
        expect(sweepSettled).toBe(false);
      } finally {
        // Releases the staged edit, which holds this template's
        // `ClassTemplate` row lock and the uncommitted `ScheduleRule` write
        // above it. In a `finally`, so a failure above fails this test alone
        // instead of holding both for the transaction's full
        // `{ timeout: 15_000 }` budget: this block's `afterEach` restores
        // `dayOfWeek` and `startTime` on that same `ScheduleRule` row and
        // would block behind it. `sweeping` is joined here rather than below
        // because it runs on the shared `prisma` client and is still creating
        // the `CalendarEntry` rows that same `afterEach` deletes.
        //
        // 3. Commit. The claim unblocks and re-reads under its own lock.
        commit();
        await editing;
        await sweeping;
      }

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

  describe('generateInstancesForTemplate — slot reporting', () => {
    /** The same four dates the generator will choose, computed the same way. */
    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant({ date: d, startTime: hhmmToTime('09:00') }, 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    afterEach(async () => {
      // Both cases below leave three generated classes plus the holder's
      // committed collider behind, on the four candidate dates the next one
      // computes from the same weekday — so the slate is cleared between
      // them rather than at the start of each.
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
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
     * `landed` in `entry-generation.ts`.
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

      let generating: ReturnType<typeof generateInstancesForTemplate> | undefined;
      try {
        // The generator starts with the holder's row in flight, so its occupancy
        // read cannot see the colliding date and its insert parks on the pending
        // entry; the other three dates insert cleanly.
        await parked;
        generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
        await new Promise((r) => setTimeout(r, 400));
        release();
        await holding;
        const result = await generating;

        expect(result.created).toBe(3);
        expect(result.skipped).toEqual([{ date: collide, reason: 'blocked_by_overlap' }]);
      } finally {
        // The span starts where the holder is in flight, because everything
        // below that point can reject before `release()` runs —
        // `freshTemplate()` is a database read sitting in an argument list —
        // and the generator's insert is already parked on the holder's
        // uncommitted `CalendarEntry`, so an unreleased holder pins both for
        // its full `{ timeout: 20_000 }` budget. `generating` is joined here
        // rather than left running because it writes `CalendarEntry` rows for
        // this `teacherId` on the shared `prisma` client, which is exactly
        // what this block's `afterEach` deletes between cases.
        release();
        try {
          await holding;
          await generating;
        } finally {
          // Nested, so a rejecting join above cannot skip the disconnect: this
          // holder owns a `PrismaClient` of its own, and an undisconnected one
          // leaks its pool for the rest of the run.
          await holder.$disconnect();
        }
      }
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

      let generating: ReturnType<typeof generateInstancesForTemplate> | undefined;
      try {
        await parked;
        generating = generateInstancesForTemplate(prisma, await freshTemplate(), now);
        await new Promise((r) => setTimeout(r, 400));
        release();
        await holding;
        const result = await generating;

        expect(result.created).toBe(3);
        expect(result.skipped).toEqual([{ date: collide, reason: 'raced' }]);
      } finally {
        // The span starts where the holder is in flight, because everything
        // below that point can reject before `release()` runs —
        // `freshTemplate()` is a database read sitting in an argument list —
        // and the generator's insert is already parked on the holder's
        // uncommitted `(scheduleRuleId, date)` entry, so an unreleased holder
        // pins both for its full `{ timeout: 20_000 }` budget. `generating` is
        // joined here rather than left running because it writes
        // `CalendarEntry` rows for this `teacherId` on the shared `prisma`
        // client, which is exactly what this block's `afterEach` deletes
        // between cases.
        release();
        try {
          await holding;
          await generating;
        } finally {
          // Nested, so a rejecting join above cannot skip the disconnect: this
          // holder owns a `PrismaClient` of its own, and an undisconnected one
          // leaks its pool for the rest of the run.
          await holder.$disconnect();
        }
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
     * THE DIRECTION, which is easy to read backwards: the holder is never
     * blocked. It inserts first and holds; the RESUME is the party that waits.
     * Pushing the hold past the 2s `setLockTimeout` bound turns that wait into
     * `busy`, which is what "answers busy when the clash outlives the lock
     * timeout, instead of reporting it raced" pins — the bound reaches
     * whichever statement does the waiting, and since #272 that statement is
     * the CAS, as that case's own comment says.
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
     * far — every contention test that branch shipped stops at the CAS.
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
          // `pg_stat_activity` on the `raceResumeAgainst` cases above: the
          // resume sat in `Lock:transactionid` on `UPDATE "ScheduleRule" SET
          // "isActive" = $1 …` for the whole hold. Same 2s bound, same
          // `busy`, one statement earlier than #116's claim. Under #327 the
          // wait sat at the insert instead; without #272 that is where this
          // test's bound would still bite.
          await parked;
          const startedAt = Date.now();
          const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');
          const waited = Date.now() - startedAt;

          expect(result).toEqual({ ok: false, reason: 'busy' });
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323,
          // `waitlist-lock-order.test.ts`'s "gives up on the 2s bound when another
          // transaction holds the class row" docblock).
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
   * Named for the `deleteMany` originally, back when that was the only
   * statement in this transaction that could contend for a `Class` row it
   * did not already hold. Issue 180 task 4 added an ordered pre-lock ahead of
   * it, over a superset of the `Class` rows the `deleteMany` can match, so
   * the pre-lock is now what blocks in THIS test's scenario — a booking
   * holding one of those rows. This test still measures the same guarantee:
   * the 2s bound reaches an ordinary booking, not just the generation sweep.
   *
   * The `deleteMany` is not itself immune to waiting, and the claim here is
   * only about which statement blocks in THIS scenario: the delete cascades
   * onto `Registration` and `WaitlistEntry` children (`onDelete: Cascade`)
   * that no `Class` pre-lock covers, and its predicate is re-evaluated at
   * execution time, so a row moved into scope after the pre-lock ran is not
   * held either. See the pre-lock's own comment in
   * `class-template-lifecycle.ts`.
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
        //
        // For `archivedAt` that is defensive — it is genuinely non-null by the
        // time this runs. For `withdrawnCount` it is LOAD-BEARING: no earlier
        // case here archives a template that has classes to withdraw, so the
        // captured count is zero, while a rollback that still recorded what it
        // would have withdrawn writes `generated.created` over it. The equality
        // discriminates on this fixture, which it would not against a count an
        // earlier case had already left non-zero.
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
          // Lower bound proves it waited on the lock. Pinned by db-locks.test.ts (#323,
          // `waitlist-lock-order.test.ts`'s "gives up on the 2s bound when another
          // transaction holds the class row" docblock).
          expect(waited).toBeGreaterThanOrEqual(1_800);

          // The CAS had already succeeded when the pre-lock blocked (issue
          // 180 task 4 — the `deleteMany` never runs; see this describe's own
          // docblock), so this also pins that the rollback took the
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
