# Login Destination Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the intended destination URL when an unauthenticated visitor accesses a sign-in-protected route on fair.yoga, ensuring they are redirected back to the requested page upon signing in with either a magic link or passkey (#615).

**Architecture:**
- **Proxy Expansion:** Widen `src/proxy.ts` matcher to include all 9 protected route prefixes (`/schedule/:path*`, `/studio-class/:path*`, `/students/:path*`, `/inbox/:path*`, `/settings/:path*`, `/class/:path*`, `/bookings/:path*`, `/account/:path*`, `/updates/:path*`).
- **Login Parameter Forwarding:** Update `src/app/(public)/login/page.tsx` with `<Suspense>` and `useSearchParams()` to extract and validate `redirect` using `isSafeRelativePath` (length $\le 200$), forwarding it to `/api/auth/magic-link/send` and `<PasskeySignIn redirect={redirect} />`.
- **Layout & Guard Fallbacks:** Update `TeacherLayout`, `StudentLayout`, `redirectNonStudent`, and `requireTeacherSession` to inspect `x-pathname` from headers and preserve destination if an invalid or expired session reaches them.
- **Verification:** Unit tests for proxy and guards, component tests for login page forwarding and safety filtering, and E2E test for end-to-end destination preservation across auth.

**Tech Stack:** Next.js 16 (App Router with `proxy.ts`), React 19, TypeScript, Vitest 4, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-login-redirect-preservation-design.md`.

---

## Global Constraints

- TypeScript `strict`, no `any`.
- Never bypass or relax `isSafeRelativePath` validation. Unsafe `redirect` values must be discarded silently with no user error.
- Comments describe the code they sit on; no counts or rosters in comments (`CLAUDE.md`, *Comment Discipline*).
- Never `git add -A` or `git add .` — stage exact paths.
- Never restart or kill the dev server on `:3000`.
- Mutation testing protocol: For each guard introduced or modified, apply a deliberate mutation, observe the test fail with the expected error, restore the file, and confirm green.

---

### Task 1: Widen `src/proxy.ts` matcher and verify proxy routing

**Files:**
- Modify: `src/proxy.ts`
- Modify: `src/proxy.test.ts`

**Behavior:**
- Expand `config.matcher` in `src/proxy.ts` to include all 9 protected prefixes:
  ```typescript
  export const config = {
    matcher: [
      '/schedule/:path*',
      '/studio-class/:path*',
      '/students/:path*',
      '/inbox/:path*',
      '/settings/:path*',
      '/class/:path*',
      '/bookings/:path*',
      '/account/:path*',
      '/updates/:path*',
    ],
  };
  ```
- Update `src/proxy.test.ts`:
  - Update `matches the 5 protected route prefixes` test to assert the 9 prefixes.
  - Add test cases verifying unauthenticated redirects on `/schedule`, `/studio-class/sc-1`, `/account/privacy`, and `/updates`.
  - Verify query parameter preservation on new routes (e.g. `/account/privacy?tab=invitations`).

- [x] **Step 1: Update `src/proxy.ts` matcher**
  Expand `config.matcher` array with the 4 missing prefixes.

- [x] **Step 2: Update `src/proxy.test.ts`**
  Update the matcher expectation and add test cases for unauthenticated redirects to the new prefixes.

- [x] **Step 3: Run proxy tests and verify green**
  Run: `pnpm exec vitest run src/proxy.test.ts`

- [x] **Step 4: Mutation probe**
  Temporarily remove `'/schedule/:path*'` from `config.matcher`. Run `pnpm exec vitest run src/proxy.test.ts`, observe test failure, restore `src/proxy.ts`, and re-run to confirm green.

---

### Task 2: Forward `redirect` in `/login` with safety validation

**Files:**
- Modify: `src/app/(public)/login/page.tsx`
- Modify: `src/app/(public)/login/page.test.tsx`

**Behavior:**
- In `src/app/(public)/login/page.tsx`:
  - Split page into `LoginForm` and default export `LoginPage` wrapped in `<Suspense fallback={null}>`.
  - Read `useSearchParams().get('redirect')`.
  - Sanitize:
    ```typescript
    const rawRedirect = searchParams.get('redirect');
    const redirect =
      rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
        ? rawRedirect
        : undefined;
    ```
  - In `handleSubmit`, send `{ email, ...(redirect ? { redirect } : {}) }` to `POST /api/auth/magic-link/send`.
  - Render `<PasskeySignIn redirect={redirect} />`.
- In `src/app/(public)/login/page.test.tsx`:
  - Mock `useSearchParams` from `next/navigation` to supply test search parameters.
  - Add test: when `?redirect=/account/privacy` is present, `fetch` to `/api/auth/magic-link/send` receives `redirect: '/account/privacy'`.
  - Add test: when `?redirect=//evil.com` or `https://evil.com` or string > 200 chars is present, `fetch` body contains no `redirect` property.
  - Add test: when `?redirect=/students/s-1` is present, `<PasskeySignIn />` receives `redirect="/students/s-1"`.

