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
  readonly status: 409 | 500;
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
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * This is the obvious home for further mappings — a lock-race loser to 503,
 * say — but nothing is queued to land here. #113, which wants that mapping,
 * currently proposes the other route: a `busy` variant on the archive
 * services' result unions, so that the routes' exhaustive narrowing turns an
 * unhandled variant into a compile error. A catch-all classifier cannot offer
 * that, so the two are alternatives, not a plan.
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
