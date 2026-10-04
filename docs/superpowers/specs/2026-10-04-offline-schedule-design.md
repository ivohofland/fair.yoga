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
| The installed app opens on a cacheable page | **No.** `manifest.ts` sets `start_url: '/start'`, a redirect page, and both detail pages' back link is `/`, which redirects to `/schedule`. Neither is a page worth caching, so §3.2 rule 2 redirects them to the stored schedule when offline. |

An adversarial review of this spec's first draft (before any code) found two
gaps that each failed the acceptance case — warmed pages had no JavaScript
offline, and the installed app's launch URL landed on the offline page — and
one claim of mine that was false: there are no portals in `src/` (no
`createPortal`, no `<dialog>`), so sheets render inside the page and the
"open sheet escapes the fieldset" gap D6 once named does not exist.

## 2. Decisions

**D1. Hand-written worker, no dependency.** Serwist would add a build-plugin
dependency subject to `docs/supply-chain.md` (7-day release age,
`strictDepBuilds`, signature audit) for what is a handful of request rules and
three caches. The existing worker is hand-written and tested by evaluating the
script (`sw.test.ts`). *Rejected:* Serwist — its value is precache manifests
and strategy plumbing this design does not use.

**D2. Cache three page shapes, nothing else that carries data.**
`/schedule`, `/class/[id]`, `/studio-class/[id]` (the schedule's two card
links), with `new` excluded from the id segment and nothing deeper (no edit
pages). Not `/schedule/past`, not `/students/*` (contact data), not the inbox.
*Rejected:* caching every visited teacher page — widens the privacy surface
for pages nobody needs in a basement.

