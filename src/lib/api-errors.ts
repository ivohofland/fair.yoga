import { Prisma } from '@prisma/client';
import { isExclusionConflictOn } from './exclusion-conflict';

/**
 * Extra log fields a classification contributes, spread flat into the log
 * line.
 *
 * The `never` keys are the ones a classification must not be able to write.
 * `err`/`method`/`path` are the request context the API wrapper guarantees on
 * every error. `level`/`time`/`msg` are pino's own, and pino writes those
 * *before* the merge object, so a `detail` carrying one emits a duplicate JSON
 * key that `JSON.parse` resolves to the last:
 *
 *   {"level":50,"time":...,"level":"debug","time":0,...}
 *
 * That parses as `level === "debug"`, a string no numeric level filter
 * matches — the line silently disappears from every filtered view. Making it
 * a compile error costs one type and cannot be forgotten.
 */
export type ApiLogDetail = Record<string, unknown> & {
  err?: never;
  method?: never;
  path?: never;
  level?: never;
  time?: never;
  msg?: never;
};

/**
 * The outcome of classifying a thrown value at the API boundary: what the
 * client is told (`message`, `status`) and what the operator is told
 * (`logMessage`, `level`, `detail`). Deliberately two different strings —
 * "Resource already exists" is a reasonable thing to return and a useless
 * thing to find in a log.
 *
 * No case controls its own return; a case says what should happen, never when
 * to stop. That is the point of the module. Before it, the P2002 branch
 * returned *above* the log line, so an escaped unique-constraint violation
 * reached a teacher as "Resource already exists" with no server-side trace at
 * all (#121) — and a second early return could have done it again.
 *
 * `status` is a union rather than `number` because it reaches the `Response`
 * constructor, which throws `RangeError: init["status"] must be in the range
 * of 200 to 599` outside that band. A typo'd `status: 5000` would throw from
 * inside the API wrapper's `catch`, leaking the stack trace that wrapper
 * exists to contain. Widening the union is a deliberate one-line edit at the
 * moment a case needs it.
 */
export type ApiFailure = {
  readonly status: 409 | 500 | 503;
  readonly message: string;
  readonly logMessage: string;
  readonly level: 'warn' | 'error';
  readonly detail?: ApiLogDetail;
};

