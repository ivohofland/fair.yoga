import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { getPaymentsForClass } from '@/services/payments';
import { CLASS_GONE } from '../shared';

export const GET = withErrorHandler(async (
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

  const payments = await getPaymentsForClass(prisma, id, session.teacherId);
  return respondOk(payments);
});
