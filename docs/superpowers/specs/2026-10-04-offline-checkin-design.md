# Queued offline check-in (#726)

Part of tracking issue #727. Builds on #725 (read-only offline: cached
`/schedule`, `/class/[id]`, `/studio-class/[id]`, the `OfflineSnapshot`
wrapper, the `offline-status` store). Attendance only; walk-ins stay out of
scope, as the issue says.

The three product decisions the issue asked for were made at the
brainstorming gate by the maintainer: payment-request wording (D7), how
check-in appears offline (D3), sign-out with pending writes (D8). An
adversarial review of the first draft (before any code) found one blocker —
synced rows would have reverted to "Not marked" on screen while the database
was right, and the planned e2e would have passed — and ten important gaps;
all are folded in below.

## 1. What the issue assumed, and what holds

Measured on `claude/compassionate-volta-7id7q6` at `dc30862`.

| Issue's premise | Measured |
|---|---|
| Every accepted attendance status is in `CHARGED_STATUSES`; a check-in never changes who is billed | **Holds.** `updateRegistrationSchema` accepts `attended`, `no_show`, `late_cancel` (`src/lib/schemas.ts`); `CHARGED_STATUSES` is `registered, attended, no_show, late_cancel` (`class-lifecycle.ts`). The PUT writes only `Registration.status` — no `Payment`, no `Class.totalRevenue`, no notification. |
| Attendance edits are allowed after completion, pinned by a test | **Holds.** `completed` is deliberately absent from the write's WHERE; `tests/integration/registrations-api.test.ts` "allows attendance corrections on a completed class". |
| "A status PATCH is naturally repeat-safe … confirm for every source→target pair" | **Holds, with the verb corrected (PUT) and one condition.** The queue must store the *absolute* target, never "toggle": the UI computes a toggle from what it displays (`attendance-list.tsx`), and a replayed toggle would flip twice. With an absolute target, a row already holding it answers `respondUnchanged` for every source. Refusals are registered 409s, but not all are permanent: `CLASS_NOT_STARTED` (a `late_cancel` row while the class is `open`) clears when the class flips to `in_progress`, up to a minute after the start, and `REGISTRATION_CANCELLED` can clear if the student re-books, since registration rows are reused (`waitlist.ts`). Neither is worth retrying automatically; the teacher sees the reason and can tap again (D5). |
| `recordedAt` on each outbox entry | **Has no server meaning.** The route reads no timestamp, version or precondition. Replay is last-write-wins, as two online devices are today. Entries carry a random `nonce` for in-flight comparison (D5) and `recordedAt` for display and ordering only. |
| The payment request's wording depends on status at completion | **Holds** (`studentPaymentRequestBody`, `src/lib/payment-request-copy.ts`), and nothing re-sends it. **And the online path already half-chose:** a completed class's "Edit attendance" shows "Corrections update the record — the payment request already sent stays as it is." |
| (implied) offline, the teacher has check-in controls to tap | **Wrong, twice.** (a) #725's D6 wraps every snapshot page in one `<fieldset disabled>` while offline; only a first `<legend>`'s content escapes one, which cannot hold a list. (b) The attendance list renders only from `CHECKIN_OPENS_MINUTES` (15) before the start (`classPageClock`, `src/lib/finish-window.ts`). #725 warms today's class pages when the schedule loads — normally hours earlier — so the cached page is the pre-check-in view: names, no controls. The basement case fails without D3. |
| Refusal → surface and drop; network failure → keep | **Incomplete.** A replay with an expired session answers 401 (`requireSession`, `api-utils.ts`). Dropping on 401 would discard what the teacher recorded. And a captive portal answers 200 with its own page: "2xx → drop" would delete queued check-ins at a hotel login screen (D5). |
| (not raised) whose writes are these | A device can change hands. Entries carry the account that made them, so a different account never replays or sees them (D6). |

## 2. Decisions

**D1. One write path: every tap goes through the outbox.** A tap writes the
entry and triggers a flush. Online, the flush runs at once and the row reads
as saved when the PUT answers, as today. Offline — or when the connection
drops mid-request, which today shows "Network error" — the entry stays queued.
*Rejected:* queue only when the status store says offline — two paths, and
the store can say online while a request fails.

