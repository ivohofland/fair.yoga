# Destination preservation on sign-in (#615)

A signed-out visitor following a link to a sign-in-protected page is signed in and then sent to the page the link named, rather than falling back to their role home (`/schedule` for teachers, `/bookings` for students).

## Problem, as measured

Issue #615 identified that sign-in destinations are dropped at two distinct boundaries:

1. **Proxy-matched paths carry `redirect` to `/login`, but `/login` drops it.**
   `src/proxy.ts` redirects an unauthenticated visitor to `/login?redirect=<path>` for any path matching its config. However, `src/app/(public)/login/page.tsx` never calls `useSearchParams()`. When submitting the magic link form, it sends `{ email }` alone to `POST /api/auth/magic-link/send`. It also renders `<PasskeySignIn />` without a `redirect` prop.
2. **Protected pages outside the proxy matcher never set `redirect`.**
   `src/proxy.ts` currently matches only 5 route prefixes:
   - `/students/:path*`
   - `/inbox/:path*`
   - `/settings/:path*`
   - `/class/:path*`
   - `/bookings/:path*`

   The other protected routes are:
   - Teacher: `/schedule/:path*` (including `/schedule` and `/schedule/past`) and `/studio-class/:path*`
   - Student: `/account/:path*` (including `/account/privacy`, `/account/tier`, `/account/notifications`, `/account/data`) and `/updates/:path*`

   Because these routes are unmatched by `proxy.ts`, unauthenticated requests skip the proxy entirely. They hit `TeacherLayout` (`src/app/(teacher)/layout.tsx`) / `requireTeacherSession` (`src/lib/session.ts`) or `StudentLayout` (`src/app/(student)/layout.tsx`) / `redirectNonStudent` (`src/lib/student-guard.ts`). Each of those redirects to bare `/login`.
   Furthermore, because `proxy.ts` never ran, the `x-pathname` header is not stamped, so server components on those routes cannot see the requested pathname.

### Downstream readiness

Everything downstream of `/login` already supports destination redirect:
- `magicLinkSendSchema` (`src/lib/schemas.ts:144`) accepts `redirect: relativePath.optional()`.
- `POST /api/auth/magic-link/send` (`src/app/api/auth/magic-link/send/route.ts:52`) stores `redirectTo: redirect` with the magic link token.
- `GET /api/auth/magic-link/verify` (`src/app/api/auth/magic-link/verify/route.ts:114`) and `POST /api/auth/magic-link/claim` (`src/app/api/auth/magic-link/claim/route.ts:101`) validate `tokenRedirect && isSafeRelativePath(tokenRedirect)` and return `{ redirectTo: tokenRedirect }`.
- `PasskeySignIn` (`src/components/booking/passkey-sign-in.tsx:47`) accepts `redirect?: string` and sends it to `POST /api/auth/passkey/authenticate/verify`.
- `BookingSignIn` (`src/components/booking/booking-sign-in.tsx`) already uses this mechanism today.

## Decisions

### 1. Widen `src/proxy.ts` matcher to cover all 9 protected route prefixes

Expand `config.matcher` in `src/proxy.ts` from 5 to 9 prefixes:
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

**Why this is safe:**
- All 9 prefixes are already defined in `RESERVED_SLUGS` (`src/lib/schemas.ts:180-183`). No teacher page slug can shadow or conflict with them.
- Public routes (`/`, `/[slug]`, `/[slug]/book/[classId]`, `/login`, `/signup`, `/verify`, `/api/*`) are not matched and remain accessible without session cookies.
- Unauthenticated requests to any protected route are caught uniformly at the proxy layer before running server layout rendering or database lookups, redirecting to `/login?redirect=<path+query>`.
- Authenticated requests to all protected routes get `x-pathname` stamped in their request headers.

### 2. Forward `redirect` in `/login` with strict relative-path safety validation

In `src/app/(public)/login/page.tsx`:
- Wrap the inner form in a `<Suspense fallback={...}>` boundary to conform with Next.js App Router requirements for `useSearchParams()`.
- Read `const searchParams = useSearchParams();` and `const redirectParam = searchParams.get('redirect');`.
- Sanitize the parameter:
  ```typescript
  const redirect =
    redirectParam && isSafeRelativePath(redirectParam) && redirectParam.length <= 200
      ? redirectParam
      : undefined;
  ```
