import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { recordDispatchFailure, __resetDispatchFailureTrackingForTests } from './notify-health';

describe('recordDispatchFailure — #392 review, Critical #1', () => {
  beforeEach(() => {
    __resetDispatchFailureTrackingForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not look systemic on the first failure', () => {
    expect(recordDispatchFailure()).toEqual({ looksSystemic: false });
  });

  it('does not look systemic on the second failure', () => {
    recordDispatchFailure();
    expect(recordDispatchFailure()).toEqual({ looksSystemic: false });
  });

  it('looks systemic from the third failure in the window onward', () => {
    recordDispatchFailure();
    recordDispatchFailure();
    expect(recordDispatchFailure()).toEqual({ looksSystemic: true });
    expect(recordDispatchFailure()).toEqual({ looksSystemic: true });
  });

  it('a failure outside the 5-minute window does not count toward the threshold', () => {
    vi.useFakeTimers();
    try {
      recordDispatchFailure();
      recordDispatchFailure();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      // The two above have aged out — this is the window's first failure again.
      expect(recordDispatchFailure()).toEqual({ looksSystemic: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('__resetDispatchFailureTrackingForTests actually clears state', () => {
    recordDispatchFailure();
    recordDispatchFailure();
    __resetDispatchFailureTrackingForTests();
    expect(recordDispatchFailure()).toEqual({ looksSystemic: false });
  });
});