/**
 * Matches the terminality triggers — plural since #247. Each raises
 * `RAISE EXCEPTION ... USING ERRCODE = '23514'` with the same
 * `which is terminal` wording, and they mean the same thing to a caller
 * ("that class is frozen"), so they route through this one branch:
 *
 * - `class_terminal_status_guard`, BEFORE UPDATE OF status on `Class`, refuses
 *   to change a terminal class's status.
 * - `entry_frozen_schedule_guard`, BEFORE UPDATE OF date, "startTime",
 *   "durationMinutes" on `CalendarEntry`, refuses to move a terminal class in
 *   the calendar. It exists because `reapClosedWaitlistEntries` DELETES on a
 *   predicate of terminal AND `date` more than 365 days past, and only the
 *   first half was enforced (#247).
 * - `entry_terminal_liveness_guard`, BEFORE UPDATE OF "cancelledAt" on
 *   `CalendarEntry`, refuses to un-cancel a terminal regular entry or to
 *   cancel a completed one.
 * - `entry_completion_marker_guard`, BEFORE UPDATE OF "classCompletedAt" on
 *   `CalendarEntry`, refuses every departure from a marker already set. It
 *   guards the column the guard above it READS: `UPDATE OF` fires on presence
 *   in the SET list, so clearing the marker named none of that guard's three
 *   columns, fired nothing, and unfroze the schedule for the next statement.
 *
 * Re-derive the roster rather than trusting it — from the DATABASE, not from
 * the migrations, which also hold every trigger since dropped:
 *
 *     SELECT t.tgname, c.relname
 *       FROM pg_trigger t
 *       JOIN pg_proc  p ON p.oid = t.tgfoid
 *       JOIN pg_class c ON c.oid = t.tgrelid
 *      WHERE NOT t.tgisinternal AND p.prosrc LIKE '%23514%'
 *      ORDER BY t.tgname;
 *
 * ADDING ANOTHER TRIGGER: it joins this branch only by doing BOTH — declaring
 * `USING ERRCODE = '23514'` *and* carrying the literal clause `which is
 * terminal` in its message. Either one alone classifies 500 for a request
 * that should be a 409. That requirement used to be undocumented and
 * unenforced, so the author of a new trigger would have had to already know
 * it; `api-errors.test.ts` now sweeps `prisma/migrations/` and reddens on the
 * commit that adds a `23514` trigger without the phrase. Mechanical, not
 * remembered.
 *
 * The name is narrower than what this matches — a frozen-schedule violation
 * classifies here too. Kept rather than renamed, but said out loud, because a
 * reader who greps `isTerminalStatusViolation`, finds nothing about dates, and
 * concludes a date violation goes unhandled would be wrong.
 *
 * Measured directly rather than assumed (`src/services/class-terminal-
 * status.test.ts`, which also pins `classifyApiError(caught).status === 409`
 * against the real thrown error, not just this file's hand-written fixture)
 * — the brief this shipped from deliberately did not predict which Prisma
 * error class would wrap a trigger's SQLSTATE. What was observed:
 *
 *   PrismaClientUnknownRequestError: Invalid `prisma.class.update()` invocation
 *   Error occurred during query execution:
 *   ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(
 *     PostgresError { code: "23514", message: "Class <id> is completed, which
 *     is terminal; cannot change status to <status>", severity: "ERROR",
 *     detail: None, column: None, hint: None }), transient: false })
 *
 * The entry-level guards' messages differ only after the shared clause, so the
 * same match covers them (observed via `db.calendarEntry.update`, #327):
 *
 *     PostgresError { code: "23514", message: "CalendarEntry <id> is completed,
 *     which is terminal; cannot change its date, start time or duration", ... }
 *
 * TWO ERROR SHAPES CARRY THE SAME SQLSTATE, and which one arrives is decided
 * by how the statement was issued, not by what failed. A typed
 * `class.update`/`updateMany` falls back to `PrismaClientUnknownRequestError`
 * — there is no P-code for "a trigger fired" — and spells the SQLSTATE
 * `code: "23514"`. A raw query has a P-code of its own, `P2010` ("raw query
 * failed"), and spells it ``Code: `23514` ``. BOTH ARE MATCHED.
 *
 * An earlier revision admitted only the Unknown shape and argued the raw one
 * was unreachable. The argument was true, and it was the wrong thing to
 * depend on: it made a 409-vs-500 hinge on a whole-repo census of raw
 * `Class` writers that nothing could keep honest, and the census as written
 * was already falsified by the date guard's own test file. `isTransientDbError`
 * below had settled the identical question the other way for `55P03`, for the
 * reason that applies here too — both shapes mean the same thing to a caller,
 * so a matcher built for one silently misses the other. `class-terminal-
 * date.test.ts` observes both shapes from this one trigger and pins both.
 *
 * `23514` (check_violation) alone is not a safe match: it is Postgres's
 * default SQLSTATE for a plain `CHECK` constraint too, and this schema
 * already has several (`Student_income_tier_check`,
 * `Student_claim_link_check`, the `Invitation` checks in
 * `20260805074500_invitation_check_constraints`) that raise it with no
 * `USING ERRCODE` override. Matching on the code by itself would relabel any
 * of those as "that class can no longer be changed." The `which is terminal`
 * wording is what actually discriminates.
 *
 * That wording is no longer unique to ONE trigger — since #247 more than one
 * emits it — but it does not need to be, and the matcher must not be narrowed
 * to restore uniqueness. What it needs is to be unique to *this class of
 * failure*, and it is: no other `23514` in this schema uses the phrase, and
 * every writer that does means the identical thing to a caller. Matching a set
 * of triggers deliberately is the design; they are kept in step by
 * `class-terminal-status.test.ts` and `class-terminal-date.test.ts`, each of
 * which pins `classifyApiError(...).status === 409` against its own real
 * thrown error.
 *
 * The SQLSTATE is matched inside its Postgres framing rather than as a bare
 * substring — the trap `isTransientDbError` documents below, and which this
 * function used to be the standing example of.
 *
 * Narrows to `Error` so the branch in `classifyApiError` can read the
 * trigger's message tail without a cast.
 */
function isTerminalStatusViolation(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (!error.message.includes('which is terminal')) return false;
  return error.message.includes('code: "23514"') || error.message.includes('Code: `23514`');
}

