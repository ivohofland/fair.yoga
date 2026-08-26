/**
 * Class Lifecycle State Machine — Pure logic, no side effects.
 *
 * Manages class status transitions with guards.
 * Classes move through: draft → open → in_progress → completed.
 * Cancellation is NOT one of them (#327): it is `CalendarEntry.cancelledAt`,
 * written by `POST /api/classes/[id]/cancel`, and both families spell it that
 * one way. "Full" is derived (registrations >= maxStudents), not a stored
 * state — `services/capacity.ts` is where that derivation lives.
 */

import type { PrismaClient, Prisma, ClassStatus, RegistrationStatus } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { ECONOMIC_FIELDS, type EconomicField } from '@/lib/class-fields';
import { toIncomeTierOrThrow } from '@/lib/tiers.server';
import { lockClassRow } from '@/lib/db-locks';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { calculateClassPricing } from './pricing';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { closeQueueOnStart } from './waitlist';
import { classStartInstant, startsInPast, isoOrNull } from '@/lib/timezone';
import { timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

export { ECONOMIC_FIELDS, type EconomicField };

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * All valid state transitions. The terminal state (`completed`) has an empty
 * array — no transitions out.
 *
 * Cancellation is absent because it is not a status any more (#327). It is
 * `CalendarEntry.cancelledAt`, reached through `POST /api/classes/[id]/cancel`
 * rather than through `POST …/transition`, so this table describes only real
 * status moves — which is what it is named for.
 *
 * The arrays are `readonly`. `VALID_TRANSITIONS.completed.push('open')`
 * compiled before, which would have desynchronised this table at runtime from
 * both `TERMINAL_CLASS_STATUSES` (frozen at module load, so it would NOT have
 * followed) and the DB trigger that enforces the same thing — the exact drift
 * the derivation below exists to make impossible. Nothing anywhere reads these
 * arrays in a way `readonly` refuses — `.length`, `.includes` and `.join` are
 * all readonly-safe — so the annotation costs nothing, and the ANNOTATION is
 * what keeps that true: a read site added anywhere that mutates one fails to
 * compile. No count is kept here for that reason; `grep -rn VALID_TRANSITIONS
 * src` is the census, and it spans this file and its test.
 *
 * `readonly ClassStatus[]` rather than `as const satisfies`: the latter would
 * narrow the values to literal unions and force `as readonly ClassStatus[]`
 * casts into `canTransition` and `sourceStatesFor`, which are the two functions
 * that most need to stay honest about their argument types.
 */
export const VALID_TRANSITIONS: Record<ClassStatus, readonly ClassStatus[]> = {
  draft: ['open'],
  open: ['in_progress'],
  in_progress: ['completed'],
  completed: [],
};

/**
 * The statuses a class can never leave, derived rather than listed.
 *
 * Terminal means "no outgoing transition", which is exactly `[]` in the table
 * above — so this cannot disagree with `VALID_TRANSITIONS` the way a
 * hand-written pair would. `updateClass` below is the consumer: it is what
 * this set closes the `Class` half of the freeze with.
 *
 * TWO FROZEN TEXTS hard-code this set, both in
 * `prisma/migrations/20260826080100_calendar_entry_rewire/`, and each writes
 * it as a one-member `IN (...)` deliberately rather than as `=`:
 *
 * - `class_reject_terminal_status_change` — a terminal class cannot leave its
 *   status.
 * - `class_sync_entry_completed` — a class REACHING a terminal status stamps
 *   `CalendarEntry.classCompletedAt`, which is the column
 *   `entry_reject_frozen_schedule_change` then reads to freeze the entry's
 *   `date`, `startTime` and `durationMinutes`.
 *
 * Deriving from a TABLE while depending on TRIGGERS is the one hazard here:
 * widen the table and this widens silently while neither text does. Each text
 * has its OWN drift pin re-deriving the set out of it and comparing it against
 * this constant — `class-terminal-status.test.ts` reads the guard,
 * `class-terminal-date.test.ts` reads the sync trigger — so adding a terminal
 * status a trigger does not cover fails there, not in production. Two texts
 * rather than one because the sync trigger is what carries terminality across
 * to the entry, and a second frozen list this constant does not know about is
 * precisely the drift a single pin would miss. Two pins rather than one
 * because both texts now live in one migration file, so nothing but the
 * function name tells them apart (`tests/migration-sql.ts`).
 *
 * A CANCELLED CLASS'S `status` IS STILL NOT FROZEN AT THE DATABASE, and the
 * outcome it used to produce IS. This constant has one member, so
 * `class_reject_terminal_status_change` refuses only a completed class leaving
 * `completed`. Before #327 cancellation was a `ClassStatus` and the same
 * trigger refused every status change on a cancelled class; liveness moved to
 * `CalendarEntry.cancelledAt`, and that arm did not move with it — so raw SQL
 * could walk a cancelled class up to `completed`, the sync trigger stamped the
 * marker, and the row was both cancelled and completed.
 *
 * `CalendarEntry_not_cancelled_and_completed`
 * (`20260826200000_entry_marker_exclusivity`) is what refuses that now, and
 * where the refusal lands is the whole of why it is a CHECK. The status
 * `UPDATE` itself is still unguarded; it is `class_sync_entry_completed`'s own
 * `UPDATE "CalendarEntry"` that violates the constraint, which aborts the
 * completing transaction. The bad state is unreachable, and the statement that
 * reached for it is the one that fails.
 *
 * Recorded here as known-open until this branch, on the ground that a guard
 * "would have to sit on `Class` and read `CalendarEntry.cancelledAt`" — the
 * cross-table read `docs/lock-order.md` prices under "Ordering BETWEEN `Class`
 * and its `CalendarEntry`", and which this project has been REMOVING rather
 * than adding (the template half in #298, the cross-family class half in
 * #327, both replaced by constraints). That was true before the extraction and
 * stopped being true with it: `cancelledAt` and `classCompletedAt` are two
 * columns of ONE row, so the invariant is a single-row CHECK with no read, no
 * lock and no ordering cost. The extraction is what made it expressible.
 *
 * `entry_terminal_liveness_guard`
 * (`20260826140000_entry_guard_restorations`) covers the arms that can be
 * expressed on the entry row being written: un-cancelling a regular entry, and
 * cancelling a completed one.
 *
 * KNOWN-OPEN (#327), and a smaller residual than the one it succeeds: only the
 * `completed` walk is refused. Raw SQL can still move a CANCELLED class among
 * the LIVE statuses — `draft → open → in_progress` — because this constant's
 * one member is the only OLD status the guard rejects, and none of those three
 * is it. Recorded rather than closed because it is bounded three ways. Nothing
 * in `src/` can reach it: every status writer's CAS carries the liveness
 * conjunct named below. It cannot become a completion: `autoCompleteClasses`
 * (`class-transitions.ts`) selects on `calendarEntry: { cancelledAt: null }`,
 * and a hand-written completion trips the CHECK above. And it cannot unfreeze
 * the entry: `entry_reject_frozen_schedule_change` reads `cancelledAt` and
 * never the class's status, so `waitlist-retention.ts`'s date guarantee is
 * untouched by the walk. What it produces is a cancelled class carrying a live
 * status — a display state, with nothing downstream acting on it. The token is
 * here so a sweep for open residuals finds it; prose saying the same thing is
 * not searchable.
 *
 * The service layer says the same thing one layer up rather than being what
 * holds it: every status writer's CAS carries
 * `calendarEntry: { cancelledAt: null }` beside its status predicate.
 * Re-derive rather than trust that sentence —
 *
 *     grep -rn 'cancelledAt: null' src --include='*.ts' | grep -v '\.test\.'
 *
 * Annotated and frozen, NOT `as const satisfies` — the same shape and reason as
 * `CLAIMABLE_WAITLIST_STATUSES` (`lib/waitlist-status.ts`, which explains it at
 * length): `as const` narrows `Array.prototype.includes`' parameter to the
 * literal members, forcing call sites to widen it back with a cast that
 * accepts any string.
 */
export const TERMINAL_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter(
    (status) => VALID_TRANSITIONS[status].length === 0,
  ),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Why a transition was refused, as a value rather than as prose.
 *
 * `error` alongside it stays free text for humans — a 409 body, a log line. The
 * split matters: those two have opposite change pressures. User-facing copy
 * wants to be rewritten (and, per CLAUDE.md's "international from day one",
 * eventually translated); something another module branches on must never
 * change silently. Before this existed, `autoCompleteClasses` told the
 * reschedule race apart from every other refusal with
 * `result.error.endsWith('has not ended yet')`, so appending a debug detail to
 * the message — still importing the shared constant, still green under `tsc`
 * and the suite — would have flipped a benign, self-resolving race back to
 * logging at `error` on every tick.
 *
 * A SUPERSET over two functions, not a contract either one satisfies alone.
 * Both `transitionClass` and `completeClass` declare `TransitionDbResult`, so
 * each sees a type wider than its own range. Enumerated in full, because an
 * earlier revision named only `NOT_ENDED_YET` and `STARTS_IN_PAST` and called
 * them "the mirror" — a tidy symmetry that miscounts. The split is 2 shared /
 * 3 `transitionClass`-only / 1 `completeClass`-only, not 1/1 — named by axis
 * because the bullets below do not run in that order, and "2/3/1" over them
 * reads as a mismatch:
 *
 * - SHARED: `NOT_FOUND`, `ILLEGAL_TRANSITION` — both functions call
 *   `validateTransition`, `transitionClass` in the diagnostic read after a
 *   failed CAS — and `CANCELLED`, since #327 made cancellation a column on the
 *   entry rather than a status, so neither function's status check can see it
 *   any more and each has to ask the entry.
 * - `completeClass` only: `NOT_ENDED_YET`.
 * - `transitionClass` only: `CONCURRENT_MODIFICATION` (its CAS is the only one
 *   that reports losing a race this way), `STARTS_IN_PAST` (#249, and only
 *   for a `draft -> open` publish), and `ROOM_ARCHIVED` (issue 76, also only
 *   for a `draft -> open` publish).
 *
 * The looseness predates #249 and no member added since introduces it.
 * `POST /api/classes/[id]/transition` handles the full union anyway via an
 * exhaustive `Record`, so the widening costs a table row rather than a wrong
 * answer.
 */
export type TransitionFailureReason =
  | 'NOT_FOUND'
  | 'ILLEGAL_TRANSITION'
  | 'NOT_ENDED_YET'
  | 'CONCURRENT_MODIFICATION'
  | 'STARTS_IN_PAST'
  | 'ROOM_ARCHIVED'
  | 'CANCELLED';

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'ILLEGAL_TRANSITION'; error: string };

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: ClassStatus, to: ClassStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Validate a state transition, returning a typed result.
 * On failure, the error message describes the invalid transition.
 */
export function validateTransition(
  from: ClassStatus,
  to: ClassStatus,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'ILLEGAL_TRANSITION',
    error: `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
  };
}

/**
 * The states from which `to` is a legal move — the inverse of
 * `VALID_TRANSITIONS`, derived rather than hand-declared so the
 * compare-and-swap in `transitionClass` cannot drift from the state machine
 * when a transition is added or removed.
 */
export function sourceStatesFor(to: ClassStatus): ClassStatus[] {
  return (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter((from) =>
    VALID_TRANSITIONS[from].includes(to),
  );
}

// ---------------------------------------------------------------------------
// Economic field locking
// ---------------------------------------------------------------------------

/**
 * Whether economic fields are locked for editing.
 * Locked once the first registration is created (settingsLocked = true).
 */
export function isEconomicFieldLocked(settingsLocked: boolean): boolean {
  return settingsLocked;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * The shape both DB-level transition functions return, parameterised by the
 * reasons the specific function can actually produce.
 *
 * The default keeps every existing annotation and consumer working unchanged —
 * `TransitionDbResult` on its own still means "any of the five". What the
 * parameter buys is that each function can now DECLARE its real range instead
 * of describing it in prose: `transitionClass` cannot return `NOT_ENDED_YET`
 * and `completeClass` cannot return `STARTS_IN_PAST`, and until this existed
 * the only record of that was a paragraph in `TransitionFailureReason`'s
 * docblock which had already miscounted once.
 *
 * A caller that switches on `reason` now gets the narrow union, so a branch for
 * a reason its callee never returns is a compile error rather than dead code.
 * `POST /api/classes/[id]/transition` deliberately keeps handling the full
 * union in one exhaustive `Record`: a route table that narrowed with its callee
 * would need editing every time a service's range changed, which is churn for
 * no safety.
 */
export type TransitionDbResult<
  R extends TransitionFailureReason = TransitionFailureReason,
> =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; reason: R; error: string };

/**
 * Transition a class to a new status in the database.
 *
 * Compare-and-swap AND a row lock, which was one thing until #327. The
 * predicate is still the guard: under READ COMMITTED the `UPDATE`
 * re-evaluates its qual after acquiring the row lock, so a status change that
 * commits between a caller's read and this write is seen rather than written
 * over.
 *
 * `FOR UPDATE`, via `lockClassRow`, BECAUSE THE CAS STOPPED BEING
 * SINGLE-TABLE. It used to be `{ id, status: { in: sourceStatesFor(…) } }` and
 * needed no lock for free: every conjunct sat on the row the `UPDATE` itself
 * locks, and `EvalPlanQual` re-checks exactly those against the freshly
 * committed tuple. Liveness moved to `CalendarEntry.cancelledAt`, the CAS
 * gained `calendarEntry: { cancelledAt: null }`, and `EvalPlanQual` re-fetches
 * only the LOCKED row — the second table's subplan keeps its pre-wait
 * snapshot. Without the lock a cancel committing mid-transition is invisible
 * and the class ends up live-and-cancelled. This is the mechanism `db-locks.ts`
 * and the spec's §2.3 both measure; every other status writer already took the
 * lock (`completeClass`, `updateClass`, the cancel route, and both sweeps in
 * `class-transitions.ts`) and this was the one left out.
 *
 * That subsumes the older reason for locking, which was about how much state a
 * decision reads: `completeClass` and `autoCancelClasses` (since #174 Task 6
 * started deciding from a registration count) take the lock because they read
 * more than a status under the decision. Reading a second TABLE inside the CAS
 * itself is the same problem one level down. See `docs/lock-order.md`.
 *
 * Since #216 this also closes the class's waitlist when the target is
 * `in_progress`, which is why the CAS sits in a transaction. The close's own
 * predicate (`classId`, `status: 'waiting'`) is re-evaluated by Postgres at
 * execution time, and the `lockClassRow` above is already holding the `Class`
 * row lock that every `WaitlistEntry` writer conflicts on — so a concurrent
 * join or promotion is either committed before this transaction opened or
 * blocked behind it. `POST /api/classes/[id]/cancel` (#327) closes the same
 * queue in the same shape, having inherited it from the transition route's
 * cancel branch when that branch became its own door.
 */
export async function transitionClass(
  db: PrismaClient,
  classId: string,
  targetStatus: ClassStatus,
): Promise<
  TransitionDbResult<
    | 'NOT_FOUND'
    | 'ILLEGAL_TRANSITION'
    | 'CONCURRENT_MODIFICATION'
    | 'STARTS_IN_PAST'
    | 'ROOM_ARCHIVED'
    | 'CANCELLED'
  >
> {
  // #249. A draft whose start has already passed cannot be published. This
  // needs no typo to reach: a draft written for Friday and published the
  // following week is enough.
  //
  // IT FALLS THROUGH RATHER THAN REFUSING for a missing row or a status the CAS
  // would reject anyway, and that is the whole subtlety. A `completed` class
  // targeted at `open` is illegal whatever its date; answering "it starts in
  // the past" there would be true and misleading, and would break the test that
  // pins `ILLEGAL_TRANSITION`. The older, stronger reason wins — the same
  // precedence `updateClass` gives `terminal` over `past_start`.
  //
  // Decided with `sourceStatesFor`, the same helper the CAS below uses, so this
  // guard can never disagree with the write it precedes. Spelling the source
  // set out here by hand would be a second copy of `VALID_TRANSITIONS` to keep
  // in sync.
  //
  // Read before the transaction rather than inside it. The stale window is
  // milliseconds, and what could go wrong in it is bounded by who else writes
  // this class's start. It can be overtaken by the clock — read at 08:59:59.9
  // for a 09:00 class, CAS at 09:00:00.1 — which publishes a class whose start
  // has just passed, exactly as publishing it a second earlier legally would.
  //
  // THE CLOCK IS NOW THE ONLY OTHER WRITER, and that took a deletion rather
  // than an argument. An earlier revision rested the whole case on "since
  // #249's other guard a class's stored start can never be moved into the
  // past, so this read cannot understate it"; that was false at the time,
  // because the template sync rewrote `startTime` on a template's instances
  // with a bare `updateMany` past no such guard (the measurement is in
  // `waitlist-retention.ts`'s docblock) and could land in this window. #194
  // deleted that function. Re-derived rather than recalled — the `class.`
  // write sites in `src/`, minus the tests — `updateClass` below is the only
  // statement left that moves an existing class's `date`/`startTime`, and it
  // is guarded. The strong claim is true again, which is precisely why the
  // narrower argument below is kept rather than dropped: it was one unguarded
  // writer away from false once already.
  //
  // It stays safe on that narrower reason regardless. Losing such a race would
  // mean publishing a `draft` whose start had just been moved into
  // the past by another writer — the same outcome the clock produces on its
  // own a moment later, and the same outcome as publishing one second earlier.
  // Nothing downstream depends on a published class's start being ahead: the
  // sweeps read the stored values fresh, and the retention argument this feeds
  // needs `date` on a TERMINAL class, which a trigger holds and neither writer
  // can touch. The refusal is a policy about intent, not an invariant, so a
  // millisecond of staleness costs a wrong answer rather than a broken one.
  if (targetStatus === 'open') {
    const cls = await db.class.findUnique({
      where: { id: classId },
      select: {
        status: true,
        teacherRoom: { select: { isArchived: true } },
        // `date`, `startTime` and the teacher all hang off the entry since
        // #327 — one nested read rather than three columns on this row.
        calendarEntry: {
          select: {
            date: true,
            startTime: true,
            teacher: { select: { defaultTimezone: true } },
          },
        },
      },
    });

    // Door 2 of the room archive lifecycle (issue 76). An archived room
    // accepts no new commitments: a draft may SIT on an archived room —
    // it is a parked intention with no registrations, which is why door 1
    // lets a draft-only room be archived — but publishing it is the moment
    // the room's availability starts to matter.
    //
    // Before the past-start check deliberately. A draft that is both
    // past-dated and in an archived room gets told about the room, because
    // that is the condition the teacher can clear; `STARTS_IN_PAST` is
    // permanent and would end the conversation.
    if (
      cls &&
      sourceStatesFor(targetStatus).includes(cls.status) &&
      cls.teacherRoom.isArchived
    ) {
      // Logged for the same reason the `STARTS_IN_PAST` refusal below is:
      // `respondError` does not log and `withErrorHandler` logs only on
      // `throw`, so an unlogged refusal leaves no record but the 409 body.
      log.info(
        { classId, targetStatus, currentStatus: cls.status },
        'class publish refused: the room is archived',
      );
      return {
        ok: false,
        reason: 'ROOM_ARCHIVED',
        error: 'This room is archived. Unarchive it to publish classes here.',
      };
    }

    if (
      cls &&
      sourceStatesFor(targetStatus).includes(cls.status) &&
      startsInPast(
        {
          date: cls.calendarEntry.date,
          startTime: cls.calendarEntry.startTime,
          timeZone: cls.calendarEntry.teacher.defaultTimezone,
        },
        new Date(),
      )
    ) {
      // Same three-way ambiguity `updateClass`'s refusal has, and the same
      // fields to tell them apart — see the longer note there. This route logs
      // nothing of its own, so without this the only record of a publish
      // refusal is a 409 body the teacher reads and no one keeps.
      const entry = cls.calendarEntry;
      const start = classStartInstant(entry, entry.teacher.defaultTimezone);
      log.info(
        {
          classId,
          timeZone: entry.teacher.defaultTimezone,
          // `entry.date` is Prisma-sourced from a `@db.Date` column and cannot
          // be an Invalid Date, unlike `updateClass`'s, which arrives as a
          // service argument. Through `isoOrNull` anyway: the cost is a
          // function call, and the alternative is a reader having to re-derive
          // that distinction to know this line is safe.
          date: isoOrNull(entry.date)?.slice(0, 10) ?? null,
          startTime: timeToHHmm(entry.startTime),
          startInstant: isoOrNull(start),
        },
        'transitionClass refused: this draft start has already passed',
      );
      return {
        ok: false,
        reason: 'STARTS_IN_PAST',
        // Prose, because this string is the whole of what the teacher sees:
        // `transition/route.ts` returns it as the 409 body and `PublishClassButton`
        // renders it, and this route logs nothing, so there is no diagnostic use
        // to preserve. The instant it used to carry was rendered in UTC — a time
        // the teacher never sees anywhere else in the app, from a guard whose
        // entire point is reading the start in `Teacher.defaultTimezone`.
        error: 'Cannot publish a class whose start time has already passed.',
      };
    }
  }

  // The CAS and the queue close in one transaction; the diagnostic reads below
  // stay outside it, because they decide nothing that gets persisted and would
  // only hold the transaction open on the failure path.
  const moved = await db.$transaction(async (tx) => {
    // `lockClassRow`, not the bare `setLockTimeout` this used to be, AND THE
    // REASON CHANGED WITH THE CAS BELOW. It was lock-free for free while its
    // only conjunct sat on the row the `UPDATE` itself locks: a writer that
    // blocked on that row and then unblocked had its qual re-checked by
    // `EvalPlanQual` against the freshly committed tuple. #327 gave the CAS a
    // SECOND table — `calendarEntry: { cancelledAt: null }` — and
    // `EvalPlanQual` re-fetches only the locked row. The `calendarEntry`
    // subplan is evaluated in the PRE-WAIT snapshot, where `cancelledAt` is
    // still NULL, so a cancel committing mid-transition is invisible and the
    // class ends up live-and-cancelled. `db-locks.ts` documents that mechanism
    // and the spec's §2.3 measures it; this was the one status writer left
    // without the lock, where the cancel route, `completeClass`, `updateClass`
    // and both sweeps all take it.
    //
    // It still bounds the wait — `lockClassRow` issues `setLockTimeout` itself
    // — which is what keeps an unbounded wait from becoming Prisma's 5s budget
    // expiring mid-transaction (`P2028`, a 503 the caller cannot act on)
    // instead of the 2s `55P03` its siblings get, which `classifyApiError`
    // answers with a retry. That is now a side effect of taking the lock
    // rather than the whole of what this line does.
    //
    // `Class` then `CalendarEntry`, the order every writer of the pair takes
    // (`docs/lock-order.md`) — the same order the trigger that writes the entry
    // from a `Class` update acquires them in.
    await lockClassRow(tx, classId);

    // `calendarEntry: { cancelledAt: null }` is not decoration and it is not
    // covered by the status conjunct beside it. Before #327 a cancelled class
    // WAS `status: 'cancelled'`, so `sourceStatesFor` excluded it for free;
    // now a cancelled class keeps whatever status it had, and this CAS would
    // happily publish or start one. The liveness half has to be asked for.
    const updated = await tx.class.updateMany({
      where: {
        id: classId,
        status: { in: sourceStatesFor(targetStatus) },
        calendarEntry: { cancelledAt: null },
      },
      data: { status: targetStatus },
    });
    if (updated.count !== 1) return false;
    // #216. Predicated on the TARGET: `draft -> open` must not expire a queue,
    // and `cancelled` is not a `ClassStatus` since #327 — it cannot be named
    // here at all. Cancelling closes the queue in its own door,
    // `POST /api/classes/[id]/cancel`.
    if (targetStatus === 'in_progress') await closeQueueOnStart(tx, classId);
    return true;
  });
  if (moved) return { ok: true, newStatus: targetStatus };

  // Nothing was written, so this read decides nothing that gets persisted —
  // it only tells the caller which refusal happened, and the route maps both
  // to a 409.
  const cls = await db.class.findUnique({
    where: { id: classId },
    select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
  });
  if (!cls) return { ok: false, reason: 'NOT_FOUND', error: `Class not found: ${classId}` };

  // Asked BEFORE `validateTransition`, because the status of a cancelled class
  // is still a live one and the transition it names is still legal on paper —
  // so the state machine alone would answer `CONCURRENT_MODIFICATION` for a
  // class that is simply off.
  if (cls.calendarEntry.cancelledAt !== null) {
    return {
      ok: false,
      reason: 'CANCELLED',
      error: `Class ${classId} is cancelled`,
    };
  }

  const validation = validateTransition(cls.status, targetStatus);
  if (!validation.ok) return validation;

  // The CAS matched nothing, yet the status now permits the move: the row
  // changed twice while we were deciding. Refuse rather than retry — the
  // caller's decision was made against a world that no longer exists.
  return {
    ok: false,
    reason: 'CONCURRENT_MODIFICATION',
    error: `Concurrent modification of class ${classId}`,
  };
}

// ---------------------------------------------------------------------------
// Class completion
// ---------------------------------------------------------------------------

/**
 * Registration statuses that represent a real obligation: the student is
 * charged for these when the class completes. Exported because the archive
 * rule in `class-template-lifecycle.ts` decides what is safe to delete by the
 * same list — a class carrying any of these is one a student is still on the
 * hook for, and must not be removed silently.
 *
 * Frozen, like `ECONOMIC_FIELDS` above: this list now gates a destructive
 * `deleteMany` in two services, so a mutation anywhere in the process would
 * silently widen what archiving is allowed to destroy. Prisma's `in` filter
 * does want a mutable `RegistrationStatus[]` and will not accept a readonly
 * one — that is a constraint on the call site, not on the source of truth, so
 * callers spread (`in: [...CHARGED_STATUSES]`) exactly as the callers of
 * `ACTIVE_REGISTRATION_STATUSES` (`@/lib/registration-status`) do. That set
 * is this one minus `late_cancel`: it asks who occupies a seat, this one asks
 * who gets billed. This constant stays here rather than joining it in `lib/`
 * because only server-side services use it, and comments in
 * `class-transitions.test.ts` and `tests/integration/registrations-api.test.ts`
 * name this file as its home — all by name rather than by line number,
 * deliberately: this docblock has already grown twice since the earliest of
 * them was written (once before this branch, once again by it),
 * and a line-number citation into a docblock that keeps growing is exactly
 * the kind of claim that goes stale silently.
 */
export const CHARGED_STATUSES: readonly RegistrationStatus[] = Object.freeze([
  'registered',
  'attended',
  'no_show',
  'late_cancel',
]);

/**
 * Complete a class: validate transition, calculate pricing, update
 * registrations with prices, and create pending payments.
 *
 * Wrapped in a transaction so that all DB mutations (class status,
 * registration prices, payment creation) succeed or fail atomically.
 */
/**
 * Whether this completion has to prove the class has actually ended.
 *
 * REQUIRED, and a union rather than an optional field, because the dangerous
 * mode is the one you get by saying nothing. `completeClass(db, id)` used to
 * read as "complete it" while silently meaning "and skip the clock" — and the
 * two callers that legitimately want that were indistinguishable from a third
 * that forgot. #182 was exactly the forgetting: `autoCompleteClasses` decided
 * from its own pre-transaction snapshot, so a class rescheduled in the gap was
 * completed against a time it no longer had, and completion runs the pricing
 * engine and writes `Payment` rows.
 *
 * `finishedEarly` is not decoration either. A teacher ending a class early
 * (`POST /api/classes/[id]/complete`) and `deleteTeacherAccount` closing
 * in-flight classes during erasure both mean it, and now have to say so.
 */
export type CompletionTiming = { requireEndedBy: Date } | { finishedEarly: true };

export async function completeClass(
  db: PrismaClient,
  classId: string,
  timing: CompletionTiming,
): Promise<
  TransitionDbResult<'NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'NOT_ENDED_YET' | 'CANCELLED'>
> {
  return db.$transaction(async (tx) => {
    // Before the read, not with the first write. Everything below decides
    // from this row — the status gate, the registration set the pricing
    // engine consumes, and the Payment rows created from it — so the read
    // has to happen under the lock rather than the update acquiring it after
    // the decision is already made.
    await lockClassRow(tx, classId);

    // The entry in the SAME `include` the teacher already came through — the
    // shape this function already used — so `lockClassRow` above covers this
    // read of `date`/`startTime`/`durationMinutes` too, which is the whole
    // point of it locking both rows (`db-locks.ts`).
    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: {
        registrations: true,
        calendarEntry: {
          select: {
            teacherId: true,
            classType: true,
            date: true,
            startTime: true,
            durationMinutes: true,
            cancelledAt: true,
            teacher: { select: { defaultTimezone: true } },
          },
        },
      },
    });
    if (!cls) return { ok: false, reason: 'NOT_FOUND', error: `Class not found: ${classId}` };

    // A cancelled class is never completed, and since #327 its status cannot
    // say so — `validateTransition` below sees an ordinary `open` or
    // `in_progress` row. Completion runs the pricing engine and writes
    // `Payment` rows, so this is the refusal that must not be inferred.
    if (cls.calendarEntry.cancelledAt !== null) {
      return { ok: false, reason: 'CANCELLED', error: `Class ${classId} is cancelled` };
    }

    // #182. The TIMING decision lives here, under the lock this function
    // already holds, rather than in the caller's pre-transaction snapshot.
    // `autoCompleteClasses` used to compute the end time from its outer
    // `findMany` and pass only the id, so a class rescheduled between that
    // read and this transaction was completed against a time it no longer
    // had — and completion runs the pricing engine and creates `Payment`
    // rows, so students were billed for a class whose start had moved.
    //
    // Two callers legitimately skip the check — a teacher finishing early
    // (`POST /api/classes/[id]/complete`) and `deleteTeacherAccount`
    // (`gdpr.ts`) closing in-flight classes during erasure — which is why
    // `finishedEarly` exists rather than the check being unconditional. They
    // have to SAY so: see `CompletionTiming` for why skipping cannot be the
    // silent default.
    if ('requireEndedBy' in timing) {
      // Not a truthiness test. An `Invalid Date` is truthy, and every
      // comparison against it is false, so the old shape let a broken clock
      // through the guard silently. `in` narrows on the KEY, and the explicit
      // NaN check turns a caller bug into a loud one rather than a completed
      // class.
      if (Number.isNaN(timing.requireEndedBy.getTime())) {
        throw new TypeError('completeClass: requireEndedBy is not a valid Date');
      }
      const entry = cls.calendarEntry;
      const start = classStartInstant(entry, entry.teacher.defaultTimezone);
      const end = new Date(start.getTime() + entry.durationMinutes * 60 * 1000);
      if (timing.requireEndedBy < end) {
        return {
          ok: false,
          reason: 'NOT_ENDED_YET',
          error: `Class ${classId} has not ended yet`,
        };
      }
    }

    // If open, transition to in_progress first (teacher completing directly)
    if (cls.status === 'open') {
      const toInProgress = validateTransition('open', 'in_progress');
      if (!toInProgress.ok) return toInProgress;
      await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
      // #216, third of the three `open -> in_progress` exits. The other two go
      // through `transitionClass` and `autoTransitionToInProgress`; this one
      // does not, so it needs its own call. Inside the lock this function
      // already holds, so it is atomic with the status flip above.
      await closeQueueOnStart(tx, classId);
    } else {
      const validation = validateTransition(cls.status, 'completed');
      if (!validation.ok) return validation;
    }

    const chargedRegistrations = cls.registrations.filter((r) =>
      CHARGED_STATUSES.includes(r.status),
    );

    if (chargedRegistrations.length === 0) {
      await tx.class.update({
        where: { id: classId },
        data: { status: 'completed', effectiveTeacherRate: 0, totalStudents: 0, totalRevenue: 0 },
      });
      return { ok: true, newStatus: 'completed' as ClassStatus };
    }

    const pricing = calculateClassPricing({
      roomCost: Number(cls.roomCost),
      minRate: Number(cls.minRate),
      targetRate: Number(cls.targetRate),
      minStudents: cls.minStudents,
      maxStudents: cls.maxStudents,
      studentTiers: chargedRegistrations.map((r) =>
        toIncomeTierOrThrow(r.tierAtBooking, { registrationId: r.id }),
      ),
    });

    await tx.class.update({
      where: { id: classId },
      data: {
        status: 'completed',
        effectiveTeacherRate: pricing.effectiveTeacherRate,
        totalStudents: pricing.studentCount,
        totalRevenue: pricing.totalCost,
      },
    });

    // Iterating the priced records rather than indexing two arrays: price and
    // ratio arrive together, so they cannot skew apart. What assertions remain
    // are on chargedRegistrations, this function's own array — never on the
    // pricing engine's output.
    for (const [i, s] of pricing.students.entries()) {
      const reg = chargedRegistrations[i]!;
      await tx.registration.update({
        where: { id: reg.id },
        data: { price: s.price, tierRatio: s.ratio },
      });
      await tx.payment.create({
        data: { registrationId: reg.id, amount: s.price, status: 'pending' },
      });
    }

    // Payments exist — now tell people about them, in the same transaction.
    // In the Level 1 model this notification IS the payment request.
    const notifications: CreateNotificationInput[] = pricing.students.map((s, i) => {
      const reg = chargedRegistrations[i]!;
      return {
        recipientType: 'student' as const,
        recipientId: reg.studentId,
        type: 'payment_request' as const,
        title: 'Payment requested',
        body: `Your price for ${cls.calendarEntry.classType} is €${s.price.toFixed(2)}. Pay your teacher directly.`,
        relatedClassId: cls.id,
      };
    });
    notifications.push({
      recipientType: 'teacher' as const,
      recipientId: cls.calendarEntry.teacherId,
      type: 'payment_request' as const,
      title: 'Class completed',
      body: `${cls.calendarEntry.classType} completed — €${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`,
      relatedClassId: cls.id,
    });
    await createBulkNotifications(tx, notifications);

    return { ok: true, newStatus: 'completed' as ClassStatus };
  });
}

// ---------------------------------------------------------------------------
// Class updates
// ---------------------------------------------------------------------------

/**
 * The fields a teacher may change on an existing class.
 *
 * Derived from `updateClassSchema` rather than hand-declared. `date` and
 * `startTime` are the two differences — `YYYY-MM-DD` / `HH:MM` strings on the
 * wire, a `Date` (`@db.Date` / `@db.Time`) by the time either reaches Prisma.
 *
 * Deriving alone buys no safety: the route builds its payload with
 * `{ ...rest }`, and spreading defeats TypeScript's excess-property check, so
 * the route itself will never flag a field added to the schema — it reaches
 * `db.class.updateMany` either way, hand-declared or derived. What deriving
 * enables is the pins below, and they are what catches it now: before them
 * adding a field to `updateClassSchema` alone left `tsc --noEmit` at exit 0
 * (that was true when this type landed, and is why #79 was filed); today the
 * allowlist pin fails the build with the field named.
 */
export type ClassUpdateData =
  Omit<z.infer<typeof updateClassSchema>, 'date' | 'startTime'> & { date?: Date; startTime?: Date };

/**
 * The half of an edit that lands on `CalendarEntry` rather than on `Class`
 * (#327). Everything not named here goes to `Class`.
 *
 * A pure type, and the split it names is performed by a destructure inside
 * `updateClass` rather than by iterating a runtime copy of this list — a
 * destructure gives each half its own Prisma-checkable type and makes the
 * `Class` half the REMAINDER by construction, so no field can fall into
 * neither. The two are tied together by a pin at that destructure; the three
 * pins below tie this list to the two tables' actual columns.
 */
type EntryUpdateField = 'classType' | 'date' | 'startTime' | 'durationMinutes';

/**
 * Compile-time pin: every field the wire schema accepts must be a column
 * `updateMany` can actually write, on whichever of the two tables
 * `EntryUpdateField` routes it to.
 *
 * Because `ClassUpdateData` is derived, a new schema field lands in `keyof
 * ClassUpdateData`; if it has no matching column this pin resolves to that
 * field's name instead of `true`, and the assignment below stops compiling
 * with the offending field named in the error. A hand-declared type could not
 * do this — the unknown field would never appear in `keyof` at all.
 *
 * TWO pins rather than one union of both tables' columns, and that is the
 * point of splitting them: a union would accept `date` as a `Class` column
 * because `CalendarEntry` has one, and the whole hazard of this extraction is
 * a field written to the table it left.
 *
 * The reference is the *Many* input deliberately: `ClassUncheckedUpdateInput`
 * (the single-record type) additionally accepts nested relation writes
 * (`registrations`, `notifications`, …) that `updateMany` rejects, so pinning
 * against it would wave through a schema field named after a relation.
 */
const _classUpdateColumnsExist: NoneOf<
  Exclude<
    Exclude<keyof ClassUpdateData, EntryUpdateField>,
    keyof Prisma.ClassUncheckedUpdateManyInput
  >
> = true;
void _classUpdateColumnsExist;

/** Compile-time pin: the entry half must be columns of `CalendarEntry`. */
const _entryUpdateColumnsExist: NoneOf<
  Exclude<EntryUpdateField, keyof Prisma.CalendarEntryUncheckedUpdateManyInput>
> = true;
void _entryUpdateColumnsExist;

/**
 * Compile-time pin: the entry half must still be fields the wire schema
 * accepts. Without it, dropping `durationMinutes` from `updateClassSchema`
 * would leave a member here that `updateClass`'s split looks for and never
 * finds — a silently dead branch rather than a build failure.
 */
const _entryUpdateFieldsAreSent: NoneOf<
  Exclude<EntryUpdateField, keyof ClassUpdateData>
> = true;
void _entryUpdateFieldsAreSent;

/**
 * The fields a teacher may change on their own class via `PUT /api/classes/[id]`.
 *
 * A pure type, not a runtime array: nothing reads this list at runtime — the
 * schema's `.strict()` already rejects undeclared keys, so this exists only to
 * feed the two pins below. Unlike `ECONOMIC_FIELDS`, which the update path
 * genuinely iterates, a runtime `as const` array here would be used solely as
 * a `typeof` source and earn an eslint suppression for the privilege.
 *
 * Adding a member is how a new schema field gets authorized: it grants write
 * access to a column of one of the two tables a class spans — `EntryUpdateField`
 * above decides which, and four of the members below are `CalendarEntry`
 * columns since #327 — and that column may be gated by business logic the plain
 * update path does not run. Before adding one, go read what actually guards
 * that column — none of these guards live in `updateClass`, which is the point:
 *   - `status`             → the lifecycle state machine (`VALID_TRANSITIONS`),
 *                            enforced by `validateTransition` in
 *                            `transitionClass` and `completeClass`
 *   - `settingsLocked`     → written once by the first registration
 *                            (`api/registrations/route.ts`). `updateClass` only
 *                            *reads* it, to gate `ECONOMIC_FIELDS` — so nothing
 *                            here would stop a write to the flag itself
 *   - `teacherId`          → class ownership, checked in the route
 *                            (`api/classes/[id]/route.ts`), not in this service.
 *                            A `CalendarEntry` column since #327, which is why
 *                            `_forbiddenColumnsExist` below pins the forbidden
 *                            list against BOTH tables' inputs
 *   - the financial totals → written only by `completeClass`
 * — because the compiler will not. For the columns above, the forbidden pin
 * below refuses the grant outright; for anything else, the judgement is yours.
 */
type TeacherEditableClassField =
  | 'classType'
  | 'description'
  | 'date'
  | 'startTime'
  | 'durationMinutes'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents';

/**
 * Compile-time pin (forward): every field `updateClassSchema` accepts must be
 * on the teacher-editable allowlist. Add a column-shaped field to the schema
 * without adding it to the allowlist and this resolves to that field's name
 * instead of `true`, failing the build with the field named. This is the guard
 * the column pin above does NOT provide: `status` is a perfectly real, writable
 * column, so that pin waves it through.
 *
 * What it proves is narrower than "this field is permitted". Together with the
 * reverse pin it forces the allowlist to equal the schema's key set exactly, so
 * the allowlist holds no policy of its own and cannot encode "the schema has
 * `status` but a teacher may not write it" — that state does not compile. What
 * it buys is that the grant must be *explicit*: a new schema field breaks the
 * build until someone also names it above, next to the list of what else guards
 * these columns. It cannot tell a considered grant from a paste of the name the
 * error just handed you. The forbidden pin below is what refuses the grants
 * that are never right. See issue #79 for the latent `status` bypass this
 * closes — latent, because no such field is in the schema today.
 */
const _classUpdateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassUpdateData, TeacherEditableClassField>
> = true;
void _classUpdateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts. Remove a field from `updateClassSchema` but leave it on the
 * allowlist and this names the stale entry, so the list can't rot into granting
 * permission for a column that no longer flows through this route.
 *
 * Two things to know before deleting this as redundant paranoia:
 *   - It is the only pin that fires if `ClassUpdateData` ever degrades to `{}`
 *     or `unknown` — on an empty `keyof`, the forward pin passes vacuously.
 *     Measured across `any`, `unknown`, `{}`, `never` and an added index
 *     signature: every degradation trips the forward pin or this one, and the
 *     narrowing half is caught here alone.
 *   - It is blind to exactly one field. `date` is re-added unconditionally by
 *     the intersection in `ClassUpdateData`, so it is in `keyof` whether or not
 *     the schema declares it, and dropping `date` from the schema leaves both
 *     pins green. Covered instead by the key-set test in `schemas.test.ts`,
 *     which reads the schema object rather than a type derived from it.
 */
const _allowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassField, keyof ClassUpdateData>
> = true;
void _allowlistHasNoStaleFields;

/**
 * The `Class` columns the plain update path must never write.
 *
 * "Plain update path", not "never": each of these is owned by a different,
 * guarded route — `status` by `POST …/transition` and `completeClass`,
 * `settingsLocked` by the first registration. The pin says "not here", which is
 * why the name says it too.
 *
 * The forward and reverse pins force the allowlist to mirror the schema, which
 * means the quickest way to make a forward-pin failure go away is to paste the
 * offending field name into the allowlist — exactly the reflexive grant #79 is
 * about. This list is the set where that repair is never the right one, and the
 * pin below fails on a const whose *name* carries the reason, since the name is
 * the part of a type error people actually read.
 *
 * It also changes the shape of the mistake: adding a member above is a one-line
 * edit that looks like configuration, while deleting a member here reads in
 * review as what it is. Granting one of these still has an escape hatch — the
 * contributor has to remove it from this list first — and that is the point,
 * not a weakness: the guard makes the decision visible, it does not pretend to
 * be an access-control system.
 */
type PlainUpdateForbiddenClassField =
  | 'id'
  | 'teacherId'
  | 'status'
  | 'settingsLocked'
  | 'effectiveTeacherRate'
  | 'totalStudents'
  | 'totalRevenue';

/**
 * Compile-time pin (completeness): no column may leave the list above
 * silently. The other two pins hold MEMBERSHIP — every name is a real column —
 * and NON-OVERLAP with the allowlist. Neither notices a deletion, so until
 * this line the docblock's "the contributor has to remove it from this list
 * first" was a one-line edit with nothing on the other side of it.
 *
 * Measured at PR review on the template twin: running the full escape hatch —
 * drop the name here, add it to the allowlist, add it to the zod schema —
 * produced exactly ONE error across the whole project, and it was in a client
 * component's form-coverage pin, which a contributor clears by adding the
 * field to the form. Duplication is the price; it turns a silent deletion into
 * a two-place edit, which is the visibility the docblock above says it wants.
 */
const _classForbiddenListIsComplete: NoneOf<
  Exclude<
    | 'id'
    | 'teacherId'
    | 'status'
    | 'settingsLocked'
    | 'effectiveTeacherRate'
    | 'totalStudents'
    | 'totalRevenue',
    PlainUpdateForbiddenClassField
  >
> = true;
void _classForbiddenListIsComplete;

/**
 * Compile-time pin: every name above must be a real column of one of the two
 * tables a class now spans. Without this, a typo (`statuss`) would sit in the
 * forbidden list protecting nothing while looking like protection — the same
 * rot the reverse pin exists to stop, one list over.
 *
 * A UNION here, unlike the split pin on the editable half above, because this
 * list is about what a teacher may not write ANYWHERE on their class, not
 * about which statement writes it: `teacherId` is a `CalendarEntry` column
 * since #327 and `status` a `Class` one, and both are equally forbidden. The
 * split pin's hazard — a field written to the table it left — does not arise
 * for a list nothing is ever written from.
 */
const _forbiddenColumnsExist: NoneOf<
  Exclude<
    PlainUpdateForbiddenClassField,
    | keyof Prisma.ClassUncheckedUpdateManyInput
    | keyof Prisma.CalendarEntryUncheckedUpdateManyInput
  >
> = true;
void _forbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * teacher-editable allowlist. Fails naming the field that must not be there.
 */
const _allowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassField, PlainUpdateForbiddenClassField>
> = true;
void _allowlistHasNoForbiddenFields;

/**
 * Thrown when `updateClass` reaches a state its own guards say cannot happen.
 * A programmer error, never a business outcome — business outcomes are values
 * of `UpdateClassResult`. Named so it is distinguishable from unrelated
 * failures in `withErrorHandler`'s catch-all.
 */
export class UpdateClassInvariantError extends Error {}

/**
 * A class row together with the entry that carries its calendar identity —
 * what `updateClass` hands back, and what `PUT /api/classes/[id]` flattens
 * onto one wire object.
 *
 * Derived from the query rather than written out: `Class & { calendarEntry:
 * CalendarEntry }` would be a second declaration of a shape Prisma already
 * knows, and it would go on compiling after a column moved between the two.
 */
export type ClassWithEntry = Prisma.ClassGetPayload<{ include: { calendarEntry: true } }>;

/**
 * The two states that freeze a class, as one value.
 *
 * Not `ClassStatus`: since #327 a cancelled class keeps a live status and
 * carries its cancellation on the entry, so the set the teacher needs named
 * back to them is no longer a subset of the enum. `ClassStatus` rather than
 * the literal `'completed'` on the other side, because
 * `TERMINAL_CLASS_STATUSES` is derived — narrowing here would go stale the day
 * a second terminal status is added, in the silent direction.
 */
export type TerminalClassState = ClassStatus | 'cancelled';

/**
 * Which freeze holds this class, or `null` if none does.
 *
 * One function rather than two conditions written out at the three sites that
 * ask (the early return, the class CAS's miss branch, and `updateClass`'s own
 * CAS filter's intent) — the two halves live on two different rows now, and a
 * site that remembers only the status half is exactly the defect this
 * extraction makes easy.
 *
 * `completed` is reported ahead of `cancelled` when a row somehow carries
 * both: it is the state that also bills.
 */
function frozenStateOf(
  status: ClassStatus,
  cancelledAt: Date | null,
): TerminalClassState | null {
  if (TERMINAL_CLASS_STATUSES.includes(status)) return status;
  if (cancelledAt !== null) return 'cancelled';
  return null;
}

/**
 * Carries a refusal out of `updateClass`'s transaction by throwing, so the
 * transaction ROLLS BACK rather than committing whatever the other half
 * already wrote.
 *
 * A returned value would not do: `db.$transaction`'s callback returning
 * normally commits, and this function now issues up to two writes across two
 * tables. Without this, a class-half write followed by an entry-half refusal
 * would leave the teacher's economics applied and their reschedule silently
 * dropped — half an edit, reported as a clean 409.
 *
 * Never escapes this module: the `catch` around the transaction converts it
 * straight back into the `UpdateClassResult` it carries.
 */
class UpdateClassRefusal extends Error {
  constructor(readonly result: UpdateClassResult) {
    super('updateClass: refused, rolling back');
  }
}

/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 *
 * `terminal` carries the state for the same reason `locked` carries fields:
 * the caller owns the wording and needs to name what happened. It is
 * `TerminalClassState` rather than `ClassStatus` because since #327 one of the
 * two things it can name is not a status at all — a cancelled class keeps
 * whatever live status it had, and its cancellation is a column on the entry.
 * The 409's sentence still has to say "cancelled", so the value has to.
 *
 * `past_start` carries NOTHING, and the asymmetry with its two neighbours is
 * deliberate. `locked` and `terminal` carry data because their callers' MESSAGE
 * VARIES with it — `terminal`'s 409 renders "completed" or "cancelled" from one
 * branch, and an integration test exists to pin that variance. This refusal has
 * one sentence for every past start, whether the offending value arrived as
 * `date`, as `startTime`, or as both. A carried instant would be a payload
 * nothing reads.
 *
 * Every *business* outcome of an update is a variant here. The one non-outcome
 * — an invariant violation, where the function's own reasoning about its
 * inputs turns out to be wrong — is not encoded as a value; it throws
 * `UpdateClassInvariantError` instead.
 */
export type UpdateClassResult =
  | { ok: true; cls: ClassWithEntry }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'terminal'; state: TerminalClassState }
  | { ok: false; reason: 'no_fields' }
  /**
   * The ENTRY refused the write: its schedule is frozen. Distinct from
   * `terminal`, which is the `Class` row's own refusal, because the two
   * statements guard different rows and a teacher reading the 409 needs to
   * know which half of their class said no — `terminal` is about the class,
   * this is about when it sits in the calendar.
   */
  | { ok: false; reason: 'frozen' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'template_date_conflict' }
  | { ok: false; reason: 'past_start' };

/**
 * Apply a partial update to a class, enforcing two independent freezes and one
 * scheduling rule.
 *
 * The FREEZES gate on different events and cover different things. The
 * ECONOMIC freeze (`settingsLocked`) starts at the first registration and
 * covers `ECONOMIC_FIELDS`. The TERMINAL freeze (#247) starts when the class
 * completes or is cancelled and covers EVERY field — it is the class that is
 * frozen, not a list of columns. Since #327 its two halves are read from two
 * different rows (`Class.status`, `CalendarEntry.cancelledAt`), which is what
 * `frozenStateOf` above exists to keep in one place.
 *
 * IT WRITES TWO TABLES, so it is an explicit transaction and it takes
 * `lockClassRow` (`db-locks.ts`) rather than letting Prisma's statement order
 * decide which row it holds first. `classType`, `date`, `startTime` and
 * `durationMinutes` land on the entry; `description` and every
 * `ECONOMIC_FIELDS` member land on `Class`. Each half runs only if it HAS
 * work — a request
 * editing only `startTime` leaves the class half empty, and an `updateMany`
 * with nothing to set is not a reliable count-of-1 — and each half has its own
 * refusal, because a `Class` miss means terminal status and a `CalendarEntry`
 * miss means a frozen schedule, which are two different sentences.
 *
 * THE SCHEDULING RULE (#249) IS NOT A THIRD FREEZE, and it still belongs in
 * this inventory. A freeze is a property of the CLASS: once it holds, some set
 * of columns is shut for good. The past-start rule is a property of the WRITE
 * — it refuses a `date`/`startTime` edit whose resulting start instant has
 * already passed, and refuses nothing else. The same class, in the same state,
 * accepts a description edit, and accepts a reschedule to next week. Counting
 * it among the freezes would predict a permanence it does not have; leaving it
 * out altogether leaves the function's inventory one refusal short of what it
 * enforces.
 *
 * NEITHER LIFTS. They differ in SCOPE, not in permanence. An earlier revision
 * of this docblock said a teacher could undo the economic freeze by removing
 * the registration; that was never true. `settingsLocked` is only ever written
 * `true`, from one site (`POST /api/registrations`), and nothing anywhere
 * writes it back to `false` — checked by grep rather than by memory.
 * `settingsLocked:` in `src/`, minus the tests and minus prose (this sentence
 * and the two comments beside the CAS below), is four sites: ONE `data:`
 * payload, `registrations/route.ts`'s `{ settingsLocked: true }`; ONE `where:`
 * filter, the conditional conjunct in `updateClass`'s own CAS below, which
 * reads the column and writes nothing; and TWO type annotations,
 * `isEconomicFieldLocked`'s parameter and `class-edit-form.tsx`'s prop. The
 * version of this parenthesis before it was re-derived said "one `data:`
 * payload and two `where:` filters" — a filter that does not exist, and no
 * annotations at all. The conclusion held on a tally that did not, which is
 * the failure a grep is there to prevent.
 *
 * A terminal status, in turn, has no outgoing transition.
 *
 * Both are checked twice, for the same reason. The first check, against the
 * row we just read, is an optimisation: it answers the common case in one
 * query instead of three. The compare-and-swap inside the write is the one
 * that matters — it catches a first registration, or a completion, landing
 * between that read and this write, and on its own it produces the identical
 * result, list of offending fields included. Deleting the ECONOMIC check costs
 * round trips, not correctness, for exactly that reason.
 *
 * DELETING THE TERMINAL CHECK IS NOT AS FREE, AND IT CHANGES THE ANSWER IN
 * THREE CASES. Measured rather than reasoned: stubbing the check out reddens
 * exactly five tests, covering the three cases below. All three are questions
 * of ORDER — the terminal check sits above three other early returns, and each
 * would answer first without it:
 *
 *  1. A class that is BOTH terminal and settings-locked with an economic
 *     field sent. `cls.settingsLocked && sentEconomic !== null` fires next and
 *     answers `locked` — the narrower and more misleading of two true
 *     refusals, since it reports the refusal as being about economic fields
 *     when in fact every field is refused. Pinned by `'reports terminal, not
 *     locked, when the class is both'`.
 *  2. A terminal class with an empty or all-`undefined` payload. `hasEdit`
 *     fires next and answers `no_fields` (a 400) where the class is in fact
 *     frozen (a 409) — and here the CAS re-derives nothing at all, because
 *     control returns before any write is attempted. Pinned by `'answers
 *     terminal, not no_fields, for a body that asks for nothing'`.
 *  3. A terminal class sent a `date` or `startTime` that has already passed —
 *     which is EVERY terminal class a real reschedule reaches, since a
 *     completed class's start is in the past by definition. #249's guard
 *     fires next and answers `past_start`: still a 409, still a refusal, but
 *     it reports the weaker and more temporary of two reasons, as though a
 *     different date would help. Nothing would; the class is frozen. This is
 *     the case that made the count three, and it is pinned three times over —
 *     `'refuses a date edit on a completed class, and writes nothing (#247)'`,
 *     its `cancelled` sibling, and the stub `'answers a visibly-terminal row
 *     from the read'`. That #247's own tests are what catch it is the point:
 *     the guard added after them silently took over their refusal.
 *
 * Everywhere else deleting it costs only round trips, and the CAS does
 * re-derive the same refusal.
 *
 * The terminal freeze additionally has a database backstop, and since #327 it
 * covers three columns rather than one: `entry_frozen_schedule_guard` refuses
 * a `date`, `startTime` or `durationMinutes` change on a frozen entry, which
 * is the span `waitlist-retention.ts` and the slot constraint both read. The
 * CAS below is the path that returns a 409; the trigger is what reaches a
 * client that never goes through this function.
 */
export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult> {
  const cls = await db.class.findUnique({
    where: { id: classId },
    include: {
      calendarEntry: {
        select: {
          id: true,
          teacherId: true,
          date: true,
          startTime: true,
          cancelledAt: true,
          teacher: { select: { defaultTimezone: true } },
        },
      },
    },
  });
  if (!cls) return { ok: false, reason: 'not_found' };
  const entry = cls.calendarEntry;

  // Checked BEFORE #249's past-start guard, before the economic lock AND
  // before `hasEdit`, and the position is load-bearing in every direction. For
  // most inputs this is an optimisation only — the two CASes below re-derive
  // the same refusal — but for THREE it is what produces the right answer at
  // all, because each of the three early returns downstream would otherwise
  // answer first: `past_start` for a frozen class sent a date that has passed,
  // `locked` for a class that is also settings-locked with an economic field
  // sent, and `no_fields` for an empty or all-undefined payload. The last is
  // the one that gets forgotten, because no CAS can cover it: `hasEdit`
  // returns before any write is attempted, so there is no compare-and-swap to
  // fall back on. `updateClass`'s docblock enumerates all three, each with the
  // test that pins it.
  const frozenState = frozenStateOf(cls.status, entry.cancelledAt);
  if (frozenState !== null) {
    return { ok: false, reason: 'terminal', state: frozenState };
  }

  // #249. A write may not newly place this class's start in the past.
  //
  // AFTER the terminal check, not before. A completed class edited with a 2020
  // date is refused because it is frozen, which is the older and stronger
  // reason; answering "that date has passed" there would be true, unhelpful,
  // and a regression on #247's two tests. Before the economic check because
  // this is a whole-request refusal like `terminal`, where `locked` is a
  // field-level one.
  //
  // GATED ON THE FIELDS SENT **AND** ON THE START ACTUALLY MOVING. Both
  // conjuncts are load-bearing, but not equally, and an earlier revision of
  // this comment claimed a parity that did not exist: for every row with a
  // READABLE `startTime` the field gate decides nothing at all, because with
  // neither field sent both `classStartInstant` calls receive identical
  // arguments and `movesStart` is already false. Delete it and 77 of the 78
  // tests in `class-lifecycle.test.ts` stay green.
  //
  // The 78th is what it is for. An unparseable stored `startTime` makes both
  // instants `NaN`, `NaN !== NaN` is true, and `movesStart` alone would then
  // read a description-only edit as a start-moving one — refusing, since
  // `startsInPast` fails closed on exactly that input. The field gate is what
  // stops the scheduling guard from refusing a write that schedules nothing.
  // Pinned by `'lets a non-scheduling edit through even when the stored
  // startTime is unreadable'`, which is a stub test because no validated row
  // can reach this state.
  //
  // An `open` class whose
  // start has already passed is a state the system produces legitimately —
  // `generateClassInstances` creates one every time it runs later in the day
  // than its template's own start time, and every class is in it for up to the
  // 60 seconds before the transition sweep. A past-dated `draft` is a second
  // such state, and a permanent one: create is unguarded (spec §6) and no sweep
  // selects drafts, so it sits there until someone fixes it.
  //
  // THE `moved` CONJUNCT IS WHY THE FIELD GATE IS NOT ENOUGH, and it is not
  // theoretical. `ClassEditForm` PUTs the whole form on every save, so `date`
  // and `startTime` are present in every request this route ever receives —
  // the field gate alone never narrows anything in production, and a teacher
  // editing only the description of a past-dated draft was refused with
  // "Cannot move a class to a date and time that has already passed" having
  // moved nothing. The rule is that a write may not NEWLY PLACE the start in
  // the past; leaving it where it already was is not that.
  //
  // NOT COVERED BY `lockClassRow`, and that is not the same thing as safe.
  // This whole check runs on `entry`, the pre-transaction read above (before
  // the lock, before the transaction even opens); `lockClassRow` (below) only
  // closes the LOCK→WRITE gap, not the READ→LOCK gap this decision is made
  // in. The residual: entry dated today at 09:00; a concurrent call to this
  // same function reschedules it sooner and commits before this call reaches
  // its lock (its own guard passes, against ITS OWN fresh read); this call,
  // still holding the `entry.date` it read before that commit, computes
  // `movesStart`/`startsInPast` against a row that no longer exists — and if
  // this call's own request omits `date` (sending only `startTime: '01:00'`,
  // say), its write touches `startTime` alone and lands beside whatever
  // `date` the concurrent call already left, newly placing the start in the
  // past. A wrong answer in a race this narrow — two writes to the same entry
  // inside one read-to-lock gap — not a broken invariant held open by design.
  //
  // It stays this narrow: `updateClass` is the only writer of a REGULAR
  // entry's `date`/`startTime` (the studio family's PUT route writes the same
  // two columns, but only on `kind: 'studio'` rows, which this function never
  // reaches). Re-derive, don't trust this sentence: `grep -rn
  // 'calendarEntry\.update' src`.
  if (data.date !== undefined || data.startTime !== undefined) {
    const timeZone = entry.teacher.defaultTimezone;
    const effectiveDate = data.date ?? entry.date;
    const effectiveStartTime = data.startTime ?? entry.startTime;
    // Compared as instants through the same function, so a resend of the stored
    // values can never read as a move however it was serialised.
    const effectiveStart = classStartInstant(
      { date: effectiveDate, startTime: effectiveStartTime },
      timeZone,
    );
    const movesStart =
      effectiveStart.getTime() !==
      classStartInstant(entry, timeZone).getTime();
    if (movesStart && startsInPast(
        { date: effectiveDate, startTime: effectiveStartTime, timeZone },
        new Date(),
      )) {
      // Logged, because a 409 with prose in it is all the teacher gets and
      // nothing else records why. The refusal has three causes that look
      // identical from outside — the start really has passed, the teacher's
      // `defaultTimezone` is wrong (it is hardcoded to `Europe/Amsterdam` at
      // signup, so it is wrong for most of the world), or `startTime` is
      // unreadable and `startsInPast` failed closed. `timeZone` and
      // `startInstant` together separate all three by grep, which is the whole
      // of this VPS's observability.
      //
      // `info`, not `warn`: a teacher picking yesterday is ordinary use, not an
      // anomaly. The unreadable-`startTime` case warns on its own account
      // inside `startsInPast`, where it can say what it actually saw.
      //
      // NaN-checked before `toISOString`, which throws a RangeError on an
      // Invalid Date. That combination is reachable now precisely because
      // `startsInPast` fails closed: it answers `true` for exactly the input
      // whose instant cannot be serialised, so a naive log line here would
      // turn every corrupt row from a clean 409 into a 500.
      log.info(
        {
          classId,
          timeZone,
          // BOTH through `isoOrNull`. `effectiveStart` is the obvious one; the
          // date was missed on the first pass and threw a RangeError for a
          // payload this guard had correctly decided to refuse. `isoDate`
          // keeps the route from producing one, but this is a service and
          // takes a `Date`.
          date: isoOrNull(effectiveDate)?.slice(0, 10) ?? null,
          startTime: timeToHHmm(effectiveStartTime),
          startInstant: isoOrNull(effectiveStart),
        },
        'updateClass refused: the edit would move this class start into the past',
      );
      return { ok: false, reason: 'past_start' };
    }
  }

  // Destructured rather than length-checked, so the non-empty tuple below is
  // proven to the compiler (via noUncheckedIndexedAccess) instead of asserted.
  const [firstEconomic, ...otherEconomic] = ECONOMIC_FIELDS.filter(
    (f) => data[f] !== undefined,
  );
  const sentEconomic: readonly [EconomicField, ...EconomicField[]] | null =
    firstEconomic === undefined ? null : [firstEconomic, ...otherEconomic];

  if (cls.settingsLocked && sentEconomic !== null) {
    return { ok: false, reason: 'locked', fields: sentEconomic };
  }

  // The split, by destructuring rather than by iterating a name list, so the
  // compiler types each half and `classFields` is the remainder BY
  // CONSTRUCTION — nothing can fall into neither.
  const { classType, date, startTime, durationMinutes, ...classFields } = data;
  const entryFields = { classType, date, startTime, durationMinutes };

  // Compile-time pin: the destructure above and `EntryUpdateField` name the
  // same set. Without it the type could gain a member the destructure never
  // takes, which would silently send that field to `Class` — the table it just
  // left. Both directions, because either half alone passes vacuously.
  const _splitMatchesEntryFields: NoneOf<
    | Exclude<keyof typeof entryFields, EntryUpdateField>
    | Exclude<EntryUpdateField, keyof typeof entryFields>
  > = true;
  void _splitMatchesEntryFields;

  // A key whose value is `undefined` is not an edit. Prisma agrees more
  // strongly than you might expect: given a `data` object whose every value is
  // undefined it issues no UPDATE at all and returns `{ count: 0 }` — with no
  // regard for whether the row exists. Testing key *presence* (rather than
  // defined *values*, as `sentEconomic` above already does) let a no-op
  // payload reach the compare-and-swap, come back with a zero count, and land
  // in the "unreachable" branch below as a 500.
  //
  // Asked PER HALF now, not once for the whole payload. A `startTime`-only
  // edit leaves `classFields` all-undefined, and running the class CAS anyway
  // would return `{ count: 0 }` for a request that asked it to do nothing —
  // which this function would then read as a lost race.
  const hasEntryEdit = Object.values(entryFields).some((v) => v !== undefined);
  const hasClassEdit = Object.values(classFields).some((v) => v !== undefined);
  if (!hasEntryEdit && !hasClassEdit) {
    return { ok: false, reason: 'no_fields' };
  }

  try {
    return await db.$transaction(async (tx) => {
      // `Class`, then `CalendarEntry` — the order every writer of these two
      // rows takes them in (`db-locks.ts`), and the order the two statements
      // below then write them in. Taken deliberately rather than inherited
      // from Prisma's statement emission: an entry-then-class emission order
      // would deadlock against every other holder of this pair.
      await lockClassRow(tx, classId);

      // Both CASes carry the SAME freeze, expressed against whichever row
      // they write — `frozenStateOf`'s two halves, one on each table. That
      // symmetry is what makes a partial edit unreachable rather than merely
      // unlikely: the entry's filter can only miss for a class that also fails
      // the class filter, so a successful class write is never followed by an
      // entry refusal. The `UpdateClassRefusal` throw below does not depend on
      // that argument holding — it rolls back either way.
      if (hasClassEdit) {
        const written = await tx.class.updateMany({
          where: {
            id: classId,
            status: { notIn: [...TERMINAL_CLASS_STATUSES] },
            // The cancel half of the freeze, which no longer lives on this
            // row. Without it a cancelled class would accept a description or
            // an economic edit, because its status is still `draft` or `open`.
            calendarEntry: { cancelledAt: null },
            ...(sentEconomic !== null ? { settingsLocked: false } : {}),
          },
          data: classFields,
        });
        if (written.count !== 1) {
          throw new UpdateClassRefusal(await explainClassCasMiss(tx, classId, sentEconomic));
        }
      }

      if (hasEntryEdit) {
        // The CAS moved with the columns. `status: { notIn: TERMINAL }` sat on
        // `Class`, and four of the ten editable fields left that table, so
        // this filter is the entry's OWN columns — the same predicate
        // `entry_frozen_schedule_guard` enforces. The trigger is the backstop
        // that reaches raw SQL; this is the path that returns a 409.
        const written = await tx.calendarEntry.updateMany({
          where: {
            id: entry.id,
            classCompletedAt: null,
            NOT: { kind: 'regular', cancelledAt: { not: null } },
          },
          data: entryFields,
        });
        if (written.count !== 1) {
          throw new UpdateClassRefusal({ ok: false, reason: 'frozen' });
        }
      }

      // Re-read under the lock this transaction still holds, so what comes
      // back cannot be a version another writer produced after the write.
      // `findUnique`, not `findUniqueOrThrow`: nothing can delete this row
      // while the lock is held, but `P2025` has no branch in
      // `classifyApiError`, so a throw here would surface a bare 500 where a
      // variant already exists.
      const updated = await tx.class.findUnique({
        where: { id: classId },
        include: { calendarEntry: true },
      });
      // THROWN, not returned, and the difference is that a `return` COMMITS.
      // Unreachable under the lock this transaction is holding — the entry FK
      // is `ON DELETE CASCADE`, so deleting the entry out from under us needs
      // the `Class` row lock we hold — but this file's own argument about its
      // siblings applies here word for word: the throw does not depend on that
      // argument holding. Every other refusal in this transaction rolls back;
      // this one used to commit two writes and then report the row missing.
      if (!updated) throw new UpdateClassRefusal({ ok: false, reason: 'not_found' });
      return { ok: true, cls: updated };
    });
  } catch (err) {
    if (err instanceof UpdateClassRefusal) return err.result;
    // #327. The slot key became `CalendarEntry_teacher_slot_excl`, an
    // `EXCLUDE USING gist` raising `23P01` — not a P2002 with a column list,
    // so `isUniqueConflictOn` cannot see it at all and this is a different
    // matcher (`exclusion-conflict.ts`). It is also RANGE-based rather than
    // exact-start now: a reschedule that merely OVERLAPS another of this
    // teacher's live entries collides, where before only an identical start
    // time did.
    if (isExclusionConflictOn(err, 'CalendarEntry_teacher_slot_excl')) {
      return { ok: false, reason: 'slot_conflict' };
    }
    // `CalendarEntry_scheduleRuleId_date_key` — the generator's one-per-week
    // key, reachable only from a reschedule, and only when the entry carries a
    // `scheduleRuleId`. Distinct message and code at the route: the slot 409
    // names a date AND time; this collision can fire with the two entries'
    // times entirely different, so naming the time back to the teacher there
    // would describe a clash that didn't happen.
    if (isUniqueConflictOn(err, ['scheduleRuleId', 'date'])) {
      return { ok: false, reason: 'template_date_conflict' };
    }
    throw err;
  }
}

/**
 * Which conjunct of the `Class` CAS failed — asked only after it has already
 * failed, so this decides nothing that gets persisted.
 *
 * Split out of `updateClass` because the CAS now sits inside a transaction and
 * its miss has to be turned into a value before the throw that rolls that
 * transaction back; inlining it would put three `await`s inside a `throw`
 * expression.
 *
 * Runs on `tx`, under the lock the caller holds, so the row it re-reads is the
 * one the CAS just failed against rather than a later version of it.
 */
async function explainClassCasMiss(
  tx: Prisma.TransactionClient,
  classId: string,
  sentEconomic: readonly EconomicField[] | null,
): Promise<UpdateClassResult> {
  // Every filter shape constrains `id`, so a deleted row explains a zero count
  // under any of them — find out which happened rather than assuming. #72 was
  // this branch asserting a cause instead of checking it; the economic path
  // had the identical defect, and a deleted class reported as "locked" is
  // harder to spot than #72's empty list, because the field name it names
  // looks entirely plausible.
  const stillExists = await tx.class.findUnique({
    where: { id: classId },
    select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
  });
  if (!stillExists) return { ok: false, reason: 'not_found' };

  // The class froze between the opening read and the write — the race the CAS
  // exists to lose. This branch is NOT optional cleanup: without it a
  // `description`-only edit on a completed class reaches the throw below (the
  // row exists, and `description` is not economic, so `sentEconomic` is null)
  // and `withErrorHandler` answers 500 — for the single most likely request
  // #247 is about.
  const frozenState = frozenStateOf(stillExists.status, stillExists.calendarEntry.cancelledAt);
  if (frozenState !== null) return { ok: false, reason: 'terminal', state: frozenState };

  // The row survives and is live, so the only other conjunct that can have
  // failed is `settingsLocked: false` — which is only ever in the filter when
  // economic fields were sent.
  const [firstField, ...otherFields] = sentEconomic ?? [];
  if (firstField !== undefined) {
    return { ok: false, reason: 'locked', fields: [firstField, ...otherFields] };
  }

  // Unreachable, and still actually so with a third conjunct in the filter:
  // the caller only runs that statement when `classFields` holds a defined
  // value, so Prisma issues a real UPDATE, and every conjunct that UPDATE can
  // fail on has just been re-read — the row exists, it is neither completed
  // nor cancelled, and `settingsLocked: false` is only ever in the filter when
  // economic fields were sent. Loud rather than silently returning a
  // plausible-but-wrong reason.
  throw new UpdateClassInvariantError(
    `updateClass: class ${classId} matched no rows but still exists`,
  );
}
