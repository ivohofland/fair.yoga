import type { Prisma } from '@prisma/client';
import type { RoomResult } from '@/lib/room-search';

/**
 * A room's shared projection: its public identity (`RoomResult`) plus
 * `equipment`. It leaves out `notes` and `createdById`, which are the creating
 * teacher's own.
 */
export interface SharedRoom extends RoomResult {
  equipment: Prisma.JsonValue;
}

/**
 * The columns of `SharedRoom`, for a Prisma `select`.
 *
 * `satisfies Record<keyof SharedRoom, true>` refuses a key `SharedRoom` does
 * not name. Pass this object to `select` as is: spreading extra columns in
 * beside it at the call site escapes the check.
 */
export const SHARED_ROOM_SELECT = {
  id: true,
  venueName: true,
  roomName: true,
  address: true,
  city: true,
  postcode: true,
  floor: true,
  maxCapacity: true,
  equipment: true,
} satisfies Record<keyof SharedRoom, true>;
