import { codedRefusal } from '@/lib/api-error-codes';
import { FINISH_GRACE_MINUTES } from '@/lib/finish-window';

/**
 * Refusals the doors under this resource draw on, each sentence written once
 * so that no two of them can drift. A second copy is a second thing to keep in
 * step, and it stops agreeing the first time only one of the two is reworded —
 * the argument `src/app/api/invitations/[id]/shared.ts` was pulled out for.
 *
 * VALUES, not the response factories that file exports, because a caller here
 * needs the parts rather than a finished `Response`: to index one by a
 * service's refusal reason, or to carry one out of a transaction and answer it
 * outside. `codedRefusal` derives each one's status from its own code, so no
 * status is hand-typed beside it.
 *
 * Its own file rather than an export from a `route.ts`: Next's Route Handler
 * convention restricts what a `route.ts` may export to HTTP verbs plus a small
 * fixed config allow-list.
 */
export const CLASS_GONE = codedRefusal('NOT_FOUND', 'This class no longer exists.');

/** A class whose entry carries `cancelledAt`: it is off, whatever status it kept. */
export const CLASS_CANCELLED = codedRefusal('CLASS_CANCELLED', 'This class has been cancelled.');

/** A completion refused because the class's finish window has not opened yet. */
export const CLASS_NOT_ENDED_YET = codedRefusal(
  'CLASS_NOT_ENDED_YET',
  `You can finish this class from ${FINISH_GRACE_MINUTES} minutes before it ends, once it has started.`,
);
