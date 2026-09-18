# Opportunistic Session Deletion Error Handling Implementation Plan

**Goal:** In `src/lib/auth/session.ts`, replace `db.session.delete({ where: { id: sessionHash } }).catch(() => {})` with `db.session.deleteMany({ where: { id: sessionHash } })` in `validateSession` for both expired sessions and sessions whose account has no live profiles. This ensures opportunistic session deletion is idempotent against concurrent deletions without throwing `P2025`, while allowing genuine database infrastructure errors to bubble to the caller (#643).

**Architecture:**
1. In `src/lib/auth/session.ts`, update `validateSession(db, token)`:
   - For expired sessions (`session.expiresAt <= new Date()`), replace `await db.session.delete({ where: { id: sessionHash } }).catch(() => {});` with `await db.session.deleteMany({ where: { id: sessionHash } });`.
   - For sessions with missing account or no live profiles (`!account || (!liveTeacher && !liveStudent)`), replace `await db.session.delete({ where: { id: sessionHash } }).catch(() => {});` with `await db.session.deleteMany({ where: { id: sessionHash } });`.
   - Document the use of `deleteMany` (idempotent against concurrent deletion without throwing P2025; bubbles database infrastructure failures).
2. In `src/lib/auth/session.test.ts`, add unit tests:
   - Verify `validateSession` re-throws database errors encountered during expired session opportunistic deletion.
   - Verify `validateSession` re-throws database errors encountered during profile-less session opportunistic deletion.
   - Verify `validateSession` returns `null` cleanly when concurrent deletion leaves 0 rows to delete (`deleteMany` returns `{ count: 0 }`).
3. Execute mutation testing:
   - Revert either cleanup to `.catch(() => {})` and verify the test suite fails (catches the swallowed error).
   - Restore and re-verify green.
4. Run full verify command:
   - `pnpm run verify` (typecheck -> lint -> full vitest suite).

**Tech Stack:** TypeScript, Vitest, Prisma, PostgreSQL.

---

### Task 1: Refactor opportunistic session deletion in `src/lib/auth/session.ts` and add unit tests

**Files:**
- Modify: `src/lib/auth/session.ts`
- Modify: `src/lib/auth/session.test.ts`

- [ ] **Step 1: Create feature branch**
  - Create and switch to branch `fix/643-validate-session-delete-errors`.

- [ ] **Step 2: Update `validateSession` in `src/lib/auth/session.ts`**
  - Replace lines 69 and 95:
    ```ts
    // Expired session cleanup:
    if (session.expiresAt <= new Date()) {
      await db.session.deleteMany({ where: { id: sessionHash } });
      return null;
    }
    ```
    and
    ```ts
    // Missing account or no live profiles cleanup:
    if (!account || (!liveTeacher && !liveStudent)) {
      await db.session.deleteMany({ where: { id: sessionHash } });
      return null;
    }
    ```
  - Add inline comments documenting that `deleteMany` is used rather than `delete` so concurrent deletions safely no-op without throwing `P2025`, while genuine database errors surface to callers.

- [ ] **Step 3: Add unit tests in `src/lib/auth/session.test.ts`**
  - In `describe('validateSession')`:
    - Add test: `re-throws database errors during expired session opportunistic deletion` (spies on `db.session.deleteMany` with `mockRejectedValueOnce(new Error('database connection lost'))`, verifies `validateSession` rejects with that error).
    - Add test: `re-throws database errors during profile-less session opportunistic deletion` (creates bare account, spies on `db.session.deleteMany` with `mockRejectedValueOnce(new Error('database deadlock'))`, verifies `validateSession` rejects with that error).
    - Add test: `returns null without throwing when session row is concurrently deleted during cleanup` (verifies `{ count: 0 }` from `deleteMany` returns `null`).

- [ ] **Step 4: Run unit tests and execute mutation testing**
  - Run: `pnpm exec vitest run src/lib/auth/session.test.ts` (all tests must pass).
  - Mutation probe:
    - In `src/lib/auth/session.ts`, temporarily reintroduce `.catch(() => {})` on expired session cleanup.
    - Run `pnpm exec vitest run src/lib/auth/session.test.ts` -> verify test fails with expected failure (assertion failed: expected promise to reject, but resolved to null).
    - In `src/lib/auth/session.ts`, temporarily reintroduce `.catch(() => {})` on profile-less session cleanup.
    - Run `pnpm exec vitest run src/lib/auth/session.test.ts` -> verify test fails with expected failure.
    - Restore original code and re-verify green.

- [ ] **Step 5: Run full project verification**
  - Run `pnpm run verify` (typecheck -> lint -> test).
