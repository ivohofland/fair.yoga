# Defense-in-depth hardening (#770) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pages get a per-request nonce CSP, API writes refuse cross-origin and non-JSON requests, the cron secret is compared in constant time and unreachable through nginx, health's per-job detail moves behind that secret, and dev Postgres stops listening on every interface.

**Architecture:** `src/proxy.ts` mints a nonce for every page and keeps the sign-in redirect as a separate path test; it never matches `/api/*`, because a matched path has its body buffered. The Origin check sits in `withErrorHandler`, which every mutating route already uses. `src/lib/csp.ts` owns both CSP strings; `src/lib/cron-auth.ts` owns the one secret compare that cron and health share.

**Tech Stack:** Next.js 16.3.4 (App Router, `proxy.ts`), TypeScript strict, Vitest (unit + integration projects), Playwright, nginx, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-08-defense-in-depth-design.md` (premise measured in `2026-10-08-defense-in-depth-census.md`, beside it).

## Global Constraints

- Nonce: 16 bytes from `crypto.getRandomValues`, base64 — 128 bits, fresh per request.
- Page CSP `script-src`: `'self' 'nonce-<n>' 'strict-dynamic'`, plus `'unsafe-eval'` in development only. Never `'unsafe-inline'` in `script-src`.
- Page CSP keeps `style-src 'self' 'unsafe-inline'`; adds `worker-src 'self'`; every other directive exactly as `next.config.ts` has it today.
- API CSP is exactly `default-src 'none'; frame-ancestors 'none'`, served only on `/api/:path*`, only from `next.config.ts`.
- The proxy matcher never includes `/api/*`. The proxy never produces an error response — headers and the sign-in redirect only.
- Origin check: methods `POST`, `PUT`, `PATCH`, `DELETE`; refuse 403 `CROSS_ORIGIN` when `Sec-Fetch-Site: cross-site`, or when `Origin` is present and its host differs from the request's `Host` (`Origin: null` is foreign). Neither header → pass. Compare host (`host:port`) only, never scheme.
- `parseBody` accepts only media type `application/json` (parameters allowed); anything else 415 `UNSUPPORTED_MEDIA_TYPE`. 415 joins both `ApiErrorStatus` and `ErrorStatus`.
- Every refusal carries a registered code and tests assert the code with `expectRefusal` (`tests/api-assertions.ts`), never the message.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments; comments state what is true now; history goes in the PR body.
- Run integration and e2e against the worktree's own app: `pnpm install --frozen-lockfile`, `pnpm run worktree:setup` once, `pnpm run worktree:up`. Never touch the dev server on `:3000`.
- Stage exact paths; never `git add -A`. Quote paths containing parentheses.

## Review Focus

1. **A same-origin write whose `Host` differs from the Origin's host only in case or default port** — a browser lowercases the Origin host and omits default ports; a proxy or client may not. Expected: passes. Pinned in Task 2 (uppercase `Host`).
2. **A malformed `Origin` header** (`Origin: not a url`). Expected: refused 403 `CROSS_ORIGIN`, never a 500 from a throwing `new URL`. Pinned in Task 2.
3. **A cross-site GET** — the magic-link email opens `/api/auth/magic-link/verify` from a mail client, which a browser marks `Sec-Fetch-Site: cross-site`. Expected: not refused; only mutating methods are checked. Pinned in Task 2, unit and integration.
4. **A signed-out visit to a public path that merely starts with a protected prefix** — `/schedulefoo` is a teacher slug, not `/schedule`. Expected: no sign-in redirect; and `/schedule?x=1` still redirects with the full `redirect=` target. Pinned in Task 1.
5. **`Content-Type` spellings** — `Application/JSON; charset=UTF-8` accepted; `application/json-patch+json` and `application/jsonx` refused; missing header refused. Pinned in Task 3.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/csp.ts` (new) | builds the page CSP from a nonce + env; exports the API CSP | 1 |
| `src/lib/csp.test.ts` (new) | unit pins on both strings | 1 |
| `src/proxy.ts` | nonce + CSP on every page; sign-in redirect on its own path test | 1 |
| `src/proxy.test.ts` (new) | unit pins on `requiresSession` and the nonce | 1 |
| `src/app/layout.tsx`, `layout.test.tsx` | `await connection()` | 1 |
| `next.config.ts` | API CSP only on `/api/:path*`; docblock | 1 |
| `tests/integration/security-headers.test.ts` | rewritten for two CSP sources | 1 |
| `src/lib/cross-origin.ts` (new) + test | `isCrossOrigin(request)` | 2 |
| `src/lib/api-utils.ts` | Origin refusal in `withErrorHandler`; content-type in `parseBody`; 415 in `ErrorStatus` | 2, 3 |
| `src/lib/api-error-codes.ts` | `CROSS_ORIGIN: 403`, `UNSUPPORTED_MEDIA_TYPE: 415`, 415 in `ApiErrorStatus` | 2, 3 |
| `tests/integration/cross-origin.test.ts` (new) | Origin check end to end | 2 |
| `src/lib/cron-auth.ts` + test | `hasCronSecret`; `requireCronAuth` on it | 4 |
| `deploy/nginx.conf.example`, `DEPLOYMENT.md` | cron deny; manual curl to `127.0.0.1:3000` | 4 |
| `src/app/api/health/route.ts` + test | summary vs full body | 5 |
| docs listed in spec §5 | follow the code | 2, 3, 5, 6 |
| `docker-compose.yml`, `docs/technical-architecture.md` compose example | dev Postgres binding | 6 |

**Task order is load-bearing for 2 → 3 only:** both edit `api-error-codes.ts` and `api-utils.ts`; run them in order. Tasks 4 → 5 likewise (5 consumes `hasCronSecret`). Task 1 and Task 6 are independent of everything.

---

### Task 1: Per-request nonce CSP on pages, static CSP on API

**Files:**
- Create: `src/lib/csp.ts`, `src/lib/csp.test.ts`, `src/proxy.test.ts`
- Modify: `src/proxy.ts`, `src/app/layout.tsx`, `src/app/layout.test.tsx`, `next.config.ts`
- Rewrite: `tests/integration/security-headers.test.ts`

**Interfaces:**
- Produces: `buildPageCsp(nonce: string, isDev: boolean): string`, `API_CSP: string` (`src/lib/csp.ts`); `requiresSession(pathname: string): boolean`, `mintNonce(): string` (exported from `src/proxy.ts` for its unit test).

- [ ] **Step 1: Write the failing unit tests for the CSP module**

`src/lib/csp.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPageCsp, API_CSP } from './csp';

function directive(csp: string, name: string): string | undefined {
  return csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));
}

describe('buildPageCsp', () => {
  it('allows scripts only by nonce and strict-dynamic in production', () => {
    const csp = buildPageCsp('abc123', false);
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
  });

  it('adds unsafe-eval and ws: in development only', () => {
    const csp = buildPageCsp('abc123', true);
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' ws:");
    expect(directive(buildPageCsp('n', false), 'connect-src')).toBe("connect-src 'self'");
  });

  it('never puts unsafe-inline in script-src, keeps it in style-src', () => {
    for (const isDev of [true, false]) {
      const csp = buildPageCsp('n', isDev);
      expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
      expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
    }
  });

  it('keeps every other directive', () => {
    const csp = buildPageCsp('n', false);
    for (const d of [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "worker-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ]) {
      expect(csp.split('; ')).toContain(d);
    }
  });
});

describe('API_CSP', () => {
  it('lets a JSON response load and run nothing', () => {
    expect(API_CSP).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run src/lib/csp.test.ts`
Expected: FAIL — cannot resolve `./csp`.

- [ ] **Step 3: Write `src/lib/csp.ts`**

No `@/` imports: `next.config.ts` imports this file, and the config is loaded before path aliases exist.

```ts
/**
 * The two Content-Security-Policy strings. Pages get `buildPageCsp` from
 * `src/proxy.ts`, with a nonce minted per request; Next reads the nonce back
 * off the request's own CSP header and stamps it on its inline scripts.
 * API responses get `API_CSP` from `next.config.ts`. The proxy never matches
 * `/api/*`, so no response carries both.
 *
 * `style-src` keeps 'unsafe-inline' for the app's `style={}` attributes;
 * style injection is not script execution. Development adds 'unsafe-eval'
 * and websockets for Fast Refresh.
 */
