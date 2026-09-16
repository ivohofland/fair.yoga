import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import type { TeacherFacingInvitationSelect } from '@/lib/contacts';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  // `satisfies TeacherFacingInvitationSelect` (`src/lib/contacts.ts`) is not
  // decoration: this is the teacher's contacts-list JSON, one of the
  // teacher-facing `Invitation` selects that type guards, so naming the
  // column it excludes here would be a build failure too.
  const invitations = await prisma.invitation.findMany({
    where: { teacherId: session.teacherId, isArchived: archived },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      status: true, isArchived: true, createdAt: true,
    } satisfies TeacherFacingInvitationSelect,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  // No pagination: a teacher's pending contacts are a working set they clear
  // out, not a directory they page through. If that assumption stops
  // holding, add paging here deliberately rather than piecemeal.
  return respondOk({ invitations, total: invitations.length });
});
