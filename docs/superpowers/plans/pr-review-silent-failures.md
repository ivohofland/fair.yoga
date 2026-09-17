# PR Review: Silent Failure Modes (#615 / PR #633)

**Reviewer:** PR Reviewer (Silent Failures)  
**Target:** PR #633 (`solve_issue_615` against `origin/main`)  
**Scope:** Silent failures, unhandled rejections, swallowed errors, dropped state, invalid redirect handling, error states, blank screens, and redirect loops.  
**Date:** 2026-09-17  

---

## 1. Executive Summary

PR #633 comprehensively resolves Issue #615 by widening `src/proxy.ts` to cover all 9 protected route prefixes, forwarding validated `redirect` parameters from `/login`, and preserving destination paths (including search queries) across expired-session layout guards.

From a silent failure and robustness perspective:
- **No Critical Breaches:** There are no unhandled promise rejections, open redirect vulnerabilities, fatal HTTP redirect loops (`ERR_TOO_MANY_REDIRECTS`), or unhandled crashes.
- **Graceful Degradation:** Invalid, malformed, or malicious redirects (`//evil.com`, `/\evil.com`, `https://evil.com`, and strings > 200 characters) are safely dropped to `undefined` and fall back gracefully to the respective role home (`/schedule` for teachers, `/bookings` for students) without disrupting sign-in.
- **Identified Failure Modes:** 
  1. **Swallowed Rate-Limit Error in `/login`:** When the magic link endpoint rate-limits a user (429), the response error message stating the retry cooldown is discarded in favor of a generic `"Something went wrong. Please try again."`, which actively encourages immediate re-submission and further rate limiting.
  2. **Auth-Page Redirect Trapping:** URLs carrying `redirect=/login` or `redirect=/verify` are treated as valid relative paths by `isSafeRelativePath`. Authenticating with `redirect=/login` drops the authenticated user right back onto the sign-in form, creating a confusing UX loop. Similarly, `redirect=/verify` displays an immediate false `"Verification failed: This link can't be used"` screen.
  3. **`requireTeacherSession` Asymmetry:** Unlike `TeacherLayout` (which redirects a student session to `/bookings` or `/account`), `requireTeacherSession` redirects any non-teacher session to `/login?redirect=...`, which is an unexpected destination for an already authenticated student.
  4. **Suspense `fallback={null}` on `/login`:** Because `useSearchParams()` triggers client-side suspense during SSR, `/login` renders an entirely blank container below the header until client hydration completes.

---

## 2. In-Depth Chase Analysis

### A. Unhandled Rejections, Swallowed Errors, Silent Drop of Inputs or State

1. **Unhandled Rejections:**
   - `src/app/(public)/login/page.tsx`: `handleSubmit` encloses `fetch('/api/auth/magic-link/send')` in a complete `try/catch` block. Both network failures and HTTP error responses are caught and transition component state to `'error'`.
   - `src/components/booking/passkey-sign-in.tsx`: All async ceremonies (`options`, `startAuthentication`, `verify`) are wrapped in `try/catch`, safely partitioning `NotAllowedError` into `'incomplete'` and everything else into `'error'`.
   - No unhandled rejections exist in the touched client components.

2. **Swallowed Errors:**
   - In `src/app/(public)/login/page.tsx`, when `fetch('/api/auth/magic-link/send')` returns a non-2xx response (such as a 429 Too Many Requests), the response JSON is never parsed. The specific rate-limit cooldown message (`"Too many sign-in requests. Try again in X minutes."`) is swallowed and replaced with a static `"Something went wrong. Please try again."`.

3. **Silent Drop of Inputs / State:**
   - Any `redirect` parameter that fails `isSafeRelativePath` or exceeds 200 characters is dropped to `undefined`. This drop is silent to the user by design (to avoid surfacing attacker-crafted error strings), and authentication proceeds to the default role home.
   - However, in `TeacherLayout` and `StudentLayout` (`redirectNonStudent`), `pathname.length <= 200` is not checked before generating `/login?redirect=...`. A path exceeding 200 characters is sent to `/login`, where `/login` drops it silently upon submission.

---

### B. Graceful Fallback for Invalid Redirects

