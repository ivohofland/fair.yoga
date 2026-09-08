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
import { ownedInvitation, NOT_FOUND, DECLINED, NOT_PENDING } from './shared';

/**
 * The `status` filter the caller's own CAS ran with — `'pending'` for PUT
 * (since #500) or `'not-declined'` for DELETE. Named off that filter rather
 * than off the caller's identity: it is the one fact `casMatchedNothing`
 * actually needs, since it decides whether `accepted` was itself excluded
 * from the write that just missed.
 */
type InvitationCasScope = 'pending' | 'not-declined';

/**
 * The two CAS filters this file's writes run under, keyed by
 * `InvitationCasScope` so a filter and the scope naming it can never drift
 * apart: each caller below reads its own `where` fragment out of here and
 * passes the very same key on to `casMatchedNothing`, rather than typing the
 * filter and the scope as two separately-editable literals.
 */
const CAS_FILTER = {
  pending: { status: 'pending' },
  'not-declined': { status: { not: 'declined' } },
} as const satisfies Record<InvitationCasScope, Prisma.InvitationWhereInput>;

/**
 * What a CAS that matched nothing actually means — asked, not assumed.
 *
 * Each caller's own CAS decides which statuses count as a miss. DELETE's
 * `CAS_FILTER['not-declined']` misses only when the row went `declined` in
 * the gap after the pre-check (the original case this function exists for),
 * or is simply gone — a concurrent delete from the teacher's other tab, or
 * their own retried delete. PUT's `CAS_FILTER.pending` (since #500) misses
 * on either of those too, plus a third way: the row went `accepted` in that
 * same gap — PUT's own CAS is narrow enough to catch that; DELETE's still
 * admits `accepted` and deletes it outright. Answering `DECLINED_IS_PERMANENT`
 * for the vanished-row case would tell a teacher who had just deleted a
 * contact that the person declined their invitation — a false statement
 * about a third party's choice, made by a tool whose premise is not making
 * those.
 *
 * So re-read and report what is actually there, the shape
 * `deleteTeacherAccount`'s class CAS (`services/gdpr.ts`) uses. Scoped to the
 * teacher again rather than by id alone: a row that is no longer theirs is not
 * theirs to hear about, which is the same reason `NOT_FOUND` exists above.
 *
 * A re-read finding `accepted` — present, not gone, not declined — is
 * reachable two ways, and neither caller needs to tell them apart: directly
 * (the invitee accepts in the gap, no decline involved), or by the one
 * mechanism a `declined`-caused miss can hide behind — `resolveInvitationOnLink`
 * (`services/link-consent.ts`) returns a `declined` row to `accepted` on any
 * booking or waitlist join by that student, unconditionally, so a CAS that
 * missed because the row went `declined` can still find `accepted` sitting
 * there by the time this function's own re-read runs. Booking a class or
 * joining a waitlist is how a student takes their own decline back, and
 * CLAUDE.md calls it the route back — the sequence is ordinary, not
 * anomalous, for either caller's own read-then-write gap.
 *
 * The two callers answer that same observation differently, because their
 * policies differ, not because the mechanism does. DELETE has never claimed
 * a policy about `pending` — deleting an `accepted` row outright is the
 * whole point of leaving it the deliberate exception (`PUT`'s own docblock
 * below) — so it falls all the way through to the generic 409, exactly as it
 * did before #500. PUT's policy, since #500, is simply "not pending is
 * refused" regardless of how the row got there, so this same observation
 * answers `NOT_PENDING` there. `info`, not `warn`, for the branch that still
 * reaches the generic answer: nothing is wrong when this fires, and the
 * honest answer to the teacher is that the row moved, not a story about a
 * refusal.
 */
