# Queued offline check-in (#726)

Part of tracking issue #727, fourth in its order. Builds on #725 (read-only
offline: `public/sw.js`, `OfflineSnapshot`, `src/lib/offline-status.ts`).
Walk-ins offline stay out of scope, as the issue says.

Run without interaction at the user's request, so every gate below was decided
by the implementing session. The one product decision the issue left open, the
payment-request wording, was made by the user: **option 1, accept it** (D8).
Each other decision names the alternative it rejected.

## 1. What the issue assumed, and what holds

Measured on `feat/726-offline-checkin` off `origin/main` at `18eb8ad5`.

| Issue's premise | Measured |
|---|---|
| The attendance write is a status `PATCH` | **A `PUT`** (`src/app/api/registrations/[id]/route.ts`), body `{status}`; it writes `status` and nothing else. |
| "Every status the attendance write accepts is in `CHARGED_STATUSES`" | **Holds.** `updateRegistrationSchema` accepts `attended`, `no_show`, `late_cancel`; `CHARGED_STATUSES` (`class-lifecycle.ts`) is those three plus `registered`. |
| Attendance edits are allowed after completion, pinned by a test | **Holds.** `completed` is absent from the write's WHERE; pinned by `'allows attendance corrections on a completed class'` (`tests/integration/registrations-api.test.ts`). That test asserts the 200 and the status, not that money and messages are unchanged; §3 adds that. |
| A repeated status write is a no-op answered `respondUnchanged` | **Holds for every pair, after one refusal.** Sources `registered`/`attended`/`no_show`/`late_cancel`/`cancelled` × targets `attended`/`no_show`/`late_cancel`: a row already holding the target matches no row and the re-read answers unchanged — but the cancelled-class check comes first, so a duplicate replay to a class cancelled in between is refused `CLASS_CANCELLED`. Correct for a queue: the teacher should hear the class was cancelled. A cancelled booking on a live class is refused `REGISTRATION_CANCELLED`. |
| (implied) The class page offers check-in to a teacher at the door with no signal | **No, twice.** (a) `showCheckin` is decided at server render (`classPageClock`, `src/lib/finish-window.ts`: an `open` class shows check-in from 15 min before start). `RefreshAt` re-renders at that instant but skips the refresh while offline. #725 warms today's class pages when the schedule loads, so a page warmed in the morning holds the pre-check-in "Registered students" list and never gains the check-in list offline. (b) `OfflineSnapshot` wraps the whole page in one `<fieldset disabled>`, so even a check-in list in the snapshot has its buttons disabled. Both change: D2 and D3. |
| The outbox is IndexedDB | **Not needed.** Replay runs in the page, not the worker (iOS has no Background Sync, as the issue says), and only the worker would need IndexedDB. D4. |
| The wording problem "already happens online today" | **Holds.** A post-completion edit made online leaves the neutral request in place. The teacher editing a completed class is told so ("Corrections update the record — the payment request already sent stays as it is.", `attendance-list.tsx`); a teacher whose offline taps replay after completion tapped an unlocked check-in list and never saw that caption. |

An adversarial review of this spec's first draft (before any code) found the
design's worst gap — a write that synced elsewhere reverted on screen, because
`AttendanceList` seeds its state from props once — plus a cross-tab reorder, a
tap that could wait forever behind a flush in flight, and a sign-in that would
have wiped the writes the 401 rule keeps. Each is fixed below (D1, D5, D6, D7).

## 2. Decisions

**D1. One write path, online and offline.** Every attendance tap goes into the
outbox (replacing that registration's pending entry), then triggers a flush.
Online the flush runs at once. *Rejected:* direct fetch online, outbox only on
failure — two writers for one row reorder: a direct write can land before an
older queued write for the same registration, which then replays over it.

What a row shows is `pending ?? confirmed ?? prop`:
- **pending** — the outbox's entry for that registration, drawn with "Waiting
  to sync" beside it and never the plain status label;
- **confirmed** — a status a flush (in any tab) got a 2xx for, kept with the
  instant it was confirmed and used only while the page rendered before that
  instant; after that the server-rendered prop is authoritative. Confirmed
  entries older than 24 h are pruned;
- **prop** — the status the page was rendered with.

`AttendanceList` drops its local status state for this. A tap computes the next
status from what the row shows. What changes online: the inline "Network
error…" message is gone (a network failure is now "Waiting to sync"), and a
refusal of a row in the mounted list still shows inline in its `role="alert"`
and still refreshes the page, as today. A success does not refresh, as today.

**D2. The check-in list appears on the device clock.** On an `open`,
uncancelled class the page renders a client gate with the server's
`showCheckin` and the check-in instant. The gate shows the attendance list when
`serverShowCheckin || now >= checkinAt` — monotone, so a device clock behind the
server can never hide a list the server showed — and otherwise the "Registered
students" list. It re-evaluates on a timer and on `visibilitychange` (iOS
suspends timers), switching only after mount, so the first paint is the
server's and hydration matches. On `open` and `in_progress` the attendance list
is always rendered through the gate, at one tree position, so `RefreshAt`'s
re-render at the instant does not remount it. The walk-in form and the pricing
preview stay server-gated: walk-ins are not queued, and the preview is
server-computed. *Rejected:* warming class pages again at the check-in instant —
needs a device that is online at that moment, which is exactly what is missing.

