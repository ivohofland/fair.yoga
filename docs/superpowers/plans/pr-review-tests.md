# PR Test Review: PR #633 (Issue #615) — Destination Preservation on Sign-In

- **PR:** #633 (`fix/615-login-redirect-preservation` against `origin/main`)
- **Issue:** #615 (Preserve intended destination through sign-in flow)
- **Reviewer:** PR Reviewer (Tests)
- **Date:** 2026-09-17
- **Touched Test Files:**
  - `src/proxy.test.ts`
  - `src/app/(public)/login/page.test.tsx`
  - `src/lib/student-guard.test.ts`
  - `tests/e2e/auth.spec.ts`
- **Associated Source Files:**
  - `src/proxy.ts`
  - `src/app/(public)/login/page.tsx`
  - `src/lib/student-guard.ts`
  - `src/app/(teacher)/layout.tsx`
  - `src/app/(student)/layout.tsx`
  - `src/lib/session.ts`
- **Verification Status:**
  - `pnpm run typecheck`: **PASS (Exit code 0, 0 errors)**
  - Unit & Component tests (`src/proxy.test.ts`, `src/app/(public)/login/page.test.tsx`, `src/lib/student-guard.test.ts`): **PASS (3 test files, 26 passed tests)**

---

## 1. Executive Summary

PR #633 implements destination preservation for unauthenticated users attempting to access protected routes. The implementation touches three distinct layers:
1. **Edge/Routing Proxy (`src/proxy.ts`)**: Expands route matcher from 5 to 9 prefixes and stamps `x-pathname` (including query parameters) on downstream requests.
2. **Login View (`src/app/(public)/login/page.tsx`)**: Reads `?redirect` search parameter via `useSearchParams()`, sanitizes it using `isSafeRelativePath` and length check (`<= 200`), forwards it to `POST /api/auth/magic-link/send`, and passes it to `<PasskeySignIn />`.
3. **Layout & Session Defense-in-Depth (`src/app/(teacher)/layout.tsx`, `src/app/(student)/layout.tsx`, `src/lib/session.ts`, `src/lib/student-guard.ts`)**: Reads `x-pathname` from headers when session verification fails, preserving redirect destinations for expired or revoked session cookies.

This test review evaluates the test suite changes against test coverage gaps, assertion falsifiability/discrimination, boundary edge cases, and mock realism across unit, component, and E2E tiers.

### Summary of Findings by Severity

| Severity | Count | Key Focus |
|---|:---:|---|
| **Critical** | 1 | Non-discriminating E2E test assertion bypassing login form submission via synthetic token minting |
| **Important** | 3 | Complete lack of tests for server layout/session defense-in-depth, boundary gaps on length limit, missing query-string tests in component & guard tests |
| **Suggestion** | 4 | Session shapes with null roles in guard tests, matcher-to-`RESERVED_SLUGS` synchronization, mock realism of `redirect()`, and open-redirect evasion payloads |

---

## 2. 🚨 Critical Findings

### Finding 1: Non-Discriminating E2E Assertion in `tests/e2e/auth.spec.ts` — Synthetic Token Decouples Destination Preservation from Form Submission

- **File & Lines:** `tests/e2e/auth.spec.ts:225-248`
- **Scenario:** End-to-end destination preservation test (`unauthenticated user visiting protected route with redirect preserves destination through sign-in`).
- **Detailed Analysis:**
  The test begins by visiting `/settings/rooms`, verifies redirection to `/login?redirect=%2Fsettings%2Frooms`, fills in `teacherEmail`, and clicks the submit button:
  ```ts
  await page.goto('/settings/rooms');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Frooms/);

  await page.getByLabel('Email').fill(teacherEmail);
  await page.getByRole('button', { name: 'Send me the link' }).click();

  await expect(
    page.getByText('Check your inbox for the link.')
  ).toBeVisible();
  ```
  At this point, the browser has called `POST /api/auth/magic-link/send`. However, lines 238–244 do the following:
  ```ts
  const cookies = await page.context().cookies();
  const originCookie = cookies.find((c) => c.name === 'fair_yoga_origin');
  const nonce = originCookie?.value ?? '';
  const rawToken = await createMagicLinkToken(teacherEmail, nonce, '/settings/rooms');

  await page.goto(`/verify?token=${rawToken}`);
  ```
  `createMagicLinkToken(teacherEmail, nonce, '/settings/rooms')` directly creates an entirely new, independent record in `prisma.magicLinkToken` with `redirectTo: '/settings/rooms'` hardcoded in the test call.
