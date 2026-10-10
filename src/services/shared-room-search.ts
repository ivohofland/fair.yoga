import type { PrismaClient } from '@prisma/client';
import { ROOM_SEARCH_SELECT } from '@/lib/room-projection';
import { ROOM_CITY_SEARCH_LIMIT, type RoomCitySearchResult, type RoomResult } from '@/lib/room-search';

/**
 * Shared rooms in a city, optionally narrowed by `q`.
 *
 * City is a prefix match and `q` a substring match on address or venue, both
 * folded by `lower(unaccent(...))`. Prisma's `where` cannot call `unaccent`,
 * so the raw query returns ids only and the rows are loaded through
 * `ROOM_SEARCH_SELECT`, so the returned columns are exactly `RoomResult`'s.
 */
export async function searchSharedRoomsByCity(
  db: PrismaClient,
  input: { city: string; q?: string },
): Promise<RoomCitySearchResult> {
  const city = input.city.trim();
  const q = input.q?.trim() ?? '';

  // The `::text` casts are required: an untyped parameter leaves
  // `unaccent(unknown)` unresolved. LIKE metacharacters are escaped in SQL,
  // after folding (backslash first): `unaccent` can itself produce a backslash
  // (U+2216 folds to one), so escaping the input before folding would let it
  // through as LIKE's escape character.
  const hits = await db.$queryRaw<{ id: string }[]>`
    SELECT r."id" FROM "Room" r,
      LATERAL (SELECT
        replace(replace(replace(lower(unaccent(${city}::text)), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' AS "cityPrefix",
        '%' || replace(replace(replace(lower(unaccent(${q}::text)), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' AS "qPattern"
      ) p
     WHERE r."isPublic" = true
       AND lower(unaccent(r."city")) LIKE p."cityPrefix"
       AND (${q}::text = ''
            OR lower(unaccent(r."address")) LIKE p."qPattern"
            OR lower(unaccent(r."venueName")) LIKE p."qPattern")
     ORDER BY lower(unaccent(r."venueName")), r."id"
     LIMIT ${ROOM_CITY_SEARCH_LIMIT + 1}`;

  const truncated = hits.length > ROOM_CITY_SEARCH_LIMIT;
  const ids = hits.slice(0, ROOM_CITY_SEARCH_LIMIT).map((h) => h.id);
  const rows: RoomResult[] = await db.room.findMany({
    where: { id: { in: ids }, isPublic: true },
    select: ROOM_SEARCH_SELECT,
  });
  // `in` does not preserve order; restore the raw query's.
  const position = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return { rooms: rows, truncated };
}
