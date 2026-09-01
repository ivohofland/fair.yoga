import { describe, it, expect } from 'vitest';
import { canRemoveContact, invitationDeliveryStatus } from './contacts';

/**
 * #166. The one behaviour the Task 9 brief named explicitly — a declined
 * contact's remove button is absent, not present-and-failing — had no
 * committed test, because the render condition lived inline in a server
 * component no test file can reach. This is the regression guard: if a
 * future edit makes the button unconditional again, this fails before a
 * teacher ever sees a 409.
 */
describe('canRemoveContact', () => {
  it('is false for a declined contact', () => {
    expect(canRemoveContact('declined')).toBe(false);
  });

  it('is true for a pending contact', () => {
    expect(canRemoveContact('pending')).toBe(true);
  });

  // Never actually reaches this function in the running app today — the
  // contact page redirects away for an accepted invitation before it can
  // render a remove button at all. Pinned anyway: `!== 'declined'` is an
  // exclusion, and a mutation to `=== 'pending'` (an inclusion that quietly
  // drops this case to `false`) would pass every other test in this file.
  it('is true for an accepted contact', () => {
    expect(canRemoveContact('accepted')).toBe(true);
  });
});

describe('invitationDeliveryStatus', () => {
  it('is sent when the last notified address matches the current one', () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: at, lastNotifiedEmail: 'lena@example.com',
    });
    expect(result).toEqual({ sent: true, at });
  });

  it('is not sent when the address was corrected after the last attempt', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com',
      lastNotifiedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastNotifiedEmail: 'lena-old-typo@example.com',
    });
    expect(result).toEqual({ sent: false });
  });

  it('is not sent when no attempt has ever been made', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: null, lastNotifiedEmail: null,
    });
    expect(result).toEqual({ sent: false });
  });
});
