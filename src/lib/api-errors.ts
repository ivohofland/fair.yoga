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
 * Matches the terminality trigger from migration
 * `20260805120000_class_terminal_status_trigger` (`class_terminal_status_
 * guard`, `RAISE EXCEPTION ... USING ERRCODE = '23514'`).
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
 * Not `PrismaClientKnownRequestError` — there is no P-code for "a trigger
 * fired", so the engine falls back to Unknown, and Unknown carries no
 * `.code`/`.meta` the way P2002 does below; the SQLSTATE only exists inside
 * the message string.
 *
 * `23514` (check_violation) alone is not a safe match: it is Postgres's
 * default SQLSTATE for a plain `CHECK` constraint too, and this schema
 * already has several (`Student_income_tier_check`,
 * `Student_claim_link_check`, the `Invitation` checks in
 * `20260805074500_invitation_check_constraints`) that raise it with no
 * `USING ERRCODE` override. Matching on the code by itself would relabel any
 * of those as "that class can no longer change status." The trigger's own
 * message text — unique to it — is what actually discriminates.
 */
function isTerminalStatusViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes('23514') &&
    error.message.includes('which is terminal')
  );
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
 *   side. `docs/lock-order.md` records two live cycles against the template
 *   sites, so this is reachable today, not hypothetical.
 * - `40001` serialization_failure — nothing here uses a serializable or
 *   repeatable-read transaction yet, so this cannot fire at present; it is
 *   listed because it belongs to the same family and adding it later would
 *   otherwise be a second edit at a second moment.
 */
const TRANSIENT_SQLSTATES = ['40001', '40P01', '55P03'] as const;

/**
 * Prisma's own codes for the same class of failure — contention, not a bad
 * request. `P2028` is the interactive-transaction budget expiring (which
 * `deleteStudentAccount`'s sized `timeout` can hit under load), `P2024` is
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
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * The lock-race-to-503 mapping this docblock once described as unqueued has
 * landed (the transient branch below), and the `busy` variants on the four
 * template lifecycle result unions have landed alongside it. They remain
 * complementary rather than redundant, and it is worth saying which does
 * what: the unions make contention a COMPILE error at four specific routes,
 * which a catch-all cannot; this branch makes it legible everywhere else,
 * which the unions cannot. A service that catches contention never reaches
 * here — by design, since it can say something more specific than this can.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // The terminality trigger (migration 20260805120000) raises with SQLSTATE
  // 23514. Reaching here means a status write lost a race that its own CAS or
  // row lock should have caught — every writer has one since #174 — so this
  // is a 409 and a `warn`, the same reading as the P2002 branch below: not an
  // outage, but worth knowing a guard was bypassed.
  if (isTerminalStatusViolation(error)) {
    // No `detail`: `withErrorHandler` always logs `err: error`, and the
    // trigger's own message already names the class id and both statuses —
    // there is nothing this branch could add that isn't in one of those two
    // places already.
    return {
      status: 409,
      message: 'That class can no longer change status',
      logMessage: 'terminal class status change reached the DB trigger',
      level: 'warn',
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
