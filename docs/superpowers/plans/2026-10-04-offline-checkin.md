# Queued Offline Check-in Implementation Plan (#726)

> **For agentic workers:** implement task by task with a review after each
> (subagent-driven development). Steps use checkbox (`- [ ]`) syntax.

**Goal:** A teacher can mark attendance (present / no-show, and the late-cancel
round trip) with no connection; each mark is queued on the device, shown as
waiting, and synced when the connection returns — never shown as saved before
the server says so, never lost to an expired session or a captive portal, and
never changing any amount.

**Architecture:** A framework-free outbox module in `src/lib/` stores one
`localStorage` key per registration and flushes them to the existing
`PUT /api/registrations/[id]`. An `OutboxSync` component in the teacher layout
drives flushes; a sync block in `OfflineSnapshot` shows what is queued,
refused or blocked. `AttendanceList` writes through the outbox and derives each
row from it. The class page escapes #725's fieldset by segmenting it, and
shows check-in on the device clock when the cached render predates the window.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest
(unit / components / integration), Playwright (Chromium).

**Spec:** `docs/superpowers/specs/2026-10-04-offline-checkin-design.md` — read
it before any task; this plan argues from it and cites its decisions as D1–D9.

## Global Constraints

- Node ^24.15 (the repo's `devEngines`); the container's default may be older.
  Integration and e2e tiers need the app and a database — bring them up per the
  `verify` skill, and never kill or restart a server already on :3000.
- No new dependency (spec D2).
- Exact values: key prefixes `fy-outbox:`, `fy-outbox-refused:`,
  `fy-outbox-note:` (each followed by `<accountId>:<id>`); flush request
  timeout 10 s; sign-out flush bound 5 s; retry cap 3 attempts; refused-entry
  expiry 7 days.
- Exact copy:
  - row: `Waiting to sync`
  - block: `1 change waiting to sync` / `N changes waiting to sync`;
    `1 change couldn't be saved` / `N changes couldn't be saved`;
    `Sign in again to sync 1 change` / `… N changes`;
    `Saved after <class label> finished — the payment requests already sent stay as they are.`
  - sign-out confirm: `1 attendance change hasn't synced and will be lost.` /
    `N attendance changes haven't synced and will be lost.`, buttons
    `Sign out anyway` and `Cancel`.
- `data-offline-writable` marks every control meant to work offline; nothing
  else sets it.
- TypeScript strict: no `any`, no widening casts. Comments annotate the code
  they sit on; no prose counts or rosters in comments (CLAUDE.md, Comment
  Discipline). Wider facts go in `docs/technical-architecture.md` (Task 7).
- Tests assert behaviour and registered error codes, never message strings
  produced by this code (the exact UI copy above is the exception: it is the
  spec).
- Stage exact paths; quote paths with parentheses. Never `git add -A`.
- Every commit message ends with the session's attribution lines.

## Review Focus

1. **A replayed toggle** — the outbox must hold the absolute target; a second
   flush of the same entry must answer `unchanged`, never flip it back.
   Pinned in Task 2 and the acceptance test in Task 1.
2. **Saved rows reverting on screen** — after a sync on a page rendered before
   it, every row must keep the synced status (spec §3, the review's blocker).
   Pinned in Task 4 and the e2e in Task 7.
3. **A captive portal or expired session deleting queued marks.** Pinned in
   Task 2.
4. **A control escaping the offline fieldset.** Pinned by the e2e tether in
   Task 7, in two class states.
5. **Hydration** — no client component reads `localStorage` or the clock in
   its first render. Pinned in Tasks 4 and 5 (server-snapshot tests).

## Task order

Tasks 1 and 2 are independent. Task 3 and Task 4 need Task 2's module. Task 5
needs Task 4 (the attribute and the props it adds). Task 6 needs Task 2.
Task 7 needs all of them. Run them in numeric order.

---

### Task 1: `classCompleted` on an applied attendance write

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts`
- Modify: `src/app/api/registrations/[id]/route.test.ts` if its mocks need
  the new read
- Modify: `tests/integration/registrations-api.test.ts`

**Behaviour (spec D7):** the applied branch (`respondTyped`) answers
`{ id, status, classCompleted }`, where `classCompleted` is
`class.status === 'completed'` read after the `updateMany`. The `unchanged`
branch keeps `{ id, status }`. Split the body types so the compiler holds that
(`AppliedAttendanceBody` / `AttendanceBody`). The write's WHERE and every
refusal are unchanged.

- [ ] Write failing integration tests in the "PUT … scoped by source status
  (#182)" describe: applied on an `in_progress` class answers
  `classCompleted: false`; applied on a `completed` class answers `true`; a
  repeated mark answers `outcome: 'unchanged'` with no `classCompleted` key.
- [ ] Write the failing **acceptance** test (spec §4): a class with three
  charged registrations is completed through `completeClass`; record every
  `Payment.amount` and `Class.totalRevenue`; PUT three attendance targets
  (two `no_show`, one `attended`); all three answer 200; amounts and revenue
  are identical; PUT the same three again: three `unchanged`, amounts still
  identical.
- [ ] Implement; see the tests pass; run the route's unit test.
- [ ] **Prove it bites:** hard-code `classCompleted: false`; record the
  failing test name and assertion text; restore.
- [ ] Commit: `feat: an applied attendance write says whether its class had completed (#726)`.

### Task 2: The attendance outbox module

**Files:**
- Create: `src/lib/attendance-outbox.ts`
- Create: `src/lib/attendance-outbox.test.ts` (unit project, `node`
  environment: stub `localStorage`, `window` (an `EventTarget`), `navigator`
  and `fetch` with `vi.stubGlobal`, as `src/lib/offline-status.test.ts` does)

**Interfaces (produced):**

```ts
export type AttendanceTarget = 'attended' | 'no_show' | 'late_cancel';

export interface OutboxEntry {
  registrationId: string;
  classId: string;
  classLabel: string;
  studentName: string;
  target: AttendanceTarget;
  nonce: string;          // crypto.randomUUID()
  recordedAt: number;     // epoch ms, display and ordering only
  attempts: number;
  knownCompleted: boolean;
}

export interface RefusedEntry extends OutboxEntry { message: string; refusedAt: number }
export interface CompletionNote { classId: string; classLabel: string }

export interface OutboxSnapshot {
  queued: readonly OutboxEntry[];
  refused: readonly RefusedEntry[];
  notes: readonly CompletionNote[];
  needsSignIn: boolean;
  /** Statuses a flush confirmed during this page's lifetime, by registration id. */
  confirmed: Readonly<Record<string, AttendanceTarget>>;
}

export function enqueueAttendance(owner: string, entry: Omit<OutboxEntry, 'nonce' | 'recordedAt' | 'attempts'>): 'queued' | 'unavailable';
export function flushOutbox(owner: string): Promise<{ applied: number }>;
export function subscribeOutbox(listener: () => void): () => void;
export function getOutboxSnapshot(owner: string): OutboxSnapshot;  // stable object until a change
export const EMPTY_OUTBOX: OutboxSnapshot;                         // the server snapshot
export function dismissRefused(owner: string, registrationId: string): void;
export function dismissNote(owner: string, classId: string): void;
export function purgeOtherOwners(owner: string): void;
export function clearAllOutboxes(): void;                          // every fy-outbox* key, any owner
export function pendingCount(owner: string): number;               // queued + refused
export function resetOutboxForTests(): void;
```

**Behaviour:**
- Keys and values per Global Constraints; values are JSON with a version
  field; an unparseable or wrong-shaped value is deleted on read.
- `enqueueAttendance` replaces any queued entry for that registration (latest
  wins, new nonce, attempts 0) and removes any refused entry for it. It
  returns `'unavailable'` when storage throws, and the caller then writes
  directly (Task 4).
- Same-tab listeners are notified by the module; other tabs via the `storage`
  event (filtered to the prefixes).
- `flushOutbox` (spec D5): one flush per tab at a time — a call during a flush
  returns the running promise and schedules one more pass after it; across
  tabs inside `navigator.locks.request('fy-outbox', …)` when `locks` exists.
  Entries oldest first. PUT with `redirect: 'error'`,
  `signal: AbortSignal.timeout(10_000)`, JSON body `{ status: target }`.
  The D5 table, row for row:
  - 200 with `data.id === registrationId` and `data.status === target` →
    delete the entry if its nonce is unchanged; record `confirmed`; when
    `outcome` is absent and `data.classCompleted === true` and the entry was
    not `knownCompleted`, write a note for its class.
  - 200 without that body, any network error, abort, redirect error, 429,
    502/503/504, non-JSON → stop the flush, keep everything.
  - 409 `CONCURRENT_MODIFICATION` or 500 → `attempts + 1`; at 3 move to
    refused (message from the body, else a fixed fallback); continue.
  - 401 → set `needsSignIn`, stop, keep everything. A later flush that gets
    any 2xx clears `needsSignIn`.
  - other 4xx → refused with the server's message; continue.
- `getOutboxSnapshot` also drops refused entries older than 7 days.

- [ ] Write failing tests for each bullet above, one `it` per D5 row, plus:
  latest-wins; a nonce replaced while the PUT is in flight keeps the new entry
  and sends it in the same flush's next pass; two concurrent `flushOutbox`
  calls produce one PUT per entry; a 500 on entry A does not stop entry B;
  owner purge leaves the current owner's keys; `clearAllOutboxes` removes all
  three prefixes for every owner and nothing else; storage throwing →
  `'unavailable'`; a stored value with a garbage shape is deleted.
- [ ] Implement; see them pass.
- [ ] **Prove each guard bites** (break, record the failing test, restore):
  store the toggle instead of the target (have the test enqueue twice and
  check the body); treat 401 as refused; accept any 200; delete on success
  without comparing nonce; drop the per-tab single-flight.
- [ ] Commit: `feat: an attendance outbox that queues marks and replays them (#726)`.

### Task 3: `OutboxSync` and the sync block

**Files:**
- Create: `src/components/layout/outbox-sync.tsx` (+ `.test.tsx`)
- Create: `src/components/layout/sync-status.tsx` (+ `.test.tsx`)
- Modify: `src/app/(teacher)/layout.tsx` — render `<OutboxSync owner={session.accountId} />` beside `OfflineWorker`
- Modify: `src/components/layout/offline-snapshot.tsx` (+ its test) — render
  `<SyncStatus owner={ownerId} />` above the offline marker

**Behaviour:**
- `OutboxSync` (spec D4): on mount `purgeOtherOwners(owner)` then
  `flushOutbox(owner)`; again on `online`, on `visibilitychange` to visible,
  and when `useConnectionStatus().offline` goes true → false. When a flush
  reports `applied > 0` and the connection store says online, one
  `router.refresh()`. Renders nothing.
- `SyncStatus` (spec §3): reads the snapshot through `useSyncExternalStore`
  with `EMPTY_OUTBOX` as the server snapshot. Renders nothing when there is
  nothing to say; otherwise a visible block (not `sr-only`, online or offline)
  with the copy from Global Constraints: the waiting count, the refused list
  (student, class label, message, Dismiss with `data-offline-writable`), the
  sign-in line linking to `/login?redirect=<encoded current path>`, and each
  completion note with Dismiss. Design tokens per `docs/design-brief.md`:
  attention uses gold tint, refusals use danger text, no new colours.

- [ ] Failing component tests: each trigger calls flush exactly once per
  event; refresh only after an applied flush while online; the block renders
  nothing for `EMPTY_OUTBOX` and the server render; each section with
  singular and plural copy; Dismiss calls the module; visible when the
  connection store says online.
- [ ] Implement; pass; update `offline-snapshot.test.tsx` for the new child.
- [ ] **Prove it bites:** remove the offline→online trigger; remove the
  `applied > 0` condition on refresh. Record and restore each.
- [ ] Commit: `feat: sync queued attendance from every teacher page and show what is waiting (#726)`.

### Task 4: `AttendanceList` writes through the outbox

**Files:**
- Modify: `src/components/class/attendance-list.tsx` (+ its test)
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx` — pass the new props

**New props:** `owner` (account id), `classId`, `classLabel` (preformatted on
the server: class type plus day and start time in the teacher's timezone,
using the existing zone formatters), `completed` (the class status is
`completed`; the existing `locked` keeps its meaning).

**Behaviour:**
- A tap computes the target exactly as today (the late-cancel round trip
  included) from the row's **derived** status, calls `enqueueAttendance`
  (`knownCompleted: completed`), then `flushOutbox`. On `'unavailable'`, the
  old direct PUT path stays as the fallback, error handling unchanged.
- Derived row status (spec §3): queued entry's target → `confirmed[id]` →
  the `items` prop. Remove the `useState` copy of statuses.
- Queued row: label replaced by `Waiting to sync`. Refused row: its message in
  danger text and Dismiss. Neither reads `localStorage` in the first render
  (server snapshot is `EMPTY_OUTBOX`).
- The toggle and "Edit attendance" carry `data-offline-writable`.
- Taps never call `router.refresh()` (spec §3); the in-flight `updating`
  disable stays for the direct-PUT fallback only.

- [ ] Failing component tests: a tap enqueues the absolute target and the row
  shows `Waiting to sync`; when the flush confirms, the row shows the target
  even though `items` still says `registered` (the blocker); the late-cancel
  round trip from a queued `attended` goes back to `late_cancel`; a refused
  row shows its message; the first render ignores storage; no
  `router.refresh` on tap; the `'unavailable'` fallback still PUTs directly.
- [ ] Implement; pass.
- [ ] **Prove it bites:** reintroduce the `useState` initialised from
  `items` and update it only on tap; record the failing blocker test; restore.
- [ ] Commit: `feat: attendance taps go through the outbox and rows show what is queued (#726)`.

### Task 5: The class page offline — segmented fieldset and the check-in switch

**Files:**
- Modify: `src/components/layout/offline-snapshot.tsx` (+ test) — export
  `OfflineFieldset`; add `segmented?: boolean`
- Create: `src/components/class/checkin-switch.tsx` (+ `.test.tsx`)
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx`
- Modify: `tests/integration/class-page-offline-marker.test.ts` if markup
  assertions move

**Behaviour:**
- `OfflineFieldset`: the existing `<fieldset data-offline-fieldset
  disabled={offline} className="m-0 min-w-0 border-0 p-0">`, reading the same
  connection store. `OfflineSnapshot` without `segmented` is unchanged; with
  it, children render without a wrapping fieldset.
- Class page (spec D9): `segmented`; header, info and captions in one
  `OfflineFieldset`; the attendance list outside any; walk-in, pricing,
  payments and actions in fieldsets after it. Every control except the
  attendance list's stays inside a fieldset.
- `CheckinSwitch` (spec D3), client, props `checkinAt` (ISO), `initial`
  (`'before' | 'checkin'`), `before: ReactNode`, `checkin: ReactNode`.
  First render shows `initial`. After mount, if `initial` is `'before'`: arm
  a timeout to `checkinAt` and check on `visibilitychange` to visible; when
  `Date.now() >= checkinAt`, switch to `checkin` and never back. Renders only
  the chosen node.
- The page renders `CheckinSwitch` for a live `open` class whose
  `showCheckin` is false: `before` = registered-students list + pre-check-in
  `PricingPreview`; `checkin` = the check-in block (attendance list outside
  any fieldset, walk-in and check-in `PricingPreview` inside one). Other states
  render as today.

- [ ] Failing tests: `CheckinSwitch` before/at/after the instant, the timer
  path, the visibility path, never switching back, first render equals
  `initial` (render to string); `OfflineFieldset` disables a descendant
  button offline; `segmented` renders no fieldset of its own.
- [ ] Implement; pass; run the class-page integration tests.
- [ ] **Prove it bites:** make the switch read `Date.now()` in its first
  render (the server-render test fails); let it switch back when the clock is
  set earlier. Record and restore each.
- [ ] Commit: `feat: the class page lets attendance through offline and opens check-in on the device clock (#726)`.

### Task 6: Sign-out and account deletion

**Files:**
- Modify: `src/components/account/sign-out-button.tsx` (+ test)
- Modify: `src/app/(teacher)/settings/(overview)/page.tsx` — pass `outboxOwner={session.accountId}`
- Modify: `src/components/account/data-and-deletion.tsx` (+ test)

**Behaviour (spec D6, D8):**
- Every `SignOutButton` calls `clearAllOutboxes()` beside `clearOfflinePages()`
  in its `finally`.
- With `outboxOwner`: before anything else, `flushOutbox` raced against 5 s;
  then if `pendingCount(owner) > 0`, show the inline confirm (Global
  Constraints copy) in the button's place and stop; "Sign out anyway"
  continues with push teardown → DELETE → clears; "Cancel" restores the
  button. Without it, behaviour is today's plus the clear.
- Account deletion calls `clearAllOutboxes()` where it calls
  `clearOfflinePages()`.

- [ ] Failing tests: clear on every sign-out (with and without owner, and
  when the DELETE fails); flush before the DELETE; confirm shown with pending
  entries and no DELETE sent; "Sign out anyway" proceeds; "Cancel" sends
  nothing; no confirm when the flush empties the queue; deletion clears.
- [ ] Implement; pass.
- [ ] **Prove it bites:** move the clear out of `finally` into the success
  path (the failed-DELETE test fails). Record and restore.
- [ ] Commit: `feat: sign-out syncs or warns about unsynced attendance and clears the queue (#726)`.

### Task 7: End to end and the architecture doc

**Files:**
- Create: `tests/e2e/offline-checkin.spec.ts` (Chromium only, worker
  allowed, the same production-build and time-of-day guards as
  `tests/e2e/offline.spec.ts`)
- Modify: `docs/technical-architecture.md` — extend "Offline (service
  worker)" with the outbox: where it lives, the D5 table, ownership and
  clears, and why the class page is segmented

**Scenario A — the acceptance case (spec §4):** seed a teacher and today's
class with three registered students, its start far enough out that the warm
happens before the check-in window. Load `/schedule` online; wait for the class
page to be stored. With `page.clock`, move past the check-in instant; go
offline; open the class page: the offline marker and the attendance list (the
switch) are shown. Mark all three; see `3 changes waiting to sync`. Go online;
reload; the block disappears, **each row reads `Present`**, and the database
holds `attended` for all three. Reconnect and reload twice more: still three
`attended`, no extra writes (count PUTs with `page.on('request')`).

**Scenario B — the fieldset tether (spec D9), in two states.** (1) A class
already in its finish window (started, end within 15 minutes), loaded online
so the header renders `CompleteClassButton`; go offline: every enabled
`button, input, select, textarea` carries `data-offline-writable`, and the
Finish button is disabled. (2) The same class after `completeClass`, loaded
online, offline, "Edit attendance" tapped: the same assertion.

- [ ] Write the spec; run it against a production build; record the result.
- [ ] **Prove the tether bites:** move `PageHeader` out of its fieldset
  (Scenario B(1) fails: Finish is enabled); record the failure; restore.
- [ ] Update the architecture doc; grep it for any sentence #725 wrote that
  this change falsifies ("nothing is written while offline", "every write
  control is disabled") and correct it in place.
- [ ] Commit: `test: offline check-in end to end, and document the outbox (#726)`.

## Whole-branch checks before the PR

- `pnpm run verify` green; record per-project counts.
- `pnpm run build` succeeds.
- `pnpm exec playwright test tests/e2e/offline.spec.ts tests/e2e/offline-checkin.spec.ts` against a production build.
- `git grep -n "nothing is written while offline\|Network error. Please check your connection" -- src docs` — each hit updated or legitimately historical.
- `git grep -n "fy-outbox" -- src` — every prefix is defined once, in `attendance-outbox.ts`.