export function buildPageCsp(nonce: string, isDev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // data: for the inline EPC payment QR codes
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws:' : ''}`,
    // The service worker registers from a bundled script, which
    // 'strict-dynamic' trusts; worker-src names the worker's own origin.
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** A JSON body is not a document: if a browser renders one, nothing in it loads or runs. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run src/lib/csp.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing proxy unit tests**

`src/proxy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, requiresSession, mintNonce } from './proxy';

describe('requiresSession', () => {
  it('covers each protected section and its sub-paths', () => {
    for (const p of ['/schedule', '/schedule/2026-10-08', '/settings/rooms', '/class/abc', '/updates']) {
      expect(requiresSession(p)).toBe(true);
    }
  });

  it('leaves public paths alone, including slugs that share a prefix', () => {
    for (const p of ['/', '/login', '/verify', '/start', '/signup', '/schedulefoo', '/classroom-anna']) {
      expect(requiresSession(p)).toBe(false);
    }
  });
});

describe('mintNonce', () => {
  it('is 16 random bytes, base64, different each call', () => {
    const a = mintNonce();
    expect(atob(a)).toHaveLength(16);
    expect(mintNonce()).not.toBe(a);
  });
});

describe('proxy', () => {
  it('redirects a signed-out protected request to login with its full target', () => {
    const res = proxy(new NextRequest('http://localhost:3000/schedule?x=1'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fschedule%3Fx%3D1');
  });

  it('puts the same nonce CSP on the forwarded request and the response of a public page', () => {
    const res = proxy(new NextRequest('http://localhost:3000/start'));
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/'nonce-[A-Za-z0-9+/]+={0,2}'/);
    // NextResponse.next({ request: { headers } }) forwards overridden request
    // headers as x-middleware-request-<name>.
    expect(res.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run src/proxy.test.ts`
Expected: FAIL — `requiresSession` / `mintNonce` are not exported.

- [ ] **Step 7: Rewrite `src/proxy.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { buildPageCsp } from '@/lib/csp';

// Duplicated here intentionally to keep proxy startup lightweight
// without pulling in database or server-only session dependencies.
const SESSION_COOKIE_NAME = 'fair_yoga_session';

// The sections a signed-out visitor is sent to /login from. The matcher
// below is wider — every page needs a nonce — so "needs a CSP" and "needs a
// session" are separate questions.
const SIGNED_IN_SECTIONS = [
  '/schedule',
  '/studio-class',
  '/students',
  '/inbox',
  '/settings',
  '/class',
  '/bookings',
  '/account',
  '/updates',
] as const;

export function requiresSession(pathname: string): boolean {
  return SIGNED_IN_SECTIONS.some((s) => pathname === s || pathname.startsWith(`${s}/`));
}

/** 16 random bytes, base64: a 128-bit nonce. */
export function mintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (requiresSession(pathname) && !request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  const csp = buildPageCsp(mintNonce(), process.env.NODE_ENV === 'development');

  // Layouts and guards can't see the pathname; stamp it with any query
  // parameters so downstream components can read the requested destination.
  const requestHeaders = new Headers(request.headers);
  // Belt and suspenders: set() replaces, but never let a client-supplied
  // value even transit.
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', pathname + search);
  // Next reads the nonce off the request's CSP to stamp its own scripts.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Every page. Never /api/*: a matched path has its request body buffered
  // before the route runs, which would defeat the photo upload's refusal of
  // an oversized body before reading it.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest|sw\\.js|icons/).*)',
  ],
};
```

- [ ] **Step 8: Run the proxy tests to verify they pass**

Run: `pnpm exec vitest run src/proxy.test.ts` — Expected: PASS. If the `x-middleware-request-…` assertion fails because Next 16.3.4 forwards request headers under another name, read `node_modules/next/dist/server/web/spec-extension/response.js` for the name it uses and assert that one; the point of the case is that the forwarded request carries the same CSP as the response.

- [ ] **Step 9: Make every page render at request time**

`src/app/layout.tsx` — add the import and make the layout async:

```tsx
import { connection } from 'next/server';
```

```tsx
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The nonce exists only on a request-time render; a page prerendered at
  // build time would ship Next's scripts without it, and the CSP would block
  // them. This makes every page dynamic.
  await connection();
  // suppressHydrationWarning is one element deep only: …(unchanged)
```

`src/app/layout.test.tsx` — mock `connection` and await the layout:

```tsx
import { describe, it, expect, vi } from 'vitest';
// …existing imports…

vi.mock('next/server', () => ({ connection: vi.fn(async () => undefined) }));
const { connection } = await import('next/server');

describe('RootLayout', () => {
  it('mounts InstallListener', async () => {
    const tree = await RootLayout({ children: <div>content</div> });
    expect(treeContainsType(tree, InstallListener)).toBe(true);
  });

  it('opts every page into a request-time render', async () => {
    await RootLayout({ children: <div /> });
    expect(connection).toHaveBeenCalled();
  });
});
```

Run: `pnpm exec vitest run src/app/layout.test.tsx` — Expected: PASS.

- [ ] **Step 10: Move the CSP out of the global header rule in `next.config.ts`**

Delete the `csp` constant and its docblock, and the `Content-Security-Policy` entry from `securityHeaders`. Import `API_CSP` and add an API-only rule:

```ts
import { API_CSP } from "./src/lib/csp";
```

```ts
  async headers() {
    const rules = [
      { source: "/(.*)", headers: securityHeaders },
      // Pages get a nonce CSP from src/proxy.ts; API responses never pass the
      // proxy and get this static one instead (src/lib/csp.ts).
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
    ];
```

Leave the `isDev` constant if the `_next/static` rule still uses it.

- [ ] **Step 11: Rewrite the integration test**

`tests/integration/security-headers.test.ts`. Before writing the slug case, confirm the teacher public page path: `ls "src/app/(public)"` — the plan assumes `/[slug]` serves `/<pageSlug>`.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, freshIp, cookie, seedSession, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const email = `csp-teacher-${suffix}@test.local`;
const slug = `csp-t-${suffix}`;
let token = '';

beforeAll(async () => {
  const account = await prisma.account.create({
    data: {
      email,
      teachers: { create: { firstName: 'Csp', lastName: 'Teacher', email, bio: '', pageSlug: slug } },
    },
  });
  token = await seedSession(prisma, account.id);
});

afterAll(async () => {
  // Keyed by the literal address, never by an id beforeAll assigns.
  await prisma.account.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const NONCE = /'nonce-([A-Za-z0-9+/]+={0,2})'/;

function scriptSrc(csp: string): string {
  return csp.split('; ').find((d) => d.startsWith('script-src ')) ?? '';
}

async function page(path: string, signedIn = false): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    headers: { ...freshIp(), ...(signedIn ? cookie(token) : {}) },
    redirect: 'manual',
  });
}