1. **Protocol-Relative and External URLs:**
   - `isSafeRelativePath` in `src/lib/schemas.ts` verifies:
     `path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')`
   - Tested against `//evil.com`, `/\evil.com`, `https://evil.com`, `javascript:...`, `data:...`. All are rejected.
   - In `login/page.tsx`:
     ```typescript
     const redirect =
       rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
         ? rawRedirect
         : undefined;
     ```
     When rejected, `redirect` evaluates to `undefined` and is omitted from the POST payload to `/api/auth/magic-link/send` and the `<PasskeySignIn />` props.
2. **Downstream API Hardening:**
   - Even if `/login` were bypassed, `magicLinkSendSchema` validates `redirect: relativePath.optional()`. Invalid payloads return HTTP 400.
   - When redeeming tokens, `/api/auth/magic-link/verify`, `/api/auth/magic-link/claim`, and `/api/auth/passkey/authenticate/verify` re-validate `isSafeRelativePath(tokenRedirect)` and substitute role defaults if invalid.
3. **Cross-Role Graceful Fallback:**
   - If a student signs in via a link targeting a teacher route (e.g. `?redirect=/schedule`):
     `verify` redirects the browser to `/schedule`. Upon arrival, `TeacherLayout` checks `session.studentId`, notices the user is a student, and redirects them to `/bookings` (or `/account` if `/settings`).
   - If a teacher signs in via a link targeting a student route (e.g. `?redirect=/account/privacy`):
     `verify` redirects the browser to `/account/privacy`. Upon arrival, `StudentLayout` calls `redirectNonStudent(session, pathname)`. Because `session.teacherId` is present, it immediately redirects to `/schedule`.
   - **Conclusion:** Invalid or cross-role redirects drop gracefully to role home without throwing or breaking the user flow.

---

### C. Error States in Login and Verification

1. **Login Page Error States:**
   - Network failure: Displays `"Something went wrong. Please try again."` and restores the submit button.
   - Server 500: Displays `"Something went wrong. Please try again."` and restores the submit button.
   - Rate limited (429): Swallows the specific wait time and displays generic error (see Finding 1).
   - Unregistered email: Returns 200 with generic success message ("Check your inbox for the link") to prevent account enumeration.
2. **Verification Page Error States:**
   - Expired / consumed token (400): Displays `"Verification failed: This link can't be used"` with links to request a new link.
   - Stale link already consumed in another tab: Probes `/api/auth/session`; if authenticated, renders `"Already signed in"` with a button to role home.
   - Request timeout (ceiling timer at 8s): Displays `"Connection problem: We couldn't reach the server"` with a retry link.
   - No token in URL (`/verify`): Immediately displays `"Verification failed: This link can't be used"`.

---

### D. Blank Screens and Loop Failure Modes

1. **Blank Screen on `/login`:**
   - `LoginPage` exports:
     ```typescript
     export default function LoginPage() {
       return (
         <Suspense fallback={null}>
           <LoginForm />
         </Suspense>
       );
     }
     ```
   - During SSR and the initial HTML streaming phase, `useSearchParams()` suspends. Because `fallback={null}`, the initial HTML contains only the outer layout's wordmark header (`fair.yoga`).
   - If JavaScript is disabled, blocked by adblockers, or encounters an uncaught runtime error in another chunk, the form never appears, leaving the user with an empty screen.
2. **Circular / UX Trapping Loop:**
   - If an unauthenticated user arrives at `/login?redirect=/login`:
     The user enters their email and authenticates.
     The verification endpoint issues a session and redirects to `/login`.
     Because `/login` does not check if an active session exists (it is an unauthenticated form without session gating), the user lands back on the empty login form.
     The user experiences a perceived sign-in loop.
   - If an unauthenticated user arrives at `/login?redirect=/verify`:
     After sign-in, the user is redirected to `/verify` (without a token parameter), which immediately shows `"Verification failed: This link can't be used"`.

---

## 3. Categorized Findings

### Critical
*None.* No application crashes, fatal HTTP redirect loops, or security vulnerabilities were discovered.

---

### Important

#### Finding 1: Swallowed 429 Rate-Limit Error Message in `/login`
- **Location:** `src/app/(public)/login/page.tsx:23-40, 80-84`
- **Description:** `POST /api/auth/magic-link/send` enforces strict IP (10/15min) and email (3/15min) rate limits, returning 429 with:
  `{ error: { message: "Too many sign-in requests. Try again in X minutes." } }`.
  `LoginForm.handleSubmit` catches any `!res.ok` and sets `status = 'error'`, showing:
  `"Something went wrong. Please try again."`
