# Task 3 Review: Defense-in-depth in layouts and session guards

**Issue:** #615  
**Review Target:** Task 3 (Plan: `docs/superpowers/plans/2026-09-17-login-redirect-preservation.md`, Spec: `docs/superpowers/specs/2026-09-17-login-redirect-preservation-design.md`, Report: `docs/superpowers/plans/task-3-report.md`)  
**Verdict:** **APPROVED**

---

## 1. Executive Summary

Task 3 implements defense-in-depth destination preservation for scenarios where an unauthenticated or expired session cookie passes edge cookie-presence checks in `proxy.ts`. 

All plan and spec requirements for Task 3 are fully satisfied:
- `redirectNonStudent` preserves `redirectPath` while ensuring precedence for signed-in teachers (`session?.teacherId -> /schedule`).
- `StudentLayout`, `TeacherLayout`, and `requireTeacherSession` retrieve `x-pathname` from `headers()` and validate with `isSafeRelativePath` prior to building the redirect target.
- Full backward compatibility is preserved for existing callers across the codebase.
- No `any` types or unsafe constructs are introduced. Comment discipline strictly aligns with repository rules.
- Robust unit tests were added in `src/lib/student-guard.test.ts`.
- Mutation tests were verified independently and proved that both destination preservation and teacher precedence guards bite.
- Clean verification passed across unit tests, component tests, TypeScript typechecking, and ESLint.

---

## 2. Detailed Checklist & Spec Compliance

### A. Spec & Plan Compliance
- [x] **`redirectNonStudent` in `src/lib/student-guard.ts`:**
  - Widened signature to `redirectNonStudent(session: SessionUser | null, redirectPath?: string | null): never`.
  - **Teacher Precedence:** Checked first via `if (session?.teacherId) redirect('/schedule')`. A teacher accessing student routes is always sent to `/schedule`, regardless of whether `redirectPath` is provided.
  - **Destination Preservation:** `else if (redirectPath && isSafeRelativePath(redirectPath))` redirects to `/login?redirect=${encodeURIComponent(redirectPath)}`.
  - **Fallback:** Unauthenticated callers with null, empty, or unsafe paths fall back to bare `/login`.
- [x] **`StudentLayout` in `src/app/(student)/layout.tsx`:**
  - Reads `const pathname = (await headers()).get('x-pathname');`.
  - Forwards `pathname` to `redirectNonStudent(session, pathname)`.
- [x] **`TeacherLayout` in `src/app/(teacher)/layout.tsx`:**
  - Reads `pathname` from `(await headers()).get('x-pathname')`.
  - Maintains courteous redirection to `/account` or `/bookings` when `session?.studentId` is present.
  - For unauthenticated requests (`!session?.teacherId && !session?.studentId`), redirects to `/login?redirect=${encodeURIComponent(pathname)}` if `pathname && isSafeRelativePath(pathname)`, else bare `/login`.
- [x] **`requireTeacherSession` in `src/lib/session.ts`:**
  - When `!session?.teacherId`, reads `x-pathname` from `(await headers()).get('x-pathname')`.
  - Redirects to `/login?redirect=${encodeURIComponent(pathname)}` if `pathname && isSafeRelativePath(pathname)`, else bare `/login`.

### B. Code Quality & Invariants
- [x] **No `any`:** Zero occurrences of `any` across touched files and new test files. Strict TypeScript compliance verified.
- [x] **Backward Compatibility:** All existing invocations of `redirectNonStudent(session)` in pages (`bookings/page.tsx`, `account/privacy/page.tsx`, `account/tier/page.tsx`, `account/page.tsx`, `account/data/page.tsx`, `account/notifications/page.tsx`, `updates/page.tsx`) pass a single argument and behave identically to their original implementation.
- [x] **Comment Discipline:** No comment rosters, counts, or changelog commentary. Comments accurately explain rationale and intent.
- [x] **Framework Conformance:** Properly complies with Next.js 16 asynchronous `headers()` API (`await headers()`).

### C. Test Robustness (`src/lib/student-guard.test.ts`)
- [x] Verifies teacher redirect to `/schedule` without `redirectPath`.
- [x] Verifies teacher redirect to `/schedule` with `redirectPath` present (proving teacher precedence).
- [x] Verifies unauthenticated session with valid `redirectPath` redirects to `/login?redirect=%2Faccount%2Fprivacy`.
- [x] Verifies unauthenticated session with unsafe redirect paths (`//evil.com`, `/\\evil.com`, `https://evil.com`) falls back to `/login`.
- [x] Verifies unauthenticated session without `redirectPath` redirects to `/login`.
- [x] Verifies unauthenticated session with `null` or `''` redirects to `/login`.
- [x] Verifies exact redirect arguments and call counts (`toHaveBeenCalledTimes(1)`).
- [x] Clean mock lifecycle with `beforeEach(() => vi.clearAllMocks())`.

---

## 3. Mutation Testing Verification

During code review, two independent mutation probes were performed against `src/lib/student-guard.ts`:

1. **Destination Preservation Bypass Probe:**
   - **Mutation:** Removed `else if (redirectPath && isSafeRelativePath(redirectPath))` branch, routing all unauthenticated callers to bare `/login`.
   - **Result:** `vitest` failed immediately:
     ```
     FAIL src/lib/student-guard.test.ts > redirectNonStudent > redirects unauthenticated session with valid redirectPath to login with encoded redirect
     AssertionError: expected "vi.fn()" to be called with arguments: [ Array(1) ]
     Received:
     - "/login?redirect=%2Faccount%2Fprivacy",
     + "/login"
     ```
2. **Teacher Precedence Inversion Probe:**
   - **Mutation:** Evaluated `redirectPath` before checking `session?.teacherId`.
   - **Result:** `vitest` failed immediately:
     ```
     FAIL src/lib/student-guard.test.ts > redirectNonStudent > redirects a teacher session to /schedule even when redirectPath is provided
     AssertionError: expected "vi.fn()" to be called with arguments: [ '/schedule' ]
     Received:
     - "/schedule",
     + "/login?redirect=%2Faccount%2Fprivacy"
     ```

Both probes confirmed that the test suite actively bites on regressions.

---

## 4. Verification Commands & Results

| Check | Command | Status | Notes |
|---|---|---|---|
| **Unit Tests** | `pnpm exec vitest run src/lib/student-guard.test.ts` | **PASS** | 6 passed (6) |
| **Component Tier** | `pnpm exec vitest run --project components` | **PASS** | 72 test files, 593 tests passed |
| **TypeScript** | `pnpm run typecheck` | **PASS** | `tsc --noEmit` exited 0 |
| **ESLint** | `pnpm run lint` | **PASS** | 0 errors |

---

## 5. Conclusion

Task 3 meets all functional, security, and quality requirements outlined in the design spec and implementation plan. The implementation is ready to proceed to Task 4.
