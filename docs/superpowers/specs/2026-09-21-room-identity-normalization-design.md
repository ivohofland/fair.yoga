# Case- and whitespace-insensitive room identity deduplication (#260)

**Date:** 2026-09-21
**Issue:** #260 — Case- and whitespace-variant rooms can both exist in the shared library
**Spun out of:** #73 / PR #261

---

## 1. The issue's premise, measured

| Claim in #260 | Verdict | Evidence |
|---|---|---|
| `Room_public_identity_unique` is a plain btree index on `("address", "floor", "roomName")` WHERE `isPublic = true` | **True** | `prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql:33-35`. `Room_private_identity_unique` on `("createdById", "address", "floor", "roomName")` WHERE `isPublic = false` has the same raw shape (:37-39). |
| Postgres compares byte-for-byte; case variants are treated as distinct | **True** | `tests/integration/room-identity-index.test.ts:64-76` deliberately asserts that Postgres accepts both `Agreement St` and `agreement st` as shared rooms. |
| *"Nothing trims these fields on the way in — POST /api/rooms trims only in the client (add-room-flow.tsx), and createRoomSchema does not."* | **False / Stale** | PR #405 (commits `8a99b1a2` and `fdd0551c`, 2026-09-07) added `.trim()` to `address`, `floor`, and `roomName` in both `createRoomSchema` and `updateRoomSchema` (`src/lib/schemas.ts:324-347`). Wire API requests are already trimmed on ingestion. However, PostgreSQL itself does not enforce trimming, `sameRoomIdentity` does not trim, and case folding is not performed anywhere. |
| Existing data has duplicates that could block an index change | **Measured: 0 duplicates** | Census on `ethical_yoga` (dev DB) and `ethical_yoga_test`: 19 rooms in dev DB (2 public, 17 private), with exactly 0 collisions under `lower(trim(...))` on either public `(address, floor, roomName)` or private `(createdById, address, floor, roomName)`. |
| Prisma P2002 behavior with Postgres expression index | **Measured** | When a unique index uses `lower(trim(...))`, Prisma's query engine returns `meta.target = ['lower(TRIM(BOTH FROM address))', ...]`. `isUniqueConflictOn(err, ['address', 'floor', 'roomName'])` evaluates to `false` unless target expressions are unwrapped to base column names. |

---

## 2. The decision

**Option A: Normalise in the index (`lower(trim(...))`) and derive `sameRoomIdentity` from a single canonical field normalizer.**

1. **Database Migration:** Replace both partial unique indexes on `Room` with expression indexes over `lower(trim(...))`:
   - `Room_public_identity_unique` on `(lower(trim("address")), lower(trim("floor")), lower(trim("roomName"))) WHERE "isPublic" = true`
   - `Room_private_identity_unique` on `("createdById", lower(trim("address")), lower(trim("floor")), lower(trim("roomName"))) WHERE "isPublic" = false`
2. **Canonical Normalizer in `src/lib/room-identity.ts`:**
   Export `normalizeRoomField(val: string): string` performing `val.trim().toLowerCase()`.
   `sameRoomIdentity(a, b)` derives from this helper across all three identity fields (`address`, `floor`, `roomName`).
   `room-identity.ts` remains pure and import-free (safe for client bundle importing by `share-room-button.tsx`).
3. **Expression-Aware `isUniqueConflictOn`:**
   Extend `isUniqueConflictOn` in `src/lib/unique-conflict.ts` to unwrap function expressions from `meta.target` strings (e.g. `lower(TRIM(BOTH FROM address))` -> `address`).
   All route call sites (`POST /api/rooms`, `POST /api/rooms/[id]/publish`, `PUT /api/rooms/[id]`) continue matching against `['address', 'floor', 'roomName']` and `['createdById', 'address', 'floor', 'roomName']` without modification.
4. **Display Casing Preserved:**
   Because normalisation occurs in the index and the identity predicate rather than on the stored column values, teacher-entered casing ("Studio A", "Prinsengracht 42") is preserved verbatim for UI rendering.

---

## 3. Detailed Component Design

### 3.1 Migration: `room_identity_case_whitespace_indexes`

A new migration created via `pnpm exec prisma migrate dev --name room_identity_case_whitespace_indexes`:
```sql
-- Drop raw-column partial unique indexes
DROP INDEX "Room_public_identity_unique";
DROP INDEX "Room_private_identity_unique";

-- Recreate as case- and whitespace-normalized expression indexes (#260)
CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" (lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))
  WHERE "isPublic" = true;

CREATE UNIQUE INDEX "Room_private_identity_unique"
  ON "Room" ("createdById", lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))
  WHERE "isPublic" = false;
```

`prisma/schema.prisma` carries a docblock comment above `model Room` describing these indexes. It will be updated to reflect the new `lower(trim(...))` expressions and cite #260.

### 3.2 `src/lib/room-identity.ts`