**D3. Warm today's classes from the schedule; cache visited pages too.** A
schedule load asks the worker to fetch today's class and studio-class pages
(in the teacher's timezone) so the acceptance case — "opened the app earlier
today, can see each class's registered students" — holds without tapping into
each class. A warm skips a page stored in the last 10 minutes or already being
stored. *Rejected:* visit-only (fails the acceptance case); also warming
tomorrow (more renders on every schedule load for a case a morning app-open
already covers — revisit if teachers ask).

**D4. Network-first, with a patience limit.** The network is always asked
first. The stored copy is served when the request fails, when it answers 502,
503 or 504 (a deploy or an outage), or when 8 seconds pass with no response
*and* a stored copy exists — one bar of signal in a basement would otherwise
show a blank screen until the OS gives up. A slow response that does arrive
still replaces the stored copy for next time. Whenever a stored copy is shown,
the marker (D5) says so. *Rejected:* stale-while-revalidate and cache-first,
which the issue rules out; and no timeout at all (the first draft), because
"stale and labelled" beats "blank" for a teacher at the door.

**D5. Offline is detected by the page, not reported by the worker.** One
client-side status store (`useSyncExternalStore`) is fed by
`navigator.onLine`, the `online`/`offline` events, and a ping to a new
`GET /api/ping` (no auth, no database, `no-store`, 5 s timeout) on mount, on
the `online` event, on returning to the tab, and every 15 s while offline.
A failed ping or `navigator.onLine === false` means offline; the latest ping
sent decides, so a slow earlier one cannot overrule a newer answer. A
successful ping returns server time; if the page's own render time is more
than a minute behind it, the page calls `router.refresh()` — at most once per
render, so it cannot loop. That is not a snapshot-only rule: pings fire only
on mount, on `online`, on tab return and on the offline retry, so a page left
open for more than a minute refreshes when the teacher returns to it, which is
intended, and it is also what recovers a refresh skipped while offline. Both
times are the server's clock, so device clock skew cannot trigger it. `RefreshAt` and `LiveUpdates` read the
same store and do not refresh while offline: offline, `router.refresh()` is a
hard reload (Next's failed-RSC fallback), so `RefreshAt` re-arming from a
snapshot's render time would otherwise reload the page on a timer.
*Rejected:* having the worker inject a flag into cached HTML (rewrites
React-owned markup) or report via `postMessage` keyed on `resultingClientId`
(uneven Safari support). The ping also covers a page that loaded live and lost
its connection while open, which no worker-side flag can see. `/api/health`
was not reused: it runs two database queries.

**D6. Write controls are disabled by one `<fieldset disabled>`.** The page
content is wrapped; while offline, every descendant `<button>` is disabled by
the browser, which holds for any control added later without opting in. Links
still work and land on the offline page if uncached. Because the browser
disables them and not the `disabled` prop, the disabled look must come from
the `:disabled` pseudo-class: `Button` (`src/components/ui/button.tsx`) and the
raw buttons on the three pages move their disabled styling to Tailwind's
`disabled:` variant, which matches both. The fieldset resets its UA styling
(`min-w-0`, no border, padding or margin). *Rejected:* a per-control
`useOffline()` — every new control would have to remember it.

**D7. Retention: 24 hours, and static files by reference.** A stored page
older than 24 hours is neither served nor kept, and expired pages are purged
whenever the worker runs (activate, message, a navigation to a cacheable path),
not only when read. A static file is kept while any stored page references it and deleted
when none does. Long enough for "loaded last night, teaching at 7"; short
enough that rosters do not accumulate on the device. The marker names the day
as well as the time when the snapshot is from an earlier day in the teacher's
timezone.

## 3. Design

### 3.1 Registration

A client component in `src/app/(teacher)/layout.tsx` registers `/sw.js`
(scope `/`) on mount where `serviceWorker` exists. Same URL and scope as
`enablePush`, so push and offline share one registration and neither
re-registers over the other. Students get no new registration; a student who
turned push on has the same worker, which stores none of their pages (§3.2)
but does give them the offline page.

### 3.2 Request rules (`public/sw.js`)

Only `GET` is ever answered. In order:

1. **Document navigation to a cacheable path** (`request.mode === 'navigate'`,
   path matches D2): network first per D4. A network response is returned to
   the page unchanged (streaming intact) and a clone goes to the store rule
   (§3.4). A redirect empties the page cache (§3.4). When the stored copy
   is not available, the offline page.
2. **Navigation to `/` or `/start` that fails** (D4's conditions): a redirect
   to `/schedule` when a servable stored schedule exists, else the offline
   page. Online, both behave exactly as before.
3. **Any other same-origin navigation:** network, and on failure the offline
   page. Never stored.
4. **`/_next/static/*`:** network first (normally the browser's HTTP cache,
   since these are immutable hashed files), falling back to the stored copy.
   These hold no personal data.
5. **Everything else** — API routes, the SSE stream, RSC fetches, `/api/ping`,
   cross-origin requests — is not answered (`respondWith` is never called), so
   the browser handles it exactly as before this change.

The offline page is a self-contained HTML string inside `sw.js` (inline styles
in the design tokens, no JavaScript): "You're offline, and this page wasn't
saved on this device." with a link to the schedule. Built into the worker, it
cannot fail to install or go stale against a later build's CSS. *Rejected:* a
Next `/offline` route precached at install — a failed precache fails the
install, which push's `ready` wait then times out on.

### 3.3 Caches and what is stored with each entry

| Cache | Holds | Cleared |
|---|---|---|
| `fy-pages-v1` | the three page shapes, keyed by pathname alone, each a rebuilt `Response` carrying `x-fy-owner` and `x-fy-stored-at` headers | clear message, a redirect on a cacheable path, an owner change, 24 h age, a cache-name version bump (the `-v1` suffix) |
| `fy-static-v1` | `/_next/static/*` responses | when no stored page references the file, a cache-name version bump (the `-v1` suffix) |
| `fy-meta-v1` | the clear generation (§3.4) | a cache-name version bump (the `-v1` suffix) |

An entry missing either header, or with one unparseable, is unservable and
deleted. Entries are keyed by pathname alone and rebuilt without `Vary`, so
`/class/x?from=inbox` finds `/class/x`. A stored page keeps the response's
security headers (CSP, framing and referrer policy) so it is served under the
policy it was rendered with.

**Storing a page pulls its static files.** When a page is stored, every
`/_next/static/…` URL in its body — `<script src>`, `<link href>` and the
flight payload's chunk references — is fetched into `fy-static-v1`. Those are
normally HTTP-cache hits. Without this, a warmed page (fetched as HTML only)
or a first-load page would hydrate offline against missing chunks: no marker,
live-looking buttons, or `error.tsx` replacing the roster.

### 3.4 Binding the cache to the signed-in account

- **Owner marker.** The wrapper (§3.5) renders `data-offline-owner="<id>"`
  in the page HTML. The store rule reads the body and **refuses to store a
  page without exactly one owner value** (the strict pattern matches only the
  attribute React writes; a name containing that text is escaped to `&quot;`
  and cannot match) — so only a wrapped page can be cached, whatever the path
  rule says. Storing a page whose owner differs from any stored entry's owner
  empties `fy-pages-v1` first.
- **Redirect means signed out.** A cacheable-path request answered with a
  redirect (`opaqueredirect` under `redirect: 'manual'`, for navigations and
  warms alike) empties `fy-pages-v1`: the proxy or the teacher layout says the
  device has no valid teacher session.
- **Explicit clears, from the page.** One client function,
  `clearOfflinePages()`, posts `{type: 'clear'}` to the worker and deletes
  `fy-pages-v1` itself. It runs on sign-out (after the session DELETE settles,
  whatever its result), on successful sign-in (every flow that completes one),
  and after account deletion. The worker, on `clear`, aborts in-flight warms and
  bumps a generation number in `fy-meta-v1`; every store reads the generation
  when its fetch starts and re-checks it immediately before `put`, so a warm
  that was in flight with the old cookie cannot repopulate the cache after a
  sign-out.
- **Residual, stated:** a session revoked elsewhere while this device stays
  offline keeps its pages until the device next reaches the server or a clear
  runs. The person holding the device is the one who loaded them.

### 3.5 The snapshot wrapper and the marker

`OfflineSnapshot` (client) wraps the content of the three pages. Props:
the owner id, the render instant (server epoch ms), the load time preformatted
on the server in the teacher's timezone (clock, and day-plus-clock), the
teacher's local date and timezone, and — on the schedule only — the warm list.

- Renders the owner marker on its wrapper.
- While offline (D5): shows **"Offline — showing what was loaded at HH:MM"**
  (or "… loaded Sat 3 Oct 21:40" when the load date is not today in the
  teacher's timezone), and puts the content in `<fieldset disabled>`.
- On mount, online: waits for `navigator.serviceWorker.ready` and posts
  `{type: 'warm', paths}` to the active worker — its own path plus the warm
  list — so the very first load, which the worker did not yet control, is
  stored too. The worker holds the warm under `waitUntil`.
- Formatting happens on the server (`formatClockInZone`,
  `formatInstantInZone`): client components server-render in UTC, and both
  formatters import the server logger.

### 3.6 Deploys and updates

The worker's behaviour depends only on its own script, not on the app build:
pages are network-first, and static files are content-hashed, so a new app
build is picked up online on the next load with no worker change; a stored
page keeps the static files it references until it is replaced or expires.
The worker itself updates the standard way: the browser byte-compares
`/sw.js` on navigation, bypassing the HTTP cache for the main script. A changed
worker calls `skipWaiting()` on install and `clients.claim()` on activate, and
`activate` deletes every `fy-*` cache not in its current set, so a
cache-format change ships as a version bump in the cache names. No manual cache
clear is ever needed.

## 4. Testing

- **Worker (unit, `sw.test.ts`):** the harness gains injected `caches` and
  `fetch`; each request rule, D4's three fallback conditions, the store
  refusals (no marker, two markers, non-200, redirect), owner change, the clear
  generation race, 24-hour expiry and purge, static extraction and
  reference pruning, the warm throttle, `activate` cleanup, and the SSE / API /
  RSC pass-through. The `'registers no fetch listener'` test is replaced.
- **Status store, wrapper and registration (components):** marker hidden
  online, shown on `offline` and on a failed ping, the day form across dates,
  the fieldset disables a descendant `Button` and it looks disabled, the
  stale-while-online refresh fires once, `RefreshAt` does not refresh while
  offline, the warm message.
- **Ping route (integration).**
- **Every clear site (components):** sign-out, each sign-in flow, account
  deletion.
- **End to end (Playwright, Chromium, production build in CI):** the offline
  spec opts into the worker; the rest of the suite runs with
  `serviceWorkers: 'block'` so its behaviour is unchanged by this PR (and
  `setOffline` only reaches worker fetches when the worker is allowed). Load
  the schedule, wait for a class page that was **never visited** to be stored,
  go offline, open it: student name, marker, a disabled button; open `/` and
  land on the schedule; open an uncached page and see the offline page; sign
  out and see `fy-pages-v1` empty.
- **Every guard bites:** the plan carries a mutation per guard (marker
  refusal, redirect wipe, owner wipe, clear generation, expiry, static
  extraction, pass-through, fieldset, offline refresh suppression).

## 5. Out of scope

- Queued offline check-in (#726).
- Navigation preload — a latency optimisation for network-first, measurable
  later.
- Caching any student-side page.
- Profile photos offline: an uploaded image is not a static file and shows as
  broken in a snapshot.
