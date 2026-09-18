# Task 2 Report: Refactor `DELETE /api/auth/session` to propagate errors, add route unit tests and integration tests

## Overview
Implemented Task 2 of the implementation plan (`docs/superpowers/plans/2026-09-18-session-delete-error-handling.md`) for Issue #641:
- Refactored `DELETE` handler in `src/app/api/auth/session/route.ts`:
  - Replaced imports: dropped `getSessionToken` and `invalidateSession`, imported `revokeRequestSession` from `@/lib/auth`.
  - Updated handler to call `await revokeRequestSession(prisma, request);` directly without the previous swallow-all empty `catch {}` block.
  - Retained cookie clearing (`clearSessionCookie(response.headers)`) and 200 response `{ data: { message: 'Logged out' } }`.
- Created route unit tests in `src/app/api/auth/session/route.test.ts`:
  - Directly invoked `DELETE` handler with `NextRequest`.
  - Verified 200 + cleared session cookie (`Max-Age=0`) when session cookie is present.
  - Verified 200 + cleared session cookie when no session cookie is present without calling `prisma.session.deleteMany`.
  - Verified database error propagation: when `prisma.session.deleteMany` rejects (e.g. `new Error('connection failed')`), the error bubbles out of the handler into `withErrorHandler`, which logs via `log.error` with request context (`method: 'DELETE'`, `path: '/api/auth/session'`) and responds with HTTP 500 (`Internal server error`).
- Added HTTP integration tests in `tests/integration/auth.test.ts`:
  - Tested `DELETE /api/auth/session` over HTTP against the running app using `fetch` and `cookie(sessionToken)`.
  - Verified 200 status, `Set-Cookie` with `Max-Age=0`, and that `validateSession(prisma, sessionToken)` returns `null`.
  - Verified idempotency: second `DELETE /api/auth/session` with the revoked token returns 200 and clears the cookie.
- Executed mutation testing protocol:
  - Wrapped `await revokeRequestSession(prisma, request)` in `try {} catch {}`.
  - Verified `route.test.ts` caught the defect by failing with `expected 200 to be 500`.
  - Restored code and confirmed tests pass.
- Verified the complete gate (`pnpm run verify`: typecheck, lint, full vitest unit/integration/components/sweeps suites, lockfile, migrations, visual baseline).

---

## Files Changed

1. `src/app/api/auth/session/route.ts`:
   - Replaced `getSessionToken` and `invalidateSession` imports with `revokeRequestSession`.
   - Removed empty `try { ... } catch {}` block; called `await revokeRequestSession(prisma, request);` directly so database errors bubble to `withErrorHandler`.
2. `src/app/api/auth/session/route.test.ts` (New):
   - Created route handler unit tests verifying 200 on present session cookie, 200 on absent session cookie, and 500 + `log.error` on database error.
3. `tests/integration/auth.test.ts`:
   - Imported `BASE_URL` and `cookie` from `../helpers`.
   - Added `describe('DELETE /api/auth/session')` integration tests for active session revocation and idempotency over HTTP.
4. `docs/superpowers/plans/2026-09-18-session-delete-error-handling.md`:
   - Marked all Task 2 steps as completed.

---

## Code Diffs

### `src/app/api/auth/session/route.ts`
```diff
@@ -1,7 +1,6 @@
 import { NextRequest } from 'next/server';
 import {
-  getSessionToken,
-  invalidateSession,
+  revokeRequestSession,
   clearSessionCookie,
 } from '@/lib/auth';
 import {
@@ -24,15 +23,7 @@ export const GET = withErrorHandler(async (request: NextRequest) => {
 });
 
 export const DELETE = withErrorHandler(async (request: NextRequest) => {
-  const token = getSessionToken(request);
-
-  if (token) {
-    try {
-      await invalidateSession(prisma, token);
-    } catch {
-      // Session may already be deleted — that's fine
-    }
-  }
+  await revokeRequestSession(prisma, request);
 
   const response = respondOk({ message: 'Logged out' });
   clearSessionCookie(response.headers);
```