async function casMatchedNothing(teacherId: string, id: string, cas: InvitationCasScope) {
  // Bounded: a throw here would turn a deterministic 409 into a 500, on the
  // retry path #196 exists to make safe. `'unread'` is its own outcome rather
  // than folding into `null`, which already means "gone" — and it falls to the
  // neutral 409 below, never to `DECLINED()`/`NOT_PENDING()`. Reporting a
  // decline or an acceptance we could not read is the precise failure this
  // whole function was written to remove.
  const observed = await ownedInvitation(teacherId, id).catch((err: unknown) => {
    log.warn({ err, teacherId, invitationId: id }, 'invitation CAS re-read failed');
    return 'unread' as const;
  });
  if (observed !== 'unread') {
    if (!observed) return NOT_FOUND();
    if (observed.status === 'declined') return DECLINED();
    // Scoped to PUT's own CAS: DELETE's `'not-declined'` CAS still admits
    // `accepted` rows and deletes them outright, so an `accepted` re-read
    // there is the `resolveInvitationOnLink` race above, not a refusal —
    // "no longer pending" is not a policy DELETE has ever stated. Logged
    // before returning rather than falling through to the shared log call
    // below: this is the one outcome under this branch #500 exists to make
    // visible, and an early return that skipped the log would make it the
    // only miss reason with no telemetry at all.
    if (cas === 'pending' && observed.status === 'accepted') {
      log.info(
        { teacherId, invitationId: id, cas, observedStatus: 'accepted' },
        'invitation CAS matched nothing; the row moved under the request',
      );
      return NOT_PENDING();
    }
  }
  log.info(
    {
      teacherId,
      invitationId: id,
      cas,
      observedStatus: observed === 'unread' ? 'unread' : observed.status,
    },
    'invitation CAS matched nothing; the row moved under the request',
  );
  return respondError(
    'This contact changed while you were working on it. Reload and try again.',
    409,
  );
}

/**
 * Gates on ownership and status, and nothing else — in particular there is
 * no roster-link check on the incoming `email`, because none is needed: the
 * check below refuses the whole write on any row that isn't `pending`, so an
 * `accepted` row can never be re-addressed to a guessed value and re-probed
 * with `POST /api/students` (#500). `resend` (`./resend/route.ts`) refuses
 * the same row the same way, for the same reason. `DELETE` deliberately does
 * not: removing an `accepted` row leaves no `existing` row for
 * `inviteContact`'s `accepted` disjunct (`services/invitations.ts`) to fire
 * on, so a guess-and-probe against a deleted row gets an ordinary fresh
 * invite either way, not a second door into the same oracle.
 */
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

  // Refuses the whole update, not just `email`, the same way the `declined`
  // refusal above already covers the whole body rather than one field. A
  // route that let `firstName`/`lastName` through on a row it has otherwise
  // decided is frozen would be a route with two policies instead of one
  // (#500). Checked before `parseBody` below, not after: a frozen row is
  // refused on its own status, not on whatever happens to be in the body —
  // the same ordering `DECLINED` above already keeps, so a non-pending row's
  // write is never even validated, let alone considered.
  if (invitation.status !== 'pending') return NOT_PENDING();

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
  const scope: InvitationCasScope = 'pending';
  try {
    changed = await prisma.invitation.updateMany({
      // Status in the WHERE for the same reason DELETE has it: the pre-check
      // above cannot see a decline — or, since #500, an acceptance — that
      // commits in its gap. `CAS_FILTER.pending` is positive equality rather
      // than `notIn: ['declined', 'accepted']`: naming the one state this
      // write allows means a future fourth `InvitationStatus` member is
      // excluded by default, not silently admitted — the same preference
      // `inviteContact`'s own comment states (`services/invitations.ts`) for
      // its `existing?.status === 'accepted'` check.
      where: { id, ...CAS_FILTER[scope] },
      // Nothing here lowercases `email` — it arrives already normalised
      // by `emailField` (`updateInvitationSchema`, src/lib/schemas.ts) at
      // HTTP ingress, and `Invitation_email_lowercase_check` rejects
      // anything else at rest. The column is lowercase by construction, and
      // the uniqueness check and later account-matching both depend on that
      // holding for every row, not just the ones created through POST.
      //
      // `delivered: false` rides along with every `email` change,
      // unconditionally — not gated on whether the new address looks
      // blocked or linked, which would need the same `TeacherBlock`/roster
      // queries `inviteContact` already runs, on a route that has never
      // needed them. `false` is simply the honest value regardless: no
      // delivery attempt has been made to the new address, full stop. This
      // is what keeps `unlinkTeacher`'s `delivered: true`-scoped tombstone
      // (`services/invitations.ts`) from matching a row whose CURRENT
      // address was never actually told this invitation exists — closing
      // the second door #502's decoy-invitation leak could otherwise
      // reopen through a re-address. See "Fix #3" in
      // `docs/superpowers/specs/2026-09-08-invitation-erasure-tombstone-design.md`.
      data: { ...rest, ...(email !== undefined ? { email, delivered: false } : {}) },
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
  if (changed.count === 0) return casMatchedNothing(session.teacherId, id, scope);
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
  const scope: InvitationCasScope = 'not-declined';
  const removed = await prisma.invitation.deleteMany({
    where: { id, ...CAS_FILTER[scope] },
  });
  if (removed.count === 0) return casMatchedNothing(session.teacherId, id, scope);
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