- **Why this fails falsifiability & discrimination:**
  "A guard that cannot fail certifies nothing." (`AGENTS.md`).
  If a regression is introduced into `src/app/(public)/login/page.tsx` that drops the `redirect` parameter from the fetch body (e.g., `body: JSON.stringify({ email })`), or if `POST /api/auth/magic-link/send` fails to persist `body.redirect`:
  **This E2E test will STILL PASS!**
  The test completely discards the token actually produced by the form submission and instead verifies against the synthetically injected token that was manually gifted `redirectTo: '/settings/rooms'`.
- **Recommended Remediation:**
  Assert that the token written to the database as a result of the UI form submission actually captured the redirect parameter before or during verification:
  ```ts
  // Assert the token produced by clicking the form actually preserved the redirect destination
  const formToken = await prisma.magicLinkToken.findFirst({
    where: { email: teacherEmail },
    orderBy: { createdAt: 'desc' },
  });
  expect(formToken?.redirectTo).toBe('/settings/rooms');
  ```
  Alternatively, if verification requires a known token secret, the test should explicitly acknowledge that the database record is the subject of verification for the form submission step.

---

## 3. ⚠️ Important Findings

### Finding 2: Complete Absence of Tests for Server Layout & Session Defense-in-Depth (`requireTeacherSession`, `TeacherLayout`, `StudentLayout`)

- **Files & Lines:**
  - `src/lib/session.ts:18-21` (`requireTeacherSession`)
  - `src/app/(teacher)/layout.tsx:22-24` (`TeacherLayout`)
  - `src/app/(student)/layout.tsx:12-13` (`StudentLayout`)
- **Scenario:** Visitor accesses a protected route with an invalid or expired `fair_yoga_session` cookie.
- **Detailed Analysis:**
  The PR modifies `requireTeacherSession` in `src/lib/session.ts`, `TeacherLayout` in `src/app/(teacher)/layout.tsx`, and `StudentLayout` in `src/app/(student)/layout.tsx` to read `x-pathname` from `headers()` and issue a redirect to `/login?redirect=${encodeURIComponent(pathname)}`.
  This is explicitly designed to handle the expired/invalid cookie edge case (where `src/proxy.ts` passes the request through because a cookie header exists, stamps `x-pathname`, but the database session lookup fails).
  However:
  - There are **zero unit tests** for `requireTeacherSession` in `src/lib/session.ts`.
  - There are **zero tests** for `TeacherLayout` or `StudentLayout` handling `x-pathname`.
  - There are **zero integration or E2E tests** that send an invalid/expired session cookie to a protected route to verify that the server-side layout/guard preserves destination.
  Only the helper function `redirectNonStudent` has unit tests (`src/lib/student-guard.test.ts`), leaving the server components and session guard that actually read from `headers()` completely untested.
- **Why it matters:**
  If Next.js header access (`(await headers()).get('x-pathname')`) fails or behaves differently during server component execution, or if `requireTeacherSession` constructs an incorrect URL, no test in the test suite will fail.
- **Recommended Remediation:**
  1. Add a unit test file `src/lib/session.test.ts` covering `requireTeacherSession`:
     - When unauthenticated and `x-pathname` is a safe relative path -> redirects to `/login?redirect=...`.
     - When unauthenticated and `x-pathname` is unsafe -> redirects to `/login`.
     - When unauthenticated and `x-pathname` is absent -> redirects to `/login`.
  2. Add an integration or E2E test making a request with an invalid `fair_yoga_session=expired-token` cookie to `/settings/rooms` and asserting redirect to `/login?redirect=%2Fsettings%2Frooms`.