### `src/app/api/auth/session/route.test.ts`
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { DELETE } from './route';

/**
 * Route unit tests for `DELETE /api/auth/session`.
 *
 * Direct test of the route handler:
 * - When a session cookie is present, delegates revocation to `revokeRequestSession`
 *   and returns 200 with an expired cookie.
 * - When no session cookie is present, safely returns 200 with an expired cookie
 *   without querying the database.
 * - When session deletion encounters a database failure, bubbles out of the handler
 *   to `withErrorHandler`, which logs the error at `error` level and responds with HTTP 500 (#641).
 */
describe('DELETE /api/auth/session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with logged out message and cleared cookie when session cookie is present', async () => {
    const deleteManySpy = vi.spyOn(prisma.session, 'deleteMany').mockResolvedValue({ count: 1 });

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
      headers: {
        cookie: 'fair_yoga_session=active-session-token',
      },
    });

    const res = await DELETE(request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string } };
    expect(body.data.message).toBe('Logged out');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('fair_yoga_session=;');
    expect(setCookie).toContain('Max-Age=0');

    expect(deleteManySpy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with logged out message and cleared cookie when no session cookie is present', async () => {
    const deleteManySpy = vi.spyOn(prisma.session, 'deleteMany');

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
    });

    const res = await DELETE(request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string } };
    expect(body.data.message).toBe('Logged out');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('fair_yoga_session=;');
    expect(setCookie).toContain('Max-Age=0');

    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it('propagates database error to withErrorHandler, logging error and answering 500', async () => {
    const dbError = new Error('connection failed');
    vi.spyOn(prisma.session, 'deleteMany').mockRejectedValue(dbError);
    const logErrorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
      headers: {
        cookie: 'fair_yoga_session=active-session-token',
      },
    });

    const res = await DELETE(request);

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Internal server error');

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: dbError,
        method: 'DELETE',
        path: '/api/auth/session',
      }),
      'unhandled API error',
    );
  });
});
```

### `tests/integration/auth.test.ts`
```diff
@@ -13,7 +13,7 @@ import {
   generateMagicLinkToken,
   verifyMagicLinkToken,
 } from '@/lib/auth';
-import { hashToken, uniqueSuffix } from '../helpers';
+import { hashToken, uniqueSuffix, BASE_URL, cookie } from '../helpers';
 
 const prisma = new PrismaClient();
 const suffix = uniqueSuffix();
@@ -197,3 +197,47 @@ describe('Session expiry', () => {
     expect(result).toBeNull();
   });
 });
+
+describe('DELETE /api/auth/session', () => {
+  it('revokes active session, clears cookie, and invalidates session in database', async () => {
+    const sessionToken = await createSession(prisma, teacherAccountId);
+
+    const before = await validateSession(prisma, sessionToken);
+    expect(before).not.toBeNull();
+
+    const res = await fetch(`${BASE_URL}/api/auth/session`, {
+      method: 'DELETE',
+      headers: cookie(sessionToken),
+    });
+
+    expect(res.status).toBe(200);
+    const setCookie = res.headers.get('set-cookie');
+    expect(setCookie).toContain('fair_yoga_session=;');
+    expect(setCookie).toContain('Max-Age=0');
+
+    const after = await validateSession(prisma, sessionToken);
+    expect(after).toBeNull();
+  });
+
+  it('is idempotent when called a second time with the revoked token', async () => {
+    const sessionToken = await createSession(prisma, teacherAccountId);
+
+    const firstRes = await fetch(`${BASE_URL}/api/auth/session`, {
+      method: 'DELETE',
+      headers: cookie(sessionToken),
+    });
+    expect(firstRes.status).toBe(200);
+    expect(await validateSession(prisma, sessionToken)).toBeNull();
+
+    const secondRes = await fetch(`${BASE_URL}/api/auth/session`, {
+      method: 'DELETE',
+      headers: cookie(sessionToken),
+    });
+
+    expect(secondRes.status).toBe(200);
+    const secondCookie = secondRes.headers.get('set-cookie');
+    expect(secondCookie).toContain('fair_yoga_session=;');
+    expect(secondCookie).toContain('Max-Age=0');
+  });
+});
```

---

## Test Execution Output

### `pnpm exec vitest run src/app/api/auth/session/route.test.ts`
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  17:16:30
   Duration  1.76s (transform 108ms, setup 0ms, import 503ms, tests 9ms, environment 0ms)
```

