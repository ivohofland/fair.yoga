import type { ClassFormat, Prisma } from '@/lib/prisma-client';
import { formatRoomLocation } from '@/lib/format';

/**
 * Where a class or template happens, as its readers see it (#911). A row is
 * read through `classLocation` (teacher-side and registered-student surfaces)
 * or `publicClassLocation` (everything else), never by dereferencing
 * `teacherRoom` directly. Client-safe: the Prisma imports are types only.
 */

/** The two room fields a location label is built from. */
export type RoomPlace = { roomName: string; venueName: string };

export type ClassLocation =
  | { format: 'in_person'; room: RoomPlace; roomArchived: boolean }
  | { format: 'online'; videoUrl: string | null };

/**
 * A location with no `videoUrl` member at all. Public and pre-booking pages
 * accept only this, so handing them the link is a compile error.
 */
export type PublicClassLocation =
  | { format: 'in_person'; room: RoomPlace }
  | { format: 'online' };

/** The columns `classLocation` reads, from a `Class` or a `ClassTemplate`. */
export type LocationRow = {
  format: ClassFormat;
  videoUrl: string | null;
  teacherRoom: { isArchived: boolean; room: RoomPlace } | null;
};

/**
 * What `publicClassLocation` reads: a `LocationRow` with no link, so a public
 * page can leave `videoUrl` out of its query altogether (`omit`).
 */
export type PublicLocationRow = Omit<LocationRow, 'videoUrl'>;

/** `LocationRow`'s columns, for a Prisma `select` on either model. */
export const classLocationSelect = {
  format: true,
  videoUrl: true,
  teacherRoom: {
    select: { isArchived: true, room: { select: { roomName: true, venueName: true } } },
  },
} as const satisfies Prisma.ClassSelect & Prisma.ClassTemplateSelect;

/**
 * Throws on a row `Class_format_shape` / `ClassTemplate_format_shape` would
 * refuse: such a row cannot be stored, so reading one means the caller built
 * it by hand wrongly.
 */
export function classLocation(row: LocationRow): ClassLocation {
  switch (row.format) {
    case 'in_person':
      if (row.teacherRoom === null) throw new Error('An in-person class row has no room.');
      return {
        format: 'in_person',
        room: { roomName: row.teacherRoom.room.roomName, venueName: row.teacherRoom.room.venueName },
        roomArchived: row.teacherRoom.isArchived,
      };
    case 'online':
      if (row.teacherRoom !== null) throw new Error('An online class row holds a room.');
      return { format: 'online', videoUrl: row.videoUrl };
    default: {
      const unreachable: never = row.format;
      throw new Error(`Unknown class format: ${String(unreachable)}`);
    }
  }
}

/** The location without the link; never reads `videoUrl`. */
export function publicClassLocation(row: PublicLocationRow): PublicClassLocation {
  switch (row.format) {
    case 'in_person':
      if (row.teacherRoom === null) throw new Error('An in-person class row has no room.');
      return {
        format: 'in_person',
        room: { roomName: row.teacherRoom.room.roomName, venueName: row.teacherRoom.room.venueName },
      };
    case 'online':
      if (row.teacherRoom !== null) throw new Error('An online class row holds a room.');
      return { format: 'online' };
    default: {
      const unreachable: never = row.format;
      throw new Error(`Unknown class format: ${String(unreachable)}`);
    }
  }
}

export function locationLabel(loc: ClassLocation | PublicClassLocation): string {
  switch (loc.format) {
    case 'in_person':
      return formatRoomLocation(loc.room.roomName, loc.room.venueName);
    case 'online':
      return 'Online';
    default: {
      const unreachable: never = loc;
      throw new Error(`Unknown class format: ${JSON.stringify(unreachable)}`);
    }
  }
}
