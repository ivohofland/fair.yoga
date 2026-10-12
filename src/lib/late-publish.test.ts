import { describe, it, expect } from 'vitest';
import { DEADLINE_HOURS, cancelDeadlineInstant } from '@/services/waitlist';
import { isPastCancelDeadline } from '@/lib/cancel-deadline';
import { cancelCheckInstant, isPastCancelCheck } from '@/lib/auto-cancel-check';
import { classStartInstant, startsInPast } from '@/lib/timezone';
import { MAX_CANCEL_CHECK_HOURS } from '@/lib/auto-cancel-check';
import { latePublishState, latePublishRefreshInstants } from './late-publish';

const HOUR = 60 * 60 * 1000;
const start = new Date('2030-01-10T18:00:00Z');
const deadline = new Date(start.getTime() - 12 * HOUR);
const checkAt = new Date(start.getTime() - 2 * HOUR);
const at = (now: Date) => latePublishState({ now, start, deadline, checkAt });
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

describe('latePublishState', () => {
  it.each([
    ['a minute before the deadline', plus(deadline, -60_000), 'none'],
    ['exactly at the deadline', deadline, 'none'],
    ['1 ms past the deadline', plus(deadline, 1), 'past_deadline'],
    ['1 ms before the check', plus(checkAt, -1), 'past_deadline'],
    ['exactly at the check', checkAt, 'past_check'],
    ['1 ms before the start', plus(start, -1), 'past_check'],
    ['exactly at the start', start, 'past_check'],
    ['1 ms after the start', plus(start, 1), 'none'],
  ] as const)('%s -> %s', (_label, now, expected) => {
    expect(at(now)).toBe(expected);
  });
});

describe('latePublishRefreshInstants', () => {
  it('lists deadline, check, start', () => {
    expect(latePublishRefreshInstants({ start, deadline, checkAt }).map((d) => d.toISOString())).toEqual([
      '2030-01-10T06:00:00.000Z',
      '2030-01-10T16:00:00.000Z',
      '2030-01-10T18:00:00.000Z',
    ]);
  });
});

describe('latePublishRefreshInstants with an unreadable instant', () => {
  it('leaves an Invalid Date out', () => {
    const invalid = new Date(NaN);
    const out = latePublishRefreshInstants({ start: invalid, deadline, checkAt });
    expect(out.map((d) => d.toISOString())).toEqual([deadline.toISOString(), checkAt.toISOString()]);
  });
});

describe('agreement with the predicates it restates', () => {
  const timeZone = 'Europe/Amsterdam';
  const entry = {
    date: new Date('2030-03-12T00:00:00Z'),
    startTime: new Date('1970-01-01T18:30:00Z'),
  };
  const realStart = classStartInstant(entry, timeZone);
  const check = 'HOURS_2' as const;
  const limit = 'HOURS_12' as const;
  const realCheckAt = cancelCheckInstant(entry, check, timeZone);
  const realDeadline = cancelDeadlineInstant(entry, limit, timeZone);
  const state = (now: Date) =>
    latePublishState({ now, start: realStart, deadline: realDeadline, checkAt: realCheckAt });

  it('reads none exactly when the start is in the past, at the start and 1 ms after', () => {
    for (const now of [realStart, plus(realStart, 1)]) {
      expect(state(now) === 'none').toBe(startsInPast({ ...entry, timeZone }, now));
    }
  });

  it('reads past_check exactly when the cancel check has passed, at checkAt - 1 ms and at checkAt', () => {
    for (const now of [plus(realCheckAt, -1), realCheckAt]) {
      expect(state(now) === 'past_check').toBe(isPastCancelCheck(entry, check, timeZone, now));
    }
  });

  it('reads past the deadline exactly when the deadline has passed, at the deadline and 1 ms after', () => {
    for (const now of [realDeadline, plus(realDeadline, 1)]) {
      expect(state(now) !== 'none').toBe(isPastCancelDeadline(realDeadline, now));
    }
  });
});

describe('ordering', () => {
  it('every cancel deadline is earlier than every check, so past_check implies past the deadline', () => {
    expect(Math.min(...Object.values(DEADLINE_HOURS))).toBeGreaterThan(MAX_CANCEL_CHECK_HOURS);
  });
});
