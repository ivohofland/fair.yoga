import { respondError } from './api-utils';

/**
 * The 400 for a `teacherRoomId` that is not one of the calling teacher's
 * rooms — it never was, or it went away between a read and the write that
 * needed it.
 *
 * One sentence, written once, for the same reason
 * `src/app/api/invitations/[id]/shared.ts` pulls its refusals out: a second
 * copy is a second thing to keep in step, and it stops agreeing the first time
 * only one of the two is reworded. Here rather than in a route tree's own
 * `shared.ts`, because a `shared.ts` can only serve the tree it sits in — a
 * module under `src/app` imported from a sibling tree is a dependency pointing
 * sideways.
 *
 * A finished `Response` rather than the parts, because that is all a caller
 * needs to answer with it.
 */
export function roomNotOnListResponse() {
  return respondError('That room is no longer in your rooms.', 400, 'ROOM_NOT_ON_LIST');
}
