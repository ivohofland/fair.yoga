# Task 1 Report: Widen `src/proxy.ts` matcher and verify proxy routing

## Overview
Implemented Task 1 of Issue #615 to expand protected route coverage in `src/proxy.ts` so that unauthenticated visitors to `/schedule`, `/studio-class`, `/account`, and `/updates` routes are intercepted by proxy middleware and redirected to `/login?redirect=<path+query>` with `x-pathname` stamping on authenticated requests.

## Changes Made

### 1. `src/proxy.ts`
Expanded `config.matcher` from 5 route prefixes to all 9 protected prefixes:
- `/schedule/:path*`
- `/studio-class/:path*`
- `/students/:path*`
- `/inbox/:path*`
- `/settings/:path*`
- `/class/:path*`
- `/bookings/:path*`
- `/account/:path*`
- `/updates/:path*`

### 2. `src/proxy.test.ts`
- Updated the matcher test (`matches the 9 protected route prefixes`) to assert all 9 prefixes in `config.matcher`.
- Added test cases verifying that unauthenticated requests to:
  - `/schedule` -> `307` redirect to `/login?redirect=%2Fschedule`
  - `/studio-class/sc-1` -> `307` redirect to `/login?redirect=%2Fstudio-class%2Fsc-1`
  - `/account/privacy` -> `307` redirect to `/login?redirect=%2Faccount%2Fprivacy`
  - `/updates` -> `307` redirect to `/login?redirect=%2Fupdates`
- Added test verifying query parameter preservation on new routes:
  - `/account/privacy?tab=invitations` -> `307` redirect to `/login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations`

---

## Code Diffs

### `src/proxy.ts`
```diff
@@ -26,11 +26,15 @@
 
 export const config = {
   matcher: [
+    '/schedule/:path*',
+    '/studio-class/:path*',
     '/students/:path*',
     '/inbox/:path*',
     '/settings/:path*',
     '/class/:path*',
     '/bookings/:path*',
+    '/account/:path*',
+    '/updates/:path*',
   ],
 };
```

### `src/proxy.test.ts`
```diff
@@ -33,6 +33,45 @@
       const location = response.headers.get('location');
       expect(location).toBe('http://localhost:3000/login?redirect=%2Fstudents%2Fstu-1%3Ftab%3Dnotes%26filter%3Dactive');
     });
+    it('redirects unauthenticated request on /schedule to login with redirect param', () => {
+      const request = makeRequest('/schedule');
+      const response = proxy(request);
+
+      expect(response.status).toBe(307);
+      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fschedule');
+    });
+
+    it('redirects unauthenticated request on /studio-class/sc-1 to login with redirect param', () => {
+      const request = makeRequest('/studio-class/sc-1');
+      const response = proxy(request);
+
+      expect(response.status).toBe(307);
+      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fstudio-class%2Fsc-1');
+    });
+
+    it('redirects unauthenticated request on /account/privacy to login with redirect param', () => {
+      const request = makeRequest('/account/privacy');
+      const response = proxy(request);
+
+      expect(response.status).toBe(307);
+      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Faccount%2Fprivacy');
+    });
+
+    it('redirects unauthenticated request on /updates to login with redirect param', () => {
+      const request = makeRequest('/updates');
+      const response = proxy(request);
+
+      expect(response.status).toBe(307);
+      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fupdates');
+    });
+
+    it('preserves query parameters on newly protected routes', () => {
+      const request = makeRequest('/account/privacy?tab=invitations');
+      const response = proxy(request);
+
+      expect(response.status).toBe(307);
+      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations');
+    });
   });
 
   describe('authenticated requests', () => {
@@ -61,8 +100,12 @@
   });
 
   describe('config matcher', () => {
-    it('matches the 5 protected route prefixes', () => {
+    it('matches the 9 protected route prefixes', () => {
       expect(config.matcher).toEqual([
+        '/schedule/:path*',
+        '/studio-class/:path*',
         '/students/:path*',
         '/inbox/:path*',
         '/settings/:path*',
@@ -69,4 +112,6 @@
         '/bookings/:path*',
+        '/account/:path*',
+        '/updates/:path*',
       ]);
     });
   });
```

---

## Test Execution Output

`pnpm exec vitest run src/proxy.test.ts`
```
 RUN  v4.1.10 /Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615

[unit-db] DATABASE_URL_TEST not set — using DATABASE_URL as-is

 ✓ |unit| src/proxy.test.ts (10 tests) 8ms
   ✓ proxy (10)
     ✓ unauthenticated requests (7)
       ✓ redirects to /login with redirect query param for protected path 3ms
       ✓ preserves query parameters in redirect URL 0ms
       ✓ redirects unauthenticated request on /schedule to login with redirect param 0ms
       ✓ redirects unauthenticated request on /studio-class/sc-1 to login with redirect param 0ms
       ✓ redirects unauthenticated request on /account/privacy to login with redirect param 0ms
       ✓ redirects unauthenticated request on /updates to login with redirect param 0ms
       ✓ preserves query parameters on newly protected routes 0ms
     ✓ authenticated requests (2)
       ✓ passes through and stamps x-pathname header 1ms
       ✓ strips client-supplied x-pathname and overwrites with actual path 1ms
     ✓ config matcher (1)
       ✓ matches the 9 protected route prefixes 0ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
   Start at  09:20:37
   Duration  292ms (transform 17ms, setup 0ms, import 84ms, tests 8ms, environment 0ms)
```

`pnpm run typecheck`
```
$ tsc --noEmit
(clean exit 0)
```

`pnpm exec eslint src/proxy.ts src/proxy.test.ts`
```
(clean exit 0)
```

---

## Mutation Testing Protocol

### Mutation Applied
Removed `'/schedule/:path*'` from `config.matcher` in `src/proxy.ts`.

### Failure Observed
```
 ❯ |unit| src/proxy.test.ts (10 tests | 1 failed) 11ms
   ❯ proxy (10)
     ✓ unauthenticated requests (7)
     ✓ authenticated requests (2)
     ❯ config matcher (1)
       × matches the 9 protected route prefixes 4ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| src/proxy.test.ts > proxy > config matcher > matches the 9 protected route prefixes
AssertionError: expected [ '/studio-class/:path*', …(7) ] to deeply equal [ '/schedule/:path*', …(8) ]

- Expected
+ Received

@@ -1,7 +1,6 @@
  [
-   "/schedule/:path*",
    "/studio-class/:path*",
    "/students/:path*",
    "/inbox/:path*",
    "/settings/:path*",
    "/class/:path*",

 ❯ src/proxy.test.ts:105:30
    103|   describe('config matcher', () => {
    104|     it('matches the 9 protected route prefixes', () => {
    105|       expect(config.matcher).toEqual([
       |                              ^
    106|         '/schedule/:path*',
    107|         '/studio-class/:path*',
```

### Restoration and Confirmation
Restored `'/schedule/:path*'` in `src/proxy.ts`.
Ran `pnpm exec vitest run src/proxy.test.ts`.
Result: 10 passed (10). Suite is green.
