# Task 2 Report: Forward `redirect` in `/login` with safety validation

## Overview
Implemented Task 2 of Issue #615 to read, sanitize, and forward the `redirect` query parameter on the `/login` page:
- Wrapped the login form in a `LoginForm` component and rendered it inside a `<Suspense fallback={null}>` boundary in `LoginPage` (default export) to safely read `useSearchParams()`.
- Validated and sanitized `redirect` using `isSafeRelativePath` and length limit ($\le 200$), discarding unsafe values (`//evil.com`, `/\evil.com`, `https://evil.com`, length $> 200$) silently to `undefined`.
- Forwarded `redirect` in the JSON request body to `POST /api/auth/magic-link/send`.
- Passed `redirect` to `<PasskeySignIn redirect={redirect} />`.
- Added comprehensive unit/component tests in `src/app/(public)/login/page.test.tsx` and performed mutation testing.

## Changes Made

### 1. `src/app/(public)/login/page.tsx`
- Extracted login form into `LoginForm`.
- Exported `LoginPage` wrapping `LoginForm` in `<Suspense fallback={null}>`.
- Used `useSearchParams()` to retrieve `redirect` query parameter.
- Sanitized with `isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200`.
- Passed `{ email, ...(redirect ? { redirect } : {}) }` to `POST /api/auth/magic-link/send`.
- Passed `redirect` prop to `<PasskeySignIn redirect={redirect} />`.

### 2. `src/app/(public)/login/page.test.tsx`
- Mocked `next/navigation` (`useSearchParams`, `useRouter`) and `@/components/booking/passkey-sign-in` (`PasskeySignIn`).
- Added tests verifying:
  - Without redirect query param: POST body has no `redirect` property and `PasskeySignIn` receives `undefined`.
  - With valid redirect (`?redirect=/account/privacy`): POST body includes `redirect: '/account/privacy'` and `PasskeySignIn` receives `'/account/privacy'`.
  - With valid redirect (`?redirect=/students/s-1`): `PasskeySignIn` receives `'/students/s-1'`.
  - With unsafe redirects (`//evil.com`, `/\evil.com`, `https://evil.com`, string $> 200$ chars): POST body omits `redirect` property and `PasskeySignIn` receives `undefined`.
  - Search params suspense fallback rendering.

---

## Code Diffs

### `src/app/(public)/login/page.tsx`
```diff
@@ -1,7 +1,8 @@
 'use client';
 
-import { useState } from 'react';
+import { useState, Suspense } from 'react';
 import Link from 'next/link';
+import { useSearchParams } from 'next/navigation';
 import { Button } from '@/components/ui/button';
 import { Input } from '@/components/ui/input';
 import { PasskeySignIn } from '@/components/booking/passkey-sign-in';
@@ -8,5 +9,13 @@
 import { HandoffCodeEntry } from '@/components/auth/handoff-code-entry';
+import { isSafeRelativePath } from '@/lib/schemas';
 
-export default function LoginPage() {
+function LoginForm() {
+  const searchParams = useSearchParams();
+  const rawRedirect = searchParams.get('redirect');
+  const redirect =
+    rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
+      ? rawRedirect
+      : undefined;
+
   const [email, setEmail] = useState('');
   const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
 
@@ -19,7 +28,7 @@
       const res = await fetch('/api/auth/magic-link/send', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
-        body: JSON.stringify({ email }),
+        body: JSON.stringify({ email, ...(redirect ? { redirect } : {}) }),
       });
       if (res.ok) {
         setStatus('sent');
@@ -76,7 +85,7 @@
           </form>
 
           <div className="mt-4">
-            <PasskeySignIn />
+            <PasskeySignIn redirect={redirect} />
           </div>
 
           {/* For anyone who bookmarked /login before they had an account. */}
@@ -90,4 +99,12 @@
     </div>
   );
 }
+
+export default function LoginPage() {
+  return (
+    <Suspense fallback={null}>
+      <LoginForm />
+    </Suspense>
+  );
+}
```