- **Impact:** The user is not informed of the cooldown period or that they have been rate-limited. Being told "Please try again" encourages repeated attempts, prolonging the lockout. In contrast, `PasskeySignIn` and `HandoffCodeEntry` both parse and render the backend's error message.
- **Recommendation:** Read the error message using `readErrorMessage` (or check for 429) and display the server's cooldown message:
  ```typescript
  if (res.ok) {
    setStatus('sent');
  } else {
    const data = await res.json().catch(() => null);
    setErrorMessage(data?.error?.message ?? 'Something went wrong. Please try again.');
    setStatus('error');
  }
  ```

#### Finding 2: Circular / Auth-Page Redirect Targets (`redirect=/login` or `/verify`)
- **Location:** `src/app/(public)/login/page.tsx:12-18`
- **Description:** `isSafeRelativePath` permits any path starting with `/` (except `//` and `\`). Consequently, `/login` and `/verify` pass validation. If a user follows a link, bookmark, or referral containing `?redirect=/login` or `?redirect=/verify`, they are sent to that destination after authenticating:
  - If redirected to `/login`: The user lands on the sign-in form despite having an active session, causing confusion and repeated sign-in attempts.
  - If redirected to `/verify`: The user lands on `/verify` without a token query parameter, which renders `"Verification failed: This link can't be used."`
- **Impact:** Misleading UX; users believe authentication failed or are trapped on the login screen.
- **Recommendation:** Filter out `/login` and `/verify` in `LoginForm`:
  ```typescript
  const redirect =
    rawRedirect &&
    isSafeRelativePath(rawRedirect) &&
    rawRedirect.length <= 200 &&
    !rawRedirect.startsWith('/login') &&
    !rawRedirect.startsWith('/verify')
      ? rawRedirect
      : undefined;
  ```

#### Finding 3: `requireTeacherSession` Asymmetry (Missing Student Redirection)
- **Location:** `src/lib/session.ts:15-25`
- **Description:** `TeacherLayout` checks `if (session?.studentId)` and redirects a student session to `/account` or `/bookings`. `redirectNonStudent` in `student-guard.ts` checks `if (session?.teacherId)` and redirects a teacher session to `/schedule`.
  In contrast, `requireTeacherSession()` checks only `if (!session?.teacherId)` and immediately redirects to `/login?redirect=${encodeURIComponent(pathname)}`.
- **Impact:** If `requireTeacherSession()` is called from a Server Action, Route Handler, or page outside `TeacherLayout` with an active student session, the student is redirected to `/login` instead of their role home.
- **Recommendation:** Add the student role check to `requireTeacherSession` for defense-in-depth:
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

---

### Suggestions

#### Finding 4: `<Suspense fallback={null}>` in `LoginPage`
- **Location:** `src/app/(public)/login/page.tsx:104-110`
- **Description:** Wrapping `LoginForm` in `<Suspense fallback={null}>` causes Next.js to stream an empty body during SSR. On slow networks or before client JS hydrates, visitors see only the wordmark header.
- **Recommendation:** Provide a minimal skeleton or a visual placeholder shell in `fallback` so the page does not appear visually blank during load.

#### Finding 5: Missing Length Cap (`<= 200`) in Layout / Guard Redirect Producers
- **Location:** `src/app/(teacher)/layout.tsx:23`, `src/lib/session.ts:19`, `src/lib/student-guard.ts:16`
- **Description:** The layouts and guards check `pathname && isSafeRelativePath(pathname)` but do not check `pathname.length <= 200`. If a path exceeds 200 characters, it is passed to `/login?redirect=...`, where `/login` silently drops it.
- **Recommendation:** Enforce `pathname.length <= 200` in the guards as well, dropping oversized paths directly to `/login`.

---

## 4. Verification Results

| Check | Command | Result |
|---|---|---|
| Unit & Component Tests | `pnpm exec vitest run src/proxy.test.ts src/app/(public)/login/page.test.tsx src/lib/student-guard.test.ts` | **3 passed (26 tests)** |
| Typecheck | `pnpm run typecheck` | **0 errors (Clean)** |
| Lint | `pnpm run lint` | **0 errors (Clean)** |

---

## 5. Summary Verdict

The PR implementation is structurally solid and safely prevents open redirect vulnerabilities while preserving query strings and destinations across valid and invalid sessions. Addressing the swallowed rate-limit message (Finding 1) and filtering out `/login`/`/verify` from allowable redirect targets (Finding 2) will prevent user confusion and eliminate subtle edge-case failure modes.
