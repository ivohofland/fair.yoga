# Task 3 Report: Defense-in-depth in layouts and session guards

## Overview
Implemented Task 3 of Issue #615 to provide defense-in-depth destination preservation in layouts and session guards for cases where an expired or invalid session cookie passes proxy cookie-presence checks:
- Updated `src/lib/student-guard.ts`:
  - Widened signature to `redirectNonStudent(session: SessionUser | null, redirectPath?: string | null): never`.
  - Preserved existing behavior for teachers: if `session?.teacherId`, redirect to `/schedule` (even if `redirectPath` is provided).
  - If `redirectPath && isSafeRelativePath(redirectPath)`, redirect to `/login?redirect=${encodeURIComponent(redirectPath)}`.
  - Else redirect to bare `/login`.
- Created unit tests in `src/lib/student-guard.test.ts` covering:
  - Teacher session redirects to `/schedule` (both with and without `redirectPath`).
  - Unauthenticated session with valid `redirectPath` (`/account/privacy`) redirects to `/login?redirect=%2Faccount%2Fprivacy`.
  - Unauthenticated session with unsafe `redirectPath` (`//evil.com`, `/\evil.com`, `https://evil.com`) redirects to bare `/login`.
  - Unauthenticated session without `redirectPath` (or with `null` / empty string) redirects to bare `/login`.
- Updated `src/app/(student)/layout.tsx`:
  - Imported `headers` from `'next/headers'`.
  - Read `x-pathname` from `(await headers()).get('x-pathname')`.
  - Passed `pathname` to `redirectNonStudent(session, pathname)`.
- Updated `src/app/(teacher)/layout.tsx`:
  - Imported `isSafeRelativePath` from `@/lib/schemas`.
  - Read `pathname` from `headers()` at the start of the `!session?.teacherId` block.
  - Kept existing redirect to `/account` or `/bookings` when `session?.studentId` is present.
  - When unauthenticated (`!session?.teacherId && !session?.studentId`), if `pathname && isSafeRelativePath(pathname)`, redirected to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.
- Updated `src/lib/session.ts`:
  - Imported `headers` from `'next/headers'` and `isSafeRelativePath` from `@/lib/schemas`.
  - In `requireTeacherSession()` when `!session?.teacherId`, read `pathname` from `(await headers()).get('x-pathname')`. If `pathname && isSafeRelativePath(pathname)`, redirected to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.
- Executed full test verification, lint checks, typechecks, and mutation testing.

---

## Code Diffs

### `src/lib/student-guard.ts`
```diff
@@ -1,4 +1,5 @@
 import { redirect } from 'next/navigation';
+import { isSafeRelativePath } from '@/lib/schemas';
 import type { SessionUser } from '@/lib/types';
 
 /**
@@ -5,6 +6,16 @@
  * goes to their own home rather than a sign-in form they cannot use.
+ * Preserves the intended destination when sending an unauthenticated visitor to login.
  */
-export function redirectNonStudent(session: SessionUser | null): never {
-  redirect(session?.teacherId ? '/schedule' : '/login');
+export function redirectNonStudent(
+  session: SessionUser | null,
+  redirectPath?: string | null,
+): never {
+  if (session?.teacherId) {
+    redirect('/schedule');
+  } else if (redirectPath && isSafeRelativePath(redirectPath)) {
+    redirect(`/login?redirect=${encodeURIComponent(redirectPath)}`);
+  } else {
+    redirect('/login');
+  }
 }
```

### `src/lib/student-guard.test.ts` (NEW)
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirectNonStudent } from './student-guard';
import type { SessionUser } from '@/lib/types';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect,
}));

const teacherSession: SessionUser = {
  sessionId: 'sess-1',
  accountId: 'acc-1',
  teacherId: 'teacher-1',
  studentId: null,
  defaultTimezone: 'America/New_York',
};