describe('page CSP', () => {
  const cases: Array<[string, boolean]> = [
    ['/', false],
    ['/login', false],
    ['/verify', false],
    ['/start', false],
    ['/schedule', true],
    [`/${slug}`, false],
    ['/no-such-teacher-csp-404', false],
  ];

  for (const [path, signedIn] of cases) {
    it(`${path} carries one nonce policy with strict-dynamic and no unsafe-inline scripts`, async () => {
      const res = await page(path, signedIn);
      const csp = res.headers.get('content-security-policy') ?? '';
      // Headers.get joins repeated headers with ", " — one policy means one default-src.
      expect(csp.split('default-src').length).toBe(2);
      expect(scriptSrc(csp)).toMatch(NONCE);
      expect(scriptSrc(csp)).toContain("'strict-dynamic'");
      expect(scriptSrc(csp)).not.toContain("'unsafe-inline'");
    });
  }

  for (const path of ['/login', '/no-such-teacher-csp-404']) {
    it(`${path} stamps the header's nonce on its scripts, fresh per request`, async () => {
      const first = await page(path);
      const nonce = (first.headers.get('content-security-policy') ?? '').match(NONCE)?.[1];
      expect(nonce).toBeDefined();
      const html = await first.text();
      expect(html).toContain(`nonce="${nonce}"`);
      expect(html).not.toMatch(/<script(?![^>]*\bnonce=)(?![^>]*\bsrc=)[^>]*>/);

      const second = await page(path);
      expect((second.headers.get('content-security-policy') ?? '').match(NONCE)?.[1]).not.toBe(nonce);
    });
  }

  it('keeps the other security headers on pages', async () => {
    const res = await page('/login');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

describe('API CSP', () => {
  it('is exactly the static deny-all policy, once', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
```

Also add to `tests/integration/pwa.test.ts`, in its `/start` describe: a signed-out `GET /start` (no cookie, `redirect: 'manual'`) answers 200 and carries a `content-security-policy` header containing `'nonce-`.

- [ ] **Step 12: Run integration and e2e against the worktree app**

```bash
pnpm run worktree:up
pnpm exec vitest run --project integration tests/integration/security-headers.test.ts tests/integration/pwa.test.ts tests/integration/teacher-photo-api.test.ts
pnpm run build
pnpm exec playwright test
```

Expected: all PASS. Playwright is the proof that `'strict-dynamic'` + nonce does not break hydration, the service worker or passkeys; a blocked script shows as a page that never hydrates. Read any failure's console output for `Refused to execute` before changing anything.

- [ ] **Step 13: Prove each guard bites (record exact failure text for each, restore, re-run green)**

Commit first, so restoring a mutation cannot discard other work. For each, warm the route (`curl` it) before reading RED/GREEN.

1. Narrow the matcher back to `'/schedule/:path*'` only → the `/login`, `/`, slug and 404 CSP cases fail.
2. Remove `await connection()` → against `pnpm run build && pnpm start` (production build), the `/login` nonce-stamp case fails. Dev renders per request regardless, so this mutation is inert in dev; record which mode you ran it in.
3. Hard-code `mintNonce` to `return 'AAAAAAAAAAAAAAAAAAAAAA==';` → the "fresh per request" case and the unit `mintNonce` case fail.
4. Add `'/api/:path*'` to the matcher → the API CSP case fails (two policies or the page policy). Then check whether `teacher-photo-api.test.ts`'s "before the body is read" case goes red too. If it stays green, record that in the ledger: the plan's spec row expected it, and a case that sees the buffering is owed (a POST with a declared `Content-Length` far above the limit and a body that never finishes must be answered before the body completes).
5. Change `next.config.ts`'s API rule source to `/(.*)` → the page "one policy" cases fail.
6. Change `requiresSession` to `pathname.startsWith(s)` → the `/schedulefoo` unit case fails.

- [ ] **Step 14: Commit**

```bash
git add src/lib/csp.ts src/lib/csp.test.ts src/proxy.ts src/proxy.test.ts src/app/layout.tsx src/app/layout.test.tsx next.config.ts tests/integration/security-headers.test.ts tests/integration/pwa.test.ts
git commit -m "feat: pages carry a per-request nonce CSP, API responses a static deny-all one (#770)"
```

---

### Task 2: Origin check on every API write

**Files:**
- Create: `src/lib/cross-origin.ts`, `src/lib/cross-origin.test.ts`, `tests/integration/cross-origin.test.ts`
- Modify: `src/lib/api-utils.ts` (`withErrorHandler`), `src/lib/api-utils.test.ts`, `src/lib/api-error-codes.ts`, `docs/technical-architecture.md` (auth/cookie passage near the `secure, sameSite)` line)

**Interfaces:**
- Produces: `isCrossOrigin(request: NextRequest): boolean`; registered code `CROSS_ORIGIN` at 403.

- [ ] **Step 1: Write the failing unit tests**

`src/lib/cross-origin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { isCrossOrigin } from './cross-origin';

function req(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/classes/x/cancel', { method, headers });
}

describe('isCrossOrigin', () => {
  it('refuses a write whose Origin names another host', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'https://evil.example' }))).toBe(true);
  });

  it('refuses Origin: null', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'null' }))).toBe(true);
  });

  it('refuses a malformed Origin instead of throwing', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'not a url' }))).toBe(true);
  });

  it('refuses Sec-Fetch-Site: cross-site even without an Origin', () => {
    expect(isCrossOrigin(req('DELETE', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('passes the request’s own host, whatever the scheme', () => {
    // nginx terminates TLS: the app sees http while the browser says https.
    expect(isCrossOrigin(req('POST', { host: 'fair.yoga', origin: 'https://fair.yoga' }))).toBe(false);
    expect(isCrossOrigin(req('PUT', { host: 'localhost:3000', origin: 'http://localhost:3000' }))).toBe(false);
  });

  it('compares hosts case-insensitively', () => {
    expect(isCrossOrigin(req('POST', { host: 'LOCALHOST:3000', origin: 'http://localhost:3000' }))).toBe(false);
  });

  it('passes a request with neither header (curl, server-to-server)', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000' }))).toBe(false);
  });

  it('never refuses a read, even cross-site (the magic-link email opens a GET)', () => {
    expect(isCrossOrigin(req('GET', { host: 'localhost:3000', origin: 'https://mail.example', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('checks every mutating method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isCrossOrigin(req(m, { host: 'localhost:3000', origin: 'https://evil.example' }))).toBe(true);
    }
  });
});
```

Run: `pnpm exec vitest run src/lib/cross-origin.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 2: Write `src/lib/cross-origin.ts`**

```ts
import type { NextRequest } from 'next/server';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * True when a state-changing request came from another site. A browser sends
 * `Origin` or `Sec-Fetch-Site` on every cross-site write; a request with
 * neither is not from a browser page (curl, the integration suite) and passes.
 *
 * Compared against the request's own `Host`, host and port only: nginx
 * forwards `Host` unchanged and terminates TLS, so the scheme the app sees
 * is not the one the browser used.
 */
export function isCrossOrigin(request: NextRequest): boolean {
  if (!MUTATING.has(request.method)) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return true;

  const origin = request.headers.get('origin');
  if (origin === null) return false;
  const host = request.headers.get('host');
  if (origin === 'null' || host === null) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  return originHost !== host.toLowerCase();
}
```

Run the unit test — Expected: PASS.

- [ ] **Step 3: Register the code**

In `src/lib/api-error-codes.ts`, add in alphabetical position:

```ts
  CROSS_ORIGIN: 403,
```

- [ ] **Step 4: Write the failing `withErrorHandler` tests**

Append inside `describe('withErrorHandler', …)` in `src/lib/api-utils.test.ts` (it already has `makeRequest`):

```ts
  it('refuses a cross-origin write with CROSS_ORIGIN and never runs the handler', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(
      makeRequest('http://localhost:3000/api/test', {
        method: 'POST',
        headers: { host: 'localhost:3000', origin: 'https://evil.example' },
      }),
    );

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CROSS_ORIGIN');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler for a same-origin write', async () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));
    const res = await withErrorHandler(handler)(
      makeRequest('http://localhost:3000/api/test', {
        method: 'POST',
        headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      }),
    );
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });
```

If `makeRequest`'s signature does not accept `headers`, read it (`grep -n "function makeRequest" -A12 src/lib/api-utils.test.ts`) and pass them the way its other callers do.

Run: `pnpm exec vitest run src/lib/api-utils.test.ts` — Expected: the first case FAILS (handler called, 200).

- [ ] **Step 5: Refuse in `withErrorHandler`**

In `src/lib/api-utils.ts`, import `isCrossOrigin` and add the check as the first statement inside the `try`:

```ts
    try {
      if (isCrossOrigin(request)) {
        return respondError('This request came from another site, so it was refused.', 403, 'CROSS_ORIGIN');
      }
      return await handler(request, ...rest);
```

Add one sentence to the docblock: "A cross-origin write (`isCrossOrigin`) is refused with `CROSS_ORIGIN` before the handler runs." Inside the `try`, an untyped caller's missing `request` is a TypeError the catch already handles.

Run: `pnpm exec vitest run src/lib/api-utils.test.ts` — Expected: PASS.

- [ ] **Step 6: Integration test against the running app**

`tests/integration/cross-origin.test.ts`. No session is needed: the check runs before the route's own auth, so a cross-origin request answers 403 where a same-origin one answers 401.

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';
import { expectRefusal } from '../api-assertions';

const ID = '00000000-0000-0000-0000-000000000000';

// Two of the bodyless POST handlers that never call parseBody — the CSRF
// surface only this check covers.
const BODYLESS = [`/api/classes/${ID}/cancel`, `/api/payments/${ID}/unpaid`];

describe('Origin check', () => {
  for (const path of BODYLESS) {
    it(`${path}: a foreign Origin is refused before auth`, async () => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { ...freshIp(), origin: 'https://evil.example' },
      });
      await expectRefusal(res, 'CROSS_ORIGIN');
    });
  }

  it('Sec-Fetch-Site: cross-site is refused', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site' },
    });
    await expectRefusal(res, 'CROSS_ORIGIN');
  });

  it('the app’s own Origin reaches the route (401, not 403)', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), origin: new URL(BASE_URL).origin },
    });
    expect(res.status).toBe(401);
  });

  it('no Origin reaches the route as today', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, { method: 'POST', headers: freshIp() });
    expect(res.status).toBe(401);
  });

  it('a cross-site GET is not refused', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site', origin: 'https://mail.example' },
    });
    expect(res.status).not.toBe(403);
  });
});
```

Confirm both routes' auth answers 401 for no session (`grep -n "require" "src/app/api/classes/[id]/cancel/route.ts" "src/app/api/payments/[id]/unpaid/route.ts"`); if one answers differently, assert its actual no-session status in the two "reaches the route" cases.

Run: `pnpm exec vitest run --project integration tests/integration/cross-origin.test.ts` — Expected: PASS.

- [ ] **Step 7: Prove the guard bites**

Commit first. Then, one at a time, record the failure text, restore, re-run green:
1. Delete the `if (isCrossOrigin…)` block → unit and integration refusals fail.
2. Compare `new URL(origin).origin` against `` `http://${host}` `` (scheme-sensitive) → the `https://fair.yoga` unit case fails.
3. Treat `'null'` as absent (`if (origin === null || origin === 'null') return false`) → the `Origin: null` case fails.
4. Drop `.toLowerCase()` → the uppercase-Host case fails.

- [ ] **Step 8: Run the whole unit suite**

Run: `pnpm exec vitest run --project unit` — Expected: PASS. A route unit test that builds a `NextRequest` with a foreign `origin` would now get 403; fix the test's request, not the guard.

- [ ] **Step 9: Docs**

In `docs/technical-architecture.md`, at the session-cookie passage (`grep -n "secure, sameSite" docs/technical-architecture.md`), add after it: writes are refused cross-origin in `withErrorHandler` (`src/lib/cross-origin.ts`), so SameSite=Lax is not the only CSRF layer; Task 3 adds the content-type layer to the same sentence.

- [ ] **Step 10: Commit**

```bash
git add src/lib/cross-origin.ts src/lib/cross-origin.test.ts src/lib/api-utils.ts src/lib/api-utils.test.ts src/lib/api-error-codes.ts tests/integration/cross-origin.test.ts docs/technical-architecture.md
git commit -m "feat: API writes from another site are refused before the handler runs (#770)"
```

---

### Task 3: `parseBody` accepts only JSON

**Files:**
- Modify: `src/lib/api-utils.ts` (`parseBody`, `ErrorStatus`), `src/lib/api-utils.test.ts`, `src/lib/api-error-codes.ts`, `docs/technical-architecture.md` (the sentence Task 2 added)

**Interfaces:**
- Consumes: `CROSS_ORIGIN` already registered (Task 2) — only to keep the code list alphabetical.
- Produces: `isJsonContentType(header: string | null): boolean` (exported from `api-utils.ts`); code `UNSUPPORTED_MEDIA_TYPE` at 415.

- [ ] **Step 1: Write the failing tests**

Append to `describe('parseBody', …)` in `src/lib/api-utils.test.ts`:

```ts
  it('refuses a text/plain body with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ title: 'Yoga Class', spots: 10 }),
      headers: { 'Content-Type': 'text/plain' },
    });
    const result = await parseBody(request, testSchema);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(415);
      expect(((await result.error.json()) as { error: { code: string } }).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('refuses a body with no Content-Type', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: new Blob([JSON.stringify({ title: 'Yoga Class', spots: 10 })]),
    });
    const result = await parseBody(request, testSchema);
    expect('error' in result && result.error.status).toBe(415);
  });

  it('accepts a charset parameter and any letter case', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ title: 'Yoga Class', spots: 10 }),
      headers: { 'Content-Type': 'Application/JSON ; charset=UTF-8' },
    });
    expect('data' in (await parseBody(request, testSchema))).toBe(true);
  });
});

describe('isJsonContentType', () => {
  it('matches the media type exactly', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/json-patch+json')).toBe(false);
    expect(isJsonContentType('application/jsonx')).toBe(false);
    expect(isJsonContentType('text/plain;charset=UTF-8')).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
```

(The final `});` of the existing `parseBody` describe moves to close the new `isJsonContentType` describe; add `isJsonContentType` to the import list.) A `Blob` body without a type sends no `Content-Type`; a string body would default to `text/plain;charset=UTF-8`.

Run: `pnpm exec vitest run src/lib/api-utils.test.ts` — Expected: FAIL.

- [ ] **Step 2: Add 415 to both status unions and register the code**

- `src/lib/api-error-codes.ts`: `export type ApiErrorStatus = 400 | 403 | 404 | 409 | 415 | 500 | 503;` and `UNSUPPORTED_MEDIA_TYPE: 415,` in alphabetical position.
- `src/lib/api-utils.ts`: `export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500 | 503;`

Then find every consumer that switches or maps over these statuses, directly or through a caller, before trusting the typecheck:

```bash
grep -rn "ApiErrorStatus\|ErrorStatus\b" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
grep -rn "case 4[0-9][0-9]\|status === 4[0-9][0-9]" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

Give each hit a verdict in the task report (handles 415 / falls through to a generic message correctly / needs a change).

- [ ] **Step 3: Implement in `parseBody`**

```ts
/** `application/json`, with or without parameters such as a charset. */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  return header.split(';')[0].trim().toLowerCase() === 'application/json';
}
```

At the top of `parseBody`, before `request.json()`:

```ts
  // A cross-site form can post text/plain without a preflight; JSON cannot.
  if (!isJsonContentType(request.headers.get('content-type'))) {
    return { error: respondError('Send this request as JSON.', 415, 'UNSUPPORTED_MEDIA_TYPE') };
  }
```

Run: `pnpm exec vitest run src/lib/api-utils.test.ts` — Expected: PASS. Run `pnpm run typecheck` — Expected: clean.

- [ ] **Step 4: Run the unit and integration suites**

```bash
pnpm exec vitest run --project unit
pnpm exec vitest run --project integration
```

Expected: PASS. The census found every body-carrying client fetch sets the JSON type; a red test here that posts a string body without `Content-Type` is a test fixture to fix (add the header), and any production caller it reveals is a census miss to report.

- [ ] **Step 5: Prove the guard bites**

Commit first. Delete the `isJsonContentType` check in `parseBody` → the 415 cases fail; record text, restore. Then change `=== 'application/json'` to `.startsWith('application/json')` → the `json-patch+json` and `jsonx` cases fail; record, restore.

- [ ] **Step 6: Docs**

Extend the sentence Task 2 added in `docs/technical-architecture.md`: `parseBody` also refuses any body not sent as `application/json` (415 `UNSUPPORTED_MEDIA_TYPE`), which closes the cross-site `text/plain` form path even where the Origin check is stripped.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api-utils.ts src/lib/api-utils.test.ts src/lib/api-error-codes.ts docs/technical-architecture.md
git commit -m "feat: parseBody refuses a body not sent as JSON with 415 (#770)"
```

---

### Task 4: Constant-time cron secret, unreachable through nginx

**Files:**
- Modify: `src/lib/cron-auth.ts`, `src/lib/cron-auth.test.ts`, `deploy/nginx.conf.example`, `DEPLOYMENT.md`

**Interfaces:**
- Produces: `hasCronSecret(request: NextRequest): boolean`; `requireCronAuth(request: NextRequest): NextResponse | null` (signature unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/cron-auth.test.ts` (import `hasCronSecret` beside `requireCronAuth`; reuse the file's `req` helper and env restore):

```ts
describe('hasCronSecret', () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('is true for the configured secret', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer right-secret'))).toBe(true);
  });

  it('is false for a wrong secret of the same length', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer wrong-secret'))).toBe(false);
  });

  it('is false for a wrong secret of another length, without throwing', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer x'))).toBe(false);
    expect(hasCronSecret(req('Bearer right-secret-and-more'))).toBe(false);
  });

  it('is false with no header', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req())).toBe(false);
  });

  it('is false when no secret is configured, or it is empty', () => {
    delete process.env.CRON_SECRET;
    expect(hasCronSecret(req('Bearer '))).toBe(false);
    process.env.CRON_SECRET = '';
    expect(hasCronSecret(req('Bearer '))).toBe(false);
  });
});
```

`req` is defined inside the existing describe; move it to module scope so both describes share it.

Run: `pnpm exec vitest run src/lib/cron-auth.test.ts` — Expected: FAIL, `hasCronSecret` not exported.

- [ ] **Step 2: Implement**

`src/lib/cron-auth.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest } from 'next/server';
import { respondError } from '@/lib/api-utils';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Whether the request carries the configured cron secret. Compares SHA-256
 * digests in constant time, so the lengths always match and a wrong secret's
 * length leaks nothing. False when no secret is configured.
 */
