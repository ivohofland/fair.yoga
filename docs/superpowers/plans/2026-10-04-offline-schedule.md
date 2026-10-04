# Read-only Offline Schedule Implementation Plan (#725)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher who opened the app earlier today can open today's schedule and each of today's class pages with no connection, clearly marked as a snapshot, with every write control disabled.

**Architecture:** The existing push worker (`public/sw.js`) gains a network-first fetch handler for three teacher page shapes, a page cache bound to the signed-in account by an owner marker in the HTML, a static-file cache pulled from each stored page, and an inline offline page. In the page, a client status store (ping + browser events) drives an `OfflineSnapshot` wrapper that shows the marker and disables controls through one `<fieldset disabled>`; sign-in, sign-out and account deletion clear the page cache.

**Tech Stack:** Next.js 16.3.4 App Router, React 19, TypeScript strict, Vitest (unit / components / integration projects), Playwright 1.61 (Chromium).

**Spec:** `docs/superpowers/specs/2026-10-04-offline-schedule-design.md` — read it before any task; this plan argues from it.

## Global Constraints

- Node: every shell command runs with `env PATH=/Users/ivohofland/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin` prefixed (the agent shell's default Node is 22; the repo requires ^24.15).
- Worktree: `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-725`. Integration and e2e run against this worktree's own app: `pnpm run worktree:up` first (port 3114, `INTEGRATION_BASE_URL` is read automatically). Never touch the dev server on :3000.
- No new dependency (spec D1).
- Cache names exactly `fy-pages-v1`, `fy-static-v1`, `fy-meta-v1`. Retention exactly 24 h; patience exactly 8 s; ping timeout exactly 5 s; warm freshness exactly 10 min; stale-while-online threshold exactly 60 s.
- Cacheable paths exactly: `/schedule`, `/class/<id>`, `/studio-class/<id>` with `<id>` not `new` and no deeper segment.
- Marker copy exactly: `Offline — showing what was loaded at HH:MM`, or `Offline — showing what was loaded <day-and-time>` when the load date is not today in the teacher's timezone (`<day-and-time>` is `formatInstantInZone`'s output).
- Owner marker attribute exactly `data-offline-owner`, value the session's `accountId` (a UUID).
- TypeScript strict: no `any`, no `as` casts to widen. Comments annotate the code they sit on; no prose counts or rosters in comments (CLAUDE.md, Comment Discipline). Wider facts go in `docs/technical-architecture.md` (Task 5).
- Tests assert behaviour, never `error.message` strings from this code.
- Stage exact paths; quote paths with parentheses (`'src/app/(teacher)/…'`). Never `git add -A`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two tabs, sign out in one** — a warm still in flight in the other must not put the signed-out account's page back. Pinned in Task 2 (generation race test).
2. **A deep link with a query** (`/class/x?from=inbox`) opened offline must find `/class/x`. Pinned in Task 2 (query-string test; entries are keyed by pathname alone).
3. **A teacher whose timezone is ahead of UTC, near midnight** — "today's classes" and the marker's day form follow the teacher's zone, not the server's or the device's. Pinned in Task 3 (`Pacific/Auckland` tests).
4. **A deploy answering 503 while the device is online** — the stored copy is served and the page shows the marker (the ping fails too). Pinned in Task 2 (gateway test) and Task 1 (ping non-ok counts as offline).
5. **A stored entry written by a different worker format** (missing or garbage `x-fy-stored-at` / `x-fy-owner`) is never served. Pinned in Task 2.

---

### Task 1: Ping route, connection status store, refresh suppression

**Files:**
- Create: `src/app/api/ping/route.ts`
- Create: `src/lib/offline-status.ts`
- Create: `src/lib/offline-status.test.ts` (unit project, `node` environment: `src/**/*.test.ts`). Stub `window`, `document`, `navigator` and `fetch` with `vi.stubGlobal` as `src/lib/push-client.test.ts` does — `window` and `document` as `EventTarget` instances (plus `visibilityState` on `document`) so dispatched events reach the listeners. There is no DOM in this project, so tests drive the store through `subscribeConnectionStatus(listener)` and `getConnectionStatus()`; the components project (jsdom) only includes `src/components/**/*.test.tsx` and `src/app/**/*.test.tsx`.
- Create: `tests/integration/ping-api.test.ts`
- Modify: `src/components/class/refresh-at.tsx` (+ its existing test)
- Modify: `src/components/layout/live-updates.tsx` (+ its existing test, if any)

**Interfaces:**
- Produces:
  - `GET /api/ping` → `200 {"now": <server epoch ms>}`, header `Cache-Control: no-store`, no auth, no database.
  - `src/lib/offline-status.ts`:
    - `export interface ConnectionStatus { offline: boolean; serverNow: number | null }`
    - `export function useConnectionStatus(): ConnectionStatus` — `useSyncExternalStore`; server snapshot `{ offline: false, serverNow: null }`.
    - `export function subscribeConnectionStatus(listener: () => void): () => void` and `export function getConnectionStatus(): ConnectionStatus` — the two functions `useConnectionStatus` hands to `useSyncExternalStore`, exported so the unit project can drive the store without a DOM. The first subscriber triggers a check and attaches `online`, `offline` and `visibilitychange` listeners; while the snapshot says offline and a subscriber remains, the ping is retried every 15 s.
    - `export function isOfflineNow(): boolean` — `navigator.onLine === false` or the last ping failed; no subscription, no request.
    - `export function checkConnection(): Promise<void>` — one ping (5 s timeout via `AbortSignal.timeout(5000)`); a non-ok status or a rejection counts as failed; never throws.
    - `export function resetConnectionStatus(): void` — test-only reset.

- [ ] **Step 1: Write the failing ping integration test** (`tests/integration/ping-api.test.ts`), following a neighbouring integration file's imports for the base URL:

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL } from '../helpers'; // use whatever the neighbouring files import for the app's base URL

