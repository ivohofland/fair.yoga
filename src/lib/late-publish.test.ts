import { describe, it, expect } from 'vitest';
import { DEADLINE_HOURS } from '@/services/waitlist';
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

describe('ordering', () => {
  it('every cancel deadline is earlier than every check, so past_check implies past the deadline', () => {
    expect(Math.min(...Object.values(DEADLINE_HOURS))).toBeGreaterThan(MAX_CANCEL_CHECK_HOURS);
  });
});