**D2. `localStorage`, not IndexedDB.** Replay is page-driven (D4), so nothing
needs storage from the worker, where only IndexedDB exists. The data is tiny.
One key per registration (`fy-outbox:<accountId>:<registrationId>`) makes
every write a single `setItem` — no read-modify-write across entries — and the
`storage` event keeps other tabs current; the same tab is notified by the
module's own subscriber set, which the `storage` event does not reach. Read
through `useSyncExternalStore` with an empty server snapshot, so the first
render matches the server HTML and queued state appears after hydration.
Every access is in try/catch; where storage throws, a tap falls back to a
direct PUT and an error if it fails, never a silent queue. *Rejected:*
IndexedDB, as the issue named — async API, no dependency-free test path
(`fake-indexeddb` is a supply-chain addition), and nothing here needs it.
*Rejected:* the Background Sync API — not in iOS Safari, as the issue says.

**D3. Check-in opens on the device clock, one way.** An `open` class page
rendered before its check-in instant ships both views — "Registered students"
plus the pre-check-in `PricingPreview`, and the check-in block (attendance
list, walk-in, check-in `PricingPreview`) — and a client switch shows exactly
one. It starts on the server's choice (no clock read in the first render, so
hydration matches), then arms a timer to the check-in instant and re-checks on
returning to the tab. Once it has shown check-in it never switches back,
online or offline: reconnecting does not hide a list holding queued rows.
Online, `RefreshAt` re-renders at the same edge anyway and the server then
renders check-in itself. The device clock only decides what is displayed; the
server judges every write. *Rejected:* only pages loaded inside the window
work offline — fails the basement case; *rejected:* switching on connection
state — flips back to the stale view on reconnect.

**D4. Replay is driven by pages, at every chance.** An `OutboxSync` client
component in the teacher layout (beside `OfflineWorker`) flushes on mount
(full loads, including launch), on the `online` event, on `visibilitychange`
to visible, when the `offline-status` store goes from offline to online (its
15 s ping retry covers a reconnect with no event), and after every tap. The
layout does not remount on soft navigation; the tap and visibility triggers
cover that.

**D5. Flushing, and the outcome per response.** One flush at a time per tab
(a module-level promise; a trigger during a flush schedules one more pass),
and across tabs under `navigator.locks` where present. Without locks, two
tabs could each send a different target for one row; the in-flight nonce
check below keeps the newer local entry, which then sends last, so the newest
tap on the device wins either way. Entries go oldest first; the PUT uses
`redirect: 'error'` and a 10 s timeout.

| Response | Entry |
|---|---|
| 200 whose JSON body is `{data: {id, status}}` matching the entry, applied or `unchanged` | a confirmation is stored (§3), then the entry is removed, unless its nonce changed while in flight (a newer tap); the newer entry is sent next |
| 200 without that body (a captive portal, a proxy page) | kept; treated as a network failure |
| 409 `CONCURRENT_MODIFICATION`, or 500 whatever its body | kept and retried on the next flush; after 3 attempts, refused |
| any other 4xx except 401 and 429 | moved to *refused*, with the server's message |
| 401 | flush stops, everything kept, "Sign in again to sync N changes" |
| network failure, timeout, redirect, 429, 502/503/504, a non-JSON 4xx | flush stops, everything kept |

A 500 is per-entry, not flush-stopping, so one row the server keeps failing
on cannot block every later tap.

