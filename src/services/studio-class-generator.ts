/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { spansOverlap } from '@/lib/generation';
import { probeOverlappingCandidates } from '@/lib/entry-conflict';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { getNextOccurrences } from './class-generator';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { classStartInstant } from '@/lib/timezone';
import { log } from '@/lib/log';

const DEFAULT_WEEKS = 4;

/**
 * The studio mirror of `class-generator.ts`'s `TemplateWithTimezone`. The
 * teacher's zone is not decoration: `generateStudioInstancesForTemplate`
 * needs it to decide whether today's class has already started, and
 * `StudioClassTemplate` carries no zone of its own.
 */
type StudioTemplateWithTimezone = Prisma.StudioClassTemplateGetPayload<{
  include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
}>;

/**
 * Claims a studio template for generation, or reports it is no longer
 * eligible. The studio mirror of `claimTemplateForGeneration` in
 * `class-generator.ts` — see that function for why the lock, and not a
 * re-read, is what closes the race (#95).
 *
 * Deliberately a second copy rather than one helper generic over a Prisma
 * delegate: the two families are kept parallel-but-separate throughout, and a
 * generic version would have to interpolate the table name into raw SQL.
 *
 * Must be called with a transaction client, never a bare `PrismaClient` — see
 * `claimTemplateForGeneration` for what that would silently break: `SET
 * LOCAL` becomes a no-op with nothing to scope to, and the row lock releases
 * the instant the `SELECT` completes. That used to mean the claim returned
 * `true` while holding nothing; it is not gone, and it now has a second
 * consequence: the `findUniqueOrThrow` below then runs unlocked too, and can
 * throw P2025 if the row is deleted out from under it before that second
 * statement runs.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking
 * `StudioClass` inserts — it looks like a free optimisation but isn't.
 * `FOR UPDATE` is what makes a concurrent insert for this template
 * impossible, because an insert's FK check takes `FOR KEY SHARE` on this row,
 * which `FOR UPDATE` conflicts with and `FOR NO KEY UPDATE` does not. Measured
 * on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateStudioInstancesForTemplate` no longer has a P2002 branch to be
 * broken — the per-template generator below, not the sweep, which never had
 * one because it issues no insert of its own.
 * Its `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort
 * nothing, with or without this lock. The lock still earns its place by
 * keeping the values this claim returns authoritative (#102).
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and a first-pass eligibility filter;
 * the Prisma read below is what makes both the VALUES and the eligibility
 * VERDICT authoritative — `claimTemplateForGeneration`'s docblock carries the
 * measurement for why the raw statement's own `WHERE` cannot be trusted alone
 * once it had to wait on the child lock — and it is safe precisely because
 * the lock is still held when it runs. Two statements rather than one
 * `SELECT *` because `hourlyRate` is `DECIMAL(10,2)` and a raw row does not
 * hand back Prisma's `Decimal`.
 */