describe('redirectNonStudent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects a teacher session to /schedule', () => {
    redirectNonStudent(teacherSession);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/schedule');
  });

  it('redirects a teacher session to /schedule even when redirectPath is provided', () => {
    redirectNonStudent(teacherSession, '/account/privacy');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/schedule');
  });

  it('redirects unauthenticated session with valid redirectPath to login with encoded redirect', () => {
    redirectNonStudent(null, '/account/privacy');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login?redirect=%2Faccount%2Fprivacy');
  });

  it('redirects unauthenticated session with unsafe redirectPath to bare /login', () => {
    const unsafePaths = ['//evil.com', '/\\evil.com', 'https://evil.com'];
    for (const unsafePath of unsafePaths) {
      vi.clearAllMocks();
      redirectNonStudent(null, unsafePath);
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith('/login');
    }
  });

  it('redirects unauthenticated session without redirectPath to bare /login', () => {
    redirectNonStudent(null);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('redirects unauthenticated session with null or empty redirectPath to bare /login', () => {
    redirectNonStudent(null, null);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');

    vi.clearAllMocks();
    redirectNonStudent(null, '');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});
```

### `src/app/(student)/layout.tsx`
```diff
@@ -1,3 +1,4 @@
+import { headers } from 'next/headers';
 import { getSession } from '@/lib/session';
 import { redirectNonStudent } from '@/lib/student-guard';
 import { LiveUpdates } from '@/components/layout/live-updates';
@@ -10,7 +11,8 @@
   // A signed-in teacher-only account belongs on its own home, not a
   // sign-in form it cannot use.
   if (!session?.studentId) {
-    redirectNonStudent(session);
+    const pathname = (await headers()).get('x-pathname');
+    redirectNonStudent(session, pathname);
   }
 
   return (
```

### `src/app/(teacher)/layout.tsx`
```diff
@@ -2,6 +2,7 @@
 import { headers } from 'next/headers';
 import { getSession } from '@/lib/session';
 import { prisma } from '@/lib/db';
+import { isSafeRelativePath } from '@/lib/schemas';
 import { TabBar } from '@/components/layout/tab-bar';
 import { LiveUpdates } from '@/components/layout/live-updates';
 
@@ -14,9 +15,12 @@
   // sign-in form it cannot use — except /settings, which courteously
   // maps to their own settings (x-pathname stamped by the proxy).
   if (!session?.teacherId) {
+    const pathname = (await headers()).get('x-pathname');
     if (session?.studentId) {
-      const pathname = (await headers()).get('x-pathname') ?? '';
-      redirect(pathname.startsWith('/settings') ? '/account' : '/bookings');
+      redirect((pathname ?? '').startsWith('/settings') ? '/account' : '/bookings');
+    }
+    if (pathname && isSafeRelativePath(pathname)) {
+      redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
     }
     redirect('/login');
   }
```

### `src/lib/session.ts`
```diff
@@ -1,7 +1,8 @@
-import { cookies } from 'next/headers';
+import { cookies, headers } from 'next/headers';
 import { redirect } from 'next/navigation';
 import { validateSession } from '@/lib/auth';
 import { prisma } from '@/lib/db';
+import { isSafeRelativePath } from '@/lib/schemas';
 import type { SessionUser, TeacherSession } from '@/lib/types';
 
 export async function getSession(): Promise<SessionUser | null> {
@@ -13,6 +14,10 @@
 export async function requireTeacherSession(): Promise<TeacherSession> {
   const session = await getSession();
   if (!session?.teacherId) {
+    const pathname = (await headers()).get('x-pathname');
+    if (pathname && isSafeRelativePath(pathname)) {
+      redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
+    }
     redirect('/login');
   }
   return { ...session, teacherId: session.teacherId };
```

---

## Verification & Test Results

### 1. Guard Unit Tests: `pnpm exec vitest run src/lib/student-guard.test.ts`
```
 RUN  v4.1.10 /Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615

 ✓ |unit| src/lib/student-guard.test.ts (6 tests) 4ms
   ✓ redirectNonStudent (6)
     ✓ redirects a teacher session to /schedule 1ms
     ✓ redirects a teacher session to /schedule even when redirectPath is provided 0ms
     ✓ redirects unauthenticated session with valid redirectPath to login with encoded redirect 0ms
     ✓ redirects unauthenticated session with unsafe redirectPath to bare /login 0ms
     ✓ redirects unauthenticated session without redirectPath to bare /login 0ms
     ✓ redirects unauthenticated session with null or empty redirectPath to bare /login 0ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  09:31:28
   Duration  344ms (transform 34ms, setup 0ms, import 133ms, tests 4ms, environment 0ms)
```

### 2. Components Test Tier: `pnpm exec vitest run --project components`
```
 Test Files  72 passed (72)
      Tests  593 passed (593)
   Start at  09:31:30
   Duration  16.81s (transform 3.51s, setup 20.96s, import 8.99s, tests 20.65s, environment 82.73s)
```

### 3. TypeScript Typecheck: `pnpm run typecheck`
```
$ tsc --noEmit
Exit code: 0
```

### 4. ESLint: Modified Files and Project-wide
```bash
pnpm exec eslint src/lib/student-guard.ts src/lib/student-guard.test.ts "src/app/(student)/layout.tsx" "src/app/(teacher)/layout.tsx" src/lib/session.ts
```
Result: Clean exit (code 0, 0 errors, 0 warnings).

Project-wide `pnpm run lint`: Clean exit (code 0, 0 errors, 6 pre-existing warnings in unrelated files).

---

## Mutation Testing

### Target Guard
`src/lib/student-guard.ts` — `redirectPath` safe destination redirection.

### Applied Mutation
Removed the `redirectPath && isSafeRelativePath(redirectPath)` conditional branch:
```typescript
export function redirectNonStudent(
  session: SessionUser | null,
  redirectPath?: string | null,
): never {
  if (session?.teacherId) {
    redirect('/schedule');
  } else {
    redirect('/login');
  }
}
```

### Mutation Test Run (`pnpm exec vitest run src/lib/student-guard.test.ts`)
```
 FAIL  |unit| src/lib/student-guard.test.ts > redirectNonStudent > redirects unauthenticated session with valid redirectPath to login with encoded redirect
AssertionError: expected "vi.fn()" to be called with arguments: [ Array(1) ]

Received:

  1st vi.fn() call:

  [
-   "/login?redirect=%2Faccount%2Fprivacy",
+   "/login",
  ]


Number of calls: 1 

 ❯ src/lib/student-guard.test.ts:41:22
     39|     redirectNonStudent(null, '/account/privacy');
     40|     expect(redirect).toHaveBeenCalledTimes(1);
     41|     expect(redirect).toHaveBeenCalledWith('/login?redirect=%2Faccount%…
       |                      ^
     42|   });
     43|

 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

### Restoration
Restored `src/lib/student-guard.ts` to include `else if (redirectPath && isSafeRelativePath(redirectPath))`.
Re-ran `pnpm exec vitest run src/lib/student-guard.test.ts`:
```
 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  09:32:20
   Duration  357ms
```
Green status confirmed.
