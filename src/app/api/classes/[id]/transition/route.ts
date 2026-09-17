import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import {
  transitionClass,
  ROOM_ARCHIVED_MESSAGE,
  STARTS_IN_PAST_MESSAGE,
  type TransitionFailureReason,
} from '@/services/class-lifecycle';
import { transitionClassSchema } from '@/lib/schemas';
import { CLASS_CANCELLED, CLASS_GONE, CLASS_NOT_ENDED_YET } from '../shared';

type TransitionApplied = Extract<Awaited<ReturnType<typeof transitionClass>>, { ok: true }>;

/**
 * How each refusal but `ILLEGAL_TRANSITION` reaches the client. That one is
 * answered in the handler, because its words depend on the pair it refused and
 * one of its pairs is not a refusal at all.
 *
 * Keyed by the full `TransitionFailureReason` union rather than by
 * `transitionClass`'s range, so a reason added to the union has an answer here
 * before any caller can return it. `CodedRefusal` checks each entry's status
 * against its own code.
 *
 * `CLASS_STARTS_IN_PAST` is the code `PUT /api/classes/[id]` answers the same
 * condition with.
 */
const TRANSITION_REFUSAL = {
  NOT_FOUND: CLASS_GONE,
  CANCELLED: CLASS_CANCELLED,
  CONCURRENT_MODIFICATION: {
    code: 'CONCURRENT_MODIFICATION',
    status: 409,
    message: 'This class was just changed elsewhere. Refresh and try again.',
  },
  STARTS_IN_PAST: { code: 'CLASS_STARTS_IN_PAST', status: 409, message: STARTS_IN_PAST_MESSAGE },
  ROOM_ARCHIVED: { code: 'ROOM_ARCHIVED', status: 409, message: ROOM_ARCHIVED_MESSAGE },
  NOT_ENDED_YET: CLASS_NOT_ENDED_YET,
} as const satisfies Record<Exclude<TransitionFailureReason, 'ILLEGAL_TRANSITION'>, CodedRefusal>;

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
  if (!cls) return respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, transitionClassSchema);
  if ('error' in parsed) return parsed.error;

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (result.ok) return respondOk(result);

  if (result.reason === 'ILLEGAL_TRANSITION') {
    // The service asks about cancellation before the state machine, so a
    // same-status refusal here is a live class already where it was asked to
    // be.
    //
    // `from`, which is the status read from the row — not `to`, which is the
    // status the request carried. They are equal on this branch, and the row
    // is what `newStatus` describes.
    if (result.from === result.to) {
      return respondUnchanged<TransitionApplied>({ ok: true, newStatus: result.from });
    }
    return respondError(
      transitionRefusalMessage(result.from, result.to),
      409,
      'ILLEGAL_TRANSITION',
    );
  }

  const refusal = TRANSITION_REFUSAL[result.reason];
  return respondError(refusal.message, refusal.status, refusal.code);
});
