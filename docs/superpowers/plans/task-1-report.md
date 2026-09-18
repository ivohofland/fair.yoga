# Task 1 Report: Refactor `invalidateSession` and `revokeRequestSession` with unit tests

## Overview
Implemented Task 1 of the implementation plan (`docs/superpowers/plans/2026-09-18-session-delete-error-handling.md`) for Issue #641:
- Refactored `invalidateSession(db, token)` in `src/lib/auth/session.ts` to use `db.session.deleteMany({ where: { id: sessionHash } })` and return `Promise<boolean>` (`count > 0`), ensuring missing records remain safe no-ops returning `false` while database errors bubble up.
- Refactored `revokeRequestSession(db, request)` in `src/lib/auth/session.ts` to delegate directly to `invalidateSession(db, token)` once extracted from the cookie store.
- Updated docblocks for both functions accurately describing their error semantics, return values, and callers.
- Updated and expanded unit tests in `src/lib/auth/session.test.ts` covering both functions and all edge cases.
- Validated with mutation testing and verified the full test suite (`pnpm run verify`).

---

## Files Changed

1. `src/lib/auth/session.ts`:
   - Updated `invalidateSession` signature to return `Promise<boolean>`.
   - Used `deleteMany` so missing sessions do not throw and return `false`.
   - Updated `revokeRequestSession` to delegate to `invalidateSession`.
   - Updated docblocks for both functions.
2. `src/lib/auth/session.test.ts`:
   - Imported `revokeRequestSession`.
   - Updated `describe('invalidateSession')` test to assert return value is `true` and that validate returns `null`.
   - Added test for `invalidateSession` returning `false` without throwing when token does not exist in the database.
   - Added `describe('revokeRequestSession')` covering:
     - Returns `false` when request carries no session cookie.
     - Revokes active session and returns `true` when session exists.
     - Returns `false` without throwing when session cookie names an absent session.
3. `docs/superpowers/plans/2026-09-18-session-delete-error-handling.md`:
   - Marked Task 1 steps as completed.

---

## Code Diffs

### `src/lib/auth/session.ts`
```diff
@@ -120,29 +120,40 @@ export async function validateSession(
   return null;
 }
 
+/**
+ * Invalidate a session by its raw token.
+ *
+ * Uses `deleteMany` rather than `delete`: a row that is already absent is this
+ * function's postcondition, not an error — missing records safely return `false`
+ * without throwing, while genuine database failures bubble to the caller.
+ *
+ * Returns `true` if a session was found and deleted, `false` if it did not exist.
+ */
 export async function invalidateSession(
   db: PrismaClient,
-  token: string
-): Promise<void> {
+  token: string,
+): Promise<boolean> {
   const sessionHash = hashToken(token);
-  await db.session.delete({
+  const { count } = await db.session.deleteMany({
     where: { id: sessionHash },
   });
+  return count > 0;
 }
 
 /**
- * Revoke whatever session the request carries, if it carries one. For a door
- * that ends a sign-in as a side effect of doing something else, where the
- * caller has no token in hand to pass to `invalidateSession`.
- *
- * `deleteMany` rather than `delete`: a row that has already gone is this
- * function's postcondition, not an error worth catching — and writing it that
- * way keeps a genuine database failure from being swallowed alongside it.
+ * Revoke whatever session the request carries, if it carries one. For doors
+ * that end a sign-in (e.g. sign-out route, magic-link verification/claim) where
+ * the caller has an incoming `NextRequest` rather than a raw token.
  *
+ * Delegates to `invalidateSession` once the session token is extracted from cookies.
  *
  * Answers whether a sign-in actually ended, which is narrower than whether a
  * cookie was carried: a cookie naming a session that had already expired or
  * been revoked cost its holder nothing, and a caller reporting the sign-out
  * to them would be describing something that did not happen.
+ *
+ * Returns `true` if an active session was found and deleted, `false` if no cookie
+ * was present or the session was already absent. Genuine database failures bubble up.
  */
 export async function revokeRequestSession(
   db: PrismaClient,
@@ -150,8 +161,7 @@ export async function revokeRequestSession(
 ): Promise<boolean> {
   const token = getSessionToken(request);
   if (!token) return false;
-  const { count } = await db.session.deleteMany({ where: { id: hashToken(token) } });
-  return count > 0;
+  return invalidateSession(db, token);
 }
 
 /**
```

