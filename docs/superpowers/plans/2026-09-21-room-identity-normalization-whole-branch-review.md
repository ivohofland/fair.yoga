# Whole-Branch Review: Case- and Whitespace-Insensitive Room Identity Deduplication (#260)

**Date:** 2026-09-21
**Branch:** `fix/260-room-identity-normalization`
**Reviewer:** Whole Branch Reviewer

---

## 1. Cross-Task Consistency and Alignment

- **Database Layer (Task 1):**
  `prisma/migrations/20260921183434_room_identity_case_whitespace_indexes/migration.sql` drops the previous raw-column partial indexes (`Room_public_identity_unique` and `Room_private_identity_unique`) and recreates them as partial unique indexes over `(lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))` for public rooms (`isPublic = true`) and `("createdById", lower(trim("address")), lower(trim("floor")), lower(trim("roomName")))` for private rooms (`isPublic = false`).
  `prisma/schema.prisma` docblock above `model Room` matches this definition and cites #260.
  `prisma migrate diff` reports zero drift and `check-migrations` confirms immutability.

- **Error-Handling Layer (Task 2):**
  `src/lib/unique-conflict.ts` defines `extractColumnIdentifier(targetExpr: string): string` to unwrap function expressions (such as `lower(TRIM(BOTH FROM col))`) from `err.meta?.target` elements back to bare column names.
  Unit tests in `src/lib/unique-conflict.test.ts` verify matching for both public and private index target shapes across permutations. Mutation test confirmed the guard bites.

- **Identity Predicate Layer (Task 3):**
  `src/lib/room-identity.ts` exports `normalizeRoomField(value: string): string` performing `value.trim().toLowerCase()`.
  `sameRoomIdentity` derives directly from `normalizeRoomField` across `address`, `floor`, and `roomName`.
  The module remains strictly pure and import-free, preserving client-side bundle safety for `'use client'` consumers such as `share-room-button.tsx`.
  Unit tests in `src/lib/room-identity.test.ts` verify trimming, lowercasing, and case/whitespace variant matching. Mutation tests confirmed both `.trim()` and `.toLowerCase()` guards bite.

- **Integration & Route Testing (Task 4):**
  `tests/integration/room-identity-index.test.ts` verifies that `sameRoomIdentity` and PostgreSQL agree: Postgres refuses case variants and whitespace variants with unique conflict on `['address', 'floor', 'roomName']`.
  `tests/integration/rooms-api.test.ts` asserts that `POST /api/rooms` returns 409 `DUPLICATE_ROOM` on case/whitespace variants for both public and private rooms.
  `tests/integration/rooms-publish-api.test.ts` asserts that `POST /api/rooms/[id]/publish` returns 409 `DUPLICATE_ROOM` when a case/whitespace duplicate exists in the commons.
  `docs/data-model.md` accurately documents the updated index expressions.

---

## 2. Invariants and Edge Cases

- **PostgreSQL Target Format:** PostgreSQL's decompiled AST representation (`lower(TRIM(BOTH FROM address))`) is cleanly normalized to `address` by `extractColumnIdentifier`. Quoted column names and standard un-wrapped columns are equally supported without regression.
- **Client Safety:** No server imports (such as `@/lib/log` or `@/lib/db`) leaked into `room-identity.ts`.
- **Display Casing:** Raw stored fields in `Room` retain the teacher's original casing and formatting; normalisation is strictly evaluated for indexing and identity matching.

---

## 3. Verdict

**APPROVED.** The whole-branch review finds zero cross-task inconsistencies, zero regressions, and full coverage of the acceptance criteria set out in Issue #260.