export function hasCronSecret(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const presented = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(presented), digest(`Bearer ${secret}`));
}

export function requireCronAuth(request: NextRequest) {
  if (!process.env.CRON_SECRET) {
    return respondError('CRON_SECRET not configured', 500);
  }
  if (!hasCronSecret(request)) {
    return respondError('Unauthorized', 401);
  }
  return null;
}
```

Run: `pnpm exec vitest run src/lib/cron-auth.test.ts` — Expected: PASS, the existing `requireCronAuth` cases included.

- [ ] **Step 3: Prove it bites**

Commit first. Invert the return (`return !timingSafeEqual(…)`) → the "true for the configured secret" case and `requireCronAuth`'s allow case fail; record, restore. Replacing the compare with `presented !== \`Bearer ${secret}\`` keeps every test green: an equivalent mutant for these tests (spec §2.4), recorded in the ledger as such, not as a gap.

- [ ] **Step 4: nginx deny**

In `deploy/nginx.conf.example`, inside the TLS `server` block and before `location / {`:

```nginx
    # Production runs these jobs in-process (src/lib/scheduler.ts). A manual
    # run goes to http://127.0.0.1:3000 from the VPS itself (DEPLOYMENT.md).
    location /api/cron/ { deny all; }
```

- [ ] **Step 5: `DEPLOYMENT.md`**

