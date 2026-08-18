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

/**
 * A result, or which way it failed — never a throw.
 *
 * `reason` exists because a refused request and an unreachable server are
 * different problems for the teacher, and both callers have to say which one
 * happened. An earlier version of this module threw on `!res.ok`; every
 * caller then had one `catch`, and a 400 or a 500 was reported as a network
 * failure. Returning the distinction instead of throwing it means a caller
 * cannot collapse the two by accident — it has to read `reason` to compile.
 *
 * The same principle for a write, with the cost it exacted there, is at
 * src/lib/use-payment-actions.ts:51.
 */
export type RoomSearchOutcome =
  | { ok: true; rooms: RoomResult[] }
  | { ok: false; reason: 'http' | 'network' };

export async function searchPublicRooms(
  postcode: string,
  street: string,
): Promise<RoomSearchOutcome> {
  const params = new URLSearchParams({ postcode: postcode.trim(), street: street.trim() });

  // Only the request itself is wrapped, so 'network' means exactly that.
  let res: Response;
  try {
    res = await fetch(`/api/rooms?${params}`);
  } catch {
    return { ok: false, reason: 'network' };
  }

  if (!res.ok) return { ok: false, reason: 'http' };

  try {
    const json: { data: RoomResult[] } = await res.json();
    return { ok: true, rooms: json.data };
  } catch {
    // An `ok` response whose body will not parse — a proxy error page, a
    // truncation — is not the server refusing us. It is reported as
    // 'network' because that is the honest description of a reply that did
    // not arrive intact, and because this is a read: nothing was written,
    // so retrying is always safe.
    return { ok: false, reason: 'network' };
  }
}
