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
