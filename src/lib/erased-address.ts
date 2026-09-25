/**
 * The placeholder address erasure writes over a real one, and the test for
 * it. One module owns both halves so a reader recognising a placeholder can
 * never drift from the writer building it. Where erasure writes it, and why
 * the value is observable, is `docs/data-model.md` (TeacherBlock, Invitation
 * erasure).
 *
 * `.invalid` is reserved (RFC 2606), so no deliverable address ends in it.
 * The id is lowercased because every email column carries a lowercase CHECK.
 */
export const ERASED_EMAIL_DOMAIN = 'deleted.invalid';

export function erasedAddress(id: string): string {
  return `deleted-${id.toLowerCase()}@${ERASED_EMAIL_DOMAIN}`;
}

export function isErasedAddress(email: string): boolean {
  return email.endsWith(`@${ERASED_EMAIL_DOMAIN}`);
}
