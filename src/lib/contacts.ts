import type { InvitationStatus } from '@prisma/client';

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
 * `lastNotifiedEmail` is written unconditionally on every attempt by both
 * writers — `POST /api/students` (route.ts) and `POST
 * /api/invitations/[id]/resend` (route.ts, #173) — so `state: 'not-sent'`
 * here means only "not sent to the CURRENT address," never "blocked."
 * `lastNotifyFailedAt` is set only inside `deliverInvitation`'s own
 * `.catch` (services/invitations.ts), which never fires for a blocked or
 * already-linked address either (both `notifyInvitee` early returns
 * resolve without throwing) — so `state: 'failed'` carries the same
 * non-disclosure property `state: 'sent'` always has. Checked only once
 * `lastNotifiedEmail === email` already holds: both `POST` routes clear
 * `lastNotifyFailedAt` on every fresh attempt and `PUT` clears it on every
 * readdress, so a stale failure from a superseded attempt or an old
 * address should never reach this branch — the email-match gate is kept
 * as a second, independent check anyway, not load-bearing on the clearing
 * writes alone.
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
