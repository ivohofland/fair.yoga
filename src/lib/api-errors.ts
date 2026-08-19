import { Prisma } from '@prisma/client';

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
 * Matches the terminality triggers — plural since #247. Both raise
 * `RAISE EXCEPTION ... USING ERRCODE = '23514'` with the same
 * `which is terminal` wording, and both mean the same thing to a caller
 * ("that class is frozen"), so both route through this one branch:
 *
 * - `20260805120000_class_terminal_status_trigger` — `class_terminal_status_
 *   guard`, BEFORE UPDATE OF status, refuses to change a terminal class's
 *   status.
 * - `20260817120000_class_terminal_date_trigger` — `class_terminal_date_
 *   guard`, BEFORE UPDATE OF date, refuses to move a terminal class's date.
 *   Added because `reapClosedWaitlistEntries` DELETES on a predicate of
 *   terminal AND `date` more than 365 days past, and only the first half was
 *   enforced.
 *
 * ADDING A THIRD TRIGGER: it joins this branch only by doing BOTH — declaring
 * `USING ERRCODE = '23514'` *and* carrying the literal clause `which is
 * terminal` in its message. Either one alone classifies 500 for a request
 * that should be a 409. That requirement used to be undocumented and
 * unenforced, so the author of a third trigger would have had to already know
 * it; `api-errors.test.ts` now sweeps `prisma/migrations/` and reddens on the
 * commit that adds a `23514` trigger without the phrase. Mechanical, not
 * remembered.
 *
 * The name is narrower than what this matches — a date violation classifies
 * here too. Kept rather than renamed, but said out loud, because a reader who
 * greps `isTerminalStatusViolation`, finds nothing about dates, and concludes
 * a date violation goes unhandled would be wrong.
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
 *     PostgresError { code: "23514", message: "Class <id> is cancelled, which
 *     is terminal; cannot change status to <status>", severity: "ERROR",
 *     detail: None, column: None, hint: None }), transient: false })
 *
 * The date trigger's message differs only after the shared clause, so the
 * same match covers it (observed via `db.class.updateMany`, #247):
 *
 *     PostgresError { code: "23514", message: "Class <id> is completed, which
 *     is terminal; cannot change its date from <old> to <new>", ... }
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
 * That wording is no longer unique to ONE trigger — since #247 two migrations
 * emit it — but it does not need to be, and the matcher must not be narrowed
 * to restore uniqueness. What it needs is to be unique to *this class of
 * failure*, and it is: no other `23514` in this schema uses the phrase, and
 * every writer that does means the identical thing to a caller. Matching a set
 * of triggers deliberately is the design; the two are kept in step by
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
 *   key is a wait edge", records real reproduced deadlocks between
 *   `syncTemplateInstances`/`updateClass` and between two `updateClass`
 *   writes. It used to be reachable a second way too, via two live
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
 * two places. This module imports nothing but `@prisma/client`, so a service
 * using it stays framework-agnostic.
 */
export function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * True when Prisma refused a delete because a `RESTRICT` foreign key still
 * points at the row — `P2003` — and the constraint that refused is one of
 * `constraints`.
 *
 * Keyed on `meta.constraint`, never on `meta.modelName`. Measured: the same
 * `ClassTemplate_teacherRoomId_fkey` arrives as `modelName: "TeacherRoom"`
 * from `DELETE /api/teacher-rooms/[id]` and as `modelName: "Room"` from
 * `DELETE /api/rooms/[id]`, because the latter trips it through the
 * `Room`→`TeacherRoom` cascade. A matcher that also required the model would
 * pass one route's tests and 500 the other.
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
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * The lock-race-to-503 mapping this docblock once described as unqueued has
 * landed (the transient branch below), and the `busy` variants on the five
 * template lifecycle result unions have landed alongside it — the
 * atomic-template-update branch made `UpdateClassTemplateResult`
 * (`class-template-lifecycle.ts`) the fifth, alongside `PauseTemplateResult`,
 * `ArchiveTemplateResult` and their two studio twins. They remain
 * complementary rather than redundant, and it is worth saying which does
 * what: the unions make contention a COMPILE error at five specific routes
 * (`PUT` and both `PATCH` branches at `/api/class-templates/[id]`, and both
 * `PATCH` branches at `/api/studio-class-templates/[id]`), which a catch-all
 * cannot; this branch makes it legible everywhere else, which the unions
 * cannot. A service that catches contention never reaches here — by design,
 * since it can say something more specific than this can.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // The terminality triggers (migrations 20260805120000 and 20260817120000)
  // raise with SQLSTATE 23514. Reaching here means a write to a frozen class
  // — its status, or since #247 its date — got past the guard that should
  // have refused it first. That is a 409 either way: the request is
  // well-formed and it conflicts with a state the class has already reached.
  if (isTerminalStatusViolation(error)) {
    // WHICH trigger fired, read from the message tail the matcher itself
    // deliberately ignores. Classification is shared; the operator's reading
    // of the two is not, and `level` is the only field that can say so.
    //
    // A STATUS fire is a lost race. Every status writer has had a CAS or a
    // row lock since #174, so the trigger catching one means a guard was
    // bypassed under contention — expected-but-notable, the same reading as
    // the P2002 branch below, and `warn` is right for it.
    //
    // A DATE fire is not a race, because there is no race to lose:
    // `updateClass` is the only writer of `Class.date` in `src/`, and its CAS
    // (`status: { notIn: [...TERMINAL_CLASS_STATUSES] }`) means this trigger's
    // own WHEN clause can never hold for it. The trigger is currently
    // unfireable. If it fires, someone has added an unguarded writer of the
    // exact column `reapClosedWaitlistEntries` reads before it permanently
    // DELETEs a class's queue — the precondition for the data loss #247
    // exists to prevent. That must not land in the log at the level a
    // lock timeout lands at.
    const trigger = error.message.includes('cannot change its date') ? 'date' : 'status';
    return {
      status: 409,
      // Deliberately names neither "status" nor "date". Both triggers reach
      // this branch and both mean the same thing to the caller — the class is
      // frozen — so any wording that names one column is wrong half the time.
      message: 'That class can no longer be changed',
      logMessage: 'terminal class write reached a DB trigger',
      level: trigger === 'date' ? 'error' : 'warn',
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
