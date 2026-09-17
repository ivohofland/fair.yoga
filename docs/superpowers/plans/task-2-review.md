# Task 2 Code Review: Forward `redirect` in `/login` with safety validation

**Verdict:** APPROVED  
**Reviewer:** Code Reviewer Subagent  
**Date:** 2026-09-17  
**Issue:** #615 (Destination preservation on sign-in)  
**Task:** Task 2 (Forward `redirect` in `/login` with safety validation)  

---

## 1. Executive Summary

Task 2 implements safe reading, validation, and forwarding of the `redirect` query parameter on the `/login` route. Unauthenticated visitors redirected to `/login` now retain their destination path when authenticating via email magic link or WebAuthn passkey.

The implementation in `src/app/(public)/login/page.tsx` and the test suite in `src/app/(public)/login/page.test.tsx` were reviewed against:
- Implementation Plan: `docs/superpowers/plans/2026-09-17-login-redirect-preservation.md` (Task 2)
- Architecture Spec: `docs/superpowers/specs/2026-09-17-login-redirect-preservation-design.md`
- Task 2 Report: `docs/superpowers/plans/task-2-report.md`

All spec requirements, quality standards, testing robustness, and mutation testing verifications have passed without reservations.

---

## 2. Spec Compliance Checklist

| Spec Requirement | Status | Evidence / Implementation Details |
|---|---|---|
| **Suspense boundary wrapping** | PASS | `LoginPage` wraps `LoginForm` in `<Suspense fallback={null}>`, satisfying Next.js App Router requirements for `useSearchParams()`. |
| **`useSearchParams()` extraction** | PASS | `searchParams.get('redirect')` extracts the parameter inside the inner `LoginForm` component. |
| **Safe relative path validation** | PASS | `isSafeRelativePath(rawRedirect)` ensures the path begins with a single slash and rejects protocol-relative or backslash paths. |
| **Length boundary enforcement** | PASS | `rawRedirect.length <= 200` guards against oversized inputs, aligning with schema constraints. |
| **Silent drop of unsafe paths** | PASS | Invalid/unsafe paths evaluate `redirect` to `undefined`. No error alert is shown to the user; the sign-in flow defaults silently to role home (`/schedule` or `/bookings`). |
| **Forwarding to Magic Link API** | PASS | `POST /api/auth/magic-link/send` body includes `...(redirect ? { redirect } : {})`, sending `redirect` only when valid and defined. |
| **Forwarding to `PasskeySignIn`** | PASS | `<PasskeySignIn redirect={redirect} />` forwards the sanitized parameter to the WebAuthn component. |

---

## 3. Code Quality & Standards

- **Type Safety & No `any`**:
  - `src/app/(public)/login/page.tsx` introduces zero `any` types.
  - `src/app/(public)/login/page.test.tsx` uses explicit typing for mocked components (`(props: { redirect?: string })`) and tuple casts (`[string, RequestInit]`).
  - `pnpm run typecheck` (`tsc --noEmit`) passes with 0 errors.
- **Clean Architecture**:
  - Clear separation between the client form logic (`LoginForm`) and the Suspense boundary wrapper (`LoginPage`).
  - Conditional spreading `...(redirect ? { redirect } : {})` avoids sending `{ redirect: undefined }` in JSON payloads.
- **Accessibility**:
  - Accessible form structure is preserved: labeled input (`label="Email"`), typed inputs, submit button with pending state feedback (`Sending...`), and error message with `role="alert"`.
- **Comment Discipline**:
  - Code contains only necessary explanations; no roster comments, task checklists, or issue counters were added to source files.

---

## 4. Test Suite Robustness

The test suite in `src/app/(public)/login/page.test.tsx` verifies both normal operation and malicious/malformed inputs:

1. **Absent parameter**:
   - Asserts magic-link `POST` body does not have `redirect`.
   - Asserts `PasskeySignIn` receives `{ redirect: undefined }`.
2. **Valid parameters**:
   - Asserts `?redirect=/account/privacy` passes `{ email, redirect: '/account/privacy' }` to magic-link `fetch` and `PasskeySignIn`.
   - Asserts `?redirect=/students/s-1` passes to `PasskeySignIn`.
3. **Unsafe parameters (parameterized via `it.each`)**:
   - `//evil.com` (protocol-relative URL)
   - `/\\evil.com` (backslash open-redirect bypass)
   - `https://evil.com` (absolute URL)
   - `'/' + 'a'.repeat(201)` (string exceeding 200 characters)
   - Asserts all unsafe values are omitted from the POST body and passed as `undefined` to `PasskeySignIn`.
4. **Suspense boundary**:
   - Asserts `<LoginPage />` renders the fallback (`container.toBeEmptyDOMElement()`) when `useSearchParams` suspends.

---

## 5. Mutation Testing Verification

An independent mutation was executed during review to verify the test suite guards:

- **Mutation applied**:
  ```diff
  -  const redirect =
  -    rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
  -      ? rawRedirect
  -      : undefined;
  +  const redirect = rawRedirect ?? undefined;
  ```
- **Observed Result**:
  Vitest immediately failed 4 tests:
  - `omits unsafe redirect (protocol-relative URL: //evil.com) from POST body and PasskeySignIn`
  - `omits unsafe redirect (backslash path: /\evil.com) from POST body and PasskeySignIn`
  - `omits unsafe redirect (absolute URL: https://evil.com) from POST body and PasskeySignIn`
  - `omits unsafe redirect (string exceeding 200 chars) from POST body and PasskeySignIn`
- **Restoration**:
  The mutation was restored and tests immediately returned to green (9 passing tests).
- **Conclusion**:
  The guard bites. The tests cannot pass without strict `isSafeRelativePath` and length validation.

---

## 6. Verification Results

All automated verification checks ran cleanly:

- **Component Tests**:
  ```bash
  $ pnpm exec vitest run "src/app/(public)/login/page.test.tsx"
  Test Files  1 passed (1)
  Tests       9 passed (9)
  Duration    1.56s
  ```
- **Typecheck**:
  ```bash
  $ pnpm run typecheck
  $ tsc --noEmit
  (exit code 0)
  ```
- **Linter**:
  ```bash
  $ pnpm run lint
  $ eslint
  (0 errors, 6 existing repository warnings in unrelated files)
  ```

---

## 7. Conclusion

Task 2 is complete, fully tested, and meets all architectural, functional, and security requirements. Task 3 (defense-in-depth in layouts and session guards) can proceed.
