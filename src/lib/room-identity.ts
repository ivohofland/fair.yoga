/**
 * The identity a shared room occupies in the commons.
 *
 * This mirrors `Room_public_identity_unique`, declared in
 * `prisma/migrations/20260921183434_room_identity_case_whitespace_indexes/migration.sql`:
 *
 *     CREATE UNIQUE INDEX "Room_public_identity_unique"
 *       ON "Room" (lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))
 *       WHERE "isPublic" = true;
 *
 * Both this predicate and the index normalize all three fields via
 * `lower(trim(...))` (#260), so two rooms differing only by case or whitespace
 * are recognized as the same room by both layers. If either changes without the
 * other, the agreement test in `tests/integration/room-identity-index.test.ts`
 * fails.
 *
 * Import-free by requirement. `share-room-button.tsx` is a client component
 * and value-imports this; a transitive edge to `@/lib/log` (pino, server-only)
 * would break `pnpm run build` while still passing `pnpm run verify`. Same
 * reason `src/lib/tiers.ts` and `src/lib/class-fields.ts` ship no RUNTIME
 * imports. `import type` is safe — it erases entirely — which is why
 * `tiers.ts` carries one and this module may too.
 *
 * The server does not use this. `POST /api/rooms/[id]/publish` lets the index
 * refuse, exactly as `POST /api/rooms` already does and for the reason stated
 * there. This module exists so the rule is named, unit-tested and greppable
 * rather than inlined in a component, where drift from the index would be
 * invisible.
 */
export interface RoomIdentity {
  readonly address: string;
  readonly floor: string;
  readonly roomName: string;
}

/**
 * Canonical normalisation for room identity fields (#260).
 *
 * Trims leading/trailing whitespace and folds case to lowercase, matching
 * `Room_public_identity_unique` and `Room_private_identity_unique`
 * in PostgreSQL.
 */
export function normalizeRoomField(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * True when two room identities describe the same physical room in the commons.
 * Derives from `normalizeRoomField`, matching Postgres's `lower(trim(...))` index.
 */
export function sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean {
  return (
    normalizeRoomField(a.address) === normalizeRoomField(b.address) &&
    normalizeRoomField(a.floor) === normalizeRoomField(b.floor) &&
    normalizeRoomField(a.roomName) === normalizeRoomField(b.roomName)
  );
}

export function findIdentityMatch<T extends RoomIdentity>(
  candidates: readonly T[],
  room: RoomIdentity,
): T | undefined {
  return candidates.find((candidate) => sameRoomIdentity(candidate, room));
}
