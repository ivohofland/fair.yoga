/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { classStartInstant, mondayOf } from '@/lib/timezone';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';
import { log } from '@/lib/log';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The rolling window, in occurrences — four weeks (`CLAUDE.md`).
 *
 * Exported since #194 for `updateClassTemplate`'s probe, which deliberately
 * looks TWICE this far. The asymmetry is the point rather than a
 * disagreement: when all four of the generator's weeks are held by the
 * superseded schedule, the honest answer to "when does this edit take effect"
 * is week five, and no window this generator can see contains it. Derived
 * there rather than restated, so a change to the window moves the prediction
 * with it.
 */
export const DEFAULT_WEEKS = 4;

// ---------------------------------------------------------------------------
// getNextOccurrences
// ---------------------------------------------------------------------------

/**
 * Returns the next `weeks` occurrences of a given day-of-week starting
 * from (and including) `from`.
 *
 * @param dayOfWeek Schema convention: 0=Monday, 1=Tuesday, ..., 6=Sunday
 * @param from      Start date (time portion is ignored)
 * @param weeks     Number of occurrences to generate
 * @returns Array of Date objects with time set to 00:00:00.000 UTC
 */
export function getNextOccurrences(
  dayOfWeek: number,
  from: Date,
  weeks: number,
): Date[] {
  // Schema convention: 0=Mon, 1=Tue, ..., 6=Sun
  // JS getUTCDay():    0=Sun, 1=Mon, ..., 6=Sat
  // Convert schema day to JS day: jsDayOfWeek = (dayOfWeek + 1) % 7
  const jsDayOfWeek = (dayOfWeek + 1) % 7;

  // Start from midnight UTC of `from`
  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );

  // Find the first occurrence on or after `start`
  const currentJsDay = start.getUTCDay();
  const daysUntilTarget = (jsDayOfWeek - currentJsDay + 7) % 7;
  // daysUntilTarget === 0 means `from` is already the target day — include it

  const firstOccurrence = new Date(start);
  firstOccurrence.setUTCDate(firstOccurrence.getUTCDate() + daysUntilTarget);

  const dates: Date[] = [];
  for (let i = 0; i < weeks; i++) {
    const date = new Date(firstOccurrence);
    date.setUTCDate(date.getUTCDate() + i * 7);
    dates.push(date);
  }

  return dates;
}

/**
 * Whether a class of this template already holds the WEEK containing `date`
 * (#194).
 *
 * One line, and extracted anyway — not because the expression is long, but
 * because two callers must never disagree about what makes a week
 * unavailable, and they are the two halves of a single promise to the teacher:
 * `generateInstancesForTemplate` below decides which dates the hourly sweep
 * actually fills, and `firstFreeWeek` — through `updateClassTemplate`'s probe
 * — decides which week the teacher is TOLD it will fill. Two copies of
 * `heldWeeks.has(mondayOf(date))` is precisely how a sentence and a behaviour
 * drift apart, and the drift is invisible from either side: both halves keep
 * passing their own tests while saying different things.
 *
 * It is the definition of "held" that is shared here, not the decision. The
 * generator must name a *reason* for every candidate date it declines, and a
 * `Date | null` cannot carry one — see `firstFreeWeek` below, which records
 * why the plan's "one decision function, two callers" was corrected rather
 * than upheld.
 *
 * `heldWeeks` is a set of `mondayOf` values, and both call sites build it the
 * same way: a `templateId`-keyed `findMany` with NO status filter, because a
 * cancelled class holds its week
 * (`docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md` §3.2,
 * and `SkipReason`'s `already_this_week` in `@/lib/generation`). That
 * construction is the one half of "held" this function cannot enforce for
 * them.
 */
export function isWeekHeld(date: Date, heldWeeks: ReadonlySet<number>): boolean {
  return heldWeeks.has(mondayOf(date));
}

/**
 * The first candidate date whose week no class of this template already holds,
 * or `null` if every candidate's week is taken (#194).
 *
 * Pure. Its caller is the template-edit endpoint's probe — `updateClassTemplate`
 * in `class-template-lifecycle.ts` — deciding what to tell the teacher.
 *
 * `generateInstancesForTemplate` below does NOT call it, and the plan's
 * "one function, two callers" line is corrected here rather than upheld: the
 * generator has to name a reason for EVERY candidate date, not find the first
 * free one, so a function that returns a single date cannot express its
 * answer. What the two genuinely share is the definition of "held", and since
 * #194's task 6 they share it as CODE rather than as a convention —
 * `isWeekHeld` above is called from here and from the generator's loop, and it
 * exists for no other reason. `resumeMessage`'s docblock records what the
 * alternative cost, where copy guessed at generator internals it did not share
 * and guessed wrong.
 *
 * The probe passes a LONGER candidate list than the generator's own
 * four-occurrence window, and that is the point rather than an inconsistency:
 * when all four of those weeks are held the honest answer is week five —
 * outside anything the generator can see.
 */
