import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { log } from '@/lib/log';
import { logDegraded } from '@/lib/degradation';
import { readClassStart } from '@/lib/class-start';
import { classStartInstant } from '@/lib/timezone';

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);
const date = (iso: string) => new Date(`${iso}T00:00:00Z`);

function expectNothingLogged() {
  expect(logDegraded).not.toHaveBeenCalled();
  for (const fn of Object.values(log)) expect(fn).not.toHaveBeenCalled();
}

describe('readClassStart', () => {
  it('reads a DST-zone entry to the instant classStartInstant returns', () => {
    // Europe/Amsterdam springs forward on 2030-03-31; the class is after it.
    const entry = { date: date('2030-03-31'), startTime: time('18:30') };
    vi.clearAllMocks();
    const reading = readClassStart(entry, 'Europe/Amsterdam');
    expect(reading.fault).toBeNull();
    expect(reading.instant.toISOString()).toBe('2030-03-31T16:30:00.000Z');
    expect(reading.instant.getTime()).toBe(classStartInstant(entry, 'Europe/Amsterdam').getTime());
  });

  it('reports an Invalid date as fault "date" with an Invalid instant', () => {
    vi.clearAllMocks();
    const reading = readClassStart({ date: new Date('nonsense'), startTime: time('18:30') }, 'Europe/Amsterdam');
    expect(reading.fault).toBe('date');
    expect(Number.isNaN(reading.instant.getTime())).toBe(true);
    expectNothingLogged();
  });

  it('reports an Invalid startTime as fault "start-time" with an Invalid instant', () => {
    vi.clearAllMocks();
    const reading = readClassStart({ date: date('2030-03-31'), startTime: new Date('nonsense') }, 'Europe/Amsterdam');
    expect(reading.fault).toBe('start-time');
    expect(Number.isNaN(reading.instant.getTime())).toBe(true);
    expectNothingLogged();
  });

  it('reports an unknown zone as fault "timezone" with the UTC-interpreted instant and the error', () => {
    vi.clearAllMocks();
    const reading = readClassStart({ date: date('2030-03-31'), startTime: time('18:30') }, 'Not/AZone');
    expect(reading.fault).toBe('timezone');
    expect(reading.instant.toISOString()).toBe('2030-03-31T18:30:00.000Z');
    if (reading.fault === 'timezone') expect(reading.error).toBeInstanceOf(Error);
    expectNothingLogged();
  });

  it('logs nothing on a readable entry', () => {
    vi.clearAllMocks();
    readClassStart({ date: date('2030-03-31'), startTime: time('18:30') }, 'Europe/Amsterdam');
    expectNothingLogged();
  });
});