### `pnpm exec vitest run --project integration tests/integration/auth.test.ts`
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  17:16:35
   Duration  771ms (transform 132ms, setup 0ms, import 500ms, tests 152ms, environment 0ms)
```

### `pnpm run verify`
```
$ pnpm run typecheck && pnpm run lint && pnpm test && pnpm run check-lockfile && pnpm run check-migrations && pnpm run check-visual-baseline-freshness
$ tsc --noEmit
$ eslint .
$ pnpm run test:unit && pnpm run test:sweeps
$ vitest run --project unit --project integration --project components

 Test Files  103 passed (103)
      Tests  839 passed (839)
   Start at  17:16:49
   Duration  26.16s (transform 3.01s, setup 5.56s, import 17.51s, tests 14.88s, environment 1.87s)

$ vitest run --project unit-sweeps

 Test Files  30 passed (30)
      Tests  183 passed (183)
   Start at  17:17:17
   Duration  26.06s (transform 3.86s, setup 305ms, import 6.09s, tests 23.36s, environment 0ms)

$ pnpm install --frozen-lockfile --prefer-offline
Lockfile is up to date, resolution step is skipped
Already up to date
$ prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code
No difference detected.
$ tsx scripts/check-visual-baseline-freshness.ts
Baseline freshness: checked 1 snapshots across 1 directories. All fresh.
```

---

## Mutation Testing Protocol

### Mutation Applied
Wrapped `await revokeRequestSession(prisma, request)` in `try { ... } catch {}` in `src/app/api/auth/session/route.ts`:
```ts
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  try {
    await revokeRequestSession(prisma, request);
  } catch {}

  const response = respondOk({ message: 'Logged out' });
  clearSessionCookie(response.headers);

  return response;
});
```

### Failure Observed
Running `pnpm exec vitest run src/app/api/auth/session/route.test.ts` failed with 1 test failure:
```
 FAIL  |unit| src/app/api/auth/session/route.test.ts > DELETE /api/auth/session > propagates database error to withErrorHandler, logging error and answering 500
AssertionError: expected 200 to be 500 // Object.is equality

- Expected
+ Received

- 500
+ 200

 ❯ src/app/api/auth/session/route.test.ts:80:24
     78|     const res = await DELETE(request);
     79|
     80|     expect(res.status).toBe(500);
       |                        ^
     81|     const body = (await res.json()) as { error: { message: string } };
     82|     expect(body.error.message).toBe('Internal server error');


 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
   Duration  1.82s
```

### Restoration and Confirmation
Restored `src/app/api/auth/session/route.ts` back to:
```ts
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  await revokeRequestSession(prisma, request);

  const response = respondOk({ message: 'Logged out' });
  clearSessionCookie(response.headers);

  return response;
});
```
Re-ran `pnpm exec vitest run src/app/api/auth/session/route.test.ts`: 3 passed (3). Green.
Re-ran `pnpm exec vitest run --project integration tests/integration/auth.test.ts`: 7 passed (7). Green.

---

## Git State
As instructed, git changes have NOT been committed:
- `src/app/api/auth/session/route.ts` (modified)
- `tests/integration/auth.test.ts` (modified)
- `src/app/api/auth/session/route.test.ts` (untracked)
- `docs/superpowers/plans/2026-09-18-session-delete-error-handling.md` (modified)
- `docs/superpowers/plans/task-2-report.md` (untracked)
