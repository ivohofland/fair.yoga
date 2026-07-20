import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { getOutstandingPayments } from '@/services/payments';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const payments = await getOutstandingPayments(prisma, session.teacherId);
  return respondOk(payments);
});
