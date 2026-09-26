import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondUnchanged,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { switchRoomSchema } from '@/lib/schemas';
import { switchToSharedRoom } from '@/services/room-switch';
import { ROOM_IN_USE_CODE } from '@/services/room-deletion';

export const SWITCH_NOT_SAME_ROOM_MESSAGE =
  "This room's address no longer matches the shared room. Check its details and try again.";
export const SWITCH_CLASS_RUNNING_MESSAGE =
  'A class is running in this room right now. You can switch once it has finished.';

/**
 * Switch a private room link onto the already-shared room with the same
 * identity (issue 259). The rules and guard order are the service's —
 * `switchToSharedRoom` (`src/services/room-switch.ts`).
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, switchRoomSchema);
  if ('error' in parsed) return parsed.error;

  const result = await switchToSharedRoom(prisma, {
    teacherId: session.teacherId,
    teacherRoomId: id,
    sharedRoomId: parsed.data.roomId,
  });

  if (result.ok) {
    switch (result.action) {
      case 'switched':
        return respondOk({
          teacherRoomId: result.teacherRoomId,
          moved: result.moved,
          reusedLink: result.reusedLink,
          capacityClamped: result.capacityClamped,
        });
      case 'unchanged':
        return respondUnchanged<{ teacherRoomId: string }>({ teacherRoomId: result.teacherRoomId });
      default: {
        const unhandledSuccess: never = result;
        return unhandledSuccess;
      }
    }
  }

  switch (result.reason) {
    case 'not_found':
      return respondError('This room is no longer in your rooms.', 404, 'NOT_FOUND');
    case 'forbidden':
      return respondError('Access denied', 403);
    case 'now_shared':
      return respondError('This room is shared now, so there is nothing to switch.', 409, 'NOW_SHARED');
    case 'shared_room_not_found':
      return respondError('That shared room no longer exists.', 404, 'NOT_FOUND');
    case 'not_same_room':
      return respondError(SWITCH_NOT_SAME_ROOM_MESSAGE, 409, 'NOT_SAME_ROOM');
    case 'class_in_progress':
      return respondError(SWITCH_CLASS_RUNNING_MESSAGE, 409, ROOM_IN_USE_CODE);
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
});