/**
 * Postgres SQLSTATEs that mean "this transaction lost a contention race", not
 * "this request was wrong". All three abort the whole transaction, so nothing
 * is half-applied, and the identical request can win the next attempt:
 *
 * - `55P03` lock_not_available — a `SET LOCAL lock_timeout` expired. This
 *   project sets one at every `lockClassRow` call and at the two template
 *   claims, so it is the one a user is most likely to meet.
 * - `40P01` deadlock_detected — Postgres broke an AB-BA cycle by killing one
 *   side. Reachable today, not hypothetical: `docs/lock-order.md`, "The slot
 *   key is a wait edge", records a real reproduced deadlock between two
 *   `updateClass` writes — 32 of 100 runs, both sides plain autocommit
 *   `UPDATE`s. The section records a second reproduction beside it, the
 *   template sync against `updateClass`; #194 deleted that function, so that
 *   pairing is evidence about a past state and the `updateClass` pair is what
 *   keeps this branch live. It used to be reachable a second way too, via two live
 *   `Class`-row-ordering cycles against the template sites; those closed
 *   with an ordered pre-lock ahead of each site's multi-row write (issue
 *   180, atomic-template-update).
 * - `40001` serialization_failure — nothing here uses a serializable or
 *   repeatable-read transaction yet, so this cannot fire at present; it is
 *   listed because it belongs to the same family and adding it later would
 *   otherwise be a second edit at a second moment.
 */
const TRANSIENT_SQLSTATES = ['40001', '40P01', '55P03'] as const;

/**
 * Prisma's own codes for the same class of failure — contention, not a bad
 * request. `P2028` is the interactive-transaction budget expiring (which
 * `deleteStudentAccount`'s flat 20s `timeout` can hit under load), `P2024` is
 * the connection pool handing out nothing in time, and `P2034` is Prisma's
 * own wrapper for "write conflict or deadlock, please retry" — the same
 * events as `40P01`/`40001` below, surfaced as a known code rather than
 * inside a driver string, which is how they arrive when the engine
 * recognises them instead of falling back to Unknown.
 */
const TRANSIENT_PRISMA_CODES = new Set(['P2024', 'P2028', 'P2034']);

/**
 * True when the failure is a lost contention race that a retry can win.
 *
 * Two different error shapes carry the same SQLSTATE, and both were measured
 * against this project's own database rather than assumed — a matcher built
 * for one of them silently misses the other:
 *
 *   // tx.class.updateMany(...) blocked past `SET LOCAL lock_timeout`
 *   PrismaClientUnknownRequestError: ... ConnectorError(ConnectorError {
 *     ... kind: QueryError(PostgresError { code: "55P03", message:
 *     "canceling statement due to lock timeout", ... }) ... })
 *
 *   // tx.$queryRaw`SELECT ... FOR UPDATE` blocked past the same timeout
 *   PrismaClientKnownRequestError (code P2010): ... Raw query failed.
 *     Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`
 *
 * `lockClassRow` (`src/lib/db-locks.ts`) issues exactly the second shape, and
 * every model write after it in the same transaction issues the first, so
 * both reach routes from the same helper.
 *
 * Matched on the SQLSTATE inside its Postgres framing (`code: "55P03"` /
 * `Code: \`55P03\``) rather than as a bare substring. A bare
 * `message.includes('40001')` would relabel any error whose text happens to
 * quote that as a digit string — a postcode, an amount, an id fragment — as
 * "the database is busy, try again", which is exactly the wrong advice and
 * exactly the trap `isTerminalStatusViolation` above documents for `23514`.
 */
export function isTransientDbError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA_CODES.has(error.code)) return true;
  }
  if (!(error instanceof Error)) return false;
  return TRANSIENT_SQLSTATES.some(
    (state) =>
      error.message.includes(`code: "${state}"`) || error.message.includes(`Code: \`${state}\``),
  );
}

/**
 * True when the failure is a Postgres lock_timeout expiry (`55P03`).
 *
 * Two different error shapes carry this SQLSTATE:
 * - `PrismaClientUnknownRequestError` for model writes, matching `code: "55P03"`
 * - `PrismaClientKnownRequestError` (P2010) for raw queries, matching `Code: \`55P03\``
 *
 * Matched inside its Postgres framing rather than as a bare substring, following
 * the same rule documented in `isTransientDbError`.
 */
export function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('code: "55P03"') || error.message.includes('Code: `55P03`');
}

