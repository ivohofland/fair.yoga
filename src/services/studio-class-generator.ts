/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { getNextOccurrences } from './class-generator';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
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
  include: { teacher: { select: { defaultTimezone: true } } };
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
 * statement above still does the locking and the eligibility re-check; the
 * Prisma read below is what makes the values authoritative, and it is safe
 * precisely because the lock is still held when it runs. Two statements
 * rather than one `SELECT *` because `hourlyRate` is `DECIMAL(10,2)` and a
 * raw row does not hand back Prisma's `Decimal`.
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
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  return tx.studioClassTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
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
 *   - `createManyAndReturn({ skipDuplicates: true })` compiles to a BARE
 *     `ON CONFLICT DO NOTHING` — no conflict target, so it covers every unique
 *     constraint on the table, including `StudioClass_teacher_slot_unique` on
 *     (teacherId, date, startTime) WHERE "cancelledAt" IS NULL — the partial
 *     index #196 added. That is what makes a clash cost only its own date.
 *     Pinned by this file's "names a date lost to a concurrent insert as
 *     raced, not as filled" test: a holder row with `templateId: null` parks
 *     on a date/time this key covers, isolated from `@@unique([templateId,
 *     date])`, and the generator's own transaction still creates the other
 *     three dates and commits rather than aborting.
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
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) > startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // One query for the whole window. Scoped to this teacher: #196's studio index
  // is `(teacherId, date, startTime) WHERE "cancelledAt" IS NULL`.
  const occupants = await db.studioClass.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, cancelledAt: true },
  });

  // The OTHER family (#296). Mirrors the predicate
  // `studio_class_reject_cross_family_slot` carries (`status <> 'cancelled'`);
  // the trigger is what enforces it, this is what names the reason. Widen or
  // narrow one without the other and this pre-check starts disagreeing with the
  // guard that backs it — the same tripwire the same-family check below carries.
  //
  // `(teacherId, date)` is indexed on `Class` already (`schema.prisma`); the
  // studio side gained its equivalent in this issue's migration, for the
  // mirror-image read in `class-generator.ts`.
  //
  // known-open (#296): this pre-check and the trigger behind it are both
  // unlocked reads, so two transactions writing opposite families at one slot
  // can still both commit. Measured at 200 of 200 runs under a FORCED overlap
  // — a rate conditional on racing, not a rate of races, which was never
  // measured. Accepted rather than closed with an advisory lock because #298's
  // recorded decision turns this invariant into a composite foreign key on an
  // extracted `CalendarEntry`, where the second writer blocks on an
  // uncommitted index entry instead. `docs/lock-order.md`, "The cross-family
  // slot guard reads, and does not lock", carries the full argument and the
  // condition for reopening it.
  const foreign = await db.class.findMany({
    where: {
      teacherId: template.teacherId,
      date: { in: dates },
      status: { not: 'cancelled' },
    },
    select: { date: true, startTime: true },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // `@@unique([templateId, date])` ignores cancellation, so a cancelled own
      // row makes the date permanently unfillable rather than already filled.
      // This is the live path #192 was filed about: it runs on every sweep and,
      // before this change, said nothing.
      skipped.push({
        date,
        reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors the predicate `StudioClass_teacher_slot_unique` carries (`WHERE
    // "cancelledAt" IS NULL`); the index backs it since #196; this pre-check
    // is what names the reason, not what enforces it.
    // Widen or narrow one without the other and this pre-check starts
    // disagreeing with the constraint that backs it — see the class family's
    // equivalent tripwire (`class-generator.ts`) and the spec's §4.1.
    if (onDate.some((c) => c.startTime === template.startTime && c.cancelledAt === null)) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    // AFTER `slot_taken`, deliberately: when this teacher holds the slot in
    // BOTH families, the same-family cause is the one worth reporting, because
    // it is the one they can act on without leaving this half of their
    // schedule. A reporting preference like the week-versus-slot one above, not
    // a guarantee — but unlike that one it costs nothing to state, since both
    // branches `continue` and no row is created either way.
    if (
      foreign.some(
        (c) => c.date.getTime() === date.getTime() && c.startTime === template.startTime,
      )
    ) {
      skipped.push({ date, reason: 'blocked_by_other_family' });
      continue;
    }

    free.push(date);
  }

  // ONE STATEMENT, NO CATCH, and #296 is the second issue to reach for one here
  // and be wrong. THIS FUNCTION'S OWN docblock already says it — not a sibling
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
  // non-functional. Every production caller of the two generators passes a
  // TRANSACTION client — six across the pair, three per generator;
  // `class-generator.ts`'s function docblock states its own three, and this
  // file's states no caller count at all, so do not read the number as coming
  // from here. Prisma takes no
  // savepoint per statement, and a `RAISE EXCEPTION` aborts the Postgres
  // transaction — so the first retried `create` returns `25P02 current
  // transaction is aborted`, which `isCrossFamilySlotConflict` correctly
  // declines, and the rethrow costs the whole window anyway. It also cost more
  // than that: the escaping error stopped being the `YG001` that the TWO
  // template POST catches match. Two, not the ten endpoints answering a
  // cross-family 409 overall — and NOT because those two are the only callers
  // that wrap generation, which is false: six do, including both sweeps and
  // both pause/resume services, as the sentence four lines up says. They are
  // the only generation-wrapping callers that CATCH `YG001`. The other four
  // let it reach `withErrorHandler`, where `classifyApiError` has no arm for
  // it and answers 500 — filed as #301. So a 409 the app knew how to word
  // became a 500 here too. (Earlier versions said "the eight route branches",
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
  // What the loss costs, stated rather than waved past: a cross-family row
  // committing between the pre-check above and this insert costs this
  // template its whole window for THIS run. The next sweep's pre-check sees
  // the now-committed row and skips exactly that date, so it self-corrects
  // within the hour — and on the two POST routes the same `YG001` becomes the
  // 409 those routes were given a branch for.
  const inserted =
    free.length === 0
      ? []
      : await db.studioClass.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            templateId: template.id,
            classType: template.classType,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            location: template.location,
            hourlyRate: template.hourlyRate,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedStudioSlots(template.id, template.teacherId, skipped);

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
 * Each template is isolated: one template whose generation throws — now
 * including a claim's lock timeout, a new way to fail this sweep did not
 * previously have — is logged and skipped, the rest still generate, and the
 * first error is rethrown at the end for job-health visibility.
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
    where: { isActive: true, isArchived: false },
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
      // Per-template isolation, matching `generateClassInstances`. The class
      // family already had this; the studio sweep did not, and the claim's
      // lock timeout above is a new way for one template to throw — without
      // this, one contended template would stop every other teacher's studio
      // classes from generating.
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'studio class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}
