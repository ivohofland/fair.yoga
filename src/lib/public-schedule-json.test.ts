import { describe, it, expect } from 'vitest';
import type { PublicClassEntry, PublicStudioEntry } from '@/services/public-schedule';
import { toPublicScheduleJson } from './public-schedule-json';

const ORIGIN = 'https://fair.yoga';

function cls(overrides: Partial<PublicClassEntry> = {}): PublicClassEntry {
  return {
    kind: 'class',
    id: 'c1',
    calendarEntryId: 'e1',
    updatedAt: new Date(0),
    date: new Date('2026-11-02T00:00:00Z'),
    startTime: new Date('1970-01-01T19:00:00Z'),
    start: new Date('2026-11-03T00:00:00Z'),
    durationMinutes: 60,
    classType: 'Vinyasa',
    location: { format: 'in_person', room: { roomName: 'Studio 2', venueName: 'De Pijp' } },
    pricingMode: 'tiered',
    availability: 'open',
    cancelled: false,
    economics: {
      roomCost: 10, minRate: 1, targetRate: 2, minStudents: 1, maxStudents: 5, vatPercent: 0,
      currency: 'EUR', registrations: [],
    },
    ...overrides,
  };
}

function studio(overrides: Partial<PublicStudioEntry> = {}): PublicStudioEntry {
  return {
    kind: 'studio', id: 's1', calendarEntryId: 'e2', updatedAt: new Date(0),
    date: new Date('2026-11-02T00:00:00Z'), startTime: new Date('1970-01-01T10:00:00Z'),
    start: new Date('2026-11-02T09:00:00Z'), durationMinutes: 45, classType: 'Hatha',
    location: 'The Loft', bookingUrl: null, cancelled: false,
    ...overrides,
  };
}

const teacher = { pageSlug: 'anna', timeZone: 'America/New_York' };

describe('toPublicScheduleJson', () => {
  it('carries exactly the permanent keys of a class', () => {
    const out = toPublicScheduleJson([cls()], teacher, ORIGIN);
    expect(out.timezone).toBe('America/New_York');
    expect(Object.keys(out.classes[0]!).sort()).toEqual([
      'availability', 'bookingUrl', 'classType', 'durationMinutes', 'id', 'kind', 'location', 'pricing', 'start',
    ]);
    const text = JSON.stringify(out);
    for (const banned of ['videoUrl', '"price"', 'amount', 'spotsLeft', '"teacher"']) {
      expect(text).not.toContain(banned);
    }
  });

  it('writes the start with the teacher offset on either side of a DST change', () => {
    const winter = cls({ start: new Date('2026-11-03T00:00:00Z') });
    const summer = cls({ start: new Date('2026-10-30T23:00:00Z') });
    const out = toPublicScheduleJson([winter, summer], teacher, ORIGIN);
    expect(out.classes[0]!.start).toBe('2026-11-02T19:00:00-05:00');
    expect(out.classes[1]!.start).toBe('2026-10-30T19:00:00-04:00');
  });

  it('builds a class booking URL from the current slug', () => {
    const entries = [cls()];
    expect(toPublicScheduleJson(entries, teacher, ORIGIN).classes[0]!.bookingUrl).toBe('https://fair.yoga/anna/book/c1');
    expect(toPublicScheduleJson(entries, { ...teacher, pageSlug: 'anna-new' }, ORIGIN).classes[0]!.bookingUrl)
      .toBe('https://fair.yoga/anna-new/book/c1');
  });

  it('names an in-person place and gives an online class no name', () => {
    const out = toPublicScheduleJson(
      [cls(), cls({ id: 'c2', location: { format: 'online' } })],
      teacher,
      ORIGIN,
    );
    expect(out.classes[0]!.location).toEqual({ format: 'in_person', name: 'Studio 2 at De Pijp' });
    expect(out.classes[1]!.location).toEqual({ format: 'online', name: null });
  });

  it('maps pricing and leaves studio availability and pricing null', () => {
    const out = toPublicScheduleJson(
      [cls({ pricingMode: 'donation', availability: 'waitlist' }), studio(), studio({ id: 's2', bookingUrl: 'https://x.test/b' })],
      teacher,
      ORIGIN,
    );
    expect(out.classes[0]).toMatchObject({ pricing: 'donation', availability: 'waitlist' });
    expect(out.classes[1]).toMatchObject({
      kind: 'studio', availability: null, pricing: null, bookingUrl: null,
      location: { format: 'in_person', name: 'The Loft' },
    });
    expect(out.classes[2]!.bookingUrl).toBe('https://x.test/b');
  });
});
