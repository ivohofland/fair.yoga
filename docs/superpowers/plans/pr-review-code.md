# Code Review: PR #633 (Issue #615) — Login Destination Preservation

- **PR:** #633
- **Branch:** `solve_issue_615` against `origin/main`
- **Issue:** #615 (Preserve destination on sign-in across all protected routes)
- **Reviewer:** PR Reviewer (Code)
- **Review Date:** 2026-09-17
- **Verdict:** **CHANGES REQUESTED** (1 Critical security vulnerability in open redirect validation, 1 Important UX/SSR finding on Suspense boundary)

---

## 1. Scope & Touched Files

The diff against `origin/main` (`git diff origin/main`) touches 6 source files and corresponding test files:

### Source Files Under Review
- [`src/proxy.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/proxy.ts) — Expands route matcher from 5 to all 9 protected prefixes; appends query parameters (`request.nextUrl.search`) to the redirect parameter and the stamped `x-pathname` header; ensures client-supplied `x-pathname` headers are deleted before forwarding.
- [`src/app/(public)/login/page.tsx`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(public)/login/page.tsx) — Reads `useSearchParams().get('redirect')`; validates with `isSafeRelativePath` and length `<= 200`; forwards sanitized redirect to `POST /api/auth/magic-link/send` and `<PasskeySignIn />`; wraps form in `<Suspense fallback={null}>`.
- [`src/app/(student)/layout.tsx`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(student)/layout.tsx) — Reads `(await headers()).get('x-pathname')` and forwards it to `redirectNonStudent(session, pathname)`.
- [`src/app/(teacher)/layout.tsx`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(teacher)/layout.tsx) — Reads `(await headers()).get('x-pathname')` for unauthenticated/expired sessions; preserves destination via `redirect('/login?redirect=' + encodeURIComponent(pathname))` when safe.
- [`src/lib/session.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/session.ts) — Updates `requireTeacherSession` to read `(await headers()).get('x-pathname')` and preserve destination when redirecting unauthenticated users.
- [`src/lib/student-guard.ts`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/student-guard.ts) — Updates `redirectNonStudent` to accept `redirectPath?: string | null` and preserve destination via `/login?redirect=...` if valid.

---

## 2. Executive Summary

PR #633 addresses the destination loss problem when unauthenticated or expired-session visitors navigate to protected routes:
1. **Matcher expansion:** `src/proxy.ts` now intercepts unauthenticated requests across all 9 protected route prefixes (adding `/schedule/:path*`, `/studio-class/:path*`, `/account/:path*`, and `/updates/:path*`).
2. **Query preservation:** Query parameters (`nextUrl.search`) are now preserved both in `/login?redirect=...` and in the stamped `x-pathname` request header.
3. **Login form forwarding:** `/login` reads the `redirect` search parameter and attaches it to both magic link submission and passkey sign-in.
4. **Defense-in-depth:** When an expired or invalid cookie bypasses the lightweight proxy check, layouts and guards inspect the stamped `x-pathname` header to preserve the user's intended destination on redirect to `/login`.

The overall architectural direction is sound and cleanly integrates with downstream authentication handlers (`magicLinkSendSchema`, `POST /api/auth/magic-link/send`, `deliverSignInLink`, `verify`, and `claim`). However, the code review identified a **Critical security bypass in open redirect protection** and an **Important UX degradation caused by the Suspense boundary placement**.

---

## 3. Findings & Detailed Analysis