### `src/app/(public)/login/page.test.tsx`
```diff
@@ -1,6 +1,26 @@
 import { describe, it, expect, vi, afterEach } from 'vitest';
 import { render, screen, fireEvent } from '@testing-library/react';
+
+let searchParams = new URLSearchParams();
+let suspendSearchParams = false;
+
+vi.mock('next/navigation', () => ({
+  useSearchParams: () => {
+    if (suspendSearchParams) throw new Promise<void>(() => {});
+    return searchParams;
+  },
+  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
+}));
+
+const passkeySignInMock = vi.fn();
+vi.mock('@/components/booking/passkey-sign-in', () => ({
+  PasskeySignIn: (props: { redirect?: string }) => {
+    passkeySignInMock(props);
+    return <div data-testid="passkey-sign-in" data-redirect={props.redirect ?? ''} />;
+  },
+}));
+
 import LoginPage from './page';
 
 function submit(email = 'anna@example.com') {
@@ -9,6 +29,9 @@
 describe('LoginPage', () => {
   afterEach(() => {
     vi.unstubAllGlobals();
+    passkeySignInMock.mockClear();
+    searchParams = new URLSearchParams();
+    suspendSearchParams = false;
   });
 
   it('swaps itself for the sent-message panel, with the handoff code entry rendered', async () => {
@@ -19,4 +42,75 @@
     expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
     expect(screen.getByLabelText('Code')).toBeInTheDocument();
   });
+
+  it('omits redirect from POST body and passes undefined to PasskeySignIn when redirect param is absent', async () => {
+    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
+    vi.stubGlobal('fetch', fetchMock);
+
+    render(<LoginPage />);
+
+    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: undefined });
+
+    submit();
+
+    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
+    expect(fetchMock).toHaveBeenCalled();
+    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
+    expect(url).toBe('/api/auth/magic-link/send');
+    const body = JSON.parse(init.body as string);
+    expect(body).toEqual({ email: 'anna@example.com' });
+    expect(body).not.toHaveProperty('redirect');
+  });
+
+  it('sends valid redirect in POST body to /api/auth/magic-link/send and passes to PasskeySignIn', async () => {
+    searchParams = new URLSearchParams({ redirect: '/account/privacy' });
+    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
+    vi.stubGlobal('fetch', fetchMock);
+
+    render(<LoginPage />);
+
+    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: '/account/privacy' });
+
+    submit();
+
+    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
+    expect(fetchMock).toHaveBeenCalled();
+    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
+    expect(url).toBe('/api/auth/magic-link/send');
+    const body = JSON.parse(init.body as string);
+    expect(body).toEqual({ email: 'anna@example.com', redirect: '/account/privacy' });
+  });
+
+  it('passes valid redirect to PasskeySignIn for protected routes like /students/s-1', () => {
+    searchParams = new URLSearchParams({ redirect: '/students/s-1' });
+    render(<LoginPage />);
+    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: '/students/s-1' });
+  });
+
+  it.each([
+    ['protocol-relative URL', '//evil.com'],
+    ['backslash path', '/\\evil.com'],
+    ['absolute URL', 'https://evil.com'],
+    ['string exceeding 200 chars', '/' + 'a'.repeat(201)],
+  ])('omits unsafe redirect (%s: %s) from POST body and PasskeySignIn', async (_, unsafeRedirect) => {
+    searchParams = new URLSearchParams({ redirect: unsafeRedirect });
+    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
+    vi.stubGlobal('fetch', fetchMock);
+
+    render(<LoginPage />);
+
+    expect(passkeySignInMock).toHaveBeenCalledWith({ redirect: undefined });
+
+    submit();
+
+    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
+    expect(fetchMock).toHaveBeenCalled();
+    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
+    expect(url).toBe('/api/auth/magic-link/send');
+    const body = JSON.parse(init.body as string);
+    expect(body).toEqual({ email: 'anna@example.com' });
+    expect(body).not.toHaveProperty('redirect');
+  });
+
+  it('renders fallback when search params suspend', () => {
+    suspendSearchParams = true;
+    const { container } = render(<LoginPage />);
+    expect(container).toBeEmptyDOMElement();
+  });
 });
```

---

## Test Execution Output

