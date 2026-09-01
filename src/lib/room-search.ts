/**
 * The shared-room lookup the two room flows run before contributing a room.
 *
 * Deliberately fuzzy: `GET /api/rooms` matches `postcode` and `address` with
 * `contains` + `mode: 'insensitive'`, and returns shared rooms only. That is
 * NOT the same question `Room_public_identity_unique` answers — see
 * `src/lib/room-identity.ts`. This one finds neighbours for a human to judge;
 * that one decides whether the database will accept the write.
 */
import type { RoomIdentity } from '@/lib/room-identity';

/**
 * A shared room as the search returns it: its identity, plus the context a
 * human needs to judge whether it is the same physical room.
 *
 * `extends RoomIdentity` declares the subset relation instead of leaving it
 * to coincide. It was already enforced, but only by `findIdentityMatch<T
 * extends RoomIdentity>` at one call site in `share-room-button.tsx` — so the
 * relation lived in the line that calls the function, not in either
 * declaration, and #259 is scheduled to rewrite exactly that line.
 *
 * `import type` only: this module is value-imported by `'use client'`
 * components, and `room-identity.ts` is import-free for the same reason.
 */
export interface RoomResult extends RoomIdentity {
  id: string;
  venueName: string;
  city: string;
  postcode: string;
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
 * The same principle for a write, with the cost it exacted there, is in the
 * `undo` function in `src/lib/use-payment-actions.ts`.
 */
export type RoomSearchOutcome =
  | { ok: true; rooms: RoomResult[] }
  | { ok: false; reason: 'http' | 'network' };

/**
 * `res.json()` is `any`, so annotating its result is a cast, not a check —
 * and this module's whole contract is that it returns a value instead of
 * throwing. Without this, a 200 whose body has no `data` array yields
 * `rooms: undefined` typed as `RoomResult[]`, and the throw reappears in the
 * *render* path of both callers, where nothing catches it.
 *
 * The precedent this module cites for returning rather than throwing (the
 * `undo` function's `readUndoStatus` call in `src/lib/use-payment-actions.ts`)
 * also validates rather than asserts — see its definition in
 * `src/lib/payment-status.ts`. This is the other half of it.
 *
 * Deliberately shallow: it checks the shape the callers actually consume —
 * an array whose entries carry the identity fields — not every field. A
 * deeper check would duplicate `RoomResult` in a second place that could
 * drift from it.
 */
function readRoomResults(body: unknown): RoomResult[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ok = data.every((room) => {
    if (typeof room !== 'object' || room === null) return false;
    const r = room as Record<string, unknown>;
    return typeof r.id === 'string'
      && typeof r.address === 'string'
      && typeof r.floor === 'string'
      && typeof r.roomName === 'string';
  });
  return ok ? (data as RoomResult[]) : null;
}

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

  // An `ok` response whose body will not parse or does not carry the shape
  // we asked for — a proxy error page, a truncation — is not the server
  // refusing us. Both are reported as 'network': it is the honest description
  // of a reply that did not arrive intact, and because this is a read,
  // nothing was written, so retrying is always safe.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'network' };
  }

  const rooms = readRoomResults(body);
  if (rooms === null) return { ok: false, reason: 'network' };
  return { ok: true, rooms };
}
