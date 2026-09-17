# Task 1 Review: Widen `src/proxy.ts` matcher and verify proxy routing (#615)

**Issue:** #615  
**Plan Reference:** `docs/superpowers/plans/2026-09-17-login-redirect-preservation.md` (Task 1)  
**Design Spec:** `docs/superpowers/specs/2026-09-17-login-redirect-preservation-design.md`  
**Implementer Report:** `docs/superpowers/plans/task-1-report.md`  
**Reviewer:** Antigravity Code Reviewer  
**Date:** 2026-09-17  

---

## Verdict: APPROVED

Task 1 changes in `src/proxy.ts` and `src/proxy.test.ts` fully comply with the design specification and implementation plan. All 9 protected route prefixes are accounted for, code quality and comment discipline are maintained, test assertions are exact, and mutation testing proves the guard bites as expected. Clean verification passed with 0 errors across typecheck, lint, and vitest.

---

## Review Checklist & Detailed Findings

### 1. Spec & Plan Compliance: FULLY COMPLIANT
- **9 Protected Route Prefixes**:
  `config.matcher` in `src/proxy.ts` was expanded from the original 5 prefixes to include all 9 protected prefixes:
  - `/schedule/:path*`
  - `/studio-class/:path*`
  - `/students/:path*`
  - `/inbox/:path*`
  - `/settings/:path*`
  - `/class/:path*`
  - `/bookings/:path*`
  - `/account/:path*`
  - `/updates/:path*`
- Matches the spec and plan verbatim.
- **Reserved Slug Invariant**: All 9 prefixes are part of `RESERVED_SLUGS` (`src/lib/schemas.ts`), guaranteeing that no teacher profile slug (`/[slug]`) can clash with these matcher routes.
- **Public Route Safety**: Public routes (`/`, `/[slug]`, `/[slug]/book/[classId]`, `/login`, `/signup`, `/verify`, `/api/*`) are not matched and remain accessible without credentials.

### 2. Code Quality & Standards: HIGH
- **Strict TypeScript**: No usage of `any`. Helper functions and signatures in `src/proxy.test.ts` are strongly typed (`options?: { cookies?: Record<string, string>; headers?: Record<string, string> }`).
- **No Unwanted Side Effects**: The changes in `src/proxy.ts` are minimal and focused exclusively on `config.matcher`. Existing proxy behavior (unauthenticated redirect vs pass-through + `x-pathname` stamping) remains intact.
- **Comment Discipline**: In compliance with `CLAUDE.md` and repository rules, no counts or rosters are introduced in comments. Comments only describe the code they sit on.
- **Linter & Compiler**: `pnpm run typecheck` (`tsc --noEmit`) and `pnpm exec eslint src/proxy.ts src/proxy.test.ts` pass with 0 warnings or errors.

### 3. Test Quality & Assertions: ROBUST & EXACT
- **Exact Array Equality**: `matches the 9 protected route prefixes` asserts `toEqual` against the exact list of 9 prefixes.
- **Explicit Redirect Targets**:
  - Tests verify unauthenticated requests to `/schedule`, `/studio-class/sc-1`, `/account/privacy`, and `/updates`.
  - Assertions check both HTTP status (`307`) and exact `Location` header (`http://localhost:3000/login?redirect=...`).
  - Query parameter preservation is verified with `/account/privacy?tab=invitations` -> `.../login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations`.
- **Authenticated Behavior**: Existing tests verify header stamping and stripping of spoofed client-supplied `x-pathname`.

### 4. Mutation Proof: VERIFIED
- **Mutation Tested**: Temporarily removed `'/schedule/:path*'` from `config.matcher` in `src/proxy.ts`.
- **Result**: Vitest immediately caught the mutation with a clear failure in `matches the 9 protected route prefixes`:
  `AssertionError: expected [ '/studio-class/:path*', …(7) ] to deeply equal [ '/schedule/:path*', …(8) ]`
- **Restoration**: Restored `src/proxy.ts` and confirmed suite is back to 10 passed tests (100% green).
- Proves that the test suite directly guards `config.matcher` entries.

### 5. Clean Verification Run
- `pnpm exec vitest run src/proxy.test.ts`: 10 passed (10 tests, 244ms).
- `pnpm run typecheck`: Passed (`tsc --noEmit` exited 0).
- `pnpm exec eslint src/proxy.ts src/proxy.test.ts`: Passed (0 errors/warnings).

---

## Conclusion & Readiness
Task 1 is complete, verified, and approved. The implementation is ready to proceed to Task 2 ("Forward `redirect` in `/login` with safety validation").
