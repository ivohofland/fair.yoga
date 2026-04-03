import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireTeacher,
  isErrorResponse,
} from '@/lib/api-utils';
import { getOutstandingPayments } from '@/services/payments';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const payments = await getOutstandingPayments(prisma, session.userId);
  return respondOk(payments);
}
