# PR Review: Silent Failure Modes (#641 / PR #642)

**Reviewer:** PR Reviewer (Silent Failure Hunter)  
**Target:** PR #642 (`fix/641-session-delete-errors` against `origin/main`)  
**Scope:** Error handling, exception bubbling, logging quality, swallowed rejections, and fallback behavior in [`src/app/api/auth/session/route.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/app/api/auth/session/route.ts) and [`src/lib/auth/session.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts).  
**Date:** 2026-09-18  

---

## 1. Executive Summary

PR #642 resolves issue #641 by addressing the unconstrained empty `catch {}` block previously residing in `DELETE /api/auth/session`.

### Key Achievements of PR #642
1. **Elimination of the Empty Catch Block in the Route Handler:**  
   In [`src/app/api/auth/session/route.ts:L25-L32`](file:///Users/ivohofland/Projects/fair.yoga/src/app/api/auth/session/route.ts#L25-L32), the old `try { await invalidateSession(prisma, token); } catch {}` block was completely removed and replaced with a direct call to `await revokeRequestSession(prisma, request)`.
2. **Idempotency Without Exception Suppression:**  
   In [`src/lib/auth/session.ts:L132-L141`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L132-L141), `invalidateSession` was refactored to use `db.session.deleteMany({ where: { id: sessionHash } })`. Absent records now return `false` cleanly without throwing Prisma's `P2025` error, completely removing the original justification for catching deletion errors.
3. **Verified Error Bubbling and Logging:**  
   When genuine database rejections occur during `deleteMany` (e.g. database down, connection pool exhaustion, timeout, deadlock), the rejection bubbles uninhibited through `invalidateSession` $\rightarrow$ `revokeRequestSession` $\rightarrow$ `DELETE` route handler $\rightarrow$ [`withErrorHandler`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/api-utils.ts#L140-L163). `withErrorHandler` logs the error with full diagnostic context (`err`, `method: 'DELETE'`, `path: '/api/auth/session'`) via Pino and returns HTTP 500 (`Internal server error`) or HTTP 503 (`The system was busy and could not finish that`).
4. **Route Unit Tests:**  
   [`src/app/api/auth/session/route.test.ts:L66-L93`](file:///Users/ivohofland/Projects/fair.yoga/src/app/api/auth/session/route.test.ts#L66-L93) explicitly tests database rejection propagation to `withErrorHandler`, asserting the 500 status code and `log.error` invocation.

### Critical Finding Uncovered
Despite fixing `invalidateSession`, the audit identified that **[`src/lib/auth/session.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts) still contains two explicit empty `.catch(() => {})` blocks in [`validateSession`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L68) (lines 68 and 94)**. These blocks silently swallow all database errors during expired-session and deleted-account cleanup, suppressing errors from logging and reporting false 401 "Session expired" responses instead of 500/503 server errors.

---

## 2. Detailed Findings

### Finding 1: Swallowed Database Write Failures in `validateSession`
- **Location:** [`src/lib/auth/session.ts:L67-L70`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L67-L70) and [`src/lib/auth/session.ts:L93-L96`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L93-L96)
- **Severity:** `CRITICAL`
- **Problem:**  
  In `validateSession`, expired sessions and accounts without live profiles are pruned using:
  ```typescript
  // Line 68 (expired session cleanup):
  if (session.expiresAt <= new Date()) {
    await db.session.delete({ where: { id: sessionHash } }).catch(() => {});
    return null;
  }

  // Line 94 (account missing or no live teacher/student profiles):
  if (!account || (!liveTeacher && !liveStudent)) {
    await db.session.delete({ where: { id: sessionHash } }).catch(() => {});
    return null;
  }
  ```
  Both lines use `db.session.delete(...)` with an empty `.catch(() => {})` handler. While originally intended to avoid throwing `P2025` when a concurrent request has already deleted the session, `.catch(() => {})` is completely unconstrained: it silently swallows **any** rejection from the database.
- **Hidden Errors:**  
  - Database connectivity failures (`PrismaClientInitializationError`, `PrismaClientRustPanicError`, socket errors).
  - Transient contention errors (`55P03` lock timeout, `40P01` deadlock, `P2024` connection pool timeout, `P2028` transaction timeout).
  - Read-only transaction errors or disk I/O errors on PostgreSQL.
- **Impact:**  
  1. **Zero Visibility / Swallowed Outages:** The database error is never logged. Neither Pino nor `withErrorHandler` is notified.
  2. **Misleading Status Code (401 instead of 500/503):** After the error is swallowed, `validateSession` returns `null`. In `GET /api/auth/session` (and every other authenticated route calling `requireSession`), `requireSession` translates `null` into `respondError('Session expired', 401)`. A client querying `GET /api/auth/session` while the database is failing writes receives HTTP 401 rather than HTTP 500 or 503, blinding operators and monitoring alerts to an active database degradation.
- **Recommendation & Fix:**  
  Adopt the exact pattern PR #642 implemented in `invalidateSession`: replace `delete` with `deleteMany`. Since `deleteMany` is idempotent and returns `{ count: 0 }` without throwing when a record does not exist, the `.catch(() => {})` block is entirely unnecessary.
  ```typescript
  // In src/lib/auth/session.ts:
  if (session.expiresAt <= new Date()) {
    await db.session.deleteMany({ where: { id: sessionHash } });
    return null;
  }

  // ...
  if (!account || (!liveTeacher && !liveStudent)) {
    await db.session.deleteMany({ where: { id: sessionHash } });
    return null;
  }
  ```
  With `deleteMany`, missing records safely pass through, while genuine database failures naturally bubble up to the route handler and `withErrorHandler`.

---

### Finding 2: Unhandled Race Condition in Sliding Session Extension
- **Location:** [`src/lib/auth/session.ts:L98-L105`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L98-L105)
- **Severity:** `MEDIUM`
- **Problem:**  
  When extending an active session older than 15 days, `validateSession` runs:
  ```typescript
  const fifteenDaysAgo = new Date(Date.now() - FIFTEEN_DAYS_MS);
  if (session.createdAt < fifteenDaysAgo) {
    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() + THIRTY_DAYS_MS) },
    });
  }
  ```
  If a user signs out in another tab or an automated cleanup deletes the session row in the narrow window between `db.session.findUnique` (line 59) and `db.session.update` (line 101), `db.session.update` throws Prisma error `P2025` ("Record to update not found.").
- **Hidden Errors:**  
  Because `P2025` is not classified as a conflict or transient error in `classifyApiError`, this benign race condition bubbles to `withErrorHandler` and triggers an HTTP 500 `Internal server error` log and response.
- **Impact:**  
  Spurious HTTP 500 error logged for a user whose session was simply revoked concurrently in another browser tab.
- **Recommendation & Fix:**  
  Use `updateMany` instead of `update`, or check `count`:
  ```typescript
  const fifteenDaysAgo = new Date(Date.now() - FIFTEEN_DAYS_MS);
  if (session.createdAt < fifteenDaysAgo) {
    const { count } = await db.session.updateMany({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() + THIRTY_DAYS_MS) },
    });
    if (count === 0) return null;
  }
  ```
  If the session was deleted concurrently, `updateMany` returns `{ count: 0 }`, allowing `validateSession` to return `null` (triggering a standard 401 re-login prompt) rather than crashing with a 500.

---

### Finding 3: Client Cookie Persistence on Database Failure in `DELETE /api/auth/session`
- **Location:** [`src/app/api/auth/session/route.ts:L25-L32`](file:///Users/ivohofland/Projects/fair.yoga/src/app/api/auth/session/route.ts#L25-L32)
- **Severity:** `MEDIUM` (Architectural & UX Observation)
- **Problem:**  
  The route handler is implemented as:
  ```typescript
  export const DELETE = withErrorHandler(async (request: NextRequest) => {
    await revokeRequestSession(prisma, request);

    const response = respondOk({ message: 'Logged out' });
    clearSessionCookie(response.headers);

    return response;
  });
  ```
  When `revokeRequestSession` throws due to a database outage, execution aborts at line 26 and enters `withErrorHandler`. Lines 28–29 are skipped, meaning the HTTP 500 response returned by `withErrorHandler` does not include the `Set-Cookie: fair_yoga_session=; Max-Age=0` header.
- **Hidden Errors:**  
  The client's browser retains the session cookie.
- **Impact & Evaluation:**  
  - **Why this is partially desirable:**  
    If the database fails to delete the session, the session row is still active in the database. If the server were to clear the client's cookie while returning 500, the user's browser would discard the token, preventing any further retry of `DELETE /api/auth/session`, while the database session would remain alive and vulnerable until its 30-day expiration.
  - **Client Handling in [`src/components/account/sign-out-button.tsx:L26-L41`](file:///Users/ivohofland/Projects/fair.yoga/src/components/account/sign-out-button.tsx#L26-L41):**  
    The frontend component checks `res.ok`. When `res.ok` is false (status 500), it sets `signOutFailed = true`, displaying `<p role="alert">Couldn't sign out — try again.</p>`. Because the cookie remains in the browser, tapping "Sign out" again retries the operation with the same session cookie.
  - **Edge Case:**  
    If a user is at an untrusted terminal and the database is failing, they cannot clear their cookie via the application UI. However, preserving the cookie across 500 is standard REST error semantics.