/**
 * True when Prisma refused a write because the row it was told to touch is
 * not there — `P2025`, "An operation failed because it depends on one or more
 * records that were required but not found."
 *
 * A service should almost never let this reach `classifyApiError`, which has
 * no branch for it and falls through to a bare 500. It means a row read
 * before the write vanished in between, and the route that ordered the write
 * almost always already models that state: `DELETE /api/teacher-links/
 * [teacherId]` answers 404 when there is no link, `DELETE /api/waitlist/[id]`
 * answers 404 when there is no entry. Losing the race should produce the same
 * answer as never having had the row, not an opaque failure.
 *
 * Lives beside `isTransientDbError` because it answers the same kind of
 * question — what does this thrown value MEAN — and splitting the two across
 * modules by who imports them would put the two halves of one lookup table in
 * two places. This module's own imports stay within that same table —
 * `isExclusionConflictOn` (`./exclusion-conflict`) is the shared DB-error
 * matcher `classifyApiError` reuses below rather than re-implementing, and it
 * in turn imports only `@prisma/client` — so a service using this module for
 * classification alone still pulls in nothing web-framework-shaped.
 */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * True when Prisma refused a delete because a `RESTRICT` foreign key still
 * points at the row — `P2003` — and the constraint that refused is one of
 * `constraints`.
 *
 * Keyed on `meta.constraint`, never on `meta.modelName`, because the same
 * constraint reports different models depending on the statement that tripped
 * it. Measured: `teacherRoom.delete` and `teacherRoom.deleteMany` both report
 * `modelName: "TeacherRoom"`, while a bare `room.delete` reports
 * `modelName: "Room"` — it trips the constraint through
 * `TeacherRoom_roomId_fkey`'s CASCADE.
 *
 * CORRECTED IN PR REVIEW, because the earlier justification here was false and
 * a maintainer would have tested it and found it did not bite. It claimed
 * `DELETE /api/rooms/[id]` emits `"Room"`. It does not: that route issues
 * `teacherRoom.deleteMany` BEFORE `room.delete`, so a blocker aborts at the
 * first statement and reports `"TeacherRoom"`, same as its sibling route.
 * Both routes emit `"TeacherRoom"` today.
 *
 * So this is a FORWARD-LOOKING guarantee, not a current-state one, and that is
 * exactly why it matters: the `deleteMany` is redundant (the CASCADE already
 * takes the links) and `rooms/[id]` says so inline, so the day someone removes
 * it that route starts emitting `"Room"`. Keying on `constraint` alone is what
 * makes that edit safe. A matcher narrowed to `modelName` would pass every
 * test today and 500 the rooms route later.
 *
 * NARROW BY CONSTRUCTION, and that is the whole design. A blanket
 * `P2003 → 409` in `classifyApiError` would be less code and worse: almost
 * everywhere else in this app a `P2003` means the server tried to write a
 * dangling reference, which is a defect that must stay a 500 at
 * `level: 'error'`. Relabelling those "still in use" would hide exactly the
 * class of failure this project hunts. `isUniqueConflictOn`
 * (`src/lib/unique-conflict.ts`) sets the same precedent one module over:
 * match the specific constraint, never the code class.
 *
 * Lives here rather than beside `isUniqueConflictOn` because this module
 * already claims the "what does this thrown value MEAN" lookup table — see
 * `isRecordNotFound`'s docblock, which argues against splitting that table by
 * who imports it.
 */
export function isRestrictViolationOn(error: unknown, constraints: readonly string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
    return false;
  }
  const constraint = error.meta?.constraint;
  return typeof constraint === 'string' && constraints.includes(constraint);
}

/**
 * Which terminality trigger fired, as a log facet — read off the message tail
 * each one owns.
 *
 * A ROSTER RATHER THAN A CHAIN OF `includes`, and the one that pays for itself
 * is not `classifyApiError`. `api-errors.test.ts` sweeps the live migration
 * bodies against these values, so a new `23514` guard whose message ends in a
 * sentence this object does not carry reddens at the migration rather than
 * degrading into somebody else's bucket at runtime.
 *
 * Each value is the SUBSTRING, not the whole message: the messages carry a row
 * id and, in three cases, a state word, so only the tail is stable.
 *
 * `satisfies Record<..., string>` with the keys spelled out is the tether: a
 * facet added to the union below without a tail here is a compile error, which
 * is the direction that matters — a facet with no tail can never be reached.
 */
