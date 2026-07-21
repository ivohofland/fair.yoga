import { describe, it, expect, vi, afterEach } from 'vitest';
import { classStartInstant } from './timezone';
import { log } from '@/lib/log';

// Class rows store a calendar date (UTC midnight) + HH:mm wall-clock startTime.
// classStartInstant interprets that wall clock in the teacher's timezone.
describe('classStartInstant', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('converts Amsterdam summer time (CEST, +2) to UTC', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-20T16:00:00.000Z');
  });

  it('converts Amsterdam winter time (CET, +1) to UTC', () => {
    const start = classStartInstant(day('2026-01-20'), '18:00', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-01-20T17:00:00.000Z');
  });

  it('handles zones behind UTC', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'America/New_York');
    expect(start.toISOString()).toBe('2026-07-20T22:00:00.000Z');
  });

  it('an early-morning class can start on the previous UTC day', () => {
    const start = classStartInstant(day('2026-07-20'), '00:30', 'Europe/Amsterdam');
    expect(start.toISOString()).toBe('2026-07-19T22:30:00.000Z');
  });

  it('UTC zone is the identity', () => {
    const start = classStartInstant(day('2026-07-20'), '09:15', 'UTC');
    expect(start.toISOString()).toBe('2026-07-20T09:15:00.000Z');
  });

  it('resolves a time on the EU spring-forward day (02:30 does not exist)', () => {
    // 2026-03-29 02:00 CET jumps to 03:00 CEST. The helper must return a
    // deterministic instant on the right day, not NaN.
    const start = classStartInstant(day('2026-03-29'), '02:30', 'Europe/Amsterdam');
    expect(Number.isNaN(start.getTime())).toBe(false);
    // Either interpretation (+1 → 01:30Z, +2 → 00:30Z) is acceptable.
    const iso = start.toISOString();
    expect(['2026-03-29T00:30:00.000Z', '2026-03-29T01:30:00.000Z']).toContain(iso);
  });

  it('falls back to UTC interpretation for an unknown timezone', () => {
    const start = classStartInstant(day('2026-07-20'), '18:00', 'Not/AZone');
    expect(start.toISOString()).toBe('2026-07-20T18:00:00.000Z');
  });

  it('warns when falling back to UTC so the bad zone is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    classStartInstant(day('2026-07-20'), '18:00', 'Not/AZone');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });
});
