# Read-only offline for today's schedule and class rosters (#725)

Part of tracking issue #727, third in its order. Builds on #723 (installable
app) and #724 (web push, which introduced `public/sw.js`). #726 (queued
offline check-in) builds on this and is unaffected here: nothing is written
while offline.

Run without interaction at the user's request, so every gate below was decided
by the implementing session. Each decision names the alternative it rejected,
so a reader can overturn it with the reason in front of them.

## 1. What the issue assumed, and what holds

Measured on `feat/725-offline-schedule` off `origin/main` at `dd8f6dc0`.

| Issue's premise | Measured |
|---|---|
| "A service worker … none exists today" | **Wrong.** `public/sw.js` exists since #724: push only, and its header says it deliberately has no `fetch` listener (`src/lib/sw.test.ts` pins that with `'registers no fetch listener'`). |
| (implied) a worker is present on a teacher's device | **Only after they turn push on.** The one `navigator.serviceWorker.register` call is inside `enablePush` (`src/lib/push-client.ts`), a click handler. A teacher who never turned push on has no worker, so offline needs a registration on page load. |
| A deploy must replace the old worker "cleanly (versioned cache …)" | **A static `public/sw.js` never changes between deploys**, so the browser never installs a new one, and the Docker build has no git and no build id (`.dockerignore` drops `.git`; `next.config.ts` sets no `generateBuildId`/`env`). §3.6 makes the worker independent of app deploys rather than inventing a build id. |
| The class page holds "student names (and contact data, on the student pages)" | **Holds, and the class page is narrower than feared.** Names only (`studentNameSelect`, `src/lib/student-visibility.ts`), shown as "First l." unless the student shares their full name; attendance and, after completion, payment status per student; tier only as aggregate counts. No email or phone. Contact data lives on `/students/[id]`, which this design never caches. |
| "Never serve a cached authenticated page to a signed-out session" | **The worker cannot see the session.** `fair_yoga_session` is `HttpOnly`; a worker has no cookie access in Safari. It can see two things: a signed-out request for a teacher page is a 307 to `/login` (`src/proxy.ts`), and the page HTML it is about to store. §3.4 binds the cache to both. |
| SSE must be excluded | **Holds.** `/api/notifications/stream` is the only streaming route. §3.2 answers only navigations and `/_next/static/`, so the stream is excluded by construction, not by a deny-list entry. |
| Offline soft navigations need handling | **They already fall back.** Next 16.3.4's `fetchServerResponse` answers a failed RSC fetch with a browser navigation (`experimental.useOffline` is off here), so a tap on a class card offline becomes a document navigation the worker can answer. The worker never caches RSC payloads. |
| Write controls are check-in, finish, walk-in | **Incomplete.** The class page also has publish, mark paid, undo paid, send reminder, announce and cancel; the studio-class page has count edit, cancel, restore and delete; the schedule page has two onboarding writes. Every one is a `<button>` calling `fetch` (none is a `<form>`), which §3.5 relies on. |

## 2. Decisions

**D1. Hand-written worker, no dependency.** Serwist would add a build-plugin
dependency subject to `docs/supply-chain.md` (7-day release age,
`strictDepBuilds`, signature audit) for what is three request rules and two
caches. The existing worker is hand-written and tested by evaluating the
script (`sw.test.ts`). *Rejected:* Serwist — its value is precache manifests
and strategy plumbing this design does not use.

**D2. Cache three page shapes, nothing else that carries data.**
`/schedule`, `/class/[id]`, `/studio-class/[id]` (the schedule's two card
links). Not `/schedule/past`, not `/students/*` (contact data), not edit
pages, not the inbox. *Rejected:* caching every visited teacher page — widens
the privacy surface for pages nobody needs in a basement.

