import { describe, it, expect } from 'vitest';
import { isPaymentStatus, readUndoStatus } from './use-payment-actions';

/**
 * #58. `usePaymentActions` used to read the undo response through
 * `as { data: { status: string } }` — an unchecked assertion over a network
 * payload. These two functions replace it. They are exported solely so this
 * file can reach them; nothing else imports them.
 */
describe('isPaymentStatus', () => {
  it('accepts every member of the schema enum', () => {
    expect(isPaymentStatus('pending')).toBe(true);
    expect(isPaymentStatus('paid')).toBe(true);
    expect(isPaymentStatus('overdue')).toBe(true);
  });

  it('rejects near-misses and non-strings', () => {
    expect(isPaymentStatus('overdu')).toBe(false);
    expect(isPaymentStatus('')).toBe(false);
    expect(isPaymentStatus('PENDING')).toBe(false); // case-sensitive on purpose
    expect(isPaymentStatus(null)).toBe(false);
    expect(isPaymentStatus(undefined)).toBe(false);
    expect(isPaymentStatus(42)).toBe(false);
  });

  /**
   * The reason this is a `Set` and not `value in PAYMENT_STATUSES`: an `in`
   * check against a plain object walks the prototype chain, so 'constructor'
   * and 'toString' would both pass. A Set has no such members.
   */
  it('rejects inherited Object.prototype keys', () => {
    expect(isPaymentStatus('constructor')).toBe(false);
    expect(isPaymentStatus('toString')).toBe(false);
    expect(isPaymentStatus('hasOwnProperty')).toBe(false);
  });
});

describe('readUndoStatus', () => {
  it('returns the status the server sent', () => {
    expect(readUndoStatus({ data: { status: 'overdue' } })).toBe('overdue');
    expect(readUndoStatus({ data: { status: 'pending' } })).toBe('pending');
  });

  /**
   * Every malformed shape falls back to 'pending' rather than throwing: an undo
   * whose response we cannot read still succeeded server-side, so the row must
   * stop showing "Paid". 'pending' is what `unmarkPaymentPaid` writes
   * (services/payments.ts:97), so it is the honest guess, not a neutral one.
   */
  it('falls back to pending on any shape it cannot read', () => {
    expect(readUndoStatus({ data: { status: 'nonsense' } })).toBe('pending');
    expect(readUndoStatus({ data: {} })).toBe('pending');
    expect(readUndoStatus({ data: null })).toBe('pending');
    expect(readUndoStatus({})).toBe('pending');
    expect(readUndoStatus(null)).toBe('pending');
    expect(readUndoStatus('not json')).toBe('pending');
  });
});