export async function claimStudioTemplateForGeneration(
  tx: TransactionClientOnly,
  templateId: string,
): Promise<StudioTemplateWithTimezone | null> {
  // `LOCK_TIMEOUT_SQL` (`@/lib/db-locks`) — shared with `lockClassRow`, which
  // takes the `Class` row lock this one deadlocks against, so the two waits
  // are the same length by construction rather than by coincidence. Its
  // docblock carries the reason `$executeRawUnsafe` is safe for it.
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT sct."id" FROM "StudioClassTemplate" sct
      JOIN "ScheduleRule" sr ON sr."id" = sct."scheduleRuleId"
    WHERE sct."id" = ${templateId}
      AND sr."isActive" = true
      AND sr."isArchived" = false
    FOR UPDATE OF sct`;
  // Silent on purpose: this row's own `WHERE` did not match, which for the
  // sweep's caller is the ordinary "not selected" case — see
  // `claimTemplateForGeneration`'s twin (`class-generator.ts`) for why that
  // is routine and not worth logging, and for the branch below this one that
  // is.
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  const fresh = await tx.studioClassTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });

  // The authoritative eligibility check — see `claimTemplateForGeneration`'s
  // docblock (class-generator.ts) for why the raw statement's own `WHERE`
  // cannot be trusted alone when it had to wait. This read is a fresh
  // statement taken under the lock, so it sees whatever the row that made us
  // wait actually committed.
  if (!fresh.scheduleRule.isActive || fresh.scheduleRule.isArchived) {
    // Mirrors `claimTemplateForGeneration`'s own log at this branch
    // (class-generator.ts): this null is the measured `EvalPlanQual` race
    // actually landing, not the ordinary "not selected" case above.
    // `pauseOrResumeRule`'s call site (`rule-lifecycle.ts`, reached for this
    // family by `pauseOrResumeStudioTemplate`) treats reaching this as
    // impossible and throws right after; logging here first costs it
    // nothing and gives the sweep's silent `return 0` the trace it does not
    // otherwise get.
    log.warn({ templateId }, 'studio class generation claim matched but found the row ineligible on re-check');
    return null;
  }

  return fresh;
}

/**
 * Generates the rolling 4-week window for ONE studio template, reporting each
 * candidate date it could not fill and why (`GenerationResult`). The studio
 * twin of `generateInstancesForTemplate` (`class-generator.ts`) — same client
 * union, same optional `from`, same result shape — so the two families can be
 * read against each other.
 *
 * Same two mechanisms as the class family:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped,
 *     which is what lets the teacher be told something true and an operator
 *     grep for it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` on the ENTRY compiles to
 *     a BARE `ON CONFLICT DO NOTHING` — no conflict target, so it covers every
 *     conflict the row can raise, `CalendarEntry_teacher_slot_excl` (an
 *     EXCLUSION constraint, which a targeted `DO UPDATE` could not name)
 *     included alongside `@@unique([scheduleRuleId, date])`. That is what
 *     makes a clash cost only its own date. Pinned by this file's "names a
 *     date lost to a concurrent insert as raced, not as filled" test: a holder
 *     entry with `scheduleRuleId: null` parks on a date/time the slot
 *     constraint covers, isolated from the rule-date key, and the generator's
 *     own transaction still creates the other three dates and commits rather
 *     than aborting.
 *
 * This function's P2002 hedge used to document the same 25P02 trap the class
 * family's did (#164): a caught `P2002` inside an interactive transaction
 * aborts it, and the next statement fails with `25P02`. It is gone for the
 * same reason — the hedge could not work, only quietly poison. Do not
 * reintroduce a `catch` here.
 *
 * Takes `PrismaClient | Prisma.TransactionClient` so a caller can compose it
 * into a transaction it already owns. That is the whole reason this function
 * exists: before #94 the loop was inlined in the sweep, so
 * `pauseOrResumeStudioTemplate` had nothing to call but the platform-wide
 * sweep, and left a resumed template empty until the next cron run.
 */
export async function generateStudioInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. Ported from
  // the class family in #94 — the studio side had no such filter, so the hourly
  // sweep could materialise a class that had already started.
  //
  // `template.scheduleRule.startTime` is already a `@db.Time` `Date` — passed
  // straight through rather than round-tripped via `timeToHHmm`, which exists
  // for the wire boundary, not for a value that already carries the type
  // `classStartInstant` and `CalendarEntry.startTime` both want.
  const startTime = template.scheduleRule.startTime;
  const dates = getNextOccurrences(template.scheduleRule.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant({ date, startTime }, template.scheduleRule.teacher.defaultTimezone) >
        startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // ONE query for the whole window, over `CalendarEntry` — which since #327 is
  // where both families' occupancy lives, so the separate cross-family read
  // that used to sit below this one is gone. Scoped to this teacher because
  // `CalendarEntry_teacher_slot_excl` is `("teacherId" WITH =, span WITH &&)`,
  // so another teacher's entry can never block this one and must not be read.
  //
  // `durationMinutes` comes back because that constraint is a RANGE, so the
  // pre-check has to compare spans rather than start times.
  const occupants = await db.calendarEntry.findMany({
    where: { teacherId: template.scheduleRule.teacherId, date: { in: dates } },
    select: {
      scheduleRuleId: true,
      kind: true,
      date: true,
      startTime: true,
      durationMinutes: true,
      cancelledAt: true,
    },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  /** What every candidate in this window would occupy — the same for all of
   * them, since a template has one start time and one duration. */
  const candidateSpan = {
    startTime,
    durationMinutes: template.scheduleRule.durationMinutes,
  };

  for (const date of dates) {
    const onDate = occupants.filter((e) => e.date.getTime() === date.getTime());

    const own = onDate.find((e) => e.scheduleRuleId === template.scheduleRuleId);
    if (own) {
      // `@@unique([scheduleRuleId, date])` is TOTAL rather than partial on
      // liveness, so a cancelled own row makes the date permanently unfillable
      // rather than already filled. This is the live path #192 was filed
      // about: it runs on every sweep and, before that change, said nothing.
      skipped.push({
        date,
        reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors the partial predicate `CalendarEntry_teacher_slot_excl` carries
    // (`WHERE "cancelledAt" IS NULL`); the constraint backs it since #327;
    // this pre-check is what names the reason, not what enforces it. Widen or
    // narrow one without the other and this pre-check starts disagreeing with
    // the constraint that backs it — see the class family's equivalent
    // tripwire (`class-generator.ts`) and the spec's §4.1.
    const live = onDate.filter((e) => e.cancelledAt === null);

    // Exact start, this family — the report a teacher can act on without
    // leaving this half of their schedule.
    if (
      live.some((e) => e.kind === 'studio' && e.startTime.getTime() === startTime.getTime())
    ) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    // AFTER `slot_taken`, deliberately: when this teacher holds the slot in
    // BOTH families, the same-family cause is the one worth reporting. A
    // reporting preference, not a guarantee — but it costs nothing to state,
    // since both branches `continue` and no row is created either way.
    //
    // Any live entry of this teacher whose span overlaps the candidate blocks
    // it here — the class twin carries the same note, and `SkipReason`'s own
    // docblock (`@/lib/generation`) is where the reason lives rather than in
    // either generator.
    if (live.some((e) => spansOverlap(e, candidateSpan))) {
      skipped.push({ date, reason: 'blocked_by_overlap' });
      continue;
    }

    free.push(date);
  }

  // NO CATCH, and #296 is the second issue to reach for one here and be
  // wrong. THIS FUNCTION'S OWN docblock already says it — not a sibling
  // function's, which makes the objection stronger rather than weaker: "Do not
  // reintroduce a `catch` here." The class twin's docblock adds the reason —
  // "there is nothing it can do that the constraint does not" — and this file
  // carries only the instruction, so the quote stops where its source does.
  // (Two earlier versions got this wrong in two different ways: one credited
  // the sentence to `claimTemplateForGeneration`, which contains it nowhere;
  // the correction then quoted the CLASS file's longer wording as though it
  // were this file's. Both were the same mistake — a claim about one of two
  // parallel files asserted about both.)
  //
  // A `catch` with a per-date retry shipped on this branch and was measured
  // non-functional. Everything in this paragraph is the TRIGGER era: the
  // `RAISE EXCEPTION` it turns on came from the cross-family guards #327
  // replaced, so read it as why a retry was wrong then, not as what an insert
  // does now. Every production caller of the two generators passes a
  // TRANSACTION client — six across the pair, three per generator;
  // `class-generator.ts`'s function docblock states its own three, and this
  // file's states no caller count at all, so do not read the number as coming
  // from here. Prisma takes no
  // savepoint per statement, and a `RAISE EXCEPTION` aborts the Postgres
  // transaction — so the first retried `create` returns `25P02 current
  // transaction is aborted`, which `isCrossFamilySlotConflict` correctly
  // declines, and the rethrow costs the whole window anyway. It also cost more
  // than that: the escaping error stopped being the `YG001` that the TWO
  // template POST catches used to match. Two, not the ten endpoints answering a
  // cross-family 409 overall — and NOT because those two were the only callers
  // that wrap generation, which is false: six do, including both sweeps and both
  // pause/resume services, as the sentence four lines up says. They were the
  // only generation-wrapping callers that caught `YG001`. The other four let it
  // reach `withErrorHandler`, where `classifyApiError` has no arm for it and
  // answers 500 — filed as #301. So a 409 the app knew how to word became a 500
  // here too. (Earlier versions said "the eight route branches",
  // the FILE count — the files-versus-endpoints conflation
  // `docs/lock-order.md` was rewritten to diagnose, written straight back into
  // new code by the commit that rewrote it.)
  //
  // The mutation could not see it. The CROSS-FAMILY tests call this function
  // with a bare client, where every statement is its own transaction and the
  // retry works, so the mutation came back green in a configuration production
  // never uses. Other tests in these files DO drive the generators through
  // `$transaction`; none of them staged a cross-family collision inside one,
  // which is the gap rather than transactions being untested generally. `generation-transaction.test.ts` now drives this
  // path through a real `$transaction` for that reason.
  //
  // WHAT A LOST RACE COSTS NOW, which is the half of that argument #327
  // changed: its own date, not the window. A row committing between the
  // pre-check above and this insert is absorbed by the `ON CONFLICT DO
  // NOTHING` below — the statement completes, the date simply does not come
  // back, and the loop after it reports that date as `'raced'`. Nothing
  // escapes to a caller, which is also why no route turns this into a 409 any
  // more: the `YG001` the two template POSTs used to catch has no raiser left
  // at all (`docs/lock-order.md`, "One teacher, one slot").
  //
  // TWO STATEMENTS SINCE #327, and only the first can conflict — the class
  // twin's own comment carries the argument. `skipDuplicates` belongs on the
  // entry because the entry is what holds every constraint; the `StudioClass`
  // rows below are keyed on the entry ids that actually landed.
  const inserted =
    free.length === 0
      ? []
      : await db.calendarEntry.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.scheduleRule.teacherId,
            kind: 'studio' as const,
            classType: template.scheduleRule.classType,
            date,
            startTime,
            durationMinutes: template.scheduleRule.durationMinutes,
            scheduleRuleId: template.scheduleRuleId,
          })),
          skipDuplicates: true,
          select: { id: true, date: true },
        });

  if (inserted.length > 0) {
    await db.studioClass.createMany({
      data: inserted.map((entry) => ({
        calendarEntryId: entry.id,
        kind: 'studio' as const,
        location: template.location,
        hourlyRate: template.hourlyRate,
      })),
    });
  }

  // The class twin carries the argument — a short date is re-asked of the
  // database rather than assumed transient, because a neighbour spilling past
  // midnight is invisible to the pre-check above and permanent, and `raced` is
  // a reason `countSkipReasons` drops.
  const landed = new Set(inserted.map((r) => r.date.getTime()));
  const short = free.filter((date) => !landed.has(date.getTime()));
  if (short.length > 0) {
    const stillHeld = await probeOverlappingCandidates(
      db,
      template.scheduleRule.teacherId,
      short,
      candidateSpan,
    );
    for (const date of short) {
      skipped.push({
        date,
        reason: stillHeld.has(date.getTime()) ? 'blocked_by_overlap' : 'raced',
      });
    }
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedStudioSlots(template.id, template.scheduleRule.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/** Studio twin of `logSkippedSlots` (`class-generator.ts`) — see it for the noise rule. */
function logSkippedStudioSlots(
  templateId: string,
  teacherId: string,
  skipped: SkippedSlot[],
): void {
  const blocking = skipped.filter((s) => s.reason !== 'already_generated');
  if (blocking.length === 0) return;

  log.warn(
    {
      templateId,
      teacherId,
      skipped: blocking.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        reason: s.reason,
      })),
    },
    'studio class generation could not fill every date in the window',
  );
}

/**
 * Cron entry point: tops up the rolling window for every active, unarchived
 * studio template, platform-wide — no `teacherId` scoping, unlike
 * `generateClassInstances`. That absence is what puts this function out of
 * reach of a single PATCH: see `pauseOrResumeStudioTemplate`
 * (`studio-class-template-lifecycle.ts`), which reaches for
 * `generateStudioInstancesForTemplate` instead, and says so.
 * Each template is isolated: one template whose generation throws is logged
 * and skipped. If the throw is a Postgres lock timeout (55P03), it means
 * a concurrent writer (such as a teacher resume or edit) holds the row;
 * this is logged at warn and skipped without failing the sweep (#122).
 * Genuine failures are logged at error, collected, and the first error is
 * rethrown at the end for job-health visibility.
 *
 * This changes what a throw means to both callers
 * (`api/cron/generate-classes/route.ts` and `lib/scheduler.ts`'s
 * `isolatedSweeps`): it used to mean the sweep aborted partway through and
 * some templates never got a turn; it now means the sweep ran to completion
 * and at least one template failed along the way. Both callers already
 * tolerate either shape, but do not assume "threw" still implies "incomplete"
 * when reading this signature.
 */
export async function generateStudioClassInstances(
  db: PrismaClient,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();

  // isArchived is defence in depth, matching class-generator.ts: the PATCH
  // route keeps archived templates inactive, but if that invariant ever slips
  // the generator must not materialise classes for something the teacher
  // shelved. It slipped once — the studio route had neither guard until #53's
  // coverage pass found it.
  const templates = await db.studioClassTemplate.findMany({
    where: { scheduleRule: { isActive: true, isArchived: false } },
    include: { scheduleRule: true },
  });

  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created (#95). The `findMany` above is
      // only a pre-filter — this template's row may be minutes stale by now.
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimStudioTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;

          // `fresh`, not `template`: the loop variable is the pre-filter's
          // snapshot and may be minutes old. #102.
          const result = await generateStudioInstancesForTemplate(tx, fresh, startDate);
          return result.created;
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      // Per-template isolation, matching `generateClassInstances`. A lock
      // timeout (55P03) against a concurrent writer means someone else has
      // the template right now, not that generation failed (#122) — so it is
      // logged at warn and skipped without failing the job health check.
      if (isLockTimeout(err)) {
        log.warn(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation skipped template due to lock contention',
        );
      } else {
        log.error(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation failed for template',
        );
        errors.push(err);
      }
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}