**D3. Warm today's classes from the schedule; cache visited pages too.** A
schedule load asks the worker to fetch today's class and studio-class pages
(in the teacher's timezone) so the acceptance case — "opened the app earlier
today, can see each class's registered students" — holds without tapping into
each class. Each warm skips a page cached in the last 10 minutes. *Rejected:*
visit-only (fails the acceptance case); also warming tomorrow (more renders on
every schedule load for a case a morning app-open already covers — revisit if
teachers ask).

**D4. Network-first, always.** A cached page is served only when the network
request *fails*; there is no timeout racing a slow network against the cache,
so a slow-but-working connection always shows live data. *Rejected:*
stale-while-revalidate and cache-first — the issue rules both out.

**D5. Offline is detected by the page, not reported by the worker.** A client
component pings a new `GET /api/ping` (no auth, no database, `no-store`)
on mount, on `online`/`offline` events and on returning to the tab. A failed
ping or `navigator.onLine === false` shows the marker. A successful ping returns
server time; if the page's own render time is more than a minute behind it,
the page is a stale snapshot shown while online, and it calls
`router.refresh()`. Both times are the server's clock, so device clock skew
cannot trigger it. *Rejected:* having the worker inject a flag into cached HTML
(rewrites React-owned markup) or report via `postMessage` keyed on
`resultingClientId` (uneven Safari support). The ping also covers a page that
loaded live and lost its connection while open, which no worker-side flag
can see. `/api/health` was not reused: it runs two database queries.

**D6. Write controls are disabled by one `<fieldset disabled>`.** The page
content is wrapped; while offline, every descendant `<button>` is disabled
by the browser, which holds for any control added later without opting in.
Links still work and land on the offline page if uncached. *Rejected:* a
per-control `useOffline()` — every new control would have to remember it.
Known gap: a sheet already open when the connection drops renders in a portal
outside the fieldset; its request fails into the existing error handling.

**D7. Retention: 24 hours.** A stored page older than 24 hours is neither
served nor kept. Long enough for "loaded last night, teaching at 7"; short
enough that rosters do not accumulate on the device. The marker names the
day as well as the time when the snapshot is from an earlier day in the
teacher's timezone.

## 3. Design

### 3.1 Registration

A client component in `src/app/(teacher)/layout.tsx` registers `/sw.js`
(scope `/`) on mount, once per page load, where `serviceWorker` exists. Same
URL and scope as `enablePush`, so push and offline share one registration and
neither re-registers over the other. Students get no new registration; a
student who turned push on has the same worker, which caches none of their
pages (§3.2) but does give them the offline fallback page.

### 3.2 Request rules (`public/sw.js`)

Only `GET` is ever answered. In order:

1. **Document navigation to a cacheable path** (`request.mode === 'navigate'`,
   path matches D2): network first. A network response is returned to the
   page unchanged (streaming intact) and a clone goes to the store rule
   (§3.4). On network failure: the stored copy if one exists and is under
   24 hours old, else the offline page.
2. **Any other same-origin navigation:** network, and on failure the offline
   page. Never stored.
3. **`/_next/static/*`:** network first (normally the browser's HTTP cache,
   since these are immutable hashed files), a copy stored in the static
   cache; the stored copy only on failure. These hold no personal data. Without
   them a cached page would render as dead HTML with no marker, which §3.5
   needs JavaScript for.
4. **Everything else** — API routes, the SSE stream, RSC fetches, `/api/ping`,
   cross-origin requests — is not answered (`respondWith` is never called), so
   the browser handles it exactly as before this change.

### 3.3 Caches

| Cache | Holds | Cleared |
|---|---|---|
| `fy-pages-v1` | the three page shapes, each with a stored-at time and an owner | sign-out, a redirect on a teacher page, an owner change, 24 h age, a new worker version |
| `fy-static-v1` | `/_next/static/*` responses | entries over 24 h old, a new worker version |
| `fy-shell-v1` | `/offline` | a new worker version |

`/offline` is fetched into `fy-shell-v1` during `install`.

### 3.4 Binding the cache to the signed-in account

- **Owner marker.** The wrapper component (§3.5) renders
  `data-offline-owner="<accountId>"` in the page HTML. The store rule reads
  the response body, and **refuses to store a page that has no marker** —
  so only a page wrapped by §3.5 can ever be cached, whatever the path rule
  says. A stored page carries its owner; storing a page whose owner differs
  from the current one empties `fy-pages-v1` first. A second account signing
  in on the device therefore wipes the first's pages on its first load.
- **Redirect means signed out.** A cacheable-path request answered with a
  redirect (an `opaqueredirect` under `redirect: 'manual'`) empties
  `fy-pages-v1`: the proxy says the device has no valid teacher session (signed
  out, expired, revoked from another device).
- **Explicit sign-out** deletes `fy-pages-v1` from the page (`caches.delete`
  is available to windows) in `SignOutButton`, before it navigates.
- **Residual, stated:** a session revoked elsewhere while this device stays
  offline keeps its pages until the device next reaches the server. The person
  holding the device is the one who loaded them.

### 3.5 The snapshot wrapper and the marker

`OfflineSnapshot` (client) wraps the content of the three pages. Props:
the owner id, the render instant (server epoch ms), the load time preformatted
on the server in the teacher's timezone (clock, and day-plus-clock), the
teacher's local date and timezone, and — on the schedule only — the warm list.

- Renders the owner marker on its wrapper.
- While offline: shows **"Offline — showing what was loaded at HH:MM"** (or
  "… loaded Sat 3 Oct, 21:40" when the load date is not today in the
  teacher's timezone), and puts the content in `<fieldset disabled>`.
- On mount, online: posts `{ type: 'warm', paths }` to the active worker —
  its own path plus the warm list — so the page the worker could not yet
  control (the very first load) is stored too.
- Formatting happens on the server (`formatClockInZone`,
  `formatInstantInZone`): client components server-render in UTC, and both
  formatters import the server logger.

### 3.6 Deploys and updates

The worker's behaviour depends only on its own script, not on the app build:
pages are network-first, and static files are content-hashed, so a new app
build is picked up online on the next load with no worker change. Old static
entries age out at 24 hours. The worker itself updates the standard way: the
browser byte-compares `/sw.js` on navigation, bypassing the HTTP cache for the
main script. A changed worker calls `skipWaiting()` on install and
`clients.claim()` on activate, and `activate` deletes every `fy-*` cache not in
its current set, so a cache-format change ships as a version bump in the cache
names. No manual cache clear is ever needed.

### 3.7 The offline page

`/offline`, a static public page outside the proxy matcher: "You're offline,
and this page wasn't saved on this device." with a link to today's schedule.
It renders without JavaScript.

## 4. Testing

- **Worker (unit, `sw.test.ts`):** the harness gains injected `caches` and
  `fetch`; each request rule, the store refusals (no marker, non-200,
  redirect), owner change, 24-hour expiry, warm throttle, `activate` cleanup,
  and the SSE / API / RSC pass-through. The `'registers no fetch listener'`
  test is replaced, not deleted silently.
- **Wrapper and registration (components):** marker hidden online, shown on
  `offline` and on a failed ping, day form across dates, the fieldset
  disables a descendant button, stale-while-online calls `router.refresh()`,
  the warm message.
- **Ping route (integration).**
- **Sign-out clears the cache (components).**
- **End to end (Playwright, Chromium, worker allowed only in its own spec):**
  load the schedule, wait for the class page to be stored, go offline, open the
  class page and see the student name, the marker, a disabled button; open an
  uncached page and see `/offline`; sign out and see `fy-pages-v1` gone. The
  rest of the suite runs with `serviceWorkers: 'block'`, because `page.route`
  does not see worker-issued requests and several specs depend on it.
- **Every guard bites:** the plan carries a mutation per guard (marker refusal,
  redirect wipe, owner wipe, expiry, pass-through, fieldset).

## 5. Out of scope

- Queued offline check-in (#726).
- Navigation preload — a latency optimisation for network-first, measurable
  later.
- Caching any student-side page.
