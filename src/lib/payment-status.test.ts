import { describe, it, expect } from 'vitest';
import { isPaymentStatus, readUndoStatus } from './payment-status';

/**
 * #58. `usePaymentActions` used to read the undo response through
 * `as { data: { status: string } }` — an unchecked assertion over a network
 * payload. These two functions replace it.
 *
 * They started life inside `use-payment-actions.ts`, exported only so this file
 * could reach them; the move to `payment-status.ts` (#58 review) is what makes
 * those exports honest. The tests came with the move rather than being dropped,
 * because each one below catches a mutation no other test in the repo does —
 * notably `rejects inherited Object.prototype keys`, which is the only test
 * anywhere that fails when `PAYMENT_STATUS_KEYS.has(value)` is swapped for
 * `value in PAYMENT_STATUSES`. The component tests that exercise this path pass
 * only `'overdue'` and `'nonsense'`, and stay green through that swap.
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
   * Every malformed shape reads as `null`, not as a substituted 'pending'
   * (#58 review). The undo has already succeeded server-side by the time this
   * runs, so the row must still stop showing "Paid" — but choosing 'pending' as
   * the stand-in is the *caller's* call, made visibly at the call site in
   * `undo`, which also logs it. Returning it from here hid a fabricated value
   * behind a signature that promised a validated one.
   */
  it('returns null on any shape it cannot read', () => {
    expect(readUndoStatus({ data: { status: 'nonsense' } })).toBeNull();
    expect(readUndoStatus({ data: {} })).toBeNull();
    expect(readUndoStatus({ data: null })).toBeNull();
    expect(readUndoStatus({})).toBeNull();
    expect(readUndoStatus(null)).toBeNull();
    expect(readUndoStatus('not json')).toBeNull();
  });
});
