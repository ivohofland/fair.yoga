import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
} from '@/lib/api-utils';
import { promoteNext } from '@/services/waitlist';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const entry = await prisma.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return respondError('Waitlist entry not found', 404);

  // Verify teacher owns the class
  const cls = await prisma.class.findUnique({ where: { id: entry.classId } });
  if (!cls || cls.teacherId !== session.userId) {
    return respondError('Not your class', 403);
  }

  const promoted = await promoteNext(prisma, entry.classId);
  if (!promoted) return respondOk(null);

  return respondOk(promoted);
}
