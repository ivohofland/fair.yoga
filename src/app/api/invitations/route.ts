import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { respondOk, requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import type { TeacherFacingInvitationSelect } from '@/lib/contacts';
import { ERASED_EMAIL_DOMAIN } from '@/lib/erased-address';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  // `?status=pending`: the unarchived pending contacts a walk-in may pick,
  // without erasure placeholders, which a walk-in refuses:
  // `docs/data-model.md` (Invitation → Walk-ins).
  const pendingOnly = request.nextUrl.searchParams.get('status') === 'pending';
  const where: Prisma.InvitationWhereInput = pendingOnly
    ? {
        teacherId: session.teacherId,
        isArchived: false,
        status: 'pending',
        NOT: { email: { endsWith: `@${ERASED_EMAIL_DOMAIN}` } },
      }
    : { teacherId: session.teacherId, isArchived: archived };

  // `satisfies TeacherFacingInvitationSelect` (`src/lib/contacts.ts`) is not
  // decoration: this is the teacher's contacts-list JSON, one of the
  // teacher-facing `Invitation` selects that type guards, so naming the
  // column it excludes here would be a build failure too.
  const invitations = await prisma.invitation.findMany({
    where,
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
