import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondRefusal,
  respondUnchanged,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { completeClass } from '@/services/class-lifecycle';
import { CLASS_CANCELLED, CLASS_GONE, CLASS_NOT_ENDED_YET } from '../shared';

type CompleteResult = Awaited<ReturnType<typeof completeClass>>;
type CompleteApplied = Extract<CompleteResult, { ok: true }>;
type CompleteRefusalReason = Exclude<
  Extract<CompleteResult, { ok: false }>['reason'],
  'ILLEGAL_TRANSITION'
>;

/**
 * How each refusal but `ILLEGAL_TRANSITION` reaches the client, keyed by
 * `completeClass`'s own range: a reason added to it fails to compile here
 * until it has an answer. `NOT_ENDED_YET` is the teacher finishing before
 * `finishOpensAt`.
 */
const COMPLETE_REFUSAL = {
  NOT_FOUND: CLASS_GONE,
  CANCELLED: CLASS_CANCELLED,
  NOT_ENDED_YET: CLASS_NOT_ENDED_YET,
} as const satisfies Record<CompleteRefusalReason, CodedRefusal>;

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
  if (!cls) return respondRefusal(CLASS_GONE);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  // `teacherAt`: the teacher may finish from `finishOpensAt`. Earlier is
  // refused under the lock as NOT_ENDED_YET → CLASS_NOT_ENDED_YET.
  const result = await completeClass(prisma, id, { teacherAt: new Date() });
  if (result.ok) return respondOk(result);

  if (result.reason === 'ILLEGAL_TRANSITION') {
    // Decided from the status `completeClass` read under its lock, after its
    // cancellation check — not from `cls` above, which a concurrent
    // completion can overtake while this request waits for the lock.
    //
    // `from`, which is the status read from the row — not `to`, which is the
    // status the request carried. They are equal on this branch, and the row
    // is what `newStatus` describes.
    if (result.from === result.to) {
      return respondUnchanged<CompleteApplied>({ ok: true, newStatus: result.from });
    }
    return respondError(
      transitionRefusalMessage(result.from, result.to),
      409,
      'ILLEGAL_TRANSITION',
    );
  }

  const refusal = COMPLETE_REFUSAL[result.reason];
  return respondRefusal(refusal);
});