describe('GET /api/ping', () => {
  it('answers without a session, with the server clock, never cached', async () => {
    const before = Date.now();
    const res = await fetch(`${BASE_URL}/api/ping`);
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body: unknown = await res.json();
    expect(body).toEqual({ now: expect.any(Number) });
    if (typeof body !== 'object' || body === null || !('now' in body) || typeof body.now !== 'number') throw new Error('no now');
    expect(body.now).toBeGreaterThanOrEqual(before - 60_000);
    expect(body.now).toBeLessThanOrEqual(after + 60_000);
  });
});
```

- [ ] **Step 2: Run it, see it fail** — `pnpm run worktree:up` then `pnpm exec vitest run --project integration tests/integration/ping-api.test.ts`. Expected: 404.

- [ ] **Step 3: Implement the route**

```ts
// src/app/api/ping/route.ts
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Reachability probe: public, no database; `now` is the server's clock. */
export function GET() {
  return NextResponse.json({ now: Date.now() }, { headers: { 'Cache-Control': 'no-store' } });
}
```

Check whether `src/proxy.ts` or a rate limiter needs anything for a new public route (it should not: the proxy matcher does not include `/api`). Run the test: PASS.

- [ ] **Step 4: Write failing tests for the status store** — cover, each as its own `it`:
  1. Server snapshot: rendering a component using `useConnectionStatus` with `renderToString` (no DOM needed) gives `offline: false`.
  2. A `subscribeConnectionStatus(listener)` call pings `/api/ping` once (mock `fetch`), and a `{now}` answer yields `{ offline: false, serverNow: now }` from `getConnectionStatus()`.
  3. A rejected ping → `offline: true`; a `503` ping → `offline: true` (Review Focus 4).
  4. Dispatching `offline` on `window` → `offline: true` without a request; dispatching `online` → a new ping.
  5. `visibilitychange` to visible → a new ping.
  6. `isOfflineNow()` is true while `navigator.onLine` is false (stub `navigator` with `vi.stubGlobal('navigator', { onLine: false })`) and after a failed ping; false after a successful one.
  7. The ping passes an abort signal (assert `fetch` was called with an object whose `signal` is an `AbortSignal`) and `cache: 'no-store'`.
  8. **Retry while offline:** subscribe; the first ping answers 503 (offline). Advance fake timers by 15 s; the second ping answers `{now}`, and the snapshot becomes `offline: false`. Once unsubscribed, advancing time sends no ping.
  9. **Latest ping wins:** ping A hangs (deferred), ping B (from `online`) answers `{now}`, then A rejects. The snapshot stays `offline: false`.
  Call `resetConnectionStatus()` in `afterEach`.

- [ ] **Step 5: Run, see them fail** (module missing).

- [ ] **Step 6: Implement `src/lib/offline-status.ts`**

```ts
import { useSyncExternalStore } from 'react';

export interface ConnectionStatus {
  offline: boolean;
  /** The server's clock at the last successful ping, epoch ms. */
  serverNow: number | null;
}

const PING_TIMEOUT_MS = 5_000;
/** While a subscriber sees `offline`, how long until the ping is tried again. */
const RETRY_MS = 15_000;
const SERVER_SNAPSHOT: ConnectionStatus = { offline: false, serverNow: null };

let pingFailed = false;
let serverNow: number | null = null;
let snapshot: ConnectionStatus = SERVER_SNAPSHOT;
/** Numbers each ping; an answer is kept only from the latest one sent. */
let latestPing = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** A new object only when a value changed: React requires a stable snapshot. */
function refreshSnapshot(): void {
  const offline = pingFailed || browserOffline();
  if (snapshot.offline !== offline || snapshot.serverNow !== serverNow) {
    snapshot = { offline, serverNow };
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = listeners.size > 0 && snapshot.offline ? setTimeout(() => void checkConnection(), RETRY_MS) : null;
}

function publish(): void {
  refreshSnapshot();
  scheduleRetry();
  listeners.forEach((listener) => listener());
}

function isServerNow(value: unknown): value is { now: number } {
  return typeof value === 'object' && value !== null && 'now' in value && typeof value.now === 'number';
}

/** One reachability check against `/api/ping`. Never throws. */
export async function checkConnection(): Promise<void> {
  const ping = ++latestPing;
  let failed = true;
  let now: number | null = null;
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body: unknown = res.ok ? await res.json() : null;
    if (isServerNow(body)) {
      failed = false;
      now = body.now;
    }
  } catch {
    // A failed ping is the answer this function exists to find, not an error.
  }
  if (ping !== latestPing) return;
  pingFailed = failed;
  if (now !== null) serverNow = now;
  publish();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void checkConnection();
}

function onOnline(): void {
  void checkConnection();
}

function detach(): void {
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', publish);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

export function subscribeConnectionStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', publish);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Seen by React's post-subscribe snapshot check, so a page opened with
    // the browser already offline disables its controls before the ping.
    refreshSnapshot();
    void checkConnection();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

export function getConnectionStatus(): ConnectionStatus {
  return snapshot;
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus, () => SERVER_SNAPSHOT);
}

/** For a caller deciding at fire time, without subscribing. */
export function isOfflineNow(): boolean {
  return pingFailed || browserOffline();
}

/** Test-only. */
export function resetConnectionStatus(): void {
  detach();
  pingFailed = false;
  serverNow = null;
  latestPing = 0;
  snapshot = SERVER_SNAPSHOT;
  listeners.clear();
}
```

Run the tests: PASS.

- [ ] **Step 7: Failing tests for refresh suppression.**
  - `refresh-at` test: with `isOfflineNow` mocked true (`vi.mock('@/lib/offline-status', …)`), advancing fake timers past an instant does **not** call `router.refresh`; the remount-with-seen-`serverNow` path does not either. With it false, existing behaviour holds (existing tests stay green).
  - `live-updates` test (if a test file exists; otherwise add one beside it): a stream message while `isOfflineNow()` is true schedules no `router.refresh`.

- [ ] **Step 8: Implement.** In `refresh-at.tsx`, replace each `router.refresh()` call with a local `refreshUnlessOffline()` that returns early when `isOfflineNow()`; add one sentence to the `RefreshAt` docblock about its own behaviour: it does not refresh while offline, because offline `router.refresh()` is a hard reload of a stored snapshot (Next's failed-RSC fallback). What recovers a skipped refresh is documented in Task 5's section (`docs/technical-architecture.md`, Offline (service worker)). Same guard in `live-updates.tsx`'s timer. Run: PASS.

- [ ] **Step 9: Prove the guards bite.** Commit first (memory: `git checkout` eats sibling edits). Then, one at a time, record the failing test name and message in the task report, and restore with `git checkout -- <file>`:
  - M1.1 `checkConnection`: change `pingFailed = !isServerNow(body)` to `pingFailed = false` → the 503 test fails.
  - M1.2 `refresh-at.tsx`: remove the `isOfflineNow()` early return → the offline refresh test fails.
  - M1.3 `isOfflineNow`: return `pingFailed` only → the `navigator.onLine` test fails.
  - M1.4 `scheduleRetry`: body → `retryTimer = null;` → test 8 fails.
  - M1.5 `checkConnection`: delete `if (ping !== latestPing) return;` → test 9 fails.
  Finish with `git status --porcelain` empty.

- [ ] **Step 10: Commit**

```bash
git add src/app/api/ping/route.ts src/lib/offline-status.ts src/lib/offline-status.test.ts tests/integration/ping-api.test.ts src/components/class/refresh-at.tsx src/components/layout/live-updates.tsx <their test files>
git commit -m "feat: ping route and connection status; no refresh while offline (#725)"
```

---

### Task 2: The worker's offline rules (`public/sw.js`)

**Files:**
- Modify: `public/sw.js`
- Modify: `src/lib/sw.test.ts`

**Interfaces:**
- Produces (consumed by Task 3 and Task 4, and by Task 5's e2e):
  - Cache names `fy-pages-v1`, `fy-static-v1`, `fy-meta-v1`.
  - Messages accepted: `{ type: 'clear' }`, `{ type: 'warm', paths: string[] }`.
  - The owner marker pattern: exactly one `data-offline-owner="<uuid>"` in a page body.

The push behaviour (`push`, `notificationclick`, `safePath`) must stay byte-for-byte equivalent; its tests stay green unedited except where the harness signature changes. The existing activate test is the one rewritten (Step 4's last paragraph).

- [ ] **Step 1: Extend the harness.** `loadWorker` gains injectable `caches` and `fetch`, passed as extra `new Function` parameters so the script resolves them before Node's globals:

```ts
type Stored = Map<string, Response>;

