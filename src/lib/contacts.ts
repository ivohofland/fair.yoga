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