---

### Finding 3: Boundary Gaps on String Length Limits in `login/page.test.tsx` and Architectural Inconsistency with Server Guards

- **Files & Lines:**
  - `src/app/(public)/login/page.test.tsx:96`
  - `src/app/(public)/login/page.tsx:16`
  - `src/lib/student-guard.ts:16`
- **Scenario:** Validating maximum URL length constraints on `redirect` parameters.
- **Detailed Analysis:**
  In `src/app/(public)/login/page.tsx`:
  ```ts
  const redirect =
    rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
      ? rawRedirect
      : undefined;
  ```
  In `src/app/(public)/login/page.test.tsx`:
  ```ts
  ['string exceeding 200 chars', '/' + 'a'.repeat(201)] // length = 202
  ```
  - **Off-by-one boundary testing gap:** The test uses length 202 (`'/' + 201 'a's`). It tests neither the exact upper boundary (length 200, which must be accepted) nor the immediate off-by-one violation (length 201, which must be rejected).
  - **Inconsistency across defense-in-depth guards:** While `login/page.tsx` and `relativePath` (`src/lib/schemas.ts:121`) enforce `length <= 200`, `redirectNonStudent` (`src/lib/student-guard.ts:16`), `TeacherLayout` (`layout.tsx:22`), and `requireTeacherSession` (`session.ts:18`) only check `isSafeRelativePath(pathname)` and **do not enforce length <= 200**. Consequently, `student-guard.test.ts` has zero tests for length boundaries.
- **Why it matters:**
  Boundary value analysis requires testing at $N$, $N+1$, and $N-1$. Testing at $N+2$ fails to verify whether the comparison operator was `<=` or `<`.
- **Recommended Remediation:**
  In `src/app/(public)/login/page.test.tsx`:
  - Add a test verifying that a 200-character path is accepted: `'/' + 'a'.repeat(199)`.
  - Update the rejection test to test the exact edge: `'/' + 'a'.repeat(200)` (201 characters).

---

### Finding 4: Query String Preservation Untested in `login/page.test.tsx` and `student-guard.test.ts`

- **Files & Lines:**
  - `src/app/(public)/login/page.test.tsx:67-84`
  - `src/lib/student-guard.test.ts:38-42`
- **Scenario:** Visiting a protected route containing query parameters (e.g. `/account/privacy?tab=invitations`).
- **Detailed Analysis:**
  A core motivation of Issue #615 was preserving query parameters across redirects (e.g. `/students/stu-1?tab=notes&filter=active`, `/account/privacy?tab=invitations`).
  `src/proxy.test.ts` has solid coverage testing that `proxy` sets `?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations`.
  However:
  - In `src/app/(public)/login/page.test.tsx`, the only paths tested are `/account/privacy` and `/students/s-1`. There is no test verifying that when `redirect` contains query parameters (or URL-encoded query parameters), it is preserved intact in the `POST /api/auth/magic-link/send` body and passed to `PasskeySignIn`.
  - In `src/lib/student-guard.test.ts`, the test only passes `redirectPath = '/account/privacy'`. It never verifies that `redirectNonStudent(null, '/account/privacy?tab=invitations')` properly encodes the query parameters into `/login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations`.
- **Recommended Remediation:**
  - In `src/app/(public)/login/page.test.tsx`, add a test case with a query-parameterized redirect: `?redirect=/account/privacy?tab=invitations`.
  - In `src/lib/student-guard.test.ts`, add a test asserting that `redirectNonStudent(null, '/account/privacy?tab=invitations')` calls `redirect('/login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations')`.

---

## 4. 🔧 Suggestions & Test Quality Improvements

### Finding 5: Missing Test for Dual-Null Role Sessions in `src/lib/student-guard.test.ts`

- **File & Lines:** `src/lib/student-guard.test.ts:26-70`
- **Analysis:**
  `src/lib/student-guard.test.ts` tests either `teacherSession` (`teacherId: 'teacher-1', studentId: null`) or `null`.
  It does not test an authenticated session where an account exists but has neither role yet (`teacherId: null, studentId: null`).