### 1. `pnpm exec vitest run "src/app/(public)/login/page.test.tsx"`
```
 RUN  v4.1.10 /Users/ivohofland/.gemini/antigravity/worktrees/fair.yoga/solve_issue_615

 ✓ |components| src/app/(public)/login/page.test.tsx (9 tests) 174ms
   ✓ LoginPage (9)
     ✓ swaps itself for the sent-message panel, with the handoff code entry rendered 95ms
     ✓ omits redirect from POST body and passes undefined to PasskeySignIn when redirect param is absent 19ms
     ✓ sends valid redirect in POST body to /api/auth/magic-link/send and passes to PasskeySignIn 12ms
     ✓ passes valid redirect to PasskeySignIn for protected routes like /students/s-1 2ms
     ✓ omits unsafe redirect (protocol-relative URL: //evil.com) from POST body and PasskeySignIn 11ms
     ✓ omits unsafe redirect (backslash path: /\evil.com) from POST body and PasskeySignIn 11ms
     ✓ omits unsafe redirect (absolute URL: https://evil.com) from POST body and PasskeySignIn 11ms
     ✓ omits unsafe redirect (string exceeding 200 chars: /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) from POST body and PasskeySignIn 10ms
     ✓ renders fallback when search params suspend 2ms

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  09:25:49
   Duration  1.32s (transform 87ms, setup 171ms, import 218ms, tests 174ms, environment 635ms)
```

### 2. `pnpm run typecheck`
```
$ tsc --noEmit
(clean exit 0)
```

### 3. `pnpm exec vitest run --project components`
```
 Test Files  72 passed (72)
      Tests  593 passed (593)
   Start at  09:25:05
   Duration  17.49s (transform 4.23s, setup 22.32s, import 10.16s, tests 21.02s, environment 85.17s)
```

---

## Mutation Testing Protocol

### Mutation Applied
Temporarily bypassed safety validation in `src/app/(public)/login/page.tsx`:
```diff
 function LoginForm() {
   const searchParams = useSearchParams();
   const rawRedirect = searchParams.get('redirect');
-  const redirect =
-    rawRedirect && isSafeRelativePath(rawRedirect) && rawRedirect.length <= 200
-      ? rawRedirect
-      : undefined;
+  const redirect = rawRedirect ?? undefined;
```

### Failure Observed
`pnpm exec vitest run "src/app/(public)/login/page.test.tsx"`
```
 ❯ |components| src/app/(public)/login/page.test.tsx (9 tests | 4 failed) 133ms
   ❯ LoginPage (9)
     ✓ swaps itself for the sent-message panel, with the handoff code entry rendered 93ms
     ✓ omits redirect from POST body and passes undefined to PasskeySignIn when redirect param is absent 13ms
     ✓ sends valid redirect in POST body to /api/auth/magic-link/send and passes to PasskeySignIn 10ms
     ✓ passes valid redirect to PasskeySignIn for protected routes like /students/s-1 2ms
     × omits unsafe redirect (protocol-relative URL: //evil.com) from POST body and PasskeySignIn 5ms
     × omits unsafe redirect (backslash path: /\evil.com) from POST body and PasskeySignIn 2ms
     × omits unsafe redirect (absolute URL: https://evil.com) from POST body and PasskeySignIn 2ms
     × omits unsafe redirect (string exceeding 200 chars: /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) from POST body and PasskeySignIn 3ms
     ✓ renders fallback when search params suspend 2ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  |components| src/app/(public)/login/page.test.tsx > LoginPage > omits unsafe redirect (protocol-relative URL: //evil.com) from POST body and PasskeySignIn
AssertionError: expected "vi.fn()" to be called with arguments: [ { redirect: undefined } ]
Received: [ { "redirect": "//evil.com" } ]

 FAIL  |components| src/app/(public)/login/page.test.tsx > LoginPage > omits unsafe redirect (backslash path: /\evil.com) from POST body and PasskeySignIn
AssertionError: expected "vi.fn()" to be called with arguments: [ { redirect: undefined } ]
Received: [ { "redirect": "/\\evil.com" } ]

 FAIL  |components| src/app/(public)/login/page.test.tsx > LoginPage > omits unsafe redirect (absolute URL: https://evil.com) from POST body and PasskeySignIn
AssertionError: expected "vi.fn()" to be called with arguments: [ { redirect: undefined } ]
Received: [ { "redirect": "https://evil.com" } ]

 FAIL  |components| src/app/(public)/login/page.test.tsx > LoginPage > omits unsafe redirect (string exceeding 200 chars: /aaa...) from POST body and PasskeySignIn
AssertionError: expected "vi.fn()" to be called with arguments: [ { redirect: undefined } ]
Received: [ { "redirect": "/aaa..." } ]
```

### Restoration and Confirmation
Restored `src/app/(public)/login/page.tsx` to use `isSafeRelativePath` and `length <= 200`.
Re-ran `pnpm exec vitest run "src/app/(public)/login/page.test.tsx"`.
Result: 9 passed (9). Suite is completely green.