### `src/lib/auth/session.test.ts`
```diff
@@ -9,6 +9,7 @@ import {
   createSession,
   validateSession,
   invalidateSession,
+  revokeRequestSession,
   getSessionToken,
   setSessionCookie,
   clearSessionCookie,
@@ -336,13 +337,50 @@ describe('validateSession', () => {
 });
 
 describe('invalidateSession', () => {
-  it('deletes the session so subsequent validate returns null', async () => {
+  it('deletes the session so subsequent validate returns null and returns true', async () => {
     const token = await createSession(db, teacherAccountId);
 
     expect(await validateSession(db, token)).not.toBeNull();
-    await invalidateSession(db, token);
+    const result = await invalidateSession(db, token);
+    expect(result).toBe(true);
     expect(await validateSession(db, token)).toBeNull();
   });
+
+  it('returns false without throwing when token does not exist in the database', async () => {
+    const nonExistentToken = '0'.repeat(64);
+    const result = await invalidateSession(db, nonExistentToken);
+    expect(result).toBe(false);
+  });
+});
+
+describe('revokeRequestSession', () => {
+  it('returns false when request carries no session cookie', async () => {
+    const request = new NextRequest('http://localhost');
+    const result = await revokeRequestSession(db, request);
+    expect(result).toBe(false);
+  });
+
+  it('revokes active session and returns true when session exists', async () => {
+    const token = await createSession(db, teacherAccountId);
+    const request = new NextRequest('http://localhost', {
+      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
+    });
+
+    expect(await validateSession(db, token)).not.toBeNull();
+    const result = await revokeRequestSession(db, request);
+    expect(result).toBe(true);
+    expect(await validateSession(db, token)).toBeNull();
+  });
+
+  it('returns false without throwing when session cookie names an absent session', async () => {
+    const nonExistentToken = '0'.repeat(64);
+    const request = new NextRequest('http://localhost', {
+      headers: { Cookie: `${SESSION_COOKIE_NAME}=${nonExistentToken}` },
+    });
+
+    const result = await revokeRequestSession(db, request);
+    expect(result).toBe(false);
+  });
 });
 
 describe('getSessionToken', () => {
```

---

## Test Execution Output

### `pnpm exec vitest run src/lib/auth/session.test.ts`
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  29 passed (29)
   Start at  13:54:23
   Duration  1.69s (transform 23ms, setup 0ms, import 114ms, tests 190ms, environment 0ms)
```

### `pnpm run typecheck`
```
$ tsc --noEmit
(clean exit 0)
```

### `pnpm run lint`
```
$ eslint
✖ 6 problems (0 errors, 6 warnings)
(clean exit 0)
```

### `pnpm run verify`
```
Test Files  77 passed (77)
     Tests  981 passed (981)
  Duration  233.08s
$ tsx scripts/check-lockfile.ts
✓ pnpm-lock.yaml passes supply-chain policy (703 entries checked)
$ tsx scripts/check-migrations.ts
✓ No applied migrations amended
$ tsx scripts/check-visual-baseline-freshness.ts
✓ Visual baselines are up to date with the routes they cover
(clean exit 0)
```

---

## Mutation Testing Protocol

### Mutation Applied
Replaced `db.session.deleteMany` with `db.session.delete` in `src/lib/auth/session.ts`:
```ts
export async function invalidateSession(
  db: PrismaClient,
  token: string,
): Promise<boolean> {
  const sessionHash = hashToken(token);
  await db.session.delete({
    where: { id: sessionHash },
  });
  return true;
}
```

### Failure Observed
Running `pnpm exec vitest run src/lib/auth/session.test.ts` failed with 2 errors:
```
 ❯ |unit| src/lib/auth/session.test.ts (29 tests | 2 failed) 209ms
     × returns false without throwing when token does not exist in the database 8ms
     × returns false without throwing when session cookie names an absent session 3ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| src/lib/auth/session.test.ts > invalidateSession > returns false without throwing when token does not exist in the database
PrismaClientKnownRequestError: 
Invalid `db.session.delete()` invocation in
/Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts:137:20

  134   token: string,
  135 ): Promise<boolean> {
  136   const sessionHash = hashToken(token);
→ 137   await db.session.delete(
An operation failed because it depends on one or more records that were required but not found. No record was found for a delete.

 FAIL  |unit| src/lib/auth/session.test.ts > revokeRequestSession > returns false without throwing when session cookie names an absent session
PrismaClientKnownRequestError: 
Invalid `db.session.delete()` invocation in
/Users/ivohofland/Projects/fair.yoga/src/lib/auth/session.ts:137:20

  134   token: string,
  135 ): Promise<boolean> {
  136   const sessionHash = hashToken(token);
→ 137   await db.session.delete(
An operation failed because it depends on one or more records that were required but not found. No record was found for a delete.
```

### Restoration and Confirmation
Restored `src/lib/auth/session.ts` back to `deleteMany`.
Re-ran `pnpm exec vitest run src/lib/auth/session.test.ts`: 29 passed (29). All green.
