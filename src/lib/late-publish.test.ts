import { describe, it, expect } from 'vitest';
import type { AutoCancelCheck, CancelDeadline } from '@prisma/client';
import { cancelDeadlineInstant } from '@/services/waitlist';
import { DEADLINE_HOURS, isPastCancelDeadline } from '@/lib/cancel-deadline';
import { CANCEL_CHECK_HOURS, MAX_CANCEL_CHECK_HOURS } from '@/lib/cancel-check';
import { cancelCheckInstant, isPastCancelCheck } from '@/lib/auto-cancel-check';
import { classStartInstant, startsInPast } from '@/lib/timezone';
import { latePublishState, latePublishRefreshInstants, latePublishInstants, moveWarningFor, isLateFirstClass } from './late-publish';

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

describe('latePublishInstants', () => {
  const entry = { date: new Date('2030-03-31T00:00:00Z'), startTime: new Date('1970-01-01T18:30:00Z') };
  const timeZone = 'Europe/Amsterdam';
  const realStart = classStartInstant(entry, timeZone);
  const deadlines = Object.keys(DEADLINE_HOURS) as CancelDeadline[];
  const checks = Object.keys(CANCEL_CHECK_HOURS) as AutoCancelCheck[];
  const pairs = deadlines.flatMap((d) => checks.map((c) => [d, c] as const));

  it.each(pairs)('agrees with the server wrappers for %s and %s', (cancelDeadline, autoCancelCheck) => {
    expect(latePublishInstants({ start: realStart, cancelDeadline, autoCancelCheck })).toEqual({
      start: realStart,
      deadline: cancelDeadlineInstant(entry, cancelDeadline, timeZone),
      checkAt: cancelCheckInstant(entry, autoCancelCheck, timeZone),
    });
  });
});

describe('moveWarningFor', () => {
  const base = {
    cancelDeadline: 'HOURS_12',
    autoCancelCheck: 'HOURS_2',
    timeZone: 'Europe/Amsterdam',
  } as const;

  it('gives the warning for an open, unlocked class', () => {
    expect(moveWarningFor({ ...base, status: 'open', settingsLocked: false })).toEqual({
      timeZone: 'Europe/Amsterdam',
      cancelDeadline: 'HOURS_12',
      autoCancelCheck: 'HOURS_2',
    });
  });

  it('gives none for a draft', () => {
    expect(moveWarningFor({ ...base, status: 'draft', settingsLocked: false })).toBeNull();
  });

  it('gives none for an open class that is locked', () => {
    expect(moveWarningFor({ ...base, status: 'open', settingsLocked: true })).toBeNull();
  });
});

describe('isLateFirstClass', () => {
  const ok = { date: '2026-11-10', state: 'past_deadline', minStudents: 3 };

  it('accepts a well-formed value', () => {
    expect(isLateFirstClass(ok)).toBe(true);
    expect(isLateFirstClass({ ...ok, state: 'past_check' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'past_deadline'],
    ['state none', { ...ok, state: 'none' }],
    ['a malformed date', { ...ok, date: '10-11-2026' }],
    ['zero students', { ...ok, minStudents: 0 }],
    ['fractional students', { ...ok, minStudents: 1.5 }],
    ['a missing field', { date: ok.date, state: ok.state }],
  ])('rejects %s', (_label, value) => {
    expect(isLateFirstClass(value)).toBe(false);
  });
});
