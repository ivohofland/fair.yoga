import { Prisma } from '@prisma/client';

/**
 * The outcome of classifying a thrown value at the API boundary: what the
 * client is told (`message`, `status`) and what the operator is told
 * (`logMessage`, `level`, `detail`). Deliberately two different strings —
 * "Resource already exists" is a reasonable thing to return and a useless
 * thing to find in a log.
 *
 * `withErrorHandler` (src/lib/api-utils.ts) is the only consumer, and it has
 * exactly one log call and one response. That is the point of this module:
 * before it, the P2002 branch returned *above* the log line, so an escaped
 * unique-constraint violation reached a teacher as "Resource already exists"
 * with no server-side trace at all (#121). A new case added here cannot
 * reintroduce that, because no case controls its own return.
 */
export type ApiFailure = {
  status: number;
  message: string;
  logMessage: string;
  level: 'warn' | 'error';
  detail?: Record<string, unknown>;
};

/**
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * #113 will add P2028 and 55P03 -> 503 here. Until then they fall to the 500.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // Reaching this branch means a route's own check-then-create lost its race
  // (teacher-rooms and students POST both have that window), or a route never
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
  };
}
