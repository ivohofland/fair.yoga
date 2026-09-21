import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodeWithStatus } from '@/lib/api-error-codes';
import { addToWaitlist, WaitlistJoinError } from '@/services/waitlist';
import { createWaitlistSchema } from '@/lib/schemas';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';
import { CLASS_GONE } from '../classes/[id]/shared';

/** The code each join refusal is sent with. The message is the service's own. */
const JOIN_REFUSAL_CODE = {
  class_cancelled: 'CLASS_CANCELLED',
  class_not_open: 'CLASS_NOT_BOOKABLE',
  class_not_full: 'CLASS_NOT_FULL',
  already_registered: 'ALREADY_REGISTERED',
  student_erased: 'STUDENT_ERASED',
} as const satisfies Record<WaitlistJoinError['reason'], CodeWithStatus<409>>;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createWaitlistSchema);
  if ('error' in parsed) return parsed.error;

  const cls = await prisma.class.findUnique({
    where: { id: parsed.data.classId },
    select: { id: true },
  });
  if (!cls) return respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code);

  try {
    const entry = await addToWaitlist(prisma, parsed.data.classId, session.studentId);
    // Joining a waitlist implies tier choice (the route is self-only);
    // promotions and claims are covered transitively — nobody reaches
    // them without joining first. Null-guarded: first choice only. Scoped to
    // a live profile because an erasure can commit while this write waits on
    // the row (`docs/lock-order.md`, "The `Student` row is the erasure's
    // gate").
    //
    // A failure is logged and the join still answered 201, because the join
    // has committed. What a lost write costs: `tierSelectedAt` stays null, so
    // the student keeps the first-booking tier prompt and the anonymous price
    // line until a later write sets it — their next self-booking or join, or
    // a tier change. `error` unless the failure is a lost race.
    try {
      await prisma.student.updateMany({
        where: { id: session.studentId, tierSelectedAt: null, deletedAt: null },
        data: { tierSelectedAt: new Date() },
      });
    } catch (err) {
      const transient = isTransientDbError(err);
      log[transient ? 'warn' : 'error'](
        {
          err,
          studentId: session.studentId,
          classId: parsed.data.classId,
          entryId: entry.id,
          transient,
        },
        'waitlist join committed but its tierSelectedAt write failed',
      );
    }
    return respondOk(entry, 201);
  } catch (err) {
    if (err instanceof WaitlistJoinError) {
      return respondError(err.message, 409, JOIN_REFUSAL_CODE[err.reason]);
    }
    throw err;
  }
});
