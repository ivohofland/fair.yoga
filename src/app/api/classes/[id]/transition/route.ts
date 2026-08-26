import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { transitionClass, type TransitionFailureReason } from '@/services/class-lifecycle';
import { transitionClassSchema } from '@/lib/schemas';

/**
 * How each refusal reaches the client, as a table rather than a ternary.
 *
 * `NOT_FOUND` is a 404 and the rest are 409s, which is why this started life as
 * `result.reason === 'NOT_FOUND' ? 404 : 409` — before that, mapping every
 * refusal to 409 answered a deleted class with `409 "Class not found: <id>"`,
 * a status and a message that contradict each other.
 *
 * The CODE is the part the ternary could not carry, and #249 is what made its
 * absence cost something. Three of these reach the client as an indistinguishable
 * 409 while wanting three different client behaviours: `STARTS_IN_PAST` is
 * permanent and the page is right (nothing will make that draft publishable),
 * `ILLEGAL_TRANSITION` means the page is stale and should re-read,
 * `CONCURRENT_MODIFICATION` means the write lost a race and may simply be
 * retried. Telling them apart by matching English in the message is exactly
 * what `TransitionFailureReason` was introduced (#182) to stop —
 * `autoCompleteClasses` used to do it with `.endsWith('has not ended yet')`.
 *
 * `CLASS_STARTS_IN_PAST` deliberately matches the code `PUT /api/classes/[id]`
 * already answers with, rather than mirroring the internal name. The two doors
 * refuse the same condition, and a client that learns to handle one gets the
 * other for nothing.
 *
 * A `Record` over the full union, so this is exhaustive by construction: a new
 * `TransitionFailureReason` member fails the build here rather than falling
 * through to some default. `NOT_ENDED_YET` is listed and unreachable through
 * this route — `completeClass` is its only producer — which is the superset
 * looseness `TransitionFailureReason`'s own docblock records.
 *
 * `CANCELLED` (#327) is a member for the same reason a cancelled class is
 * still a live-status row: cancellation is a column on the entry now, so
 * `transitionClass`'s status check cannot see it and answers it separately
 * rather than reporting a legal-looking transition as a lost race.
 */
const TRANSITION_FAILURE_RESPONSE: Record<
  TransitionFailureReason,
  { httpStatus: number; code: string }
> = {
  NOT_FOUND: { httpStatus: 404, code: 'NOT_FOUND' },
  ILLEGAL_TRANSITION: { httpStatus: 409, code: 'ILLEGAL_TRANSITION' },
  NOT_ENDED_YET: { httpStatus: 409, code: 'CLASS_NOT_ENDED_YET' },
  CONCURRENT_MODIFICATION: { httpStatus: 409, code: 'CONCURRENT_MODIFICATION' },
  STARTS_IN_PAST: { httpStatus: 409, code: 'CLASS_STARTS_IN_PAST' },
  ROOM_ARCHIVED: { httpStatus: 409, code: 'ROOM_ARCHIVED' },
  CANCELLED: { httpStatus: 409, code: 'CLASS_CANCELLED' },
};

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: { select: { teacherId: true } } },
  });
  if (!cls) return respondError('Class not found', 404);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, transitionClassSchema);
  if ('error' in parsed) return parsed.error;

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (!result.ok) {
    const { httpStatus, code } = TRANSITION_FAILURE_RESPONSE[result.reason];
    return respondError(result.error, httpStatus, code);
  }

  return respondOk(result);
});