- The manual cron example (`grep -n "api/cron/daily-cleanup" DEPLOYMENT.md`): change the URL to `http://127.0.0.1:3000/api/cron/daily-cleanup`, and add one sentence before it: nginx refuses `/api/cron/` from outside, so the call is made on the VPS itself.
- The `CRON_SECRET` row in the env table: keep its text; Task 5 adds health.

- [ ] **Step 6: Commit**

```bash
git add src/lib/cron-auth.ts src/lib/cron-auth.test.ts deploy/nginx.conf.example DEPLOYMENT.md
git commit -m "feat: the cron secret is compared in constant time and nginx refuses /api/cron/ from outside (#770)"
```

---

### Task 5: Health detail behind the cron secret

**Files:**
- Modify: `src/app/api/health/route.ts`, `src/app/api/health/route.test.ts`, `DEPLOYMENT.md`, `docs/technical-architecture.md`, `docs/superpowers/specs/2026-10-02-degradation-events-design.md`, `docs/degradation-sites.md`, `src/services/degradation-digest.ts` (and any comment found in Step 6)

**Interfaces:**
- Consumes: `hasCronSecret(request: NextRequest): boolean` (Task 4).

- [ ] **Step 1: Write the failing tests**

In `src/app/api/health/route.test.ts`, change `read()` to take an optional secret and pass a request, and default the existing cases to the detailed body so they keep testing what they test:

