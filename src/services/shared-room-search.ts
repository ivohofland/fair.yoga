import type { PrismaClient } from '@prisma/client';
import { ROOM_SEARCH_SELECT } from '@/lib/room-projection';
import { ROOM_CITY_SEARCH_LIMIT, type RoomCitySearchResult, type RoomResult } from '@/lib/room-search';

/** Escapes LIKE's metacharacters so user input matches literally (`\` is LIKE's default escape). */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Shared rooms in a city, for a teacher browsing before contributing a room.
 *
 * City is a prefix match and `q` a substring match on address or venue, both
 * folded by `lower(unaccent(...))`. Prisma's `where` cannot call `unaccent`,
 * so the raw query returns ids only and the rows are loaded through
 * `ROOM_SEARCH_SELECT` — the projection that keeps other teachers' private
 * columns off the wire. The `::text` casts are required: an untyped
 * parameter leaves `unaccent(unknown)` unresolved.
 */
export async function searchSharedRoomsByCity(
  db: PrismaClient,
  input: { city: string; q?: string },
): Promise<RoomCitySearchResult> {
  const cityPrefix = `${escapeLike(input.city.trim())}%`;
  const q = input.q?.trim() ?? '';
  const qPattern = `%${escapeLike(q)}%`;

  const hits = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Room"
     WHERE "isPublic" = true
       AND lower(unaccent("city")) LIKE lower(unaccent(${cityPrefix}::text))
       AND (${q}::text = ''
            OR lower(unaccent("address")) LIKE lower(unaccent(${qPattern}::text))
            OR lower(unaccent("venueName")) LIKE lower(unaccent(${qPattern}::text)))
     ORDER BY lower(unaccent("venueName")), "id"
     LIMIT ${ROOM_CITY_SEARCH_LIMIT + 1}`;

  const truncated = hits.length > ROOM_CITY_SEARCH_LIMIT;
  const ids = hits.slice(0, ROOM_CITY_SEARCH_LIMIT).map((h) => h.id);
  const rows: RoomResult[] = await db.room.findMany({
    where: { id: { in: ids } },
    select: ROOM_SEARCH_SELECT,
  });
  // `in` does not preserve order; restore the raw query's.
  const position = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return { rooms: rows, truncated };
}