export const TERMINAL_TRIGGER_TAILS = {
  /** `class_terminal_status_guard` — a completed class cannot leave its status. */
  status: 'cannot change status to',
  /** `entry_frozen_schedule_guard` — a frozen entry cannot move in the calendar. */
  date: 'cannot change its date',
  /** `entry_terminal_liveness_guard` — a terminal regular entry cannot change its cancellation. */
  liveness: 'cannot change its cancellation',
  /** `entry_completion_marker_guard` — the completion marker is write-once. */
  completion: 'cannot change its completion',
  /** `entry_rule_kind_mismatch_guard` — an entry cannot reference a rule of a different kind. */
  entry_rule_kind: 'cannot attach to mismatched rule kind',
  /** `schedule_rule_kind_immutability_guard` — schedule rule kind is immutable. */
  rule_kind: 'cannot change its kind',
} as const satisfies Record<
  'status' | 'date' | 'liveness' | 'completion' | 'entry_rule_kind' | 'rule_kind',
  string
>;

/**
 * The facet `detail.trigger` carries. `'unknown'` is not a trigger — it is what
 * a `23514` terminality violation whose tail matches no known guard is filed
 * under, and it is logged at `error` for that reason.
 */
export type TerminalTriggerFacet = keyof typeof TERMINAL_TRIGGER_TAILS | 'unknown';

/**
 * Read off the object so the two cannot disagree about membership — the same
 * move `FAMILIES` makes in `entry-conflict.ts`.
 */
const TERMINAL_TRIGGER_FACETS = Object.keys(
  TERMINAL_TRIGGER_TAILS,
) as ReadonlyArray<keyof typeof TERMINAL_TRIGGER_TAILS>;