```typescript
export interface RoomIdentity {
  address: string;
  floor: string;
  roomName: string;
}

/**
 * Canonical normalisation for room identity fields (#260).
 * Trims leading/trailing whitespace and folds case to lowercase, matching
 * `Room_public_identity_unique` and `Room_private_identity_unique`.
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
```

The stale comment tracking #260 as an unaddressed gap will be removed, and replaced with documentation of the invariant.

### 3.3 `src/lib/unique-conflict.ts`

PostgreSQL decompiles index expressions into `pg_get_indexdef` syntax, which Prisma splits into `meta.target`.
Specifically, `lower(trim("address"))` becomes `lower(TRIM(BOTH FROM address))` in `meta.target`.

To maintain caller independence from PostgreSQL's internal decompiled expression representation, `isUniqueConflictOn` normalises target elements by extracting the underlying column identifier:

```typescript
function extractColumnIdentifier(targetExpr: string): string {
  const stripped = targetExpr.replace(/["']/g, '');
  const match = stripped.match(/([a-zA-Z0-9_]+)\s*\)*$/);
  return match ? match[1]! : stripped;
}
```

When comparing `err.meta?.target` against `columns`, each element of `target` is passed through `extractColumnIdentifier`.
Existing behavior on plain column names (e.g. `'accountId'`, `'email'`) is 100% preserved.

---

## 4. Invariants and Safety

1. **Agreement:** The predicate `sameRoomIdentity` and PostgreSQL's index `Room_public_identity_unique` agree on every input. If `sameRoomIdentity(a, b)` is true, Postgres refuses inserting both as public rooms.
2. **Symmetry:** Both public rooms (`Room_public_identity_unique`) and private rooms (`Room_private_identity_unique`) share the identical `lower(trim(...))` normalization semantics.
3. **Display Integrity:** Stored text preserves the teacher's original formatting and casing.
4. **Drift Safety:** `prisma migrate diff` continues to report zero drift because partial indexes are ignored by Prisma's schema comparison.
5. **Client Bundle Safety:** `src/lib/room-identity.ts` remains strictly import-free.

---

## 5. Testing & Mutation Plan

Each guard will be verified using the break-record-restore-reverify protocol:

| # | Guard | Test Location | Mutation that must break it | Expected Result |
|---|---|---|---|---|
| 1 | `normalizeRoomField` trims whitespace and lowercases | `src/lib/room-identity.test.ts` | Remove `.toLowerCase()` or `.trim()` | Unit test fails on case/whitespace variants |
| 2 | `sameRoomIdentity` matches case variants | `src/lib/room-identity.test.ts` | Change to `===` comparison without `normalizeRoomField` | `matches case variants` test fails |
| 3 | `sameRoomIdentity` matches whitespace variants | `src/lib/room-identity.test.ts` | Compare un-trimmed fields | `matches whitespace variants` test fails |
| 4 | `isUniqueConflictOn` unwraps expression index targets | `src/lib/unique-conflict.test.ts` | Remove `extractColumnIdentifier` | Test asserting `lower(TRIM(BOTH FROM address))` fails to match `['address']` |
| 5 | Postgres refuses duplicate shared room differing only in case | `tests/integration/room-identity-index.test.ts` | Revert index in DB to raw columns | `shared(variantAddress, ...)` resolves instead of rejecting |
| 6 | Postgres refuses duplicate shared room differing only in whitespace | `tests/integration/room-identity-index.test.ts` | Revert index in DB to raw columns | Whitespace variant resolves instead of rejecting |
| 7 | `POST /api/rooms` returns 409 `DUPLICATE_ROOM` on case/whitespace variant public room | `tests/integration/rooms-api.test.ts` | Drop `lower(trim(...))` from index | Second create succeeds with 201 instead of 409 |
| 8 | `POST /api/rooms` returns 409 `DUPLICATE_ROOM` on case/whitespace variant private room for same teacher | `tests/integration/rooms-api.test.ts` | Drop `lower(trim(...))` from index | Second create succeeds with 201 instead of 409 |
| 9 | `POST /api/rooms/[id]/publish` returns 409 `DUPLICATE_ROOM` when shared room exists with case variant | `tests/integration/rooms-publish-api.test.ts` | Drop `lower(trim(...))` from index | Publish succeeds with 200 instead of 409 |

---

## 6. Artifacts to Update & Claims to Reconcile

- `src/lib/room-identity.ts`: Remove the comment stating that #260 is an open gap. Replace with documentation of the `normalizeRoomField` invariant.
- `src/lib/room-identity.test.ts`: Invert existing tests asserting that case/whitespace variants are *different* rooms — they must now assert that they are the *same* room.
- `tests/integration/room-identity-index.test.ts`: Invert existing test asserting that Postgres accepts two case-variant rooms — Postgres must now refuse them with unique conflict.
- `src/lib/unique-conflict.ts`: Update docblock referencing `Room_private_identity_unique` to note that target expressions are unwrapped to base columns.
- `prisma/schema.prisma`: Update the `model Room` docblock to reflect `lower(trim(...))` indexes.
- `docs/data-model.md`: Update references to `Room_public_identity_unique` and `Room_private_identity_unique`.
