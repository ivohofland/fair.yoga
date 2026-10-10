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

/**
 * The columns a shared-room search returns: exactly `RoomResult`'s keys.
 *
 * `satisfies Record<keyof RoomResult, true>` refuses a key `RoomResult` does
 * not name, and that is what keeps other teachers' `createdById`, `notes` and
 * timestamps out of the browser. A `RoomResult` annotation on the query result
 * cannot: a query result is not a fresh literal, so it gets no
 * excess-property check; what it adds is refusing a column whose type no
 * longer matches. Pass this object to `select` as is — spreading extra
 * columns in beside it escapes both.
 */
export const ROOM_SEARCH_SELECT = {
  id: true,
  venueName: true,
  roomName: true,
  address: true,
  city: true,
  postcode: true,
  floor: true,
  maxCapacity: true,
} satisfies Record<keyof RoomResult, true>;