```ts
import { NextRequest } from 'next/server';

const SECRET = 'health-test-secret';

async function read(authorization: string | null = `Bearer ${SECRET}`): Promise<{ status: number; body: HealthBody }> {
  const res = await GET(
    new NextRequest('http://localhost:3000/api/health', authorization ? { headers: { authorization } } : {}),
  );
  return { status: res.status, body: (await res.json()) as HealthBody };
}
```

Set `process.env.CRON_SECRET = SECRET` in a `beforeEach`, and restore the original in `afterEach` (same pattern as `cron-auth.test.ts`). Then add:

```ts
describe('GET /api/health without the secret', () => {
  it('answers only status and db', async () => {
    const { status, body } = await read(null);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'up' });
  });

  it('a wrong secret gets the same summary', async () => {
    const { body } = await read('Bearer wrong');
    expect(Object.keys(body).sort()).toEqual(['db', 'status']);
  });

  it('still rolls an unhealthy job into status', async () => {
    globalThis.__fairYogaJobHealth = {
      'daily-cleanup': entry({ lastError: 'boom' }),
    } as typeof globalThis.__fairYogaJobHealth;
    const { body } = await read(null);
    expect(body).toEqual({ status: 'degraded', db: 'up' });
  });

  it('a database outage is still a 503, summary only', async () => {
    queryRaw.mockRejectedValueOnce(new Error('down'));
    const { status, body } = await read(null);
    expect(status).toBe(503);
    expect(body).toEqual({ status: 'degraded', db: 'down' });
  });

  it('with no CRON_SECRET configured, answers the summary rather than failing', async () => {
    delete process.env.CRON_SECRET;
    const { status, body } = await read(`Bearer ${SECRET}`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok', db: 'up' });
  });
});
```

