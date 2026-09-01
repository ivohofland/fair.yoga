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
import { ownedInvitation, NOT_FOUND, DECLINED } from './shared';

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
 * The third branch — present, not gone, not declined — IS reachable, and by
 * the one mechanism this domain is built around. `resolveInvitationOnLink`
 * (`services/link-consent.ts`) flips `status: { not: 'accepted' }` to
 * `accepted`, declined rows included: booking a class or joining a waitlist is
 * how a student takes their own decline back, and CLAUDE.md calls it the route
 * back. So the sequence is ordinary, not anomalous — the teacher's edit passes
 * its pre-check on a `pending` row, the invitee declines, the CAS matches
 * nothing, and the invitee then books. `info`, not `warn`, for that reason:
 * nothing is wrong when this fires, and the honest answer to the teacher is
 * that the row moved, not a story about a refusal.
 */
async function casMatchedNothing(teacherId: string, id: string) {
  // Bounded: a throw here would turn a deterministic 409 into a 500, on the
  // retry path #196 exists to make safe. `'unread'` is its own outcome rather
  // than folding into `null`, which already means "gone" — and it falls to the
  // neutral 409 below, never to `DECLINED()`. Reporting a decline we could not
  // read is the precise failure this whole function was written to remove.
  const observed = await ownedInvitation(teacherId, id).catch((err: unknown) => {
    log.warn({ err, teacherId, invitationId: id }, 'invitation CAS re-read failed');
    return 'unread' as const;
  });
  if (observed !== 'unread') {
    if (!observed) return NOT_FOUND();
    if (observed.status === 'declined') return DECLINED();
  }
  log.info(
    {
      teacherId,
      invitationId: id,
      observedStatus: observed === 'unread' ? 'unread' : observed.status,
    },
    'invitation CAS matched nothing; the row moved under the request',
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
