import { describe, it, expect } from 'vitest';
import {
  isPastCancelDeadline,
  freeCancelUntil,
  freeCancelUntilFor,
  FREE_CANCEL_GRACE_MINUTES,
} from './cancel-deadline';

describe('isPastCancelDeadline', () => {
  const deadline = new Date('2026-04-09T09:00:00Z');

  it('is false before the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date('2026-04-09T08:59:59.999Z'))).toBe(false);
  });

  it('is false exactly at the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date(deadline.getTime()))).toBe(false);
  });

  it('is true one millisecond after the deadline', () => {
    expect(isPastCancelDeadline(deadline, new Date(deadline.getTime() + 1))).toBe(true);
  });
});

describe('freeCancelUntil', () => {
  const deadline = new Date('2026-06-01T06:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('is the deadline for a booking that was not auto-promoted', () => {
    expect(freeCancelUntil(deadline, null)).toEqual(deadline);
  });

  it('is the deadline when the promotion was 15+ minutes before it', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T03:00:00Z'))).toEqual(deadline);
    expect(freeCancelUntil(deadline, at('2026-06-01T05:45:00Z'))).toEqual(deadline);
  });

  it('extends past the deadline for a promotion inside its last 15 minutes', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T05:55:00Z'))).toEqual(at('2026-06-01T06:10:00Z'));
  });

  it('gives 15 minutes to a promotion after the deadline', () => {
    expect(freeCancelUntil(deadline, at('2026-06-01T14:00:00Z'))).toEqual(at('2026-06-01T14:15:00Z'));
  });

  it('the free-until instant itself is still free; one second later is not', () => {
    const until = freeCancelUntil(deadline, at('2026-06-01T14:00:00Z'));
    expect(isPastCancelDeadline(until, at('2026-06-01T14:15:00Z'))).toBe(false);
    expect(isPastCancelDeadline(until, at('2026-06-01T14:15:01Z'))).toBe(true);
  });

  it('the grace is fifteen minutes', () => {
    expect(FREE_CANCEL_GRACE_MINUTES).toBe(15);
  });
});

describe('freeCancelUntilFor', () => {
  const deadline = new Date('2026-06-01T06:00:00Z');
  const promotedAt = new Date('2026-06-01T05:55:00Z'); // inside the last 15 minutes

  it('is the deadline for no linked entry at all', () => {
    expect(freeCancelUntilFor(deadline, null)).toEqual(deadline);
  });

  it('extends the deadline for a promoted entry, matching freeCancelUntil', () => {
    expect(freeCancelUntilFor(deadline, { status: 'promoted', promotedAt })).toEqual(
      freeCancelUntil(deadline, promotedAt),
    );
  });

  it('gives a claimed entry no grace, even with the same promotedAt a promotion would extend on', () => {
    expect(freeCancelUntilFor(deadline, { status: 'claimed', promotedAt })).toEqual(deadline);
  });

  it('gives a waiting entry no grace — it was never promoted', () => {
    expect(freeCancelUntilFor(deadline, { status: 'waiting', promotedAt: null })).toEqual(deadline);
  });
});