/** An in-memory CacheStorage: enough of the API for public/sw.js. */
function fakeCaches() {
  const stores = new Map<string, Stored>();
  const urlOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);
  function cache(store: Stored) {
    return {
      // Lookups are exact: the worker keys every entry by pathname alone.
      match: async (r: string | { url: string }) => {
        const hit = store.get(urlOf(r));
        return hit ? hit.clone() : undefined;
      },
      // Real Cache.put rejects a body that was already read; so does this.
      put: async (r: string | { url: string }, res: Response) => {
        if (res.bodyUsed) throw new TypeError('body used');
        store.set(urlOf(r), res.clone());
      },
      delete: async (r: string | { url: string }) => store.delete(urlOf(r)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    };
  }
  return {
    stores,
    api: {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return cache(stores.get(name)!);
      },
      has: async (name: string) => stores.has(name),
      delete: async (name: string) => stores.delete(name),
      keys: async () => [...stores.keys()],
      match: async () => undefined,
    },
  };
}
```

`loadWorker(clientsList, { fetch, caches })` builds `self` as today plus `skipWaiting: vi.fn(async () => {})`, and runs `new Function('self', 'caches', 'fetch', source)(self, caches.api, fetchMock)`. Every existing call site passes defaults. Add helpers:

```ts
const ORIGIN = 'https://fair.yoga';
const OWNER = '3f6c2a7e-0b1d-4c8e-9a5f-1e2d3c4b5a69';
function html(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}
function page(owner = OWNER, extra = '') {
  return html(`<div data-offline-owner="${owner}"><script src="/_next/static/chunks/app-abc.js"></script>${extra}</div>`, 200, {
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
}
function navigation(pathname: string) {
  return { method: 'GET', url: `${ORIGIN}${pathname}`, mode: 'navigate' };
}
/** A fetch event; `settled()` resolves once every waitUntil promise has. */
function fetchEvent(request: { method: string; url: string; mode: string }) {
  const extended: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  return {
    request,
    waitUntil: (p: Promise<unknown>) => { extended.push(p); },
    respondWith: (p: Promise<Response>) => { responded = p; },
    response: () => responded,
    settled: async () => { await Promise.all(extended); },
  };
}
```

Replace the `'registers no fetch listener'` test with `'answers no request that is not a GET'`.

The mock `fetch` ignores `signal`, which is why case 12 pins the generation check and not the abort; say so in a comment on that test, so nobody "fixes" the fake and makes the generation half vacuous.

- [ ] **Step 2: Write the failing tests.** Each its own `it`, in a `describe('offline')` block. Use `vi.useFakeTimers({ shouldAdvanceTime: true })` only in the patience tests. Required cases, with the assertion each must make:
  1. **Pass-through:** a `POST` navigation, `GET /api/notifications/stream` (mode `cors`), `GET /api/classes/x` (mode `cors`), `GET /class/x?_rsc=1` (mode `cors`), `GET /api/ping`, and a cross-origin navigation → `respondWith` never called.
  2. **Online cacheable navigation:** `fetch` answers `page()` for `/class/c1` → the page receives that response; after `settled()`, `fy-pages-v1` holds `${ORIGIN}/class/c1` with `x-fy-owner: OWNER`, a numeric `x-fy-stored-at` and the response's `Content-Security-Policy` (`page()` sends `frame-ancestors 'none'`), and `fy-static-v1` holds `${ORIGIN}/_next/static/chunks/app-abc.js` (static pulled; mock `fetch` answers `200` JS for static URLs).
  3. **Not stored:** a body with no marker; a body with two markers; a `500`; a non-HTML `200` (`application/json`); a marker with a non-UUID-ish value containing `"` (`data-offline-owner="x&quot;y"`) → `fy-pages-v1` empty after `settled()`.
  4. **Offline serves the stored copy:** store `/class/c1`, then `fetch` rejects → the response body is the stored page.
  5. **Query string:** stored `/class/c1`, offline navigation to `/class/c1?from=inbox` → stored page (Review Focus 2).
  6. **Offline, nothing stored:** → `503`, body contains `You're offline`, `Content-Type` HTML, and a `Content-Security-Policy` header.
  7. **Expiry:** a stored entry with `x-fy-stored-at` 24 h + 1 ms old → offline page, and the entry is deleted; 24 h − 1 min old → served.
  8. **Garbage headers:** an entry with `x-fy-stored-at: nope`, or with no `x-fy-owner` → never served (Review Focus 5).
  9. **Redirect wipes:** stored `/schedule`; a navigation to `/class/c2` answered `Response` with `type` `opaqueredirect` (construct with `Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })` or `new Response(null, { status: 307, headers: { Location: '/login' } })` — test both) → the page gets the redirect; `fy-pages-v1` has no entries; and the generation in `fy-meta-v1` increased.
  10. **Owner change wipes:** stored `/class/c1` for OWNER; storing `/schedule` for another UUID → `fy-pages-v1` holds only `/schedule`.
  11. **Clear message:** `listeners.message({ data: { type: 'clear' }, waitUntil })` → `fy-pages-v1` gone, generation +1, static entries no page references are deleted.
  12. **Generation race (Review Focus 1):** start a warm whose `fetch` is a `deferred`; send `clear`; resolve the warm's fetch with `page()` → nothing is stored. Also: the warm's fetch received an `AbortSignal` that is aborted after `clear`. Annotate the test: the mock ignores the signal, so the generation check is what keeps the page out.
  13. **Warm:** `{ type: 'warm', paths: ['/class/c1', '/students/s1', '/class/new', '/class/c1/edit', 42] }` → only `/class/c1` fetched, with `credentials: 'same-origin'`, `redirect: 'manual'`; stored. A second warm within 10 minutes makes no fetch; after 10 minutes (advance `Date.now` via fake timers) it fetches again. A warm for a path whose navigation store is still in flight makes no fetch.
  14. **Patience:** online-but-silent network (`fetch` returns a never-settling deferred), stored copy exists → after 8 s the stored copy is served; with no stored copy → the response waits for the network (resolve it later; the page gets it).
  15. **Gateway (Review Focus 4):** network answers `503`, stored copy exists → stored copy; no stored copy → the `503` itself.
  16. **Launch URL:** offline navigation to `/` and to `/start` with a stored `/schedule` → a `302` to `${ORIGIN}/schedule`; without one → the offline page; online → the network response untouched and nothing stored.
  17. **Other navigation:** offline `/students` → offline page; online → network response, nothing stored.
  18. **Static:** offline `GET /_next/static/chunks/app-abc.js` with a stored copy → the copy; online → network response; a static request whose network never settles with a stored copy → the copy after 8 s.
  19. **Static pruning:** two stored pages referencing `a.js` and `b.js`; the page referencing `b.js` expires and a purge runs (a navigation to a cacheable path) → `b.js` deleted, `a.js` kept. Flight-payload form: a body containing `self.__next_f.push([1,"…\"/_next/static/chunks/c.js\"…"])` pulls `c.js` (the backslash ends the match).
  20. **Install / activate:** install calls `skipWaiting` inside `waitUntil`; activate deletes `fy-pages-v0` and `fy-old`-prefixed caches not in the current set, keeps `fy-pages-v1`, leaves a non-`fy-` cache alone, and still calls `clients.claim()` — also when deleting throws.

- [ ] **Step 3: Run, see them fail.** `pnpm exec vitest run --project unit src/lib/sw.test.ts`. Expected: every new test fails (no fetch listener).

- [ ] **Step 4: Implement.** Replace `public/sw.js`'s header comment and the `activate` listener; add everything below. Keep `safePath`, `push` and `notificationclick` as they are.

```js
// fair.yoga service worker: push, and a read-only offline copy of a
// teacher's schedule and class pages. The rules, and why each holds, are in
// docs/technical-architecture.md (Offline (service worker)); this file is
// their code.

const PAGES = 'fy-pages-v1';
const STATIC = 'fy-static-v1';
const META = 'fy-meta-v1';
const CURRENT_CACHES = [PAGES, STATIC, META];

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PATIENCE_MS = 8000;
const WARM_FRESH_MS = 10 * 60 * 1000;
const MAX_WARM_PATHS = 20;
const GATEWAY_FAILURES = new Set([502, 503, 504]);
const GENERATION_KEY = '/__fy/generation';
// The attribute React writes for OfflineSnapshot's owner. A `"` inside any
// other text arrives escaped (`&quot;`, or `\"` in the flight payload), so
// page content cannot forge a second match.
const OWNER_PATTERN = /data-offline-owner="([A-Za-z0-9-]+)"/g;
const STATIC_PATTERN = /\/_next\/static\/[^"'\\\s)<>]+/g;
const SLOW = 'slow';
const FAILED = 'failed';

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · fair.yoga</title></head>
<body style="margin:0;background:#F7F4EF;color:#6B5B4E;font-family:system-ui,-apple-system,sans-serif">
<main style="max-width:640px;margin:0 auto;padding:48px 16px">
<h1 style="font-family:Georgia,serif;color:#1A5653;font-size:24px;margin:0 0 12px">You're offline</h1>
<p style="margin:0 0 24px;line-height:1.5">This page wasn't saved on this device. Your schedule and today's classes are, once you've opened the app with a connection today.</p>
<p style="margin:0"><a href="/schedule" style="color:#1A5653;font-weight:600">Open your schedule</a></p>
</main></body></html>`;

/** Paths whose network response is being stored now; a warm skips them. */
const pathsBeingStored = new Set();
/** Warms in flight, aborted by a clear. */
const warmControllers = new Set();

function key(pathname) {
  return self.location.origin + pathname;
}

function isCacheablePath(pathname) {
  return pathname === '/schedule' || /^\/(?:class|studio-class)\/(?!new$)[^/]+$/.test(pathname);
}

function isRedirect(res) {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
}

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}

// Copied from the network response, so a stored page is served under the
// same policy it was rendered with.
const KEPT_HEADERS = [
  'content-type',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
];

function storedHeaders(res, owner) {
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('x-fy-owner', owner);
  headers.set('x-fy-stored-at', String(Date.now()));
  return headers;
}

function storedAt(res) {
  const at = Number(res.headers.get('x-fy-stored-at'));
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Written by this worker, owned, and under the retention limit. */
function isServable(res) {
  const at = storedAt(res);
  return at !== null && Boolean(res.headers.get('x-fy-owner')) && Date.now() - at < MAX_AGE_MS;
}

async function generation() {
  const res = await (await caches.open(META)).match(key(GENERATION_KEY));
  const value = res ? Number(await res.text()) : 0;
  return Number.isFinite(value) ? value : 0;
}

function staticPaths(body) {
  return new Set(Array.from(body.matchAll(STATIC_PATTERN), (m) => m[0]));
}

/** Deletes every static file no stored page references. */
async function pruneStatic() {
  const referenced = new Set();
  if (await caches.has(PAGES)) {
    const pages = await caches.open(PAGES);
    for (const req of await pages.keys()) {
      const res = await pages.match(req);
      if (res) for (const path of staticPaths(await res.text())) referenced.add(key(path));
    }
  }
  const files = await caches.open(STATIC);
  for (const req of await files.keys()) {
    if (!referenced.has(req.url)) await files.delete(req);
  }
}

async function pullStatic(body) {
  const files = await caches.open(STATIC);
  await Promise.all(
    [...staticPaths(body)].map(async (path) => {
      if (await files.match(key(path))) return;
      try {
        const res = await fetch(key(path));
        if (res.ok) await files.put(key(path), res);
      } catch (err) {
        // The stored page will hydrate without this file offline.
        console.warn('[sw] could not store a static file', path, err);
      }
    }),
  );
}

async function purgeExpired() {
  if (!(await caches.has(PAGES))) return;
  const pages = await caches.open(PAGES);
  let removed = false;
  for (const req of await pages.keys()) {
    const res = await pages.match(req);
    if (!res || !isServable(res)) {
      await pages.delete(req);
      removed = true;
    }
  }
  if (removed) await pruneStatic();
}

async function clearPages() {
  for (const controller of warmControllers) controller.abort();
  const next = (await generation()) + 1;
  await (await caches.open(META)).put(key(GENERATION_KEY), new Response(String(next)));
  await caches.delete(PAGES);
  await pruneStatic();
}

/**
 * Stores `res` for `pathname` when it is a page this worker may keep: a 200
 * HTML page carrying exactly one owner. `startedAt` is the generation read
 * when its request began; a clear since then means the request carried a
 * session that has ended, so nothing is kept.
 */
async function storePage(pathname, res, startedAt) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return;
  const body = await res.text();
  const owners = Array.from(body.matchAll(OWNER_PATTERN), (m) => m[1]);
  if (owners.length !== 1) return;
  const owner = owners[0];
  let pages = await caches.open(PAGES);
  for (const req of await pages.keys()) {
    const existing = await pages.match(req);
    if (!existing || existing.headers.get('x-fy-owner') !== owner) {
      await caches.delete(PAGES);
      pages = await caches.open(PAGES);
      break;
    }
  }
  const headers = storedHeaders(res, owner);
  // clearPages bumps the generation before it deletes PAGES, so a put that
  // passes this check lands in a cache that clear then removes.
  if ((await generation()) !== startedAt) return;
  await pages.put(key(pathname), new Response(body, { status: 200, headers }));
  await pullStatic(body);
}

async function storedCopy(pathname) {
  const pages = await caches.open(PAGES);
  const res = await pages.match(key(pathname));
  if (!res) return null;
  if (isServable(res)) return res;
  await pages.delete(key(pathname));
  return null;
}

/**
 * The network's answer, unless it fails, answers a gateway error, or is
 * still silent after PATIENCE_MS — then `fallback()`'s response if it has
 * one. A slow network with no fallback is still waited for.
 */
async function networkFirst(fromNetwork, fallback) {
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SLOW), PATIENCE_MS);
  });
  const first = await Promise.race([fromNetwork.catch(() => FAILED), slow]);
  clearTimeout(timer);
  if (first !== SLOW && first !== FAILED && !GATEWAY_FAILURES.has(first.status)) return first;
  const stored = await fallback().catch((err) => {
    console.warn('[sw] stored copy unreadable', err);
    return null;
  });
  if (stored) return stored;
  if (first === SLOW) return fromNetwork.catch(() => offlineResponse());
  return first === FAILED ? offlineResponse() : first;
}

function handleCacheablePage(event, pathname) {
  pathsBeingStored.add(pathname);
  const startedAt = generation();
  const fromNetwork = fetch(event.request);
  const stored = fromNetwork
    .then(
      (res) => {
        if (isRedirect(res)) return clearPages();
        // Cloned before the page reads the original.
        const copy = res.clone();
        return startedAt.then((g) => storePage(pathname, copy, g));
      },
      // No response is no page to store; serving is networkFirst's job.
      () => undefined,
    )
    .catch((err) => console.warn('[sw] could not store a page', pathname, err))
    .finally(() => pathsBeingStored.delete(pathname));
  event.waitUntil(stored.then(() => purgeExpired()));
  event.respondWith(networkFirst(fromNetwork, () => storedCopy(pathname)));
}

async function scheduleRedirect() {
  return (await storedCopy('/schedule')) ? Response.redirect(key('/schedule'), 302) : null;
}

async function warm(paths) {
  const startedAt = await generation();
  const pages = await caches.open(PAGES);
  const wanted = paths.filter((p) => typeof p === 'string' && isCacheablePath(p)).slice(0, MAX_WARM_PATHS);
  await Promise.all(
    wanted.map(async (pathname) => {
      if (pathsBeingStored.has(pathname)) return;
      const existing = await pages.match(key(pathname));
      if (existing && isServable(existing) && Date.now() - storedAt(existing) < WARM_FRESH_MS) return;
      const controller = new AbortController();
      warmControllers.add(controller);
      pathsBeingStored.add(pathname);
      try {
        const res = await fetch(key(pathname), { credentials: 'same-origin', redirect: 'manual', signal: controller.signal });
        if (isRedirect(res)) await clearPages();
        else await storePage(pathname, res, startedAt);
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[sw] could not warm a page', pathname, err);
      } finally {
        warmControllers.delete(controller);
        pathsBeingStored.delete(pathname);
      }
    }),
  );
  await purgeExpired();
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// Drops caches an older worker version wrote, then takes control of windows
// already open, so a push tap can navigate them and their next navigation is
// answered here.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n.startsWith('fy-') && !CURRENT_CACHES.includes(n)).map((n) => caches.delete(n))),
      )
      .then(() => purgeExpired())
      .catch((err) => console.error('[sw] cache cleanup on activate failed', err))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (isCacheablePath(url.pathname)) {
      handleCacheablePage(event, url.pathname);
    } else if (url.pathname === '/' || url.pathname === '/start') {
      event.respondWith(networkFirst(fetch(request), scheduleRedirect));
    } else {
      event.respondWith(fetch(request).catch(() => offlineResponse()));
    }
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(networkFirst(fetch(request), async () => (await caches.open(STATIC)).match(request.url, { ignoreVary: true }) || null));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'clear') event.waitUntil(clearPages());
  else if (data.type === 'warm' && Array.isArray(data.paths)) event.waitUntil(warm(data.paths));
});
```

The original `activate` listener (claim only) is removed — the harness keeps only the last listener per type, and the browser would run both. The existing activate test is rewritten, not just re-signatured: `claim` now runs after `caches.keys()` resolves, and `waitUntil` receives the chain rather than `claim`'s promise, so it awaits the event's `waitUntil` promise and then asserts `claim` was called once.

Run: all `sw.test.ts` tests pass. If a case in Step 2 exposes a defect in the code above, fix the code (and say so in the task report) — do not bend the test.

- [ ] **Step 5: Check the static pattern against a real build.** Run `pnpm run build`, start the standalone server on a free port (`PORT=3199 node .next-build/standalone/server.js` — check `package.json`/CI for the exact command and env), sign in as a seeded teacher (the `verify` skill's recipe), `curl` `/schedule` and one `/class/<id>` with the session cookie, and confirm with `grep -oE '/_next/static/[^"'"'"'\\\\ )<>]+'` that every chunk the page's `<script src>` tags name is matched, and whether the flight payload names chunks with or without the `/_next/` prefix. If any chunk reference uses a form the pattern misses, widen `STATIC_PATTERN` and add a test case with that literal form. Record the counts (scripts in HTML vs pattern matches) in the task report. Also `curl -sI` a class page the signed-in teacher does not own (a real id, not theirs) and a deleted class id, with the session cookie, and record the status each answers: both pages call `redirect('/schedule')`, which may reach the worker as a 3xx. Ruling: if it is a 3xx, it wipes the page cache, which costs the teacher one re-warm and only happens when visiting another teacher's class URL — acceptable, no code change; Task 5's doc section records it. Stop the server.

- [ ] **Step 6: Prove the guards bite.** Commit first. One at a time, with exact text recorded, then `git checkout -- public/sw.js`:
  - M2.1 `storePage`: `if (owners.length !== 1) return;` → `if (owners.length === 0) return;` → case 3 (two markers) fails.
  - M2.2 `handleCacheablePage`: `if (isRedirect(res)) return clearPages();` → `if (isRedirect(res)) return undefined;` → case 9 fails.
  - M2.3 `storePage`: remove the owner-mismatch loop → case 10 fails.
  - M2.4 `storePage`: delete `if ((await generation()) !== startedAt) return;` → case 12 fails.
  - M2.5 `isServable`: `Date.now() - at < MAX_AGE_MS` → `true` → case 7 fails.
  - M2.6 `fetch` listener: drop `if (request.method !== 'GET') return;` → case 1 fails.
  - M2.7 `isCacheablePath`: remove `(?!new$)` → case 13 fails.
  - M2.8 `pullStatic` call removed from `storePage` → case 2 fails.
  - M2.9 `pruneStatic`: delete nothing → case 19 fails.
  - M2.10 `networkFirst`: drop `!GATEWAY_FAILURES.has(first.status)` → case 15 fails.
  - M2.11 `fetch` listener: `handleCacheablePage(event, url.pathname)` → `handleCacheablePage(event, url.pathname + url.search)` → case 5 fails.
  - M2.12 `KEPT_HEADERS` → `['content-type']` → case 2 fails.
  Finish with `git status --porcelain` empty.

- [ ] **Step 7: Commit**

```bash
git add public/sw.js src/lib/sw.test.ts
git commit -m "feat(sw): network-first offline copy of the schedule and class pages (#725)"
```

---

### Task 3: Registration, the snapshot wrapper, and the three pages

**Files:**
- Create: `src/lib/service-worker.ts` — `export const SW_URL = '/sw.js'; export const SW_SCOPE = '/';`
- Modify: `src/lib/push-client.ts` — import `SW_URL`/`SW_SCOPE` instead of its local constant (no behaviour change).
- Create: `src/lib/offline-client.ts` + test
- Create: `src/lib/offline-snapshot-props.ts` (server-only helpers) + unit test
- Create: `src/components/layout/offline-worker.tsx` + test
- Create: `src/components/layout/offline-snapshot.tsx` + test
- Modify: `src/app/(teacher)/layout.tsx` — render `<OfflineWorker />` beside `<LiveUpdates />`.
- Modify: `src/app/(teacher)/schedule/(overview)/page.tsx`, `src/app/(teacher)/class/[id]/(overview)/page.tsx`, `src/app/(teacher)/studio-class/[id]/page.tsx` — wrap their returned content.
- Modify: `src/components/ui/button.tsx` and every raw `<button>` rendered on the three pages whose disabled look depends on the prop.

**Interfaces:**
- Consumes: `useConnectionStatus` (Task 1); cache name `fy-pages-v1` and the `warm`/`clear` messages (Task 2).
- Produces:
  - `src/lib/offline-client.ts`:
    - `export const OFFLINE_PAGES_CACHE = 'fy-pages-v1';`
    - `export async function registerOfflineWorker(): Promise<void>` — registers `SW_URL` at `SW_SCOPE` where supported; logs a failure via `logRequestFailure('offline-client', { step: 'register' }, err)`; never throws.
    - `export async function warmOfflinePages(paths: readonly string[]): Promise<void>` — waits for `navigator.serviceWorker.ready` (at most 10 s), posts `{ type: 'warm', paths: [...paths] }` to `registration.active`; never throws.
    - `export async function clearOfflinePages(): Promise<void>` — posts `{ type: 'clear' }` to the `/` registration's active worker (via `getRegistration(SW_SCOPE)`, not `ready`, so it never waits on an install) and `caches.delete(OFFLINE_PAGES_CACHE)` where `caches` exists; never throws (Task 4 uses it).
  - `src/lib/offline-snapshot-props.ts`:
    - `export interface OfflineSnapshotStamp { ownerId: string; renderedAt: number; loadedAtClock: string; loadedAtDayClock: string; loadedOn: string; timeZone: string }`
    - `export function offlineSnapshotStamp(session: TeacherSession, now: Date): OfflineSnapshotStamp` — `loadedAtClock = formatClockInZone(now, tz)`, `loadedAtDayClock = formatInstantInZone(now, tz)`, `loadedOn = localDateKey(now, tz)`.
    - `export function localDateKey(instant: Date, timeZone: string): string` — `YYYY-MM-DD` of `instant` in `timeZone`, taken from `startOfLocalDay(instant, timeZone).toISOString().slice(0, 10)` so an unknown zone degrades to UTC's date (logged) instead of throwing.
    - `export function todaysOfflinePaths(classes: ReadonlyArray<{ id: string; calendarEntry: { date: Date } }>, studioClasses: ReadonlyArray<{ id: string; calendarEntry: { date: Date } }>, todayKey: string): string[]` — `/class/<id>` and `/studio-class/<id>` for entries whose `calendarEntry.date.toISOString().slice(0, 10) === todayKey` (an `@db.Date` is midnight UTC of the local date).
  - `OfflineSnapshot` props: `OfflineSnapshotStamp & { warmPaths?: readonly string[]; children: ReactNode }`.

- [ ] **Step 1: Tether the cache name.** A unit test in `src/lib/offline-client.test.ts` (unit project, node; stub globals as `push-client.test.ts` does) reads `public/sw.js` and asserts it contains `const PAGES = '${OFFLINE_PAGES_CACHE}';`. Plus behaviour tests (stub `navigator.serviceWorker` and `caches`): `clearOfflinePages` posts `{type:'clear'}` and deletes the cache; resolves when `serviceWorker` or `caches` is absent; resolves when `getRegistration` rejects (and logs). `warmOfflinePages` posts the paths after `ready`; resolves after 10 s when `ready` never settles (fake timers). `registerOfflineWorker` calls `register('/sw.js', { scope: '/' })`; swallows and logs a rejection.

- [ ] **Step 2: Unit tests for `offline-snapshot-props.ts`** (unit project, TZ is `America/New_York` there): `localDateKey(new Date('2026-10-04T11:30:00Z'), 'Pacific/Auckland')` is `'2026-10-05'` (Review Focus 3); `todaysOfflinePaths` keeps only entries on `todayKey` and emits both families' paths; `offlineSnapshotStamp` uses `session.accountId` and the session's `defaultTimezone`; `localDateKey` with an unknown zone returns UTC's date without throwing; `todaysOfflinePaths` with `todayKey: '2026-10-05'` under `vi.setSystemTime(new Date('2026-10-04T11:30:00Z'))` keeps the 2026-10-05 entries and drops the 2026-10-04 ones.

- [ ] **Step 3: Component tests for `OfflineSnapshot`** (mock `@/lib/offline-status`'s `useConnectionStatus` and `isOfflineNow`, `@/lib/offline-client`'s `warmOfflinePages`, and `next/navigation`'s `useRouter`):
  1. Renders `data-offline-owner` with the owner id on its wrapper; online → the status element is empty and `sr-only`, fieldset not disabled.
  2. Offline, `loadedOn` equal to today in the stamp's zone → `Offline — showing what was loaded at 09:12` (exact), with `role="status"`.
  3. Offline, `loadedOn` an earlier day → `Offline — showing what was loaded Sat 3 Oct 21:40` (whatever `loadedAtDayClock` holds, verbatim). Use `timeZone: 'Pacific/Auckland'` and fake system time so the device's own date differs from Auckland's (Review Focus 3).
  4. Offline → a descendant `<Button>` is disabled (`toBeDisabled()`), and has the `disabled:opacity-50` class (the look comes from the pseudo-class); an `AttendanceList` check-in button inside the wrapper has `disabled:opacity-50` too.
  5. Online with `serverNow - renderedAt > 60_000` → `router.refresh` called exactly once, also after a second successful ping that brings a later, still-stale `serverNow` (the mock returns a new status object), with the router mock returning one stable object; `≤ 60_000` → not called; offline → not called. Any successful ping triggers this, not only one on a stored snapshot; a page left open and returned to after a minute refreshes, which is intended.
  6. Online on mount → `warmOfflinePages` called once with the current path (mock `usePathname`) followed by `warmPaths`; offline → not called; and with `useConnectionStatus` still saying online but `isOfflineNow()` true (a page opened from the cache while offline) → not called.
  7. Toggling offline → online does not remount children (a child with local state keeps it).

- [ ] **Step 4: Run, see them fail.**

- [ ] **Step 5: Implement.**

```tsx
// src/components/layout/offline-snapshot.tsx
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isOfflineNow, useConnectionStatus } from '@/lib/offline-status';
import { warmOfflinePages } from '@/lib/offline-client';
import type { OfflineSnapshotStamp } from '@/lib/offline-snapshot-props';

/** How far a page's render may trail the server's clock before a successful ping refreshes it. */
const STALE_AFTER_MS = 60_000;

function todayIn(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (err) {
    console.error('[offline-snapshot] unreadable timezone, showing the day', { timeZone }, err);
    return null;
  }
}

/**
 * Wraps a page the service worker may store. Offline, it says when the page
 * was loaded and disables every control inside it through the fieldset. The
 * `data-offline-owner` attribute is the owner marker the worker requires; see
 * docs/technical-architecture.md (Offline (service worker)).
 */
export function OfflineSnapshot({
  ownerId,
  renderedAt,
  loadedAtClock,
  loadedAtDayClock,
  loadedOn,
  timeZone,
  warmPaths = [],
  children,
}: OfflineSnapshotStamp & { warmPaths?: readonly string[]; children: ReactNode }) {
  const { offline, serverNow } = useConnectionStatus();
  const router = useRouter();
  const pathname = usePathname();
  const refreshedFor = useRef<number | null>(null);
  const warmKey = [pathname, ...warmPaths].join('|');

  useEffect(() => {
    // The first run sees the server snapshot, before the browser's own state is read.
    if (offline || isOfflineNow()) return;
    void warmOfflinePages(warmKey.split('|'));
  }, [offline, warmKey]);

  useEffect(() => {
    if (offline || serverNow === null || serverNow - renderedAt <= STALE_AFTER_MS) return;
    if (refreshedFor.current === renderedAt) return;
    refreshedFor.current = renderedAt;
    router.refresh();
  }, [offline, serverNow, renderedAt, router]);

  const loaded = offline ? (loadedOn === todayIn(timeZone) ? `at ${loadedAtClock}` : loadedAtDayClock) : null;

  return (
    <div data-offline-owner={ownerId}>
      <p role="status" className={offline ? 'type-label text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4' : 'sr-only'}>
        {offline && `Offline — showing what was loaded ${loaded}`}
      </p>
      <fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </div>
  );
}
```

The marker is a calm notice, not a danger state: gold attention colour on its tint, card radius, no shadow. The `<p>` stays mounted (empty and `sr-only` online) because a live region inserted already holding its text is not reliably announced.

`OfflineWorker`: `'use client'`, `useEffect(() => { void registerOfflineWorker(); }, [])`, returns `null`.

`src/lib/offline-snapshot-props.ts` imports `formatClockInZone` (`@/lib/finish-window`) and `formatInstantInZone` and `startOfLocalDay` (`@/lib/timezone`); it is server-only by its imports — do not import it from a client component except as `import type`.

`Button`: drop `disabledClass`; add `disabled:opacity-50 disabled:cursor-not-allowed` to `base`. Then census the raw controls: `grep -rnE "\? '[^']*(opacity-|cursor-not-allowed)" src/components` (quoted, run from the worktree), keeping only files the three pages render (follow their imports). For each hit on a `<button>`, `<select>` or `<input>`, add `disabled:opacity-50` (and `disabled:cursor-not-allowed`) beside the existing class. Keep the busy-state class: it covers a pending write while online. List each converted site in the task report.

- [ ] **Step 6: Wrap the pages.** In each page, after the session is read and before `return`, compute `const stamp = offlineSnapshotStamp(session, new Date());` and wrap the whole returned tree in `<OfflineSnapshot {...stamp}>…</OfflineSnapshot>` — the class page's `PageHeader` (whose action holds Publish / Finish) goes inside. The schedule passes `warmPaths={todaysOfflinePaths(classes, studioClasses, stamp.loadedOn)}`. Any early `redirect`/`notFound` stays before the wrap. Add `<OfflineWorker />` to `src/app/(teacher)/layout.tsx`.

  Integration check: the existing page-level integration tests for these pages (`grep -ln "/schedule\|/class/\|/studio-class/" tests/integration/*page*.test.ts`) still pass; add to `tests/integration/studio-class-page.test.ts` (or the closest page test) one assertion that the HTML of a signed-in teacher's page contains exactly one `data-offline-owner="<that account's id>"`.

- [ ] **Step 7: Run all three projects' affected tests; PASS.** `pnpm exec vitest run --project unit --project components <files>`.

- [ ] **Step 8: Prove the guards bite.** Commit first; one at a time, record, restore:
  - M3.1 `OfflineSnapshot`: `disabled={offline}` → `disabled={false}` → test 4 fails.
  - M3.2 remove `if (refreshedFor.current === renderedAt) return;` → test 5 (exactly once) fails.
  - M3.3 `todaysOfflinePaths`: compare against `new Date().toISOString().slice(0,10)` instead of `todayKey` → the `todaysOfflinePaths` fixed-clock test (Step 2) fails.
  - M3.4 `Button`: restore the prop-conditional `disabledClass` and drop the `disabled:` classes → test 4's class assertion fails.
  - M3.5 the tether: change `OFFLINE_PAGES_CACHE` to `'fy-pages-v2'` → the tether test fails.

- [ ] **Step 9: Commit** (exact paths, parentheses quoted).

---

### Task 4: Clear the page cache at every account change

**Files:**
- Modify: `src/components/account/sign-out-button.tsx` (+ test)
- Modify: `src/components/account/data-and-deletion.tsx` (+ test)
- Modify: every sign-in completion site — the census command: `grep -rln "recordPushDevice" src --include='*.tsx' | grep -v test`. On `origin/main` at `dd8f6dc0` that names `src/app/(public)/verify/page.tsx`, `src/components/auth/handoff-code-entry.tsx`, `src/components/booking/booking-name-step.tsx`, `src/components/booking/passkey-sign-in.tsx`, `src/components/signup/profile-setup-form.tsx` — re-run it and treat its output, not this list, as the set. Then check whether any sign-in that sets the session cookie reaches the client without one of those sites: the cookie is set by `setSessionCookie` (`src/lib/auth/session.ts`); for each of its callers, find the client component that called that route and confirm it is in the set or add it.
- Tests: each site's existing component test, or a new one beside it.

**Interfaces:**
- Consumes: `clearOfflinePages(): Promise<void>` (Task 3), never throws.

- [ ] **Step 1: Failing tests.** Mock `@/lib/offline-client`. For each site:
  - sign-out: `clearOfflinePages` is called after the `DELETE /api/auth/session` settles — both when it answers ok and when it rejects — and before `router.push`.
  - account deletion: called after a successful `DELETE /api/account`, before `router.push('/login')`.
  - each sign-in site: called when the sign-in completes, on every branch that completes one (in `verify/page.tsx` that includes the `isNew` branch, which today skips `recordPushDeviceForSignIn`); where the site awaits push before navigating (`handoff-code-entry`, `profile-setup-form`), the clear is awaited before the navigation too.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.** In `sign-out-button.tsx`, inside `finally`, before `router.push(redirectTo)`: `await clearOfflinePages();` with a comment of one line: the device's stored teacher pages belong to the account that just left. Elsewhere, `void clearOfflinePages()` beside a `void recordPushDevice…` call, `await clearOfflinePages()` beside an awaited one.

- [ ] **Step 4: Run; PASS.**

- [ ] **Step 5: Prove the guards bite.** Commit first. Remove the call from `sign-out-button.tsx` → its test fails; restore. Remove it from the `isNew` branch of `verify/page.tsx` → its test fails; restore. `git status --porcelain` empty.

- [ ] **Step 6: Commit.**

---

### Task 5: End to end, Playwright config, and the architecture doc

**Files:**
- Modify: `playwright.config.ts` — `use: { …, serviceWorkers: 'block' }` at the top level.
- Create: `tests/e2e/offline.spec.ts`
- Modify: `docs/technical-architecture.md` — a new section **Offline (service worker)**.
- Modify: `docs/superpowers/specs/2026-10-04-offline-schedule-design.md` only if the build contradicted it (record what changed and why in the commit message).

- [ ] **Step 1: Write the spec.** `test.use({ serviceWorkers: 'allow' })`; Chromium project only (`test.skip(({ browserName }, ) => …)` or a project filter — follow how other specs scope to one project). Fixture: a teacher whose timezone is `UTC` (memory: real-time fixtures need a UTC teacher), signed in the way `tests/e2e/teacher-journey.spec.ts` does it, with one open class **today** starting at the earlier of now + 2 h and 23:00 UTC today (floored to the minute), 30 minutes long (after 23:00 UTC the class is under way, and the page still renders its roster; assert this once by running the spec with the clock-derived start pinned to now − 10 min), and one registered student with a distinctive first name, created through Prisma as neighbouring specs do (`tests/class-fixtures.ts` helpers where they fit), cleaned up in `afterAll` scoped by ids assigned in the test (memory: never `deleteMany` by an id a failed `beforeAll` left undefined).

Steps of the test:
  1. `page.goto('/schedule')`; `await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))`.
  2. `await expect.poll(() => page.evaluate(async (path) => Boolean(await (await caches.open('fy-pages-v1')).match(path)), `/class/${classId}`), { timeout: 20_000 }).toBe(true)` — the class page was warmed, never visited.
  3. `await context.setOffline(true)`; `page.goto(`/class/${classId}`)` → the student's first name is visible; `getByRole('status')` has text matching `/^Offline — showing what was loaded at \d{2}:\d{2}$/`; a control on the page (e.g. the Cancel class button) `toBeDisabled()`.
  4. `page.goto('/')` → `expect(page).toHaveURL(/\/schedule$/)` and the marker shows.
  5. `page.goto('/students')` → text `You're offline`.
  6. `await context.setOffline(false)`; go to `/settings`, click **Sign out**, wait for `/login`; `expect.poll(() => page.evaluate(async () => (await caches.has('fy-pages-v1')) ? (await (await caches.open('fy-pages-v1')).keys()).length : 0)).toBe(0)`.

- [ ] **Step 2: Run it locally against the worktree app** (`pnpm run worktree:up`, then `pnpm exec playwright test tests/e2e/offline.spec.ts --project=chromium`). It must fail first if run before Task 3's wrap exists — it does not here, since Tasks 1–4 are in; instead prove it can fail: comment out the `warmOfflinePages` effect in `offline-snapshot.tsx`, run → step 2 times out; restore. Record that run.

- [ ] **Step 3: Run the whole e2e suite once with `serviceWorkers: 'block'`** to confirm nothing else changed: `pnpm exec playwright test --project=chromium`. Also run it against a production build if time allows (CI's job does: `pnpm run build`, then the standalone server — see `.github/workflows/ci.yml` `test-e2e`).

- [ ] **Step 4: Write the doc section** in `docs/technical-architecture.md` (find the PWA / push section and put it beside it). It owns the facts the code comments point to: the three cacheable paths and why only those; network-first with the 8 s patience and the gateway fallback; the three caches and what clears each; the owner marker and why a page without it is never stored; the clear sites, with the re-derivation command `grep -rn "clearOfflinePages()" src --include='*.tsx' | grep -v test`; the 24 h retention and static pruning by reference; the deploy story (byte-compared `sw.js`, `skipWaiting`, versioned cache names — bump the `-v1` suffix when the stored format changes); the residual (a session revoked elsewhere while the device stays offline); why the e2e suite blocks service workers except in `offline.spec.ts`. Also record: the stale-while-online rule is not snapshot-only — a successful ping (pings fire only on mount, on the `online` event, on returning to the tab and on the offline retry) makes any page whose render is more than a minute behind the server's clock call `router.refresh()` once, so a page left open more than a minute refreshes on tab return, and this is what recovers a `RefreshAt` refresh skipped while offline; the connection store retries its ping every 15 s while offline; an owner wipe inside one warm can delete a sibling's just-stored entry (data lost, nothing leaked, healed by the next warm); and the class and studio-class pages' `redirect('/schedule')` for a missing or foreign id, if Task 2 Step 5 measured it as a 3xx, wipes the cache (one re-warm, accepted). Link the spec.

- [ ] **Step 5: Commit.**

---

## Whole-branch checks before the PR

- `pnpm run verify` (typecheck, lint, all vitest projects) green against the worktree app; record the per-project counts.
- `pnpm run build` succeeds (catches a server-only import reaching `OfflineSnapshot`'s bundle).
- `git grep -n "no \`fetch\` listener\|registers no fetch listener\|push only" -- public src docs` — every hit is either updated or legitimately historical (spec/plan records).
