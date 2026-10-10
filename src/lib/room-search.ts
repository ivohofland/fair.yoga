/**
 * Client for the shared-room lookups behind `GET /api/rooms`; the server's
 * matching rules live on the route and on `searchSharedRoomsByCity`.
 *
 * `searchPublicRooms` finds neighbours of one known address for a human to
 * judge; it is NOT the question `Room_public_identity_unique` answers — see
 * `src/lib/room-identity.ts`. `searchRoomsByCity` browses by city.
 */
import { logRequestFailure } from './client-errors';
import type { RoomIdentity } from '@/lib/room-identity';

/**
 * A shared room as the search returns it: its identity, plus the context a
 * human needs to judge whether it is the same physical room.
 *
 * `extends RoomIdentity` declares the subset relation that
 * `findIdentityMatch<T extends RoomIdentity>` relies on, so it lives in the
 * type rather than at a call site.
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

/** The most rooms one city search returns. */
export const ROOM_CITY_SEARCH_LIMIT = 50;

/** What `GET /api/rooms?city=` answers with. */
export interface RoomCitySearchResult {
  rooms: RoomResult[];
  /** True when more rooms matched than `ROOM_CITY_SEARCH_LIMIT`. */
  truncated: boolean;
}

/**
 * A result, or which way it failed — never a throw.
 *
 * `reason` exists because a refused request and an unreachable server are
 * different problems for the teacher, so the type says which one happened.
 * Returning the distinction instead of throwing it means a caller cannot
 * collapse the two by accident — it has to read `reason` to compile.
 *
 * The same principle for a write, with the cost it exacted there, is in the
 * `undo` function in `src/lib/use-payment-actions.ts`.
 */
export type RoomSearchOutcome =
  | { ok: true; rooms: RoomResult[] }
  | { ok: false; reason: 'http' | 'network' };

/** `RoomSearchOutcome`'s counterpart for the city search. */
export type RoomCitySearchOutcome =
  | ({ ok: true } & RoomCitySearchResult)
  | { ok: false; reason: 'http' | 'network' };

/**
 * Deliberately shallow: checks only `id` and the address/floor/room-name
 * fields, not every `RoomResult` field. A deeper check would duplicate
 * `RoomResult` in a second place that could drift from it.
 */
function isRoomResult(room: unknown): room is RoomResult {
  if (typeof room !== 'object' || room === null) return false;
  const r = room as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.address === 'string'
    && typeof r.floor === 'string'
    && typeof r.roomName === 'string';
}

/**
 * `res.json()` is `any`, so annotating its result is a cast, not a check —
 * and this module's whole contract is that it returns a value instead of
 * throwing. Without this, a 200 whose body has no `data` array yields
 * `rooms: undefined` typed as `RoomResult[]`, and the throw reappears in the
 * *render* path of whoever consumes the result, where nothing catches it.
 *
 * The precedent this module cites for returning rather than throwing (the
 * `undo` function's `readUndoStatus` call in `src/lib/use-payment-actions.ts`)
 * also validates rather than asserts — see its definition in
 * `src/lib/payment-status.ts`. This is the other half of it.
 */
function readRoomResults(body: unknown): RoomResult[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  return data.every(isRoomResult) ? data : null;
}

/** The city search's body: `data` is `{ rooms, truncated }`, not a bare array. */
function readRoomCitySearch(body: unknown): RoomCitySearchResult | null {
  if (typeof body !== 'object' || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const { rooms, truncated } = data as { rooms?: unknown; truncated?: unknown };
  if (!Array.isArray(rooms) || !rooms.every(isRoomResult)) return null;
  if (typeof truncated !== 'boolean') return null;
  return { rooms, truncated };
}

/**
 * Send a room-search request, then hand back the parsed body or which way it
 * failed. `logTag` prefixes the `logRequestFailure` tags so
 * each search keeps its own.
 */
async function fetchRoomSearch(
  params: URLSearchParams,
  logTag: string,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: 'http' | 'network' }> {
  // Only the request itself is wrapped, so 'network' means exactly that.
  let res: Response;
  try {
    res = await fetch(`/api/rooms?${params}`);
  } catch (err) {
    logRequestFailure(`${logTag}-request`, {}, err);
    return { ok: false, reason: 'network' };
  }

  if (!res.ok) return { ok: false, reason: 'http' };

  // An `ok` response whose body will not parse — a proxy error page, a
  // truncation — is not the server refusing us. It is reported as 'network':
  // the honest description of a reply that did not arrive intact, and because
  // this is a read, nothing was written, so retrying is always safe.
  try {
    return { ok: true, body: await res.json() };
  } catch (err) {
    logRequestFailure(`${logTag}-body`, {}, err);
    return { ok: false, reason: 'network' };
  }
}

export async function searchPublicRooms(
  postcode: string,
  street: string,
): Promise<RoomSearchOutcome> {
  const params = new URLSearchParams({ postcode: postcode.trim(), street: street.trim() });
  const fetched = await fetchRoomSearch(params, 'room-search');
  if (!fetched.ok) return fetched;

  const rooms = readRoomResults(fetched.body);
  // A body of the wrong shape is a reply that did not arrive intact too.
  if (rooms === null) return { ok: false, reason: 'network' };
  return { ok: true, rooms };
}

/** `GET /api/rooms?city=`: shared rooms in a city, optionally narrowed by `q`. */
export async function searchRoomsByCity(city: string, q: string): Promise<RoomCitySearchOutcome> {
  const params = new URLSearchParams({ city: city.trim() });
  if (q.trim()) params.set('q', q.trim());
  const fetched = await fetchRoomSearch(params, 'room-city-search');
  if (!fetched.ok) return fetched;

  const result = readRoomCitySearch(fetched.body);
  if (result === null) return { ok: false, reason: 'network' };
  return { ok: true, ...result };
}
