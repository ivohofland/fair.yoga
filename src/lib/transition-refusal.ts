/**
 * What a teacher reads when a class's lifecycle state refuses a request.
 *
 * The one import is a type and is erased at build, so this module runs
 * anywhere. Each `switch` ends in a `never` default: a new `ClassStatus`
 * fails to compile here until it has its own sentence.
 */
import type { ClassStatus } from '@prisma/client';

/**
 * Why moving a class from `from` to `to` is refused. Keyed on `from`; only a
 * published class has two refused targets that need different words. A pair
 * the state machine accepts, or `from === to`, is never refused, and gets the
 * sentence its `from` row gives.
 */
export function transitionRefusalMessage(from: ClassStatus, to: ClassStatus): string {
  switch (from) {
    case 'draft':
      return 'Publish this class first.';
    case 'open':
      return to === 'draft'
        ? "A published class can't go back to draft."
        : "This class can't be completed from here.";
    case 'in_progress':
      return 'This class has already started.';
    case 'completed':
      return 'This class has already finished.';
    default: {
      const unhandled: never = from;
      return unhandled;
    }
  }
}

/**
 * Why the cancel door refuses a class that is not already cancelled, by its
 * status. `draft` and `open` are the statuses the door cancels, so their
 * sentence names no state.
 */
export function notCancellableMessage(status: ClassStatus): string {
  switch (status) {
    case 'in_progress':
      return "This class has already started, so it can't be cancelled.";
    case 'completed':
      return "This class has already finished, so it can't be cancelled.";
    case 'draft':
    case 'open':
      return "This class can't be cancelled right now. Refresh and try again.";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

/**
 * Why a frozen class refuses an edit. `state` is a status or `'cancelled'`,
 * the domain a freeze is reported in. A live status is never reported as
 * frozen, so its sentence names no state.
 */
export function frozenClassMessage(state: ClassStatus | 'cancelled'): string {
  switch (state) {
    case 'completed':
      return 'This class has finished and can no longer be changed.';
    case 'cancelled':
      return 'This class has been cancelled and can no longer be changed.';
    case 'draft':
    case 'open':
    case 'in_progress':
      return 'This class can no longer be changed.';
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}
