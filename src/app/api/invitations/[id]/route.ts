import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateInvitationSchema, archiveStateQuerySchema } from '@/lib/schemas';

/**
 * The ownership preamble shared by PUT/DELETE/PATCH below.
 *
 * `findFirst` with `teacherId` in the `where`, not `findUnique` by id
 * followed by a separate ownership check — the ownership condition belongs
 * in the query itself, which is the shape this project's gate model calls
 * for (#162 was a PUT that skipped exactly this).
 */
async function ownedInvitation(teacherId: string, id: string) {
  return prisma.invitation.findFirst({
    where: { id, teacherId },
    select: { id: true, status: true, isArchived: true },
  });
}

/**
 * 404, not 403, when the row isn't this teacher's. The students routes
 * answer 403 for the equivalent case because a caller may legitimately know
 * a student id (they share a class roster, a booking link, etc). An
 * invitation id is never shared with anyone but the teacher who created it,
 * so its absence is the honest answer — a 403 would confirm the id exists
 * and belongs to someone else, which is a disclosure this route has no
 * reason to make.
 */
const NOT_FOUND = () => respondError('Contact not found', 404);

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  // Same refusal as DELETE, and for the same reason. The tombstone is keyed
  // on (teacherId, email) — editing the address off a declined row would
  // free that address for a fresh invite just as surely as deleting the row
  // would, so an edit is the same hole through a second door.
  if (invitation.status === 'declined') {
    return respondError(
      'This person declined. You can archive this contact, but it cannot be removed.',
      409,
      'DECLINED_IS_PERMANENT',
    );
  }

  const parsed = await parseBody(request, updateInvitationSchema);
  if ('error' in parsed) return parsed.error;

  // Every field on `updateInvitationSchema` is optional, so `{}` parses and
  // would reach `update({ data: {} })` — a write that touches nothing and
  // answers 200, telling the caller their edit landed. Same refusal, same
  // wording as `PUT /api/students/[id]` (route.ts) for the same body.
  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const { email, ...rest } = parsed.data;

  const updated = await prisma.invitation.update({
    where: { id },
    // Lowercased on write, matching `inviteContact` (services/invitations.ts)
    // — this column is lowercase by construction, and the uniqueness check
    // and later account-matching both depend on that holding for every row,
    // not just the ones created through POST.
    data: { ...rest, ...(email !== undefined ? { email: email.toLowerCase() } : {}) },
    select: { id: true },
  });

  return respondOk({ id: updated.id });
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  // The tombstone must outlive the teacher's wish to be rid of it. If this
  // row could be deleted, delete-then-re-invite would restore exactly the
  // harassment loop that declining exists to end. Archiving is the escape
  // hatch: it hides the row without disarming the uniqueness check that
  // `inviteContact` runs against it.
  if (invitation.status === 'declined') {
    return respondError(
      'This person declined. You can archive this contact, but it cannot be removed.',
      409,
      'DECLINED_IS_PERMANENT',
    );
  }

  await prisma.invitation.delete({ where: { id } });
  return respondOk({ id });
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }
  const archiving = parsed.data.state === 'archived';

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  // Already there: no write. The point of #98 — a retry after a lost
  // response must not undo what the first attempt did. Archiving a declined
  // row is allowed (that's the whole escape hatch DELETE points to above);
  // this branch only short-circuits when there is nothing to change.
  if (invitation.isArchived === archiving) {
    return respondOk({ isArchived: invitation.isArchived, action: 'unchanged' });
  }

  const updated = await prisma.invitation.update({
    where: { id },
    data: { isArchived: archiving },
    select: { isArchived: true },
  });

  return respondOk({
    isArchived: updated.isArchived,
    action: archiving ? 'archived' : 'unarchived',
  });
});
