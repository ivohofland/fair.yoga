import type { CodedRefusal } from '@/lib/api-error-codes';

/**
 * Refusals the doors under this resource draw on, each sentence written once
 * so that no two of them can drift. A second copy is a second thing to keep in
 * step, and it stops agreeing the first time only one of the two is reworded —
 * the argument `src/app/api/invitations/[id]/shared.ts` was pulled out for.
 *
 * VALUES, not the response factories that file exports, because a caller here
 * needs the parts rather than a finished `Response`: to index one by a
 * service's refusal reason, or to carry one out of a transaction and answer it
 * outside. `satisfies CodedRefusal` checks each one's status against its own
 * code.
 *
 * Its own file rather than an export from a `route.ts`: Next's Route Handler
 * convention restricts what a `route.ts` may export to HTTP verbs plus a small
 * fixed config allow-list.
 */
export const CLASS_GONE = {
  code: 'NOT_FOUND',
  status: 404,
  message: 'This class no longer exists.',
} as const satisfies CodedRefusal;

/** A class whose entry carries `cancelledAt`: it is off, whatever status it kept. */
export const CLASS_CANCELLED = {
  code: 'CLASS_CANCELLED',
  status: 409,
  message: 'This class has been cancelled.',
} as const satisfies CodedRefusal;

/** A completion refused because the class's scheduled end is still ahead. */
export const CLASS_NOT_ENDED_YET = {
  code: 'CLASS_NOT_ENDED_YET',
  status: 409,
  message: "This class hasn't finished yet.",
} as const satisfies CodedRefusal;
