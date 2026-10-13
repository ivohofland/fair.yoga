import { describe, it, expect } from 'vitest';
import type { ClassTemplate } from '@prisma/client';
import { cancelCheckInstant } from '@/lib/auto-cancel-check';
import { hhmmToTime } from '@/lib/time-of-day';
import { CLASS_GENERATOR } from './class-generator';
import { STUDIO_GENERATOR } from './studio-class-generator';

/**
 * The descriptor half of #859: which family has a check the sweep may decline
 * past, and where its edge sits. Pure — no row is read or written.
 */
describe('GeneratorFamily.pastCancelCheck (#859)', () => {
  const timeZone = 'Europe/Amsterdam';
  // A CET date, so the zone moves the instant: 10:00 local is 09:00Z.
  const entry = { date: new Date('2026-11-02T00:00:00Z'), startTime: hhmmToTime('10:00') };
  const template = { autoCancelCheck: 'HOURS_2' } as ClassTemplate;

  it("is true from the class family's check instant, and false 1 ms before it", () => {
    const check = cancelCheckInstant(entry, 'HOURS_2', timeZone);
    expect(check.toISOString()).toBe('2026-11-02T07:00:00.000Z');

    const past = CLASS_GENERATOR.pastCancelCheck;
    if (past === null) throw new Error('the class family has a check');
    expect(past(template, entry, timeZone, check)).toBe(true);
    expect(past(template, entry, timeZone, new Date(check.getTime() - 1))).toBe(false);
  });

  it('is null for the studio family, which has no check', () => {
    expect(STUDIO_GENERATOR.pastCancelCheck).toBeNull();
  });
});