**D6. Entries belong to an account.** The key carries the account id, the same
owner #725's page cache uses (`offlineSnapshotStamp`). `OutboxSync` receives
it from the layout's session and, on mount, deletes every entry for any other
account. Every sign-out (teacher, student, signup) and account deletion clear
every outbox key whatever its owner, beside `clearOfflinePages()`.
Sign-in does not clear the outbox: a teacher whose session expired offline
signs in to sync (D5's 401 row). Every entry stores the student's display
name and the class label, because a refusal is usually discovered by a flush
running on the schedule, where neither is known — data the cached pages
already hold. A queued entry stays until it syncs or a clear runs; a refused
one expires after 7 days.

**D7. Payment wording: accept, and tell the teacher** (issue options 1 + 3,
decided at the gate). No new student message. The PUT's applied answer gains
`classCompleted: boolean`, read after the write (informational; the write's
WHERE is unchanged; completion is terminal, so it can only over-report a write
that landed just before completion, which is harmless). `respondUnchanged`'s
body is unchanged. Each entry records `knownCompleted` — whether the page it
was tapped on showed the class complete. When an applied write answers
`classCompleted: true` and its entry was not `knownCompleted`, the sync block
(§3) shows once per class: "Saved after <class label> finished — the payment
requests already sent stay as they are." This covers the offline replay and
the online tap that lands after auto-completion with one rule, as the issue
asked; the deliberate correction on a completed class already has its caption.

**D8. Sign-out: flush, then warn** (decided at the gate), on every sign-out a
teacher can reach with a session: the teacher settings page, the student
account page (a dual-hat account's other side, linked from its settings) and
the signup "Already teaching" panel. `SignOutButton` takes an optional
`outboxOwner`; with it, the order is flush (bounded at 5 s) → if anything is
still queued or refused, an inline confirm in the button's own place ("N
attendance changes haven't synced and will be lost." with "Sign out anyway"
and "Cancel"; focus moves to Cancel, and the copy is a polite status) → push
teardown → session DELETE → clears (D6). A student-only account's queue is
empty, so on the account page the flush sends nothing. Without an owner (the
profile setup form, which has no account id) only the clear is added. The
scope widened from the settings page alone after review: one login serves
both hats, and the account page's sign-out cleared a dual-hat teacher's
queue without a word.

**D9. The attendance list escapes the fieldset by structure, tethered by a
test.** `OfflineSnapshot` gains a `segmented` mode in which it renders no
fieldset of its own; the class page wraps its regions (header included) in an
exported `OfflineFieldset` (the same `<fieldset disabled={offline}>` and reset
classes) and leaves the attendance list between them. The schedule and studio
class pages are unchanged. Controls meant to work offline carry
`data-offline-writable`. The tether is the offline e2e: on the cached class
page offline, in both the check-in state (with Finish in the header) and the
completed state, every enabled `button`, `input`, `select` and `textarea` must
carry the attribute — a control added later outside a fieldset fails it.
*Rejected:* a non-`<button>` toggle immune to the fieldset — hand-rolled
keyboard handling for a native control; *rejected:* `useOffline()` per
control — #725 D6's reason stands.

## 3. Visible state

- **Row status is derived, not initialised.** Each row shows, in order: its
  queued entry's target; else a stored confirmation (`fy-outbox-confirmed:`,
  written by a sync in any tab or document, kept 24 h) whose `confirmedAt` —
  the server's `Date` header — is no earlier than the page's render, floored
  to the second; else the status the direct-write fallback saved on this page;
  else the `items` prop. A row never falls back to a server render older than
  its confirmation, a stored page hard-loaded offline included, and a render
  newer than the confirmation (another device's correction) wins.
- **Row markers:** a queued row shows "Waiting to sync" in place of the status
  label; a refused row shows the server's message in danger text with
  Dismiss. A queued write is never shown as saved.
- **Sync block:** its own element at the top of the three snapshot pages,
  visible online and offline whenever there is anything to say (the offline
  marker's status line is `sr-only` online, so it cannot carry this): "N
  changes waiting to sync"; refusals listing student, class and reason, each
  dismissable; "Sign in again to sync N changes" linking to
  `/login?redirect=<current path>`; D7's note.
- **Refresh:** none after a tap the list can show itself — offline, a failed
  RSC refresh becomes a hard reload of the cached page mid check-in. After a
  flush that applied replayed entries, online: one `router.refresh()`.

## 4. Testing

- **Outbox module (unit):** key shape, latest-wins per registration, owner
  purge, clear-all, refused expiry, storage-throws fallback, every D5 row
  against a mocked `fetch` — including a 200 portal body, "replaced while in
  flight is kept" by nonce, one flush at a time, the 3-attempt cap, a 500 not
  blocking later entries.
- **PUT route (integration):** `classCompleted` false on an in-progress class,
  true on a completed one; `unchanged` answers carry no flag; the existing
  matrix unchanged.
- **Acceptance (integration):** three attendance writes replayed after
  `completeClass` are accepted, and every `Payment.amount` and
  `Class.totalRevenue` is identical before and after; replaying the same three
  again answers `unchanged` three times and changes nothing.
- **Components:** `AttendanceList` derived row status (entry → confirmation
  no older than the render → fallback → prop, across a remount), queued and refused rows; `OutboxSync` triggers; the check-in switch
  before, at and after the instant, and never switching back; the sync block
  online; the completion note; `SignOutButton` with and without
  `outboxOwner`.
- **End to end (Playwright, offline spec opted into the worker, `page.clock`
  for the class instant):** load the schedule; go offline; open a warmed class
  whose check-in window opened after the warm; mark three students; see "3
  changes waiting to sync"; go online; reload; the counter clears, **each row
  reads Present**, and the server holds the three statuses. D9's tether in both
  states.
- **Every guard bites:** the plan carries a mutation per guard — toggle stored
  instead of target, 401 treated as refusal, portal 200 accepted, owner purge
  removed, in-flight replacement deleted, row state initialised from props,
  fieldset tether, clock switch reverting, `classCompleted` hard-coded.

## 5. Out of scope

- Walk-ins offline (as the issue says).
- Any other write offline: finish, publish, mark paid, announce, cancel stay
  disabled by the fieldset.
- Re-sending or correcting a payment request (D7).
