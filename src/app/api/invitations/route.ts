import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  // `origin: 'teacher_invite'` is a security filter, not a display
  // preference. A `student_block` row is a tombstone the STUDENT wrote by
  // unlinking, and it carries their email — an address this teacher may
  // never have been given, since shareEmail defaults to false. Returning
  // it would mean that leaving disclosed more than staying did.
  const invitations = await prisma.invitation.findMany({
    where: { teacherId: session.teacherId, origin: 'teacher_invite', isArchived: archived },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      status: true, isArchived: true, createdAt: true,
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  // No pagination, unlike GET /api/students: a teacher's pending contacts
  // are a working set they clear out, not a directory they page through.
  // If that assumption stops holding, `studentListQuerySchema` (schemas.ts)
  // is the idiom to copy — don't add paging here piecemeal.
  return respondOk({ invitations, total: invitations.length });
});
