/**
 * The shared-room lookup both sharing paths run before contributing a room.
 *
 * Deliberately fuzzy: `GET /api/rooms` matches `postcode` and `address` with
 * `contains` + `mode: 'insensitive'`, and returns shared rooms only. That is
 * NOT the same question `Room_public_identity_unique` answers — see
 * `src/lib/room-identity.ts`. This one finds neighbours for a human to judge;
 * that one decides whether the database will accept the write.
 */
export interface RoomResult {
  id: string;
  venueName: string;
  roomName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  maxCapacity: number;
}

export async function searchPublicRooms(
  postcode: string,
  street: string,
): Promise<RoomResult[]> {
  const params = new URLSearchParams({ postcode: postcode.trim(), street: street.trim() });
  const res = await fetch(`/api/rooms?${params}`);
  if (!res.ok) throw new Error('Room search failed');
  const json: { data: RoomResult[] } = await res.json();
  return json.data;
}
