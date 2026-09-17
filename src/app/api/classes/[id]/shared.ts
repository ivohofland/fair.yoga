import type { CodedRefusal } from '@/lib/api-error-codes';

/**
 * The refusals that more than one door under this resource sends, each written
 * once. A teacher who publishes, completes or cancels a class that is gone —
 * or one that is off — is told the same thing whichever door they reached, and
 * each copy of one sentence is another chance for them to stop agreeing. The
 * same argument `src/app/api/invitations/[id]/shared.ts` was pulled out for.
 *
 * VALUES, not response factories like that file's, because the doors here need
 * the parts rather than a finished `Response`: each maps its service's own
 * refusal reasons through a table these sit in, and the cancel door decides
 * inside its transaction and answers outside it. `satisfies CodedRefusal`
 * checks each one's status against its own code.
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
