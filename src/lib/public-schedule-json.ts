import type { PublicScheduleEntry } from '@/services/public-schedule';
import { formatRoomLocation } from '@/lib/format';
import { formatIsoWithOffset } from '@/lib/timezone';

/**
 * The v1 public schedule. Fields are permanent: additions are fine, removals
 * and renames are not (`docs/technical-architecture.md`, Public API (v1)).
 */
export type PublicScheduleJson = {
  timezone: string;
  classes: {
    id: string;
    kind: 'class' | 'studio';
    start: string;
    durationMinutes: number;
    classType: string;
    location: { format: 'in_person' | 'online'; name: string | null };
    availability: 'open' | 'waitlist' | null;
    pricing: 'tiered' | 'donation' | null;
    bookingUrl: string | null;
  }[];
};

export function toPublicScheduleJson(
  entries: PublicScheduleEntry[],
  teacher: { pageSlug: string; timeZone: string },
  origin: string,
): PublicScheduleJson {
  return {
    timezone: teacher.timeZone,
    classes: entries.map((e) => {
      const base = {
        id: e.id,
        kind: e.kind,
        start: formatIsoWithOffset(e.start, teacher.timeZone),
        durationMinutes: e.durationMinutes,
        classType: e.classType,
      };
      if (e.kind === 'studio') {
        return {
          ...base,
          location: { format: 'in_person' as const, name: e.location },
          availability: null,
          pricing: null,
          bookingUrl: e.bookingUrl,
        };
      }
      return {
        ...base,
        location:
          e.location.format === 'online'
            ? { format: 'online' as const, name: null }
            : {
                format: 'in_person' as const,
                name: formatRoomLocation(e.location.room.roomName, e.location.room.venueName),
              },
        availability: e.availability,
        pricing: e.pricingMode,
        bookingUrl: `${origin}/${teacher.pageSlug}/book/${e.id}`,
      };
    }),
  };
}