- Unsafe values (e.g. `//evil.com`, `/\evil.com`, `https://evil.com`, or strings exceeding 200 characters) are silently ignored (set to `undefined`), not surfaced as user-facing errors. When ignored, sign-in falls back to standard role home.
- Forward `redirect` to `POST /api/auth/magic-link/send`:
  ```typescript
  body: JSON.stringify({ email, ...(redirect ? { redirect } : {}) })
  ```
- Pass `redirect` to `<PasskeySignIn redirect={redirect} />`.

### 3. Layout and guard defense-in-depth for expired/invalid sessions

If a client sends an expired, revoked, or corrupted session cookie, `proxy.ts` lets the request through (because `proxy.ts` checks only cookie presence to avoid database overhead).
On these requests, `proxy.ts` still stamped `x-pathname`.
To handle this expired-cookie edge case consistently:
- `TeacherLayout` (`src/app/(teacher)/layout.tsx`):
  When `!session?.teacherId` and `!session?.studentId`, read `x-pathname` from `headers()`. If present and safe via `isSafeRelativePath(pathname)`, redirect to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.
- `StudentLayout` (`src/app/(student)/layout.tsx`):
  When `!session?.studentId`, read `x-pathname` from `headers()` and pass it to `redirectNonStudent(session, pathname)`.
- `redirectNonStudent` (`src/lib/student-guard.ts`):
  Update signature to `redirectNonStudent(session: SessionUser | null, redirectPath?: string | null): never`. If `session?.teacherId`, redirect to `/schedule`. Otherwise, if `redirectPath && isSafeRelativePath(redirectPath)`, redirect to `/login?redirect=${encodeURIComponent(redirectPath)}`, else `/login`.
- `requireTeacherSession` (`src/lib/session.ts`):
  When `!session?.teacherId`, read `x-pathname` from `headers()`. If present and safe via `isSafeRelativePath(pathname)`, redirect to `/login?redirect=${encodeURIComponent(pathname)}`, else `/login`.

## Invariants & Guardrails

1. **No Open Redirect:** Any incoming `redirect` query parameter MUST pass `isSafeRelativePath` and length <= 200 before being forwarded to APIs or components. Unsafe parameters are discarded immediately.
2. **Deterministic Role Fallback:** When no redirect is present or when an unsafe redirect is discarded, teachers land on `/schedule` and students land on `/bookings`.
3. **No Unwanted Clashes:** `RESERVED_SLUGS` contains every matched prefix, preventing collision with dynamic teacher profiles (`/[slug]`).
4. **Suspense Isolation:** Using `useSearchParams()` in `login/page.tsx` must not de-opt or throw during static generation. It is wrapped in `<Suspense>`.

## Acceptance & Verification

1. **Unit / Component Tests:**
   - `src/proxy.test.ts`:
     - Assert `config.matcher` contains all 9 protected prefixes.
     - Assert unauthenticated request to `/schedule`, `/account/privacy`, `/studio-class/sc-1`, and `/updates` redirects to `/login?redirect=<path>`.
   - `src/app/(public)/login/page.test.tsx`:
     - Assert submitting form with valid `?redirect=/account/privacy` passes `{ email, redirect: '/account/privacy' }` to `/api/auth/magic-link/send`.
     - Assert rendering with valid `?redirect=/students/stu-1` passes `redirect` prop to `PasskeySignIn`.
     - Assert unsafe `?redirect=//evil.com` or `/\\evil.com` or `https://evil.com` is omitted from the POST body and `PasskeySignIn` prop.
   - `src/lib/student-guard.test.ts`:
     - Assert `redirectNonStudent` redirects to `/login?redirect=<path>` when given an unauthenticated session and safe relative path.
2. **E2E Tests:**
   - `tests/e2e/auth.spec.ts`:
     - Test that unauthenticated visit to `/schedule`, `/settings`, `/account/privacy`, etc. redirects to `/login?redirect=...`.
     - Test end-to-end: unauthenticated user visits `/inbox`, enters email at `/login`, verifies magic link, and is redirected to `/inbox` (not `/schedule`).
