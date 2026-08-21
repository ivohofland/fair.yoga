import { describe, it, expect } from 'vitest';
import { studioClassDeletability } from './studio-class-deletion';

const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** A `@db.Date` value — midnight UTC of the calendar date, as Prisma returns one. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('studioClassDeletability', () => {
  // 2026-06-15T12:00Z is 14:00 in Amsterdam and 08:00 in New York.
  const now = new Date('2026-06-15T12:00:00.000Z');

  describe('the matrix', () => {
    it('allows a manual class that has not started', () => {
      expect(
        studioClassDeletability(
          { templateId: null, date: d('2026-06-20'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('allows a manual class that has started', () => {
      expect(
        studioClassDeletability(
          { templateId: null, date: d('2026-06-10'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('refuses a generated class that has not started, because the sweep would create it again', () => {
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-20'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows a generated class that has started, because it is no longer a candidate', () => {
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-10'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * BOTH DIRECTIONS, DELIBERATELY. A single zone proves nothing: run only the
   * east-of-UTC case and a UTC-naive implementation still fails it, but run
   * only a case where local and UTC agree and every implementation passes.
   * `prisma/seed.ts:622-625` records that exact failure for the class family.
   */
  describe('the zone decides, not UTC', () => {
    it('east of UTC: a 09:00 Amsterdam class has started by 08:00 UTC', () => {
      // Starts 07:00Z. A UTC-naive reading compares 09:00Z > 08:00Z and refuses.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
          new Date('2026-06-15T08:00:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('west of UTC: a 09:00 New York class has not started by 12:00 UTC', () => {
      // Starts 13:00Z. A UTC-naive reading compares 09:00Z <= 12:00Z and allows.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
          new Date('2026-06-15T12:00:00.000Z'),
          NYC,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });
  });

  it('treats the start instant itself as started', () => {
    // The boundary is `<=`. Exactly 09:00 Amsterdam on 2026-06-15 is 07:00Z.
    expect(
      studioClassDeletability(
        { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
        new Date('2026-06-15T07:00:00.000Z'),
        AMS,
      ),
    ).toEqual({ deletable: true });
  });
});
