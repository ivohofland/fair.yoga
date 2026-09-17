# Fix Wave Review: Login Destination Preservation (#615)

**Review Date:** 2026-09-17  
**Reviewer:** Scoped Re-Reviewer  
**Status:** **APPROVED / PASS**

---

## 1. Findings and Verification Checklist

### 1. Query Parameter Preservation in `x-pathname`
- **Question:** Did `src/proxy.ts` preserve query parameters in `x-pathname` (`request.nextUrl.pathname + request.nextUrl.search`) so invalid/expired session fallbacks retain query strings?
- **Finding:** **Yes.**
- **Details:** In `src/proxy.ts` line 23, the header assignment was updated to:
  ```typescript
  requestHeaders.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);
  ```
  When a user with an invalid or expired session cookie accesses a protected route with query parameters (such as `/account/privacy?tab=invitations`), the proxy forwards the request with `x-pathname` containing both the pathname and search query. Downstream layout guards (`TeacherLayout` and `StudentLayout` via `redirectNonStudent`) read `x-pathname` and pass it to `/login?redirect=${encodeURIComponent(pathname)}`, successfully preserving query parameters across the login and re-authentication flow.

### 2. Stale Comment Cleanup
- **Question:** Was the stale comment on lines 20-21 of `src/proxy.ts` cleaned up?
- **Finding:** **Yes.**
- **Details:** The stale comment stating `(unmatched teacher routes skip this proxy, so the layout treats the header as advisory with hardcoded targets only)` was completely removed. It was replaced with an accurate comment describing the current universal route protection and destination preservation behavior:
  ```typescript
  // Layouts can't see the pathname; stamp it with any query parameters so
  // layouts and guards can preserve destination on invalid sessions, and so
  // the (teacher) layout can send a student-only session from /settings to their own.
  const requestHeaders = new Headers(request.headers);
  // Belt and suspenders: set() replaces, but never let a client-supplied
  // value even transit.
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);
  ```

### 3. Unit Test Coverage in `src/proxy.test.ts`
- **Question:** Did `src/proxy.test.ts` add a test asserting query parameters are preserved in `x-pathname`?
- **Finding:** **Yes.**
- **Details:** A dedicated unit test was added under the `authenticated requests` suite in `src/proxy.test.ts` (lines 102–111):
  ```typescript
  it('preserves query parameters in stamped x-pathname header', () => {
    const request = makeRequest('/account/privacy?tab=invitations', {
      cookies: { fair_yoga_session: 'valid-session-token' },
    });
    const response = proxy(request);

    expect(response.status).toBe(200);
    const stampedPathname = response.headers.get('x-middleware-request-x-pathname');
    expect(stampedPathname).toBe('/account/privacy?tab=invitations');
  });
  ```

### 4. Vitest Test Execution
- **Question:** Run `pnpm exec vitest run src/proxy.test.ts` and verify it passes.
- **Finding:** **Yes, passed cleanly.**
- **Details:**
  Command: `pnpm exec vitest run src/proxy.test.ts`
  Output:
  ```
   RUN  v4.1.10 /Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615

  [unit-db] unit tests run against ethical_yoga_test

   Test Files  1 passed (1)
        Tests  11 passed (11)
     Start at  10:01:55
     Duration  1.32s
  ```
  In addition, `pnpm run typecheck` and `pnpm run lint` were executed and both passed with 0 errors.

---

## 2. Verdict

All items identified in `docs/superpowers/plans/whole-branch-review.md` have been properly addressed, verified with automated tests, and confirmed passing. The fix wave is complete and ready to merge.