**D3. The attendance region escapes the disabled fieldset, nothing else does.**
`OfflineSnapshot` gains optional `queueable` and `after` slots: `children` in a
disabled-while-offline fieldset, then `queueable` outside any fieldset, then
`after` in a second disabled-while-offline fieldset (same
`data-offline-fieldset` attribute, so `globals.css` styles it identically). On
the class page `queueable` is the attendance region and nothing else: the gate
on `open`/`in_progress`, the locked list on `completed`, absent on draft and
cancelled. The schedule and studio-class pages are unchanged. Every other
control keeps #725's default. The "Edit attendance" toggle is enabled offline:
it is local state, and the correction it opens is queued like any other.
*Rejected:* the first `<legend>` exemption (read out as the group's label); a
portal (cannot keep the visual position); a per-control offline prop (#725 D6's
reason).

**D4. Outbox in `localStorage`, behind one module.** Key `fy-outbox-v1`, one
JSON document: pending entries keyed by registration id, confirmed entries
(D1), refused entries (D6). A pending entry is `{ownerId, registrationId,
classId, studentName, status, recordedAt, id}`, `id` from
`crypto.randomUUID()` so two tabs can never mint the same one. `studentName` is
the name the page already shows, so a refusal can say who it was about off the
class page.

- **Reads** go through `useSyncExternalStore(subscribe, getSnapshot, () =>
  EMPTY)`: the server snapshot is empty (a page served from the worker's cache
  was rendered with no outbox), and `getSnapshot` returns a cached object that
  changes identity only on a write or a `storage` event.
- **Writes** are read-modify-write under `navigator.locks.request('fy-outbox',
  …)` where Web Locks exist (Safari 15.4+), so two tabs cannot lose each
  other's entries; without them a single tab is still correct.
- **Storage that throws** (private window, blocked) falls back to memory for
  that tab.
- **Clears** are its own, never `clearOfflinePages()`: that runs on every
  sign-in, and D7 keeps writes across a sign-in. Refused entries expire after
  7 days; pending entries do not expire (a replay is still a valid write).
- *Rejected:* IndexedDB — async with no gain here and a new test dependency
  (`fake-indexeddb`) under `docs/supply-chain.md`'s policy; one key per
  registration — the lock already serialises writes.

**D5. Flushing.** One flush at a time across tabs: the flush runs under a
second lock, `fy-outbox-flush` (a tap's storage write takes only the short
`fy-outbox` lock, so a tap never waits on another tab's request). Within a tab
a trigger that arrives during a flush sets a re-run flag, and the flush loops
until a pass ends with the flag clear. Each pass re-reads the outbox and sends
the current owner's entries one at a time, each `PUT` with a 10 s timeout.

Triggers, none of them Background Sync: mount of the teacher layout (every
teacher page, including one served from the worker's cache), a tap, the
browser's `online` event, the tab becoming visible, the connection store
(`offline-status.ts`) flipping from offline to online (driven by its 15 s
offline ping), and a backoff retry timer (5 s, 15 s, then every 60 s) that runs
while retryable entries remain and the tab is visible.

**D6. Replay outcomes.**

| Answer | Outcome |
|---|---|
| 2xx whose body is `{id, status}` matching what was sent (applied or unchanged) | drop the entry *only if it is still the entry that was sent* (same `id`) — a newer tap made during the request stays pending — and record it confirmed |
| 2xx with any other body, 409 `CONCURRENT_MODIFICATION`, 429, 5xx, timeout, network failure | keep; retry on the next trigger or timer |
| 401 | keep; stop this pass (every entry would get the same 401); the status line says to sign in to sync |
| 403 | drop, not surfaced: the only way the UI reaches it is a stored page of one account tapped under another account's cookie, and the refusal would show the first account's student name to the second |
| any other 4xx (404, 400, 409 `CLASS_CANCELLED` / `REGISTRATION_CANCELLED` / `CLASS_NOT_STARTED`) | move to refused with the server's message; never retried |

Refused, not retried, because the same request would be refused again:
`CLASS_CANCELLED`, `REGISTRATION_CANCELLED` and `NOT_FOUND` are terminal, and
`CLASS_NOT_STARTED` (a late-canceller marked present before start) is what the
teacher gets online too — the message says to record it once the class has
started, and they can. Refused entries are shown until dismissed or 7 days old.
A refusal of a row in the mounted list also refreshes the page (D1); nothing
else does, because `OfflineSnapshot` already refreshes a stale page on the first
successful ping. *Rejected:* retrying refusals with backoff.

**Last writer wins across devices**, stated: a replay from a phone hours later
overwrites a correction made on a laptop in between. The issue accepts that a
late replay is a correction; `recordedAt` is stored for display, not ordering.

**D7. Bound to the account; sign-out flushes, then warns.** Entries carry the
`ownerId` (`session.accountId`, the same id as `data-offline-owner`), which the
teacher layout supplies by context. A flush sends only the current owner's
entries and drops other owners' (they would 403). Sign-out considers *every*
entry on the device, whoever owns it, so `SignOutButton` needs no owner id at
any of its sites: it flushes (at most 3 s, as push teardown is bounded today);
if entries remain it shows "N attendance changes haven't synced yet. Signing out
discards them." and a "Sign out anyway" button. Signing out clears the outbox
in the same `finally` as `clearOfflinePages()`, whatever the session DELETE
returned — the teacher was told the entries would be discarded. Account
deletion clears it too. Sign-in does not: the same teacher signing back in after
a session expiry keeps their writes. *Rejected:* flush-only (sign-out offline
would hang or lose silently); warn-only (a needless prompt online).
**Residual:** a session that expires without a sign-out, followed by a
*different* account signing in on the same device, drops the first account's
unsynced writes; there was no sign-out to warn at.

**D8. Payment-request wording: option 1, accepted (user's decision).** A
status change after completion, online or replayed, changes the registration
and nothing else: no payment amount, no `Class.totalRevenue`, no second
message. A student marked `no_show` after completion keeps the neutral "Your
price for …" request; the amount is right and the wording is true. Only a
student marked before completion gets the no-show explanation. Documented in
`docs/technical-architecture.md` beside the offline section. *Rejected:* a
follow-up message (one more notification, against *no attention economy
patterns*) and a replay-time teacher notice.

**D9. What the teacher sees.** Text only, no badge, no motion, nothing that
moves the rows under a thumb.
- **Class page:** a pending row shows its queued status with "Waiting to sync".
  The Attendance heading row shows "N waiting to sync" on its right while this
  class has pending entries (in the heading's own line, so nothing shifts).
- **Every teacher page:** a status region in the teacher layout, *after* the
  page content, so it never pushes content down: "N attendance changes waiting
  to sync" (or "… sign in to sync them" after a 401) while the current owner has
  pending entries, and each refused entry: "Couldn't record <name> as <present /
  no-show / cancelled late>: <server message>", with a link to its class and a
  Dismiss button, in danger text.

## 3. Testing

- **Outbox module (unit, jsdom):** enqueue replaces per registration;
  id-guarded drop; each D6 row; confirmed overlay and its render-instant rule;
  owner filtering; memory fallback when storage throws; refused expiry; clear;
  stable snapshot identity.
- **Flush (unit):** single-flight with re-run (two taps, the second during the
  first's request, both reach the server in order); timeout; backoff timer;
  stop at 401; body validation.
- **AttendanceList (components):** a tap shows "Waiting to sync" until the
  flush confirms; a confirm made by another component keeps the row's new
  status with stale props; a pending entry reapplies after remount with no
  hydration warning; inline refusal + refresh kept; no refresh on success.
- **Check-in gate (components):** before/after the instant, monotone with the
  server flag, timer and visibility re-evaluation, server-first paint.
- **OfflineSnapshot (components):** offline, buttons in `children` and `after`
  are disabled and the `queueable` button is not.
- **Sign-out (components):** flush first; warning and a second button when
  entries remain; clear on confirmation whatever the DELETE returns; a sign-in
  completion leaves the outbox alone.
- **Integration:** after `completeClass`, a `no_show` PUT answers 200 and
  leaves every `Payment.amount`, `Class.totalRevenue` and the student's
  `payment_request` notification as they were, with no new notification. A
  repeated PUT answers unchanged.
- **End to end (extends `tests/e2e/offline.spec.ts`):** load a class page in
  check-in, go offline, mark three students, reload (served from the worker),
  see the three rows still "Waiting to sync" and "3 attendance changes waiting
  to sync", go online, see it clear and the server state match.
- **Every guard bites:** the plan carries a mutation per guard.

## 4. Out of scope

- Walk-ins offline (the issue's reasoning; needs a product decision).
- Any other write offline: finish, publish, cancel, payments.
- Background Sync, as a requirement (iOS).
- Safari-tab storage eviction: in a Safari tab (not the installed app),
  script-writable storage is evicted after 7 days without interaction. An entry
  that old has met every trigger above many times.