Check how the file's existing cases set an unhealthy job (`grep -n "__fairYogaJobHealth" src/app/api/health/route.test.ts`) and set it the same way; the shape above is a sketch of that, and `entry`'s field that makes a job unhealthy is whatever `isJobHealthy` reads.

Run: `pnpm exec vitest run src/app/api/health/route.test.ts` — Expected: FAIL (GET takes no request, body is full).

- [ ] **Step 2: Implement**

`src/app/api/health/route.ts` — take the request, decide once, skip the degradation count for the summary:

```ts
import type { NextRequest } from 'next/server';
import { hasCronSecret } from '@/lib/cron-auth';
```

```ts
/**
 * Health check for the reverse proxy / uptime monitor.
 * Public: liveness and DB reachability, `{ status, db }`, where `status`
 * already rolls up every job's health. With the cron secret (`hasCronSecret`,
 * never `requireCronAuth`, whose 401/500 would fail the monitor): per-job
 * scheduler state (timestamps + `isJobHealthy`'s verdict — error text stays in
 * the server log) and how many degradation events fired in the last day, as a
 * bare number. Which ones, and what they carried, appear only in the
 * operator's digest email and the server log (`docs/technical-architecture.md`,
 * Cron Jobs → Degradation events). When that number cannot be read, the
 * `degradations` key is omitted and the database still reports up.
 */
export async function GET(request: NextRequest) {
  const detailed = hasCronSecret(request);
  const jobs = …unchanged…;
  const jobsUnhealthy = …unchanged…;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    // `db: 'down'` is the whole of what the public response may say. WHY it
    // is down must still reach the log: …(rest of the existing comment)
    log.error({ err }, 'health check: database probe failed');
    return Response.json(
      detailed ? { status: 'degraded', db: 'down', jobs } : { status: 'degraded', db: 'down' },
      { status: 503 },
    );
  }
  const status = jobsUnhealthy ? 'degraded' : 'ok';
  if (!detailed) return Response.json({ status, db: 'up' });
  try {
    …unchanged count and responses…
```

