import type { Prisma } from '@prisma/client';
import type { RoomResult } from '@/lib/room-search';

/**
 * A room as any API read answers it: the shared search result plus its
 * `equipment`. Everything else on the row (`notes`, `createdById`, timestamps)
 * belongs to the teacher who wrote the room and is not part of what a shared
 * room is.
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
