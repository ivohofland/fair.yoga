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
  it('is sent when the last notified address matches the current one and no failure is recorded', () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: at, lastNotifiedEmail: 'lena@example.com',
      lastNotifyFailedAt: null,
    });
    expect(result).toEqual({ state: 'sent', at });
  });

  it('is failed when the last attempt against the current address is recorded as failed', () => {
    const notifiedAt = new Date('2026-08-01T00:00:00.000Z');
    const failedAt = new Date('2026-08-01T00:05:00.000Z');
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: notifiedAt, lastNotifiedEmail: 'lena@example.com',
      lastNotifyFailedAt: failedAt,
    });
    expect(result).toEqual({ state: 'failed', at: failedAt });
  });

  it('is not-sent when the address was corrected after the last attempt, even with a stale failure recorded', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com',
      lastNotifiedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastNotifiedEmail: 'lena-old-typo@example.com',
      lastNotifyFailedAt: new Date('2026-08-01T00:05:00.000Z'),
    });
    expect(result).toEqual({ state: 'not-sent' });
  });

  it('is not-sent when no attempt has ever been made', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: null, lastNotifiedEmail: null,
      lastNotifyFailedAt: null,
    });
    expect(result).toEqual({ state: 'not-sent' });
  });
});