export function firstFreeWeek(
  candidates: readonly Date[],
  heldWeeks: ReadonlySet<number>,
): Date | null {
  for (const date of candidates) {
    if (!isWeekHeld(date, heldWeeks)) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// generateClassInstances
// ---------------------------------------------------------------------------

type TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
}>;

/**
 * Generates the rolling 4-week window for ONE template, reporting each
 * candidate date it could not fill and why (`GenerationResult`).
 *
 * Keyed per WEEK, not per date (#194). A template is a stamp, not a live link:
 * editing `dayOfWeek` no longer rewrites the classes already generated — the
 * sync that did is deleted — so without a week key, moving a template from
 * Tuesday to Thursday would leave four Tuesdays standing and create four
 * Thursdays beside them. The `heldWeeks` read below is what stops that, and
 * `already_this_week` is what tells the teacher it happened.
 *
 * Two mechanisms, each with a job the other cannot do:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped, which
 *     is what lets the teacher be told something true and an operator grep for
 *     it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` compiles to a BARE
 *     `ON CONFLICT DO NOTHING` — no conflict target, so it covers every unique
 *     constraint on the table, including `Class_teacher_slot_unique` on
 *     (teacherId, date, startTime) WHERE status <> 'cancelled' — the partial
 *     index #196 added. That is what makes a clash cost only its own date,
 *     inside a transaction that then goes on to run another statement and
 *     commit. Pinned by `src/services/class-generator.test.ts`, "names a date
 *     lost to a concurrent insert as raced, not as filled" — a holder row
 *     with `templateId: null`, so the collision is isolated to the slot key
 *     rather than riding along on `@@unique([templateId, date])` too.
 *
 * This function used to claim it was idempotent via "`@@unique([templateId,
 * date])` + P2002-skip". It was not, and the correction is the reason this
 * shape exists: Prisma does not savepoint individual queries inside an
 * interactive transaction, so a caught `P2002` leaves Postgres with an aborted
 * transaction. The next statement fails with `25P02`, and if the clash landed
 * on the *last* date there is no next statement — `COMMIT` on an aborted
 * transaction returns the `ROLLBACK` tag with no error, so `$transaction`
 * resolved successfully while every row it reported was discarded (#164).
 * Named rather than counted, because a count goes stale on the first unrelated
 * change and this one was wrong on arrival. Re-derived rather than edited by
 * one name when #194 removed a member — `grep -rn "generateInstancesForTemplate("
 * src/` returns three production call sites and all three pass a transaction
 * client: `api/class-templates/route.ts`, `generateClassInstances` below, and
 * `pauseOrResumeTemplate` (`class-template-lifecycle.ts`). There was a fourth,
 * the template sync, and it was the one that did not — it passed a bare
 * `PrismaClient` until the atomic-template-update branch (issue 83) stopped it
 * opening a transaction of its own, and #194 deleted it outright. In
 * production, that is: this file's own tests still call this function directly
 * with a bare `prisma` (`class-generator.test.ts`), which is why the roster
 * says production rather than pretending to be exhaustive. Do not reintroduce
 * a `catch` here; there is nothing it can do that the constraint does not.
 *
 * Accepts a transaction client so a route can create the template and its
 * window atomically.
 */
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. A run
  // after today's start time must not create a class that already happened;
  // the window slides one week further instead.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) >
        startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // `dates` is empty only if every occurrence in the window has already
  // started, which today it cannot be — the filter above can only drop the
  // first of five. It is guarded rather than asserted anyway because the week
  // bounds below dereference both ends of the array, and under
  // `noUncheckedIndexedAccess` a `!` there would be a claim about a filter
  // three lines up rather than a check. Returning the empty result is what the
  // loop below would have produced from an empty `dates` regardless.
  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];
  if (windowStart === undefined || windowEnd === undefined) {
    return { created: 0, skipped: [] };
  }

  // One query for the whole window, replacing the per-date `findFirst`. Scoped
  // to this teacher because the slot key #196 enforces is
  // `(teacherId, date, startTime)` — another teacher's class can never block
  // this one and must not be read.
  const occupants = await db.class.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, status: true },
  });

  // Week occupancy for the whole window (#194). A SECOND read rather than a
  // widening of `occupants` above, and keyed on `templateId` rather than
  // `teacherId`, for two reasons. The read above is scoped to the candidate
  // dates and structurally cannot see the class that blocks a week from a
  // DIFFERENT date — which is the entire case this exists for. And keying on
  // `templateId` rides `@@unique([templateId, date])`, which both `Class` and
  // `StudioClass` already carry, so this does not widen an unindexed scan
  // (see `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md`
  // §5; it corrects a claim on #284 that said otherwise).
  //
  // No `status` filter, deliberately: a cancelled class holds its week.
  // `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md`
  // §3.2 has the flip-flop schedule the alternative produces — move a template
  // Tuesday→Thursday, cancel the Tuesday in week 2 only, and a status-filtered
  // read moves week 2 to Thursday while weeks 1, 3 and 4 stay Tuesday: a
  // schedule that changes slot and changes back. A week left empty is easier
  // for a teacher to read than that. Do not add a filter for consistency with
  // `Class_teacher_slot_unique`, which reads cancelled as free for the
  // different and correct reason that its index carries
  // `WHERE "status" <> 'cancelled'`.
  //
  // Bounds derived from `dates` itself, not computed independently — the read
  // and the loop below must not be able to disagree about which weeks are in
  // play. `mondayOf` takes a CALENDAR DATE and no timezone, which is what both
  // operands are: `Class.date` is `@db.Date` and `getNextOccurrences` builds
  // UTC midnights. `startOfLocalWeek` is the wrong tool here — it resolves an
  // INSTANT through `Intl`, and west of UTC it returns the previous day, which
  // for a Monday is the previous week. The `+ 7 days` is plain UTC-midnight
  // arithmetic for the same reason: no local calendar, so no DST to skew it.
  const weekStart = new Date(mondayOf(windowStart));
  const weekEnd = new Date(mondayOf(windowEnd) + 7 * 24 * 60 * 60 * 1000);
  const heldWeeks = new Set(
    (
      await db.class.findMany({
        where: { templateId: template.id, date: { gte: weekStart, lt: weekEnd } },
        select: { date: true },
      })
    ).map((c) => mondayOf(c.date)),
  );

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    // At most one, by `@@unique([templateId, date])`.
    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // A cancelled own row still holds the date: that unique key does not
      // care about status, so the date is unfillable for good, not merely
      // already filled. Telling those two apart is #192.
      skipped.push({
        date,
        reason: own.status === 'cancelled' ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // AFTER the own-date branch above, deliberately — and that half of the
    // order IS pinned: reversing it reddens the steady-state re-run case,
    // which is why it is stated as a guarantee where the next paragraph is
    // not. `heldWeeks` contains this
    // candidate's own week too, so checking week-first would mask
    // `already_generated` on every steady-state re-run — and the two are not
    // interchangeable downstream, since `countSkipReasons` counts
    // `already_this_week` into a number that reaches the teacher and
    // deliberately ignores `already_generated`. That chain is real now rather
    // than planned: the count runs `pauseOrResumeTemplate` → the PATCH
    // `active` arm → `resumeMessage`, which renders it as "N dates are still
    // held by classes on your previous day".
    //
    // Before `slot_taken` below — a REPORTING PREFERENCE, not a guarantee, and
    // deliberately stated as one: nothing pins it. No fixture makes a single
    // date both week-held and slot-taken by an unrelated class, so swapping
    // these two branches fails no test today. The preference is that when a
    // day edit and an unrelated class both block a date, the systematic cause
    // is the one worth reporting.
    //
    // Not free to get wrong, either: the two reasons land in DIFFERENT
    // `SkipCounts` fields and reach a teacher as different clauses of
    // `resumeMessage` ("N dates already had a class" versus "N dates are still
    // held by classes on your previous day"). What bounds it is that both
    // branches `continue` — no class is created either way, the total is
    // unchanged, and `resumeMessage` appends every applicable clause before
    // choosing a head — so a reorder changes WHICH CLAUSE the teacher reads,
    // never whether the sentence is true. Closing it costs one fixture; until
    // someone spends it, this comment must not claim an order the suite does
    // not enforce.
    if (isWeekHeld(date, heldWeeks)) {
      skipped.push({ date, reason: 'already_this_week' });
      continue;
    }

    // Mirrors the predicate `Class_teacher_slot_unique` carries (`WHERE
    // "status" <> 'cancelled'`); the index backs it since #196; this
    // pre-check is what names the reason, not what enforces it.
    // Widen or narrow one without the other and this pre-check starts
    // disagreeing with the constraint that backs it — see the spec's §4.1.
    if (onDate.some((c) => c.startTime === template.startTime && c.status !== 'cancelled')) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    free.push(date);
  }

  const inserted =
    free.length === 0
      ? []
      : await db.class.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            teacherRoomId: template.teacherRoomId,
            templateId: template.id,
            classType: template.classType,
            description: template.description,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            roomCost: template.roomCost,
            minRate: template.minRate,
            targetRate: template.targetRate,
            minStudents: template.minStudents,
            maxStudents: template.maxStudents,
            cancelDeadline: template.cancelDeadline,
            autoCancelCheck: template.autoCancelCheck,
            status: 'open' as const,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  // A free date that did not come back lost a race with a concurrent insert.
  // Before #164 this was the P2002 that poisoned the transaction; it is now an
  // ordinary skipped date, and the only one whose cause is not in `occupants`.
  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedSlots(template.id, template.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/**
 * One line per generator call, never one per date — that ratio is the answer to
 * the noise question #192 raised, where per-date logging on an hourly sweep put
 * ~48 lines/day on a 2GB VPS for a teacher with two blocked dates. Per call it
 * is 24, and each is complete rather than a fragment.
 *
 * `already_generated` is excluded deliberately: it is the correct, expected
 * outcome of every steady-state run, and logging it *is* the noise.
 */
function logSkippedSlots(templateId: string, teacherId: string, skipped: SkippedSlot[]): void {
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
    'class generation could not fill every date in the window',
  );
}

/**
 * Claims a template for generation, or reports it is no longer eligible.
 *
 * `FOR UPDATE` is the point, not the `SELECT`. It locks the same row
 * `archiveOrUnarchiveTemplate`'s compare-and-swap locks, and the two modes
 * conflict — that `updateMany` touches no key column, so Postgres grants it
 * `FOR NO KEY UPDATE`, which this blocks and which blocks this — so the sweep
 * and an archive serialise instead of interleaving:
 *
 *   - claim first  → the archive's UPDATE waits; we generate and commit; the
 *                    archive's own deleteMany then withdraws what we made —
 *                    all but a class dated today. Its boundary is `gt: today`
 *                    (`scheduledWhere` in `class-template-lifecycle.ts`), the
 *                    same deliberate spare-today carve-out applied everywhere
 *                    else: a class hours from starting should not disappear
 *                    out from under students who already see it as open.
 *                    `remaining` counts with `gte`, so the teacher is told
 *                    honestly that one class survived rather than being
 *                    handed a total that quietly excludes it. One publicly
 *                    bookable class under a just-archived template is this
 *                    interleaving's correct outcome, not a gap this lock
 *                    failed to close. The studio side reaches this same
 *                    outcome at the same rate, not more often (#94):
 *                    `generateStudioInstancesForTemplate`
 *                    (`studio-class-generator.ts`) now applies the same
 *                    `classStartInstant` "start is still ahead" filter this
 *                    file's `generateInstancesForTemplate` does, so neither
 *                    family generates an already-started today's instance.
 *   - archive first → we wait, then read `isArchived: true` and skip.
 *
 * A plain re-read would not do this. Under READ COMMITTED each statement takes
 * a fresh snapshot, so an archive committing between the re-read and the
 * `create` is invisible to the re-read and still lost. Do not "simplify" the
 * locking `SELECT` above into a plain `findUnique`.
 *
 * Must be called with a transaction client, never a bare `PrismaClient` —
 * `Prisma.TransactionClient` is structurally just `Omit<PrismaClient,
 * ITXClientDenyList>`, so `claimTemplateForGeneration(prisma, id)` type-checks
 * without complaint. It would make `SET LOCAL` a no-op (there is no
 * transaction for "local" to scope to) and release the row lock the instant
 * the `SELECT` completes. That used to mean the claim returned `true` while
 * holding nothing; it is not gone, and it now has a second consequence: the
 * `findUniqueOrThrow` below then runs unlocked too, and can throw P2025 if
 * the row is deleted out from under it before that second statement runs.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking `Class`
 * inserts — it looks like a free optimisation but isn't. `FOR UPDATE` is what
 * makes a concurrent insert for this template impossible, because an insert's
 * FK check takes `FOR KEY SHARE` on this row, which `FOR UPDATE` conflicts with
 * and `FOR NO KEY UPDATE` does not. Measured on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateInstancesForTemplate` no longer has a P2002 branch to be broken.
 * Its `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort
 * nothing, with or without this lock. The lock still earns its place by
 * keeping the values this claim returns authoritative (#102).
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and the eligibility re-check; the
 * Prisma read below is what makes the values authoritative, and it is safe
 * precisely because the lock is still held when it runs. Two statements rather
 * than one `SELECT *` because `roomCost`, `minRate` and `targetRate` are
 * `DECIMAL(10,2)` and a raw row does not hand back Prisma's `Decimal`.
 */
export async function claimTemplateForGeneration(
  tx: TransactionClientOnly,
  templateId: string,
): Promise<TemplateWithTimezone | null> {
  // `LOCK_TIMEOUT_SQL` (`@/lib/db-locks`) — shared with `lockClassRow`, which
  // takes the `Class` row lock this one deadlocks against, so the two waits
  // are the same length by construction rather than by coincidence. Its
  // docblock carries the reason `$executeRawUnsafe` is safe for it.
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above, so nothing can change this row before we
  // commit. `OrThrow` because the row provably exists — the FOR UPDATE just
  // matched it — and an impossible `| null` would force every caller to
  // pretend to handle it.
  return tx.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}

/**
 * Cron / teacher-wide entry point: tops up the rolling window for all
 * active templates (or one teacher's). Each template is isolated — one
 * template whose generation throws is logged and skipped, the rest still
 * generate, and the first error is rethrown at the end for job-health
 * visibility.
 */
export async function generateClassInstances(
  db: PrismaClient,
  from?: Date,
  teacherId?: string,
): Promise<number> {
  const startDate = from ?? new Date();

  // isArchived is defense in depth: the routes keep archived templates
  // inactive, but if that invariant ever slips, the generator must not
  // materialize classes for something the teacher shelved. That half now
  // comes from the shared constant so `services/room-archive.ts` cannot
  // block on a different set than this query selects. See
  // `lib/template-selection.ts`.
  //
  // KNOWN-OPEN, and deliberate (issue 76, spec §10): both flags on
  // `ACTIVE_TEMPLATE_WHERE` are the TEMPLATE's own — this selection never
  // reads `teacherRoom.isArchived`. `room-archive.ts`'s header calls that
  // module "what gives `isArchived` meaning"; this query is the one reader
  // that still doesn't consult it.
  //
  // REACHABLE and measured, not latent. What generates here is an ACTIVE
  // template on an ARCHIVED room: door 3 of the room archive lifecycle reads
  // `teacherRoom.isArchived` from a non-transactional `findUnique` at the top
  // of `pauseOrResumeTemplate`, so a room archive committing between that read
  // and the CAS below is invisible to it. Measured on #116's branch: four
  // classes generated into a just-archived room
  // (`{"outcome":"active","roomArchived":true,"generated":4}`). The template's
  // own archive race IS closed by the CAS — but a CAS on `ClassTemplate`
  // cannot carry a predicate on the related room's column.
  //
  // Not closed here, deliberately, and not by oversight: `room-archive.ts`
  // (see its own KNOWN-OPEN, spec section 8) accepts this same race class from
  // the other side rather than locking, because the alternative is a new
  // `FOR UPDATE` node in the ordering `template-lock-order.test.ts` exists to
  // defend. A re-read after the CAS would close the interleaving measured
  // above and leave its mirror open — a half-guard whose residue would need
  // documenting forever. The invariant "an active template may not sit on an
  // archived room" is currently enforced by five application doors, every one
  // a non-transactional read. Enforcing it once in Postgres is the structural
  // answer and a product-and-schema decision, filed as such: issue #272, which
  // carries the reproduction above and three options.
  //
  // Kept anyway, because what makes this query safe is an invariant held
  // elsewhere rather than anything the query itself checks. Any future writer
  // that sets `isArchived` outside `room-archive.ts` — a seed script, an admin
  // surface, a data import — makes the gap reachable again, and closing it is
  // then a product decision (does archiving pause the template? refuse the
  // sweep per-instance and log?), not something this file settles alone.
  const templates = await db.classTemplate.findMany({
    where: { ...ACTIVE_TEMPLATE_WHERE, ...(teacherId ? { teacherId } : {}) },
    include: { teacher: { select: { defaultTimezone: true } } },
  });

  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created, or the archive it is protecting
      // against can commit in between. The `findMany` above is only a
      // pre-filter — by the time the loop reaches this template its row may
      // be minutes stale: #95 closed that for `isActive`/`isArchived`, #102
      // for every other value the generator reads.
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;
          // `fresh`, not `template`: the loop variable is the pre-filter's
          // stale snapshot.
          const result = await generateInstancesForTemplate(tx, fresh, startDate);
          return result.created;
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}