- **Recommendation:**  
  Current behavior is correct and preserves retry ability. Document this design decision in `src/app/api/auth/session/route.ts` so future maintainers understand why `clearSessionCookie` is intentionally placed after the `await` rather than in a `finally` block.

---

### Finding 4: Lack of Direct Error Bubbling Unit Tests on `session.ts`
- **Location:** [`src/lib/auth/session.test.ts:L339-L389`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.test.ts#L339-L389)
- **Severity:** `LOW`
- **Problem:**  
  `src/lib/auth/session.test.ts` contains tests for:
  - `invalidateSession`: active session deletion $\rightarrow$ returns `true`.
  - `invalidateSession`: non-existent session $\rightarrow$ returns `false` without throwing.
  - `revokeRequestSession`: no cookie $\rightarrow$ returns `false`.
  - `revokeRequestSession`: active session $\rightarrow$ returns `true`.
  - `revokeRequestSession`: absent session $\rightarrow$ returns `false`.
  However, there is no unit test in `session.test.ts` asserting that `invalidateSession` or `revokeRequestSession` rejects if `db.session.deleteMany` rejects.
- **Impact:**  
  While [`src/app/api/auth/session/route.test.ts:L66-L92`](file:///Users/ivohofland/Projects/fair.yoga/src/app/api/auth/session/route.test.ts#L66-L92) tests this indirectly through the route handler, the underlying service function lacks a unit regression guard asserting that it propagates DB rejections.
- **Recommendation & Fix:**  
  Add a unit test in `src/lib/auth/session.test.ts`:
  ```typescript
  it('bubbles unexpected database rejections', async () => {
    const dbError = new Error('database connection lost');
    const mockDb = {
      session: {
        deleteMany: vi.fn().mockRejectedValue(dbError),
      },
    } as unknown as PrismaClient;

    await expect(invalidateSession(mockDb, 'any-token')).rejects.toThrow('database connection lost');
  });
  ```

---

## 3. Verification of Specific PR #642 Audit Items

| Audit Requirement | Status | Evidence / Notes |
|---|---|---|
| **Swallowed DB errors in `DELETE /api/auth/session` fixed?** | **VERIFIED** | The empty `catch {}` block in `src/app/api/auth/session/route.ts` was completely removed. |
| **Missing sessions handled idempotently without throwing?** | **VERIFIED** | `invalidateSession` uses `db.session.deleteMany`, returning `false` (`count > 0`) when 0 rows match. |
| **Do database errors bubble to `withErrorHandler`?** | **VERIFIED** | No `catch` block intercepts rejections in `invalidateSession`, `revokeRequestSession`, or `DELETE`. Rejections bubble directly to `withErrorHandler`. |
| **Are database errors properly logged?** | **VERIFIED** | `withErrorHandler` classifies errors through `classifyApiError(error)` and logs via `log[failure.level]` with `err`, `method`, and `path`. Generic failures log at `error` level with message `'unhandled API error'`; transient contention logs at `warn` level with `'transient database contention surfaced to a client'`. |
| **Can any errors be swallowed in `src/app/api/auth/session/route.ts`?** | **NONE** | Neither `GET` nor `DELETE` contains any `try/catch` or unawaited promises. |
| **Can any errors be swallowed in `src/lib/auth/session.ts`?** | **DEFECT FOUND** | `validateSession` lines 68 and 94 contain `.catch(() => {})`, swallowing database errors during expired/invalid session cleanup. |

---

## 4. Conclusion & Next Steps

PR #642 completely and successfully accomplishes its stated mission for issue #641: `DELETE /api/auth/session` no longer swallows database errors, missing sessions remain idempotent, and genuine errors bubble to `withErrorHandler` with structured logging and HTTP 500/503 responses.

However, the audit revealed that the exact same vulnerability—using `db.session.delete` with `.catch(() => {})` to swallow missing-record errors—still exists in [`validateSession`](file:///Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts#L68) (lines 68 and 94). A follow-up PR or immediate patch on this branch should replace those two calls with `db.session.deleteMany({ where: { id: sessionHash } })` (without `.catch`), eliminating all silent failure modes in the session management subsystem.
