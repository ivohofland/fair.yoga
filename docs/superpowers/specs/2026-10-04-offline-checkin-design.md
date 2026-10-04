# Queued offline check-in (#726)

Part of tracking issue #727. Builds on #725 (read-only offline: cached
`/schedule`, `/class/[id]`, `/studio-class/[id]`, the `OfflineSnapshot`
wrapper, the `offline-status` store). Attendance only; walk-ins stay out of
scope, as the issue says.

The three product decisions the issue asked for were made at the
brainstorming gate by the maintainer: payment-request wording (D7), how
check-in appears offline (D3), sign-out with pending writes (D8).

## 1. What the issue assumed, and what holds

Measured on `claude/compassionate-volta-7id7q6` at `dc30862`.

| Issue's premise | Measured |
|---|---|
| Every accepted attendance status is in `CHARGED_STATUSES`; a check-in never changes who is billed | **Holds.** `updateRegistrationSchema` accepts `attended`, `no_show`, `late_cancel` (`src/lib/schemas.ts`); `CHARGED_STATUSES` is `registered, attended, no_show, late_cancel` (`class-lifecycle.ts`). The PUT writes only `Registration.status` — no `Payment`, no `Class.totalRevenue`, no notification. |
| Attendance edits are allowed after completion, pinned by a test | **Holds.** `completed` is deliberately absent from the write's WHERE; `tests/integration/registrations-api.test.ts` "allows attendance corrections on a completed class". |
| "A status PATCH is naturally repeat-safe … confirm for every source→target pair" | **Holds, with the verb corrected (PUT) and one condition.** The queue must store the *absolute* target, never "toggle": the UI computes a toggle from what it displays (`attendance-list.tsx`), and a replayed toggle would flip twice. With an absolute target: a row already holding it answers `respondUnchanged` for every source; every other outcome is a registered 409 that is permanent for the request as sent (`CLASS_CANCELLED`, `REGISTRATION_CANCELLED`, `CLASS_NOT_STARTED` for a `late_cancel` row while the class is `open`), except `CONCURRENT_MODIFICATION`, which is a race and retryable. |
| `recordedAt` on each outbox entry | **Has no server meaning.** The route reads no timestamp, version or precondition. Replay is last-write-wins, exactly as two online devices are today. `recordedAt` is kept for local ordering and display only. |
| The payment request's wording depends on status at completion | **Holds** (`studentPaymentRequestBody`, `src/lib/payment-request-copy.ts`), and nothing re-sends it. **And the online path already half-chose:** a completed class's "Edit attendance" shows "Corrections update the record — the payment request already sent stays as it is." |
| (implied) offline, the teacher has check-in controls to tap | **Wrong, twice.** (a) #725's D6 wraps every snapshot page in one `<fieldset disabled>` while offline; a descendant cannot opt out. (b) The attendance list renders only from `CHECKIN_OPENS_MINUTES` (15) before the start (`classPageClock`, `src/lib/finish-window.ts`). #725 warms today's class pages when the schedule loads — normally hours earlier — so the cached page is the pre-check-in view: names, no controls. The basement case fails without D3. |
| Refusal → surface and drop; network failure → keep | **Incomplete.** A replay with an expired session answers 401. Dropping on 401 would discard what the teacher recorded; it is neither refusal nor network failure (D5). |
| (not raised) whose writes are these | A device can change hands. Entries must carry the teacher who made them, so a different account never replays or sees them (D6). |

## 2. Decisions

**D1. One write path: every tap goes through the outbox.** A tap writes the
entry, updates the row, and triggers a flush. Online, the flush runs at once
and the row reads as saved when the PUT answers, as today. Offline — or when
the connection drops mid-request, which today shows "Network error" — the
entry simply stays queued. *Rejected:* queue only when the status store says
offline — two paths, and the store can say online while a request fails.

**D2. `localStorage`, not IndexedDB.** Replay is page-driven (D4), so nothing
needs storage from the worker, where only IndexedDB exists. The data is a few
hundred bytes. One key per registration
(`fy-outbox:<teacherId>:<registrationId>`) makes every write a single
`setItem` — no read-modify-write across entries for two tabs to race — and
the `storage` event keeps other tabs' rows current for free. jsdom has
`localStorage`, so the logic is unit-testable without a fake. Every access is
in try/catch; where storage throws, a tap falls back to a direct PUT and an
error if it fails, never a silent queue. *Rejected:* IndexedDB, as the issue
named — async API, no dependency-free test path (`fake-indexeddb` is a
supply-chain addition), and nothing here needs it. *Rejected:* the Background
Sync API — not in iOS Safari, as the issue says.

**D3. Offline, check-in opens on the device clock.** An `open` class page
whose check-in window has not yet opened ships both views — the "Registered
students" list and the check-in block (attendance list; walk-in and pricing
preview stay in the disabled region) — and a client switch picks one. Online
it shows the server's choice (`RefreshAt` already re-renders at the edge).
Offline it shows check-in once `Date.now()` passes the check-in instant the
server rendered. The device clock only decides what is displayed; the server
judges every write when it lands, and the PUT has no time guard except
`CLASS_NOT_STARTED` for a late-cancel row. *Rejected:* only pages loaded
inside the window work offline — fails the basement case.

**D4. Replay is driven by pages, at every chance.** An `OutboxSync` client
component in the teacher layout (beside `OfflineWorker`) flushes on mount
(launch and every page load), on the `online` event, on `visibilitychange` to
visible, when the `offline-status` store goes from offline to online (its
15 s ping retry covers a reconnect with no event), and after every tap.
`navigator.locks` (where present) serialises flushes across tabs; without it,
a duplicate PUT answers `respondUnchanged`, so the lock saves requests, not
correctness.

