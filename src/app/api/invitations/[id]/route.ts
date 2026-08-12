import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
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
import { log } from '@/lib/log';

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

/**
 * The refusal a declined row earns, in one place — PUT's pre-check, DELETE's
 * pre-check and both of their post-CAS answers say exactly this, and three
 * copies of one sentence is three chances for them to stop agreeing.
 */
const DECLINED = () =>
  respondError(
    'This person declined. You can archive this contact, but it cannot be removed.',
    409,
    'DECLINED_IS_PERMANENT',
  );

/**
 * What a CAS that matched nothing actually means — asked, not assumed.
 *
 * `where: { id, status: { not: 'declined' } }` matches nothing for TWO
 * reasons: the row went declined in the gap after the pre-check (the case the
 * guard exists for), or the row is simply gone — a concurrent delete from the
 * teacher's other tab, or their own retried delete. Answering
 * `DECLINED_IS_PERMANENT` for both told a teacher who had just deleted a
 * contact that the person had declined their invitation: a false statement
 * about a third party's choice, made by a tool whose premise is not making
 * those.
 *
 * So re-read and report what is actually there, the shape
 * `deleteTeacherAccount`'s class CAS (`services/gdpr.ts`) uses. Scoped to the
 * teacher again rather than by id alone: a row that is no longer theirs is not
 * theirs to hear about, which is the same reason `NOT_FOUND` exists above.
 *
 * The third branch is unreachable today — nothing in this codebase moves an
 * invitation out of `declined` — so it says so in the log rather than
 * inventing a story for the teacher, and answers the same 409 the CAS was
 * refusing on.
 */
async function casMatchedNothing(teacherId: string, id: string) {
  const observed = await ownedInvitation(teacherId, id);
  if (!observed) return NOT_FOUND();
  if (observed.status === 'declined') return DECLINED();
  log.warn(
    { teacherId, invitationId: id, observedStatus: observed.status },
    'invitation CAS matched nothing on a row that is neither gone nor declined',
  );
  return respondError(
    'This contact changed while you were working on it. Reload and try again.',
    409,
  );
}

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
  if (invitation.status === 'declined') return DECLINED();

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

  // Caught rather than pre-checked (F9, #166 review). `Invitation` has one
  // unique key besides its primary — `@@unique([teacherId, email])` — and
  // this is the only field on the form that can collide with it: the teacher
  // retyped one contact's address as another's. That is an ordinary mistake
  // on a contact form, not a race, and it used to fall all the way through
  // to `classifyApiError`'s generic fallback (src/lib/api-errors.ts), which
  // rendered Prisma's own "Resource already exists" in the form's error slot
  // and logged a `warn` written for genuine lost races.
  //
  // A pre-check would leave the race the fallback is for, so this catches
  // instead: the same shape `POST /api/registrations` uses for its own
  // unique collision. `ALREADY_INVITED` is this domain's existing name for
  // "a row already exists for this (teacher, address)" — the same code
  // `POST /api/students` answers with, since it is the same constraint —
  // but the message is the edit form's, because "another contact holds this
  // address" is what the teacher standing on this page can act on.
  let changed: { count: number };
  try {
    changed = await prisma.invitation.updateMany({
      // Status in the WHERE for the same reason DELETE has it: the pre-check
      // above cannot see a decline that commits in its gap.
      where: { id, status: { not: 'declined' } },
      // Nothing here lowercases `email` — it arrives already normalised
      // by `emailField` (`updateInvitationSchema`, src/lib/schemas.ts) at
      // HTTP ingress, and `Invitation_email_lowercase_check` rejects
      // anything else at rest. The column is lowercase by construction, and
      // the uniqueness check and later account-matching both depend on that
      // holding for every row, not just the ones created through POST.
      data: { ...rest, ...(email !== undefined ? { email } : {}) },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return respondError(
        'Another of your contacts already uses this email address.',
        409,
        'ALREADY_INVITED',
      );
    }
    throw err;
  }
  // Not automatically the decline: the row may simply be gone. See
  // `casMatchedNothing`.
  if (changed.count === 0) return casMatchedNothing(session.teacherId, id);
  return respondOk({ id });
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
  if (invitation.status === 'declined') return DECLINED();

  // The pre-check above is a read-then-write, so a decline committing in the
  // gap would reach a plain `delete({ where: { id } })` and destroy the
  // tombstone anyway. The status lives in the WHERE for that reason. Same
  // idiom as `revivePendingInvitation` (`services/invitations.ts`), which
  // CASes on `status: 'accepted'`. What a count of 0 MEANS is
  // `casMatchedNothing`'s question — a decline is only one of its answers, and
  // "the row is already gone" is the other, which for a DELETE is the retry
  // this route is meant to survive.
  const removed = await prisma.invitation.deleteMany({
    where: { id, status: { not: 'declined' } },
  });
  if (removed.count === 0) return casMatchedNothing(session.teacherId, id);
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

  // Deliberately NOT status-scoped, unlike DELETE and PUT above. Archiving a
  // declined row is the escape hatch those two refusals point at, so a CAS on
  // `status: { not: 'declined' }` here would remove the only thing a teacher
  // can still do with a tombstone. `invitations-api.test.ts` ('archives a
  // declined row') fails if this is ever scoped. The read-then-write gap that
  // matters there is benign: two concurrent PATCHes converge on one
  // `isArchived`.
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