- [x] **Step 1: Update `src/app/(public)/login/page.tsx`**
  Add `<Suspense>`, `useSearchParams`, `isSafeRelativePath`, and parameter forwarding.

- [x] **Step 2: Update `src/app/(public)/login/page.test.tsx`**
  Add unit tests for valid parameter forwarding, unsafe parameter rejection, and passkey forwarding.

- [x] **Step 3: Run login tests and verify green**
  Run: `pnpm exec vitest run src/app/\(public\)/login/page.test.tsx`

- [x] **Step 4: Mutation probe**
  Temporarily bypass the `isSafeRelativePath` check in `src/app/(public)/login/page.tsx` (e.g. forward `rawRedirect` directly). Run `pnpm exec vitest run src/app/\(public\)/login/page.test.tsx`, observe the unsafe redirect test fail, restore `page.tsx`, and re-run to confirm green.

---

### Task 3: Defense-in-depth in layouts and session guards

**Files:**
- Modify: `src/lib/student-guard.ts`
- Create: `src/lib/student-guard.test.ts`
- Modify: `src/app/(student)/layout.tsx`
- Modify: `src/app/(teacher)/layout.tsx`
- Modify: `src/lib/session.ts`

**Behavior:**
- In `src/lib/student-guard.ts`:
  - Signature: `redirectNonStudent(session: SessionUser | null, redirectPath?: string | null): never`.
  - If `session?.teacherId`, redirect to `/schedule`.
  - If `redirectPath && isSafeRelativePath(redirectPath)`, redirect to `/login?redirect=${encodeURIComponent(redirectPath)}`.
  - Else redirect to `/login`.
- In `src/app/(student)/layout.tsx`:
  - Read `const pathname = (await headers()).get('x-pathname');`
  - Pass to `redirectNonStudent(session, pathname)`.
- In `src/app/(teacher)/layout.tsx`:
  - When `!session?.teacherId` and `!session?.studentId`:
    - Read `const pathname = (await headers()).get('x-pathname');`
    - If `pathname && isSafeRelativePath(pathname)`, redirect to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.
- In `src/lib/session.ts`:
  - In `requireTeacherSession()`:
    - If `!session?.teacherId`:
      - Read `const pathname = (await headers()).get('x-pathname');`
      - If `pathname && isSafeRelativePath(pathname)`, redirect to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.
- In `src/lib/student-guard.test.ts`:
  - Test `redirectNonStudent(teacherSession)` redirects to `/schedule`.
  - Test `redirectNonStudent(null, '/account/privacy')` redirects to `/login?redirect=%2Faccount%2Fprivacy`.
  - Test `redirectNonStudent(null, '//evil.com')` redirects to bare `/login`.
  - Test `redirectNonStudent(null)` redirects to bare `/login`.

- [x] **Step 1: Update `src/lib/student-guard.ts` and create `src/lib/student-guard.test.ts`**
  Implement optional `redirectPath` with `isSafeRelativePath` validation and test all branches.

- [x] **Step 2: Update `src/app/(student)/layout.tsx`, `src/app/(teacher)/layout.tsx`, and `src/lib/session.ts`**
  Forward `x-pathname` header to login redirect when unauthenticated or expired.

- [x] **Step 3: Run guard and layout tests**
  Run: `pnpm exec vitest run src/lib/student-guard.test.ts`
  Run: `pnpm exec vitest run --project components`

- [x] **Step 4: Mutation probe**
  Temporarily disable the `redirectPath` handling in `src/lib/student-guard.ts` (always redirect to `/login`). Run `pnpm exec vitest run src/lib/student-guard.test.ts`, observe test failure, restore `student-guard.ts`, and re-run to confirm green.

---

### Task 4: E2E test verification and whole-suite verify

**Files:**
- Modify: `tests/e2e/auth.spec.ts`

**Behavior:**
- In `tests/e2e/auth.spec.ts`:
  - Update `unauthenticated user is redirected to login from protected routes` test to cover the expanded protected route set:
    `['/settings', '/students', '/inbox', '/bookings', '/class/new', '/schedule', '/studio-class/sc-1', '/account/privacy', '/updates']`.
  - Add test: `'unauthenticated user visiting protected route with redirect preserves destination through sign-in'`:
    - Signed out, browse to `/settings/rooms`.
    - Observe URL redirects to `/login?redirect=%2Fsettings%2Frooms`.
    - Fill email and submit login form.
    - Create magic link token bound to browser origin nonce with `redirectTo: '/settings/rooms'`.
    - Navigate to `/verify?token=<rawToken>`.
    - Wait for URL and assert browser lands on `/settings/rooms` (heading "Rooms"), NOT `/schedule`.
- Run full verification suite: `pnpm run typecheck`, `pnpm run lint`, `pnpm test`.

- [x] **Step 1: Update `tests/e2e/auth.spec.ts`**
  Add the new protected routes to the redirect check and add the end-to-end destination preservation test.

- [x] **Step 2: Run verification**
  Run: `pnpm run typecheck`
  Run: `pnpm run lint`
  Run: `pnpm test`