**D5. Outcome per response.**

| Response | Entry |
|---|---|
| 2xx (`respondTyped` or `respondUnchanged`) | removed — only if it was not replaced by a newer tap while in flight (compare `recordedAt`); a replaced entry is flushed next |
| 409 `CONCURRENT_MODIFICATION` | kept; after 3 attempts, refused |
| other 4xx except 401 and 429 (400, 403, 404, the other 409 codes) | moved to *refused*, carrying the server's message |
| 401 | flush stops, everything kept, "Sign in again to sync N changes" |
| 429, 5xx, network failure, timeout | flush stops, everything kept |

The flush walks entries oldest first and stops at the first network-shaped
failure rather than burning through the queue offline.

**D6. Entries belong to a teacher.** The key carries the teacher id;
`OutboxSync` receives it from the layout's session. On mount it deletes every
outbox and refused entry for any other teacher id, mirroring #725's owner
wipe. A refused entry stores the student's display name and the class label
so the message is legible on the schedule; that is the same data the cached
pages already hold on the device, and it is cleared on the same occasions.

**D7. Payment wording: accept, and tell the teacher** (issue options 1 + 3,
decided at the gate). No new student message. The PUT's success body gains
`classCompleted: boolean`, read after the write (informational; the write's
own WHERE is unchanged). When an applied write — not `unchanged` — answers
`classCompleted: true` and the page did not already know the class was
complete, the teacher sees, once per class: "Saved after the class finished —
the payment requests already sent stay as they are." This covers the offline
replay and the online tap that lands after auto-completion alike, so both
paths get one rule, as the issue asked. The existing caption on a completed
class's "Edit attendance" already says the same for the deliberate
correction path.

**D8. Sign-out: flush, then warn** (decided at the gate). `SignOutButton`
runs a flush first (bounded at 5 s). If anything is still pending or refused,
it asks "N attendance changes haven't synced and will be lost. Sign out
anyway?" before continuing. Sign-out then clears every outbox key for that
teacher, beside `clearOfflinePages()`; account deletion does the same.
Sign-in does not clear the outbox: a teacher whose session expired offline
signs in to sync (D5's 401 row), and D6 handles a different account.

**D9. The attendance list escapes the fieldset by structure, tethered by a
test.** `OfflineSnapshot` gains a `segmented` mode in which it renders no
fieldset of its own; the class page wraps its regions in an exported
`OfflineFieldset` (the same `<fieldset disabled={offline}>`, same reset
classes) and leaves `AttendanceList` between them. The schedule and studio
class pages are unchanged. The tether is the offline e2e: on the cached class
page offline, every enabled `<button>` must carry `data-offline-writable`,
which only the attendance list's controls set — a control added later outside
a fieldset fails it. *Rejected:* a non-`<button>` toggle immune to the
fieldset — trades a native control for hand-rolled keyboard handling;
*rejected:* reading `useOffline()` per control — #725 D6's reason stands.

## 3. Visible state

- **Row:** a queued row shows its queued status and the caption "Waiting to
  sync" in place of the status label; a refused row shows the server's
  message in danger text with a Dismiss control. A queued write is never
  shown as saved.
- **Page:** inside `OfflineSnapshot`'s status area on all three pages, while
  the outbox is non-empty: "N changes waiting to sync"; with refusals: "N
  changes couldn't be saved" listing student, class and reason, each
  dismissable; with a 401: "Sign in again to sync N changes" linking to
  `/login?redirect=<current path>`. The schedule is where a teacher reopening
  the app lands, so the counter is visible there per the acceptance case.
- **After a flush that applied anything, online:** `router.refresh()`, so the
  page shows the server's state.

## 4. Testing

- **Outbox module (unit):** key shape, latest-wins per registration, owner
  purge, storage-throws fallback, every D5 row against a mocked `fetch`
  (including "replaced while in flight is kept"), stop-at-first-network-failure,
  the 3-attempt cap, lock-absent path.
- **PUT route (integration):** `classCompleted` false on an in-progress class,
  true on a completed one; the existing matrix unchanged.
- **Acceptance (integration):** three attendance writes replayed after
  `completeClass` are accepted, and every `Payment.amount` and
  `Class.totalRevenue` is byte-identical before and after; replaying the same
  three again answers `unchanged` three times and changes nothing.
- **Components:** `AttendanceList` queued and refused rows, `OutboxSync`
  triggers, the check-in switch on both sides of the instant, offline and
  online, the completion note, `SignOutButton` flush-then-confirm and clear.
- **End to end (Playwright, offline spec opted into the worker):** load the
  schedule; go offline; open a warmed class whose check-in window opened after
  the warm; mark three students; see "3 changes waiting to sync"; go online;
  reload; the counter clears and the server holds the three statuses; every
  enabled button on the offline class page carries `data-offline-writable`
  (D9's tether).
- **Every guard bites:** the plan carries a mutation per guard — toggle stored
  instead of target, 401 treated as refusal, owner purge removed, in-flight
  replacement deleted, fieldset tether, clock switch inverted,
  `classCompleted` hard-coded.

## 5. Out of scope

- Walk-ins offline (as the issue says).
- Any other write offline: finish, publish, mark paid, announce, cancel stay
  disabled by the fieldset.
- Re-sending or correcting a payment request (D7).