Run: `pnpm exec vitest run src/app/api/health/route.test.ts` — Expected: PASS, old and new cases.

- [ ] **Step 3: Integration**

In `tests/integration/security-headers.test.ts`'s API CSP case nothing changes. Add `tests/integration/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';

describe('GET /api/health', () => {
  it('without the secret answers exactly status and db', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, { headers: freshIp() });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['db', 'status']);
  });

  it('with the secret answers the full body', async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new Error('CRON_SECRET must be set for the integration suite');
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { ...freshIp(), authorization: `Bearer ${secret}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('jobs');
  });
});
```

Check how other integration tests read the cron secret (`grep -rn "CRON_SECRET" tests | head`) and use the same source; the worktree app has its own (`docs/superpowers/plans/2026-09-09-worktree-cron-secret.md`).

Run: `pnpm exec vitest run --project integration tests/integration/health.test.ts` — Expected: PASS.

- [ ] **Step 4: Prove it bites**

Commit first. (1) Replace `const detailed = hasCronSecret(request)` with `true` → the summary cases fail; record, restore. (2) Replace it with a `requireCronAuth(request) === null` check that returns its response when non-null → the no-`CRON_SECRET` case fails (500); record, restore.

- [ ] **Step 5: Re-derive `docs/degradation-sites.md`'s health rows**

`grep -n "log\.\(error\|warn\)" src/app/api/health/route.ts` gives the new line numbers; update the two `src/app/api/health/route.ts:<line>` rows to match. If that doc ships a re-derivation command, run it instead of hand-editing.

- [ ] **Step 6: Docs and comments**

- `DEPLOYMENT.md`: the health curl's expected output (`grep -n "api/health" DEPLOYMENT.md`) becomes `{"status":"ok","db":"up"}`, followed by the same curl with `-H "Authorization: Bearer $CRON_SECRET"` showing today's full body; the monitor description says a monitor needs only the public summary, and the detail needs the secret; the `CRON_SECRET` env row adds "and unlocks `/api/health`'s per-job detail".
- `docs/technical-architecture.md`: in the unauthenticated-routes table, `health`'s row becomes "Public summary `{ status, db }`; per-job detail and the degradation count need the cron secret (`hasCronSecret`)." Then run that section's re-derivation loop and correct the counts above the table to what it prints (health now prints `CRON_SECRET`, so decide whether it still belongs among the "neither" routes and say so in the PR body). In Degradation events → Health (`grep -n "degradations.open" docs/technical-architecture.md`), say the count is in the secret-holder's body.
- `docs/superpowers/specs/2026-10-02-degradation-events-design.md`: add at the top, below the title, one dated line: "2026-10-08 (#770): `/api/health` is no longer fully public — the degradation count and per-job detail need the cron secret; see `2026-10-08-defense-in-depth-design.md` §2.5." Leave the body as written.
- `src/services/degradation-digest.ts:19` — "the verdict `/api/health` already publishes" becomes "already reports". Then `grep -rn "api/health" src | grep -iv test | grep -i "public\|publish"` and give every hit a verdict; a comment that only says health *reports* something stays.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/health/route.test.ts tests/integration/health.test.ts DEPLOYMENT.md docs/technical-architecture.md docs/superpowers/specs/2026-10-02-degradation-events-design.md docs/degradation-sites.md src/services/degradation-digest.ts
git commit -m "feat: /api/health answers status and db publicly, per-job detail only with the cron secret (#770)"
```

(Add any further comment file Step 6 changed, by exact path.)

---

### Task 6: Dev Postgres on loopback only

**Files:**
- Modify: `docker-compose.yml`, `docs/technical-architecture.md` (the compose example claiming to be production)

- [ ] **Step 1: Bind to loopback**

`docker-compose.yml`: `- '5432:5432'` becomes `- '127.0.0.1:5432:5432'`. Validate the file without starting anything: `docker compose config --quiet` — Expected: exit 0. Do **not** run `docker compose up` or restart `fairyoga-db-1`: it serves the `:3000` dev server and every other worktree. The binding takes effect on the next `up`; say so in the PR body.

- [ ] **Step 2: Correct the production compose example**

`grep -n "docker-compose\|5432" docs/technical-architecture.md` finds the example near the deployment diagram. Compare it with `docker-compose.prod.yml`; replace the example with a one-line pointer to `docker-compose.prod.yml` if it differs in anything beyond formatting, since a copy will drift again.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml docs/technical-architecture.md
git commit -m "chore: dev Postgres listens on loopback only (#770)"
```

---

## After the tasks

- Whole-branch review (six tasks): one reviewer on the most capable model, one fix wave, one scoped re-review — then the unscoped PR-toolkit pass anyway.
- `pnpm run verify`, then push; CI's Playwright run on the production build is the e2e proof for Task 1.
- PR body: the census's corrected premises (spec §1), the equivalent-mutant note (Task 4), the Postgres binding not exercised (Task 6), the photo-buffering result from Task 1 Step 13.4, which integration files this branch touched by path.
