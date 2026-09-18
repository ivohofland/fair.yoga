# Session Invalidation Error Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `DELETE /api/auth/session`, replace the unconstrained empty `catch {}` block around session deletion with `revokeRequestSession`, and refactor `invalidateSession` to use `deleteMany` so that missing records remain safe no-ops while genuine database errors bubble to `withErrorHandler` and return HTTP 500 (#641).

**Architecture:**
1. In `src/lib/auth/session.ts`, refactor `invalidateSession(db, token)` to use `db.session.deleteMany({ where: { id: sessionHash } })` and return `Promise<boolean>` (`count > 0`). Refactor `revokeRequestSession(db, request)` to delegate to `invalidateSession(db, token)` once extracted from the cookie store.
2. In `src/app/api/auth/session/route.ts`, replace `getSessionToken` + `try { await invalidateSession(...) } catch {}` with `await revokeRequestSession(prisma, request)`. Genuine database errors bubble to `withErrorHandler`, which logs the error via pino and returns HTTP 500.
3. Add unit test coverage in `src/lib/auth/session.test.ts` for both `invalidateSession` (idempotent against missing rows) and `revokeRequestSession`.
4. Add route unit test in `src/app/api/auth/session/route.test.ts` verifying error propagation (HTTP 500 + logging) when the database rejects, and 200 + cookie clear on success.
5. Add integration test in `tests/integration/auth.test.ts` exercising HTTP `DELETE /api/auth/session`.

**Tech Stack:** TypeScript, Vitest, Prisma, Next.js route handlers.

---

### Task 1: Refactor `invalidateSession` and `revokeRequestSession` in `src/lib/auth/session.ts` with unit tests

**Files:**
- Modify: `src/lib/auth/session.ts`
- Test: `src/lib/auth/session.test.ts`

- [ ] **Step 1: Refactor `invalidateSession` and `revokeRequestSession` in `src/lib/auth/session.ts`**
  - Update `invalidateSession(db: PrismaClient, token: string): Promise<boolean>`:
    ```ts
    export async function invalidateSession(
      db: PrismaClient,
      token: string,
    ): Promise<boolean> {
      const sessionHash = hashToken(token);
      const { count } = await db.session.deleteMany({
        where: { id: sessionHash },
      });
      return count > 0;
    }
    ```
  - Update `revokeRequestSession(db: PrismaClient, request: NextRequest): Promise<boolean>`:
    ```ts
    export async function revokeRequestSession(
      db: PrismaClient,
      request: NextRequest,
    ): Promise<boolean> {
      const token = getSessionToken(request);
      if (!token) return false;
      return invalidateSession(db, token);
    }
    ```
  - Update docblocks for both functions accurately describing their behavior and callers.

- [ ] **Step 2: Add comprehensive unit tests in `src/lib/auth/session.test.ts`**
  - Update `describe('invalidateSession')`:
    - deletes the session so subsequent validate returns null and returns true
    - returns false without throwing when token does not exist in the database
  - Add `describe('revokeRequestSession')`:
    - returns false when request carries no session cookie
    - revokes active session and returns true when session exists
    - returns false without throwing when session cookie names an absent session

- [ ] **Step 3: Run unit tests and prove mutation**
  - Run: `pnpm exec vitest run src/lib/auth/session.test.ts` (must pass).
  - Mutation probe: Mutate `invalidateSession` to throw on non-existent token (simulating `delete`). Verify test fails. Restore and re-verify green.

---

### Task 2: Refactor `DELETE /api/auth/session` to propagate errors, add route unit tests and integration tests

**Files:**
- Modify: `src/app/api/auth/session/route.ts`
- New: `src/app/api/auth/session/route.test.ts`
- Modify: `tests/integration/auth.test.ts`

- [ ] **Step 1: Refactor `DELETE` in `src/app/api/auth/session/route.ts`**
  - Remove `getSessionToken` and `invalidateSession` imports; import `revokeRequestSession`.
  - Replace the handler body with:
    ```ts
    export const DELETE = withErrorHandler(async (request: NextRequest) => {
      await revokeRequestSession(prisma, request);

      const response = respondOk({ message: 'Logged out' });
      clearSessionCookie(response.headers);

      return response;
    });
    ```

- [ ] **Step 2: Create unit tests in `src/app/api/auth/session/route.test.ts`**
  - Test `DELETE`:
    - returns 200 with `{ message: 'Logged out' }` and expired cookie when session cookie is present
    - returns 200 with `{ message: 'Logged out' }` and expired cookie when no session cookie is present
    - bubbles database errors: when `prisma.session.deleteMany` throws, `withErrorHandler` catches it, logs via `log.error`, and responds with status 500

- [ ] **Step 3: Add integration tests in `tests/integration/auth.test.ts`**
  - Add test for `DELETE /api/auth/session` over HTTP:
    - active session -> returns 200, sets expired cookie header, `validateSession` returns null
    - idempotent -> repeated request with already-revoked session returns 200 and clears cookie

- [ ] **Step 4: Run tests and prove mutation**
  - Run: `pnpm exec vitest run src/app/api/auth/session/route.test.ts`
  - Run: `pnpm exec vitest run --project integration tests/integration/auth.test.ts`
  - Mutation probe: Wrap `await revokeRequestSession(prisma, request)` in `try {} catch {}` in `src/app/api/auth/session/route.ts`. Run `route.test.ts`. Verify it fails because status 500 was expected but 200 was received. Restore and re-verify green.
  - Run `pnpm run verify` to ensure typecheck, lint, and full test suite pass.