### Finding 1: Open Redirect Bypass via WHATWG URL Control Whitespace Stripping
- **Category:** **CRITICAL**
- **Affected Files:**
  - [`src/lib/schemas.ts:117`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/schemas.ts#L117) (`isSafeRelativePath`)
  - [`src/app/(public)/login/page.tsx:16`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(public)/login/page.tsx#L16)
  - [`src/lib/student-guard.ts:16`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/student-guard.ts#L16)
  - [`src/app/(teacher)/layout.tsx:23`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(teacher)/layout.tsx#L23)
  - [`src/lib/session.ts:19`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/session.ts#L19)

#### Description & Root Cause
The open redirect validation relies on `isSafeRelativePath`:
```typescript
export function isSafeRelativePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');
}
```
This check is vulnerable to circumvention via ASCII whitespace and control character stripping defined in the **WHATWG URL Standard** (Section 4.1 "URL parsing"). Under the standard, browsers and compliant URL parsers strip all ASCII tabs (`\t` / `0x09`), line feeds (`\n` / `0x0A`), and carriage returns (`\r` / `0x0D`) from anywhere in the URL string prior to parsing the scheme, authority, and host.

#### Exploit Mechanism
1. An attacker constructs a link:
   `https://fair.yoga/login?redirect=/%09/attacker.com` (or `/%0a/attacker.com` / `/%0d/attacker.com`).
2. In `src/app/(public)/login/page.tsx`:
   ```typescript
   const rawRedirect = searchParams.get('redirect');
   ```
   `searchParams.get` decodes `%09` to literal `\t`.
3. `isSafeRelativePath("/\t/attacker.com")` evaluates:
   - `path.startsWith('/')` -> `true`
   - `path.startsWith('//')` -> `false` (second character is `\t`, not `/`)
   - `path.includes('\\')` -> `false`
   - Returns `true`!
4. Length check `rawRedirect.length <= 200` passes.
5. The un-sanitized string `"/\t/attacker.com"` is submitted to `POST /api/auth/magic-link/send`, where `magicLinkSendSchema` validates it using `relativePath` (which also delegates to `isSafeRelativePath`).
6. The token is stored in the database with `redirectTo = "/\t/attacker.com"`.
7. Upon successful authentication:
   - In `handoff-code-entry.tsx`:
     ```typescript
     window.location.assign(json.data.redirectTo);
     ```
     The browser resolves `"/\t/attacker.com"` against the current page origin (`https://fair.yoga`). The WHATWG parser strips `\t`, transforming `"/\t/attacker.com"` into `"//attacker.com"`, which navigates directly to `https://attacker.com/`.
   - In standard browser URL resolution:
     `new URL("/\t/attacker.com", "https://fair.yoga").href` resolves to `"https://attacker.com/"`.

#### Empirical Verification
Running the WHATWG parser in Node 22 / Chromium:
```javascript
new URL("/\t/attacker.com", "https://fair.yoga").href  // -> "https://attacker.com/"
new URL("/\n/attacker.com", "https://fair.yoga").href  // -> "https://attacker.com/"
new URL("/\r/attacker.com", "https://fair.yoga").href  // -> "https://attacker.com/"
```
All three bypass the guard and execute an open redirect to external domains.

#### Recommended Remediation
Harden `isSafeRelativePath` in `src/lib/schemas.ts` to strip control characters before evaluating, and validate origin resolution using the WHATWG `URL` parser against a dummy base origin:
```typescript
export function isSafeRelativePath(path: string): boolean {
  // Strip WHATWG whitespace / control characters that browsers remove during URL parsing
  const stripped = path.replace(/[\t\r\n]/g, '');
  if (!stripped.startsWith('/') || stripped.startsWith('//') || stripped.includes('\\')) {
    return false;
  }
  try {
    const parsed = new URL(stripped, 'http://localhost');
    return parsed.origin === 'http://localhost' && parsed.pathname.startsWith('/');
  } catch {
    return false;
  }
}
```
Add unit tests in `src/lib/student-guard.test.ts` and `src/app/(public)/login/page.test.tsx` for `/%09/evil.com`, `/%0a/evil.com`, and `/%0d/evil.com`.

---

### Finding 2: Suspense Boundary Placement and Blank Viewport During SSR / Hydration
- **Category:** **IMPORTANT**
- **Affected File:** [`src/app/(public)/login/page.tsx:104-110`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(public)/login/page.tsx#L104-L110)

#### Description
In Next.js 16 App Router, calling `useSearchParams()` in a client component de-opts static prerendering up to the nearest `<Suspense>` boundary. To satisfy this requirement, `LoginPage` was wrapped in `<Suspense fallback={null}>`:
```tsx
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
```
However, `LoginForm` contains the **entire page UI**:
- `<h1>Sign in with a link sent to your inbox</h1>`
- Body copy and instructions
- Email `<Input />` field
- "Send me the link" `<Button />`
- `<PasskeySignIn />` component
- "Start teaching on fair.yoga" link

#### Impact
During SSR / initial HTML streaming, or when `useSearchParams()` suspends, React renders the fallback: `null`.
As a result:
- The initial HTML document delivered to the browser contains an empty container.
- On slow mobile networks, before JavaScript bundles download and hydrate, visitors see a completely blank white screen.
- SEO and First Contentful Paint (FCP) metrics for `/login` are negatively impacted.

#### Recommended Remediation
Either:
1. **Provide a visual fallback**: Replace `fallback={null}` with a lightweight skeleton or static markup matching the login form shell (`<LoginFormFallback />`).
2. **Narrow the Suspense boundary**: Render the page heading, email form, and static links in the outer component, and isolate `useSearchParams()` into a focused sub-component or hook that passes the redirect parameter without suspending the primary form markup.

---

### Finding 3: Role Separation Discrepancy Between `requireTeacherSession` and `TeacherLayout`
- **Category:** **SUGGESTION**
- **Affected Files:**
  - [`src/lib/session.ts:15-25`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/session.ts#L15-L25) (`requireTeacherSession`)
  - [`src/app/(teacher)/layout.tsx:18-27`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(teacher)/layout.tsx#L18-L27) (`TeacherLayout`)

#### Description
In `TeacherLayout`, role mismatch is handled with intelligent routing:
```typescript
if (!session?.teacherId) {
  const pathname = (await headers()).get('x-pathname');
  if (session?.studentId) {
    redirect((pathname ?? '').startsWith('/settings') ? '/account' : '/bookings');
  }
  if (pathname && isSafeRelativePath(pathname)) {
    redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
  }
  redirect('/login');
}
```
If an active session belongs to a student, they are routed to `/account` or `/bookings`.

In contrast, `requireTeacherSession` in `src/lib/session.ts` does not check `session?.studentId`:
```typescript
export async function requireTeacherSession(): Promise<TeacherSession> {
  const session = await getSession();
  if (!session?.teacherId) {
    const pathname = (await headers()).get('x-pathname');
    if (pathname && isSafeRelativePath(pathname)) {
      redirect(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
    redirect('/login');
  }
  return { ...session, teacherId: session.teacherId };
}
```
Currently, all pages calling `requireTeacherSession` reside within the `(teacher)` layout, which executes first. However, if `requireTeacherSession` is ever invoked in Server Actions or independent endpoints, a student session would be sent to `/login` rather than their student portal.

#### Recommended Remediation
Consider aligning `requireTeacherSession`'s fallback behavior or documenting that cross-role redirections are exclusively owned by the layout tier.

---

### Finding 4: Bounding Query String Length on Server Component Redirects
- **Category:** **SUGGESTION**
- **Affected Files:**
  - [`src/lib/student-guard.ts:16`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/student-guard.ts#L16)
  - [`src/app/(teacher)/layout.tsx:23`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/app/(teacher)/layout.tsx#L23)
  - [`src/lib/session.ts:19`](file:///Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615/src/lib/session.ts#L19)

#### Description
`src/proxy.ts` stamps `x-pathname` as `request.nextUrl.pathname + request.nextUrl.search`.
In `LoginForm` (`src/app/(public)/login/page.tsx`), the parameter is validated with:
```typescript
rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
```
However, the server component redirects (`redirectNonStudent`, `TeacherLayout`, `requireTeacherSession`) check `isSafeRelativePath(pathname)` but do not enforce `pathname.length <= 200`.

If an unauthenticated request arrives with an unusually long query string (> 200 characters), the server will issue a redirect to `/login?redirect=<long_string>`, which `/login` will then discard upon client load, silently falling back to the role home.

#### Recommended Remediation
Enforce `redirectPath.length <= 200` in `redirectNonStudent`, `TeacherLayout`, and `requireTeacherSession` before generating the redirect URL, or strip excessive query parameters.

---

## 4. Verification of Specific Review Areas

### 4.1. Server Component Headers Access
- **Compliance with Next.js 16**: In Next.js 15+, `headers()` returns a Promise and must be awaited. All three call sites (`StudentLayout`, `TeacherLayout`, `requireTeacherSession`) correctly use `(await headers()).get('x-pathname')`.
- **Header Spoofing Protection**: In `src/proxy.ts`:
  ```typescript
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
  ```
  Deleting `x-pathname` before re-setting it guarantees that client-supplied headers cannot spoof internal route state.
- **Dynamic Rendering Impact**: All routes under `(student)` and `(teacher)` already invoke `getSession()`, which accesses `cookies()` and queries the database. Reading `headers()` within the unauthorized branch introduces zero additional dynamic de-optimizations.

### 4.2. Route Prefix Coverage
- The 9 prefixes in `config.matcher`:
  - `/schedule/:path*`
  - `/studio-class/:path*`
  - `/students/:path*`
  - `/inbox/:path*`
  - `/settings/:path*`
  - `/class/:path*`
  - `/bookings/:path*`
  - `/account/:path*`
  - `/updates/:path*`
- Exhaustive verification against the filesystem confirms that 100% of route files under `src/app/(teacher)` and `src/app/(student)` fall under these 9 prefixes.
- All 9 prefixes are registered in `RESERVED_SLUGS` (`src/lib/schemas.ts:180-183`), ensuring that no dynamic teacher slug (`/[slug]`) can shadow or conflict with protected paths.

### 4.3. Downstream Authentication Flow
- `magicLinkSendSchema`: Validates `redirect: relativePath.optional()`.
- `POST /api/auth/magic-link/send`: Persists `redirectTo` in `magicLinkToken`.
- `GET /api/auth/magic-link/verify`: Validates `isSafeRelativePath(tokenRedirect)` and returns `{ redirectTo }`.
- `POST /api/auth/magic-link/claim`: Validates `isSafeRelativePath(tokenRedirect)` and returns `{ redirectTo }`.
- `PasskeySignIn`: Forwards `redirect` to `POST /api/auth/passkey/authenticate/verify`.
- The pipeline end-to-end preserves and honors the validated redirect destination.

---

## 5. Summary of Findings

| ID | Finding | Severity | File(s) | Action Required |
|---|---|---|---|---|
| **SEC-1** | Open redirect circumvention via WHATWG control whitespace stripping (`\t`, `\n`, `\r`) | **Critical** | `src/lib/schemas.ts`, `src/app/(public)/login/page.tsx` | Strip control characters and validate origin with `new URL()` parser |
| **UX-1** | `<Suspense fallback={null}>` renders blank screen during SSR / hydration of `/login` | **Important** | `src/app/(public)/login/page.tsx` | Add meaningful visual fallback skeleton or isolate `useSearchParams` |
| **ARCH-1** | `requireTeacherSession` does not mirror `TeacherLayout`'s student redirect routing | **Suggestion** | `src/lib/session.ts` | Consider routing student sessions to `/account` or `/bookings` |
| **DEF-1** | Server component redirects do not check length `<= 200` before creating `/login?redirect=...` | **Suggestion** | `src/lib/student-guard.ts`, `src/app/(teacher)/layout.tsx`, `src/lib/session.ts` | Guard length `<= 200` to prevent generating URLs `/login` will drop |

---

## 6. Verdict

**CHANGES REQUESTED** due to **SEC-1** (Critical Open Redirect vulnerability). Addressing SEC-1 and refining UX-1 will ensure the PR is safe and performant for production release.