/**
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * The lock-race-to-503 mapping this docblock once described as unqueued has
 * landed (the transient branch below), and the `busy` variants on the
 * template lifecycle result unions have landed alongside it: `class-template-
 * lifecycle.ts` exports `UpdateClassTemplateResult`, `PauseTemplateResult`
 * and `ArchiveTemplateResult`; `studio-class-template-lifecycle.ts` exports
 * their studio twins `UpdateStudioClassTemplateResult`,
 * `PauseStudioTemplateResult` and `ArchiveStudioTemplateResult`. They remain
 * complementary rather than redundant, and it is worth saying which does
 * what: each union makes contention a COMPILE error at the route that
 * switches on its `reason` — `PUT` and both `PATCH` branches at
 * `/api/class-templates/[id]`, and the same three at
 * `/api/studio-class-templates/[id]` — which a catch-all cannot; this branch
 * makes it legible everywhere else, which the unions cannot. A service that
 * catches contention never reaches here — by design, since it can say
 * something more specific than this can.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // The terminality triggers named in `isTerminalStatusViolation`'s docblock
  // raise with SQLSTATE 23514. Reaching here means a write to a frozen class —
  // its status, its liveness, or since #247 its place in the calendar — got
  // past the guard that should have refused it first. That is a 409 either
  // way: the request is well-formed and it conflicts with a state the class
  // has already reached.
  if (isTerminalStatusViolation(error)) {
    // WHICH trigger fired, read from the message tail the matcher itself
    // deliberately ignores. Classification is shared; the operator's reading
    // is not, and `level` is the only field that can say so.
    //
    // A STATUS or LIVENESS fire is a lost race. Every status and liveness
    // writer has had a CAS or a row lock since #174, so a trigger catching one
    // means a guard was bypassed under contention — expected-but-notable, the
    // same reading as the P2002 branch below, and `warn` is right for it.
    // The two are told apart anyway: they are different rows on
    // different tables, and an operator narrowing "which CAS is losing races"
    // to one of them cannot do it from a facet that calls both `status`.
    //
    // A DATE or COMPLETION fire is not a race, because there is no race to
    // lose, and both name the same guarantee from its two ends.
    // `updateClass` is the only writer in `src/` that moves an existing
    // entry's `date`, and its entry CAS (`classCompletedAt: null` plus the
    // regular-and-cancelled exclusion) re-asks exactly what
    // `entry_frozen_schedule_guard` asks, so that guard can never fire for it.
    // `entry_completion_marker_guard` sits behind it on the column that guard
    // READS: no writer in `src/` clears `classCompletedAt`, and clearing it is
    // what unfreezes a `date`. Either fire means someone has added an
    // unguarded writer reaching the column `reapClosedWaitlistEntries` trusts
    // before it permanently DELETEs a class's queue — the precondition for the
    // data loss #247 exists to prevent. That must not land in the log at the
    // level a lock timeout lands at.
    // FIVE values, four of them a trigger's own tail and the fifth the absence
    // of any. `status` used to be the fallback — a real facet with a meaning of
    // its own, at `warn`, the level that pages nobody — so a trigger added with
    // a tail this list does not know about degraded into the bucket an operator
    // queries for something else, silently and at the wrong level. It is now
    // its own test like the rest, and an unrecognised tail answers `unknown` at
    // `error`: an unplaceable terminality fire is a guard nobody has classified,
    // which is the same "someone added an unguarded writer" reading the `date`
    // and `completion` facets get.
    //
    // `TERMINAL_TRIGGER_TAILS` is the roster, and it is a roster rather than a
    // chain so `api-errors.test.ts` can sweep the live migration bodies against
    // it — every function raising `23514` must own one of these tails, or this
    // branch cannot place it.
    const trigger: TerminalTriggerFacet =
      TERMINAL_TRIGGER_FACETS.find((facet) =>
        error.message.includes(TERMINAL_TRIGGER_TAILS[facet]),
      ) ?? 'unknown';
    return {
      status: 409,
      // Deliberately names no column. Every trigger that reaches this branch
      // means the same thing to the caller — the class is frozen — so any
      // wording that names one column is wrong for the others.
      message: 'That class can no longer be changed',
      logMessage: 'terminal class write reached a DB trigger',
      level: trigger === 'status' || trigger === 'liveness' ? 'warn' : 'error',
      // `withErrorHandler` always logs `err: error`, so the trigger's own
      // message is already in the line. What it is not is GROUPABLE: it lives
      // inside a several-hundred-character driver string that no log filter
      // can facet on. One field turns "did the unfireable trigger fire" into
      // a query.
      detail: { trigger },
    };
  }

  // A lost contention race, not a bad request. Before this branch these
  // reached the user as "Internal server error" at `level: 'error'` — which
  // is wrong twice over. Wrong for the user, because the one thing that helps
  // is the one thing that message does not say: try again. And wrong for the
  // operator, because `error` is the level that pages someone, while a
  // `lock_timeout` on a contended row is the system doing what it was
  // configured to do. Concretely: a student tapping "leave waitlist" while
  // the 60-second transitions sweep holds their class row got a 500 for it,
  // where before #174 bounded that wait they simply blocked and succeeded.
  //
  // Checked BEFORE the P2002 branch below on purpose — a `P2024`/`P2028` is a
  // `PrismaClientKnownRequestError` too, and ordering these the other way
  // round would leave the transient codes to fall past a branch that does not
  // match them into the generic 500, i.e. exactly the behaviour this branch
  // exists to remove.
  if (isTransientDbError(error)) {
    return {
      status: 503,
      message: 'The system was busy and could not finish that. Please try again.',
      logMessage: 'transient database contention surfaced to a client',
      level: 'warn',
    };
  }

  // Reaching this branch means a route's own check-then-create lost its race
  // — at least four routes have that window today — or a route never
  // pre-checked at all. Both are worth knowing about; neither is an outage,
  // which is why this is `warn` and not `error`. `meta.target` names the
  // constraint — without it the log says something already existed but not
  // what, which is the same gap one level in.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return {
      status: 409,
      message: 'Resource already exists',
      logMessage: 'unique constraint escaped a route to the 409 fallback',
      level: 'warn',
      detail: { target: error.meta?.target },
    };
  }

  // The same gap one level in as the P2002 branch above, for the constraint
  // issue 298 introduced: a route that never caught
  // `ScheduleRule_teacher_slot_excl` itself, or a probe-and-catch that raced
  // and lost. This branch has neither a probe nor a teacher in scope — those
  // live at the call site that reaches `withErrorHandler`, not in this
  // classifier — so it cannot name which family holds the slot the way the
  // four template routes do; it carries the `unknown` sentence those routes'
  // own `SLOT_TAKEN` maps use for exactly that case.
  if (isExclusionConflictOn(error, 'ScheduleRule_teacher_slot_excl')) {
    return {
      status: 409,
      message: 'You already have a recurring class or studio class at an overlapping time on that day.',
      logMessage: 'schedule rule slot exclusion escaped a route to the 409 fallback',
      level: 'warn',
    };
  }

  return {
    status: 500,
    message: 'Internal server error',
    logMessage: 'unhandled API error',
    level: 'error',
    // Pino passes a non-Error `err` through unserialized and drops the key
    // outright when the value is `undefined`, so `throw undefined` in a
    // wrapped handler would otherwise log a line that names no error at all.
    // `typeof` is total and cannot throw; `String(error)` can — an object may
    // have no `toString` (`Object.create(null)`) or a throwing one — and this
    // runs inside the very `catch` it must not throw from.
    ...(error instanceof Error ? {} : { detail: { thrownType: typeof error } }),
  };
}
