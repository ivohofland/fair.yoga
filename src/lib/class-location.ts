import type { ClassFormat, Prisma } from '@/lib/prisma-client';
import { formatRoomLocation } from '@/lib/format';

/**
 * Where a class or template happens, as its readers see it (#911):
 * `classLocation` carries the link, `publicClassLocation` cannot. Client-safe:
 * the Prisma imports are types only.
 */

/** The two room fields a location label is built from. */
export type RoomPlace = { roomName: string; venueName: string };

export type ClassLocation =
  | { format: 'in_person'; room: RoomPlace; roomArchived: boolean }
  | { format: 'online'; videoUrl: string | null };

/**
 * A location that cannot hold the link. `videoUrl?: never` rather than leaving
 * the member out: structural typing lets an object with an extra member
 * through, so without it a `ClassLocation` would be assignable here and its
 * link would ride along.
 */
export type PublicClassLocation =
  | { format: 'in_person'; room: RoomPlace }
  | { format: 'online'; videoUrl?: never };

/** The label of the button that opens an online class's link, in the app and in email. */
export const JOIN_CLASS_LABEL = 'Join the class';

/** What a booked student reads where the link will be, while the class has none. */
export const VIDEO_LINK_PENDING_COPY = 'Your teacher will share the video link before class.';

/** Appended to a teacher's class reminder for an online class with no link. */
export const TEACHER_REMINDER_NO_LINK_COPY = ' No video link yet — add one so your students can join.';

/** Whether a class is online and has no link yet. */
export function isVideoLinkPending(row: { format: ClassFormat; videoUrl: string | null }): boolean {
  return row.format === 'online' && row.videoUrl === null;
}

/**
 * The pending sentence, with its leading space, for a notification body about
 * a class of this shape; empty unless `isVideoLinkPending`.
 */
export function videoLinkPendingSuffix(row: { format: ClassFormat; videoUrl: string | null }): string {
  return isVideoLinkPending(row) ? ` ${VIDEO_LINK_PENDING_COPY}` : '';
}

/** The columns `classLocation` reads, from a `Class` or a `ClassTemplate`. */
export type LocationRow = {
  /** Named in a thrown message when the row is malformed; callers that select it get it there. */
  id?: string;
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

/** The row's id for an error message, or nothing when the caller did not select it. */
function rowRef(row: { id?: string }): string {
  return row.id === undefined ? '' : ` (row ${row.id})`;
}

/**
 * Throws on a row `Class_format_shape` / `ClassTemplate_format_shape` would
 * refuse: such a row cannot be stored, so reading one means the caller built
 * it by hand wrongly.
 */
export function classLocation(row: LocationRow): ClassLocation {
  switch (row.format) {
    case 'in_person':
      if (row.teacherRoom === null) throw new Error(`An in-person class row has no room${rowRef(row)}.`);
      return {
        format: 'in_person',
        room: { roomName: row.teacherRoom.room.roomName, venueName: row.teacherRoom.room.venueName },
        roomArchived: row.teacherRoom.isArchived,
      };
    case 'online':
      if (row.teacherRoom !== null) throw new Error(`An online class row holds a room${rowRef(row)}.`);
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
      if (row.teacherRoom === null) throw new Error(`An in-person class row has no room${rowRef(row)}.`);
      return {
        format: 'in_person',
        room: { roomName: row.teacherRoom.room.roomName, venueName: row.teacherRoom.room.venueName },
      };
    case 'online':
      if (row.teacherRoom !== null) throw new Error(`An online class row holds a room${rowRef(row)}.`);
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

/** The sentence each format-shape rule answers with. */
export const FORMAT_SHAPE_MESSAGES = {
  videoUrlInPerson: 'Only an online class has a video link.',
  roomOnline: 'An online class has no room.',
  roomCostOnline: 'An online class has no room cost.',
  noRoomInPerson: 'Choose the room this class is held in.',
} as const;

/** The columns `ClassTemplate_format_shape` / `Class_format_shape` tie to the format. */
export type FormatShapeRow = {
  format: ClassFormat;
  teacherRoomId: string | null;
  roomCost: number;
  videoUrl: string | null;
};

export type FormatShapeViolation = {
  path: 'teacherRoomId' | 'roomCost' | 'videoUrl';
  message: string;
};

/**
 * Every rule of the format shape `row` breaks; empty when it breaks none. In
 * a room: a room and no link. Online: no room and a room cost of 0. Run on a
 * merged row before a write, so a contradiction answers a field error rather
 * than reaching the database's CHECK.
 */
export function formatShapeViolations(row: FormatShapeRow): readonly FormatShapeViolation[] {
  const out: FormatShapeViolation[] = [];
  switch (row.format) {
    case 'in_person':
      if (row.teacherRoomId === null) out.push({ path: 'teacherRoomId', message: FORMAT_SHAPE_MESSAGES.noRoomInPerson });
      if (row.videoUrl !== null) out.push({ path: 'videoUrl', message: FORMAT_SHAPE_MESSAGES.videoUrlInPerson });
      return out;
    case 'online':
      if (row.teacherRoomId !== null) out.push({ path: 'teacherRoomId', message: FORMAT_SHAPE_MESSAGES.roomOnline });
      if (row.roomCost !== 0) out.push({ path: 'roomCost', message: FORMAT_SHAPE_MESSAGES.roomCostOnline });
      return out;
    default: {
      const unreachable: never = row.format;
      throw new Error(`Unknown class format: ${String(unreachable)}`);
    }
  }
}

/** The `path: message` list `parseBody` builds from Zod issues. */
export function formatShapeMessage(vs: readonly FormatShapeViolation[]): string {
  return vs.map((v) => `${v.path}: ${v.message}`).join(', ');
}
