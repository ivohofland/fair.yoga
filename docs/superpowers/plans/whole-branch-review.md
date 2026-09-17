# Whole-Branch Review: Login Destination Preservation (#615)

## 1. Cross-Task Consistency

### **CRITICAL: Query Parameter Loss on Invalid Sessions**
While `proxy.ts` correctly preserves query parameters for visitors without a cookie (`request.nextUrl.pathname + request.nextUrl.search`), it drops them for visitors with an **invalid or expired** session cookie.
- **Where:** `src/proxy.ts` sets the layout header as `requestHeaders.set('x-pathname', request.nextUrl.pathname);` (omitting `.search`).
- **Impact:** When a user with an expired session cookie visits `/account/privacy?tab=invitations`, `proxy.ts` allows the request through to the layouts. `TeacherLayout` and `StudentLayout` then read `x-pathname` (which is just `/account/privacy`) and redirect the user to `/login?redirect=%2Faccount%2Fprivacy`, silently dropping their query parameters.
- **Fix:** Update `proxy.ts` to include the search string in the header (e.g., `request.nextUrl.pathname + request.nextUrl.search`). (Note that `(pathname ?? '').startsWith('/settings')` in `TeacherLayout` will still work perfectly if query parameters are appended).

## 2. Stale Comments and Claims

### **IMPORTANT: Stale Proxy Comment**
- **Where:** `src/proxy.ts` lines 20-21.
- **Issue:** The comment states: `(unmatched teacher routes skip this proxy, so the layout treats the header as advisory with hardcoded targets only)`.
- **Fix:** This is now definitively stale. Task 1 expanded `config.matcher` to include all 9 protected route prefixes, meaning there are no "unmatched teacher routes" anymore. The comment should be updated to reflect that the proxy now universally intercepts all protected routes.

## 3. Security and Invariants

### **CLEAN: Open Redirect and Encoding Chain**
- `isSafeRelativePath` safely handles and validates the redirect parameter. It correctly rejects protocol-relative attacks like `//evil.com` and browsers' backslash normalization `/\evil.com`.
- The URL encoding chain is robust:
  - `proxy.ts` safely encodes parameters via `loginUrl.searchParams.set('redirect', ...)`
  - `src/app/(public)/login/page.tsx` safely decodes them via `useSearchParams().get('redirect')`
  - The layouts re-encode them correctly via `encodeURIComponent(pathname)`
- No double-encoding or decoding issues exist in the implemented flows.

## Conclusion
The branch successfully implements the destination preservation logic across the proxy, layouts, and auth pages. Addressing the query parameter drop in the invalid-session fallback and the stale comment in `proxy.ts` will bring the branch to completion.
