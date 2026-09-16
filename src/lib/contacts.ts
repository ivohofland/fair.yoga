import type { InvitationStatus, Prisma } from '@prisma/client';

/**
 * The shape an `Invitation` select must have to be allowed to reach a
 * teacher-facing surface — this file's callers, `ownedInvitation`
 * (`src/app/api/invitations/[id]/shared.ts`) and the contact detail page.
 *
 * `teacherInboxNotifiedAt?: never` is the whole point: intersected with
 * Prisma's own select, the column's only permitted value becomes `never`, so
 * naming it in one of those selects is a build failure rather than something a
 * reviewer has to notice. It is a direct statement of which account shape an
 * address holds — the fact `notifyInvitee`'s branch routing exists to keep off
 * every surface (#172, #622) — and it is the one column on this row whose leak
 * costs a privacy property rather than a duplicate notification. The column's
 * writers and the reason nothing reads it: `docs/data-model.md` (Invitation,
 * "Who an invitation reaches").
 *
 * The exclusion lives here, named once, so that the selects it guards can
 * point at it without spelling the column out beside the data they render.
 */
export type TeacherFacingInvitationSelect = Prisma.InvitationSelect & {
  teacherInboxNotifiedAt?: never;
};

/**
 * Whether a contact's remove affordance should render at all.
 *
 * Pulled out of `/students/contacts/[id]/page.tsx` on purpose: that page is
 * a server component, so no component test can reach the JSX condition
 * directly, and the only prior evidence this rule held was a throwaway
 * Playwright script run by hand and then deleted. `PUT`/`DELETE
 * /api/invitations/[id]` both 409 `DECLINED_IS_PERMANENT` on a declined
 * row — that's the backstop — but the brief was explicit that the button
 * itself must be *absent* for a declined contact, not present-and-failing
 * against that 409. This function is what a regression in that rendering
 * condition would actually break, so it's what gets the test.
 *
 * Type-only `@prisma/client` import, same as `payment-status.ts`: this stays
 * safe to import from a `'use client'` module without pulling the Prisma
 * runtime into the browser bundle, should a client component ever need it.
 */
export function canRemoveContact(status: InvitationStatus): boolean {
  return status !== 'declined';
}

/**
 * Whether a pending invitation's most recent notify attempt reached the
 * address the row currently holds, and whether that attempt is known to
 * have failed (#392). Pulled out of `/students/contacts/[id]/page.tsx` for
 * the same reason `canRemoveContact` above was: that page is a server
 * component, so no component test can reach the comparison directly.
 *
 * This function only checks `lastNotifiedEmail === email` before trusting
 * `lastNotifyFailedAt` at all — `state: 'not-sent'` means "not sent to the
 * CURRENT address," never "blocked." Which writers set or clear either
 * column, and the oracle-safety property `state: 'failed'` carries (bounded,
 * not zero — a burst of failures is suppressed rather than persisted; see
 * `deliverInvitation`, `src/services/invitations.ts`), are cross-file facts
 * this function doesn't own: see the `last_notify_failed_at` row in
 * `docs/data-model.md`. One consequence worth stating here since it's easy
 * to assume the opposite: a suppressed failure does NOT read as
 * `'not-sent'` — `lastNotifiedAt`/`lastNotifiedEmail` are already written by
 * the time suppression is even decided, so a suppressed row reads
 * `'sent'`, same as pre-#392 behaviour for every failure.
 */
export function invitationDeliveryStatus(
  invitation: {
    email: string;
    lastNotifiedAt: Date | null;
    lastNotifiedEmail: string | null;
    lastNotifyFailedAt: Date | null;
  },
): { state: 'sent'; at: Date } | { state: 'failed'; at: Date } | { state: 'not-sent' } {
  if (invitation.lastNotifiedAt && invitation.lastNotifiedEmail === invitation.email) {
    return invitation.lastNotifyFailedAt
      ? { state: 'failed', at: invitation.lastNotifyFailedAt }
      : { state: 'sent', at: invitation.lastNotifiedAt };
  }
  return { state: 'not-sent' };
}
