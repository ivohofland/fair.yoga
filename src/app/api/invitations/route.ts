import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  const invitations = await prisma.invitation.findMany({
    where: { teacherId: session.teacherId, isArchived: archived },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      status: true, isArchived: true, createdAt: true,
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  // No pagination: a teacher's pending contacts are a working set they clear
  // out, not a directory they page through. If that assumption stops
  // holding, add paging here deliberately rather than piecemeal.
  return respondOk({ invitations, total: invitations.length });
});
