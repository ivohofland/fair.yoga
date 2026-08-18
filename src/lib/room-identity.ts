/**
 * The identity a shared room occupies in the commons.
 *
 * This mirrors `Room_public_identity_unique`, declared in
 * `prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql:33`:
 *
 *     CREATE UNIQUE INDEX "Room_public_identity_unique"
 *       ON "Room" ("address", "floor", "roomName") WHERE "isPublic" = true;
 *
 * Three raw `text` columns — no `citext`, no `lower()` — so the comparison
 * below is byte-exact on purpose. Do not add `.toLowerCase()` or `.trim()`
 * here without changing the index in the same commit: a predicate stricter
 * than the index refuses shares the database would have accepted. The
 * teacher is not left in silence — they are told "already shared" about a
 * room that is neither theirs nor the same, which is worse: what is
 * invisible is that the message is wrong.
 *
 * Consequence, tracked as #260: two rooms differing only by case or trailing
 * whitespace are distinct to both this predicate and the index. The
 * neighbourhood search in the sharing flow surfaces both to a human, which is
 * the mitigation that flow relies on.
 *
 * Import-free by requirement. `share-room-button.tsx` is a client component
 * and value-imports this; a transitive edge to `@/lib/log` (pino, server-only)
 * would break `npm run build` while still passing `npm run verify`. Same
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
  address: string;
  floor: string;
  roomName: string;
}

export function sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean {
  return a.address === b.address && a.floor === b.floor && a.roomName === b.roomName;
}

export function findIdentityMatch<T extends RoomIdentity>(
  candidates: readonly T[],
  room: RoomIdentity,
): T | undefined {
  return candidates.find((candidate) => sameRoomIdentity(candidate, room));
}
