# Case- and whitespace-insensitive room identity deduplication (#260)

## Problem & Context
Rooms in fair.yoga carry three identity fields: `address`, `floor`, and `roomName`.
Historically (#196), PostgreSQL partial unique indexes (`Room_public_identity_unique` and `Room_private_identity_unique`) were defined over raw `text` columns without `lower()` or `trim()`. As a result, case variants (`Prinsengracht 42` vs `prinsengracht 42`) and whitespace variants were treated as distinct rows by both PostgreSQL and the client-side `sameRoomIdentity` predicate (#73).

This plan implements Option A from the design spec (`docs/superpowers/specs/2026-09-21-room-identity-normalization-design.md`):
1. PostgreSQL expression indexes over `lower(trim(...))` for both public and private room uniqueness constraints.
2. Expression-aware target extraction in `isUniqueConflictOn` so Prisma `P2002` errors continue to map cleanly to `DUPLICATE_ROOM` without changing route signatures.
3. Canonical field normalizer `normalizeRoomField` in `src/lib/room-identity.ts`, which `sameRoomIdentity` derives from.
4. Comprehensive unit and integration test coverage with mutation testing across all affected layers.

## User Review Required
- A new database migration (`room_identity_case_whitespace_indexes`) drops the existing raw-column partial indexes on `Room` and creates expression indexes over `lower(trim(...))`.
- Census confirmed 0 conflicting duplicates across existing dev and test databases.

---

## Proposed Changes

### Component 1: Database Migration & Schema

#### [NEW] [prisma/migrations/20260921200000_room_identity_case_whitespace_indexes/migration.sql](file:///Users/ivohofland/Projects/fair.yoga/prisma/migrations/20260921200000_room_identity_case_whitespace_indexes/migration.sql)
- Drop `Room_public_identity_unique` and `Room_private_identity_unique`.
- Create `Room_public_identity_unique` ON `"Room" (lower(trim("address")), lower(trim("floor")), lower(trim("roomName"))) WHERE "isPublic" = true;`
- Create `Room_private_identity_unique` ON `"Room" ("createdById", lower(trim("address")), lower(trim("floor")), lower(trim("roomName"))) WHERE "isPublic" = false;`

#### [MODIFY] [prisma/schema.prisma](file:///Users/ivohofland/Projects/fair.yoga/prisma/schema.prisma)
- Update docblock comments above `model Room` (lines 311-317) describing the two partial indexes to cite `lower(trim(...))` and issue #260.

---

### Component 2: Error Mapping

#### [MODIFY] [src/lib/unique-conflict.ts](file:///Users/ivohofland/Projects/fair.yoga/src/lib/unique-conflict.ts)
- Add `extractColumnIdentifier(targetExpr: string): string` to unwrap function calls like `lower(...)`, `trim(...)`, and `TRIM(BOTH FROM ...)` from `err.meta?.target` elements.
- Normalize `err.meta?.target` elements before comparing them with `columns`.
- Update docblock explaining expression un-wrapping and citing #260 alongside #196.

#### [MODIFY] [src/lib/unique-conflict.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/lib/unique-conflict.test.ts)
- Add unit tests verifying that `isUniqueConflictOn` matches `meta.target` containing expression strings:
  - `['lower(TRIM(BOTH FROM address))', 'lower(TRIM(BOTH FROM floor))', 'lower(TRIM(BOTH FROM roomName))']` matches `['address', 'floor', 'roomName']`.
  - `['createdById', 'lower(TRIM(BOTH FROM address))', 'lower(TRIM(BOTH FROM floor))', 'lower(TRIM(BOTH FROM roomName))']` matches `['createdById', 'address', 'floor', 'roomName']`.

---

### Component 3: Identity Predicate

#### [MODIFY] [src/lib/room-identity.ts](file:///Users/ivohofland/Projects/fair.yoga/src/lib/room-identity.ts)
- Export `normalizeRoomField(value: string): string` returning `value.trim().toLowerCase()`.
- Update `sameRoomIdentity` to derive from `normalizeRoomField` across `address`, `floor`, and `roomName`.
- Remove obsolete docblock comment citing #260 as an unaddressed gap. Document the `lower(trim(...))` index agreement invariant.
- Maintain pure, import-free module guarantee.

#### [MODIFY] [src/lib/room-identity.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/lib/room-identity.test.ts)
- Add unit tests for `normalizeRoomField`:
  - Trims leading and trailing whitespace (`'  Studio A  '` -> `'studio a'`).
  - Lowercases mixed case (`'STUDIO A'` -> `'studio a'`).
  - Handles empty string (`''` -> `''`).
- Update `sameRoomIdentity` tests:
  - Invert previous tests: case variants are now considered the SAME room (`expect(sameRoomIdentity(base, { ...base, address: 'prinsengracht 42' })).toBe(true)`).
  - Invert previous tests: whitespace variants are now considered the SAME room (`expect(sameRoomIdentity(base, { ...base, address: 'Prinsengracht 42 ' })).toBe(true)`).
  - Still differentiates genuinely different addresses, floors, and room names.

---

### Component 4: Integration Tests & Documentation

#### [MODIFY] [tests/integration/room-identity-index.test.ts](file:///Users/ivohofland/Projects/fair.yoga/tests/integration/room-identity-index.test.ts)
- Invert test `accepts as shared two rooms the predicate calls different`:
  - It must now assert that the predicate calls them the SAME (`sameRoomIdentity(...) === true`).
  - It must assert that Postgres refuses the second case-variant shared room with unique conflict (`isUniqueConflictOn(err, ['address', 'floor', 'roomName']) === true`).
- Add test verifying that Postgres also refuses whitespace-variant shared rooms (`address + ' '`).

#### [MODIFY] [tests/integration/rooms-api.test.ts](file:///Users/ivohofland/Projects/fair.yoga/tests/integration/rooms-api.test.ts)
- Add test in `POST /api/rooms dedupes both branches`:
  - Rejects a second PUBLIC room differing only in case or whitespace with 409 `DUPLICATE_ROOM`.
  - Rejects a second PRIVATE room differing only in case or whitespace from the same teacher with 409 `DUPLICATE_ROOM`.

#### [MODIFY] [tests/integration/rooms-publish-api.test.ts](file:///Users/ivohofland/Projects/fair.yoga/tests/integration/rooms-publish-api.test.ts)
- Add test verifying that `POST /api/rooms/[id]/publish` returns 409 `DUPLICATE_ROOM` when attempting to share a private room whose identity collides with an existing shared room under case/whitespace insensitivity.

#### [MODIFY] [docs/data-model.md](file:///Users/ivohofland/Projects/fair.yoga/docs/data-model.md)
- Update references to `Room_public_identity_unique` and `Room_private_identity_unique` to document their `lower(trim(...))` expression index shape.

---

## Task Breakdown

### Task 1: Migration and Schema
1. Create and apply migration `room_identity_case_whitespace_indexes`.
2. Update `prisma/schema.prisma` comments.
3. Verify `prisma migrate diff` reports no difference.
4. Verify `pnpm run check-migrations` passes.

### Task 2: Expression-aware `isUniqueConflictOn`
1. Edit `src/lib/unique-conflict.ts` to implement `extractColumnIdentifier`.
2. Add unit tests in `src/lib/unique-conflict.test.ts`.
3. Prove guard bites via mutation:
   - Break `extractColumnIdentifier` (e.g. return raw string unchanged) -> test fails expecting column match.
   - Restore and re-verify green.

### Task 3: Room Identity Predicate & Unit Tests
1. Edit `src/lib/room-identity.ts` to export `normalizeRoomField` and update `sameRoomIdentity`.
2. Update `src/lib/room-identity.test.ts` with tests for `normalizeRoomField` and updated `sameRoomIdentity`.
3. Prove guards bite via mutation:
   - Remove `.toLowerCase()` in `normalizeRoomField` -> case variant test fails.
   - Remove `.trim()` in `normalizeRoomField` -> whitespace variant test fails.
   - Restore and re-verify green.

### Task 4: Integration Tests & Route Coverage
1. Update `tests/integration/room-identity-index.test.ts`.
2. Add case/whitespace duplicate tests in `tests/integration/rooms-api.test.ts` and `tests/integration/rooms-publish-api.test.ts`.
3. Update `docs/data-model.md`.
4. Run integration tests: `pnpm exec vitest run --project integration tests/integration/room-identity-index.test.ts tests/integration/rooms-api.test.ts tests/integration/rooms-publish-api.test.ts`.

### Task 5: Full Verification
1. Run `pnpm run verify` (typecheck, lint, all unit, sweeps, and integration tests).
2. Confirm zero regressions across all tiers.