- **Recommendation:**
  Add a test:
  ```ts
  it('redirects an account session with no teacher or student role to login with redirect param', () => {
    const rolelessSession: SessionUser = {
      ...teacherSession,
      teacherId: null,
      studentId: null,
    };
    redirectNonStudent(rolelessSession, '/account/privacy');
    expect(redirect).toHaveBeenCalledWith('/login?redirect=%2Faccount%2Fprivacy');
  });
  ```

---

### Finding 6: Missing Contract Synchronization Test Between `config.matcher` and `RESERVED_SLUGS`

- **File & Lines:** `src/proxy.test.ts:114-128`
- **Analysis:**
  The design spec states:
  > *"All 9 prefixes are already defined in `RESERVED_SLUGS` (`src/lib/schemas.ts:180-183`). No teacher page slug can shadow or conflict with them."*
  `src/proxy.test.ts` tests `expect(config.matcher).toEqual([...])`. While this verifies literal array equality, it does not programmatically link `config.matcher` with `RESERVED_SLUGS`. If a developer adds a 10th prefix to `config.matcher` without registering it in `RESERVED_SLUGS`, a teacher could register that slug as their username, causing their public profile (`/[slug]`) to be intercepted by the auth proxy.
- **Recommendation:**
  Add a test in `src/proxy.test.ts` verifying that every top-level segment in `config.matcher` exists in `RESERVED_SLUGS`.

---

### Finding 7: Mock Realism — Next.js `redirect()` Control Flow Termination

- **File & Lines:** `src/lib/student-guard.test.ts:5-11`
- **Analysis:**
  In Next.js, `redirect()` throws an internal `NEXT_REDIRECT` error and never returns (return type is `never`).
  In `src/lib/student-guard.test.ts`, `redirect` is mocked as a standard `vi.fn()` that returns `undefined`.
  Because all branches in `redirectNonStudent` currently terminate with `redirect(...)`, this mock does not cause immediate problems. However, if code were ever placed after a `redirect()` call, the test suite would not catch that it is unreachable in production.
- **Recommendation:**
  Document the mock choice with a comment, or mock `redirect` to throw an error simulating Next.js runtime termination.

---

### Finding 8: Extended Open-Redirect Evasion Payloads in `login/page.test.tsx`

- **File & Lines:** `src/app/(public)/login/page.test.tsx:92-97`
- **Analysis:**
  The `it.each` table in `login/page.test.tsx` tests `//evil.com`, `/\\evil.com`, `https://evil.com`, and length > 200.
  Common open-redirect evasion payloads that should also be rejected include:
  - Relative URL missing leading slash: `'evil.com'` or `'google.com/path'`
  - Protocol-less script payload: `'javascript:alert(1)'`
  - Empty string: `''` (`?redirect=`)
  - Carriage return / newline injection: `'/\r/evil.com'`
- **Recommendation:**
  Expand the parameterized table in `login/page.test.tsx` to include `'evil.com'`, `'javascript:alert(1)'`, and `''`.

---

## 5. Verification Checklist & Empirical Results

| Check | Expected | Actual | Verdict |
|---|---|---|:---:|
| `tsc --noEmit` | Clean exit 0 | Exit code 0, 0 errors | **PASS** |
| `src/proxy.test.ts` | All pass | 11 passed | **PASS** |
| `src/app/(public)/login/page.test.tsx` | All pass | 9 passed | **PASS** |
| `src/lib/student-guard.test.ts` | All pass | 6 passed | **PASS** |
| Assertion Falsifiability | Fails when logic broken | E2E synthetic token does NOT fail if form drops redirect | **FAIL (Finding 1)** |
| Boundary Testing | Edge cases ($N, N+1$) tested | 200/201 length boundary untested | **WARN (Finding 3)** |
| Guard Coverage | All touched modules tested | `requireTeacherSession`, `(teacher)/layout`, `(student)/layout` untested | **WARN (Finding 2)** |
