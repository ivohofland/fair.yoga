# Queued Offline Check-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can mark attendance while offline; the marks are queued on the device and replayed when the connection returns (#726).

**Architecture:** A `localStorage` outbox (`src/lib/attendance-outbox.ts`) holds pending, confirmed and refused attendance writes, read through `useSyncExternalStore`. A sync engine (`src/lib/attendance-sync.ts`) replays pending writes as the existing `PUT /api/registrations/[id]`, single-flight under a Web Lock, on every trigger the page can see. Every tap — online too — goes through the outbox. The class page lets the attendance region escape #725's disabled fieldset and reveals the check-in list on the device clock.

**Tech Stack:** Next.js 16 App Router, React 19 (`useSyncExternalStore`), TypeScript strict, Vitest (unit = node, components = jsdom), Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-offline-checkin-design.md` — read it before your task; decisions are cited as D1–D9.

## Global Constraints

- TypeScript `strict`, no `any`, no `as` casts to widen a type (parse unknown JSON with type guards).
- Outbox storage key: `fy-outbox-v1`. Web Lock names: `fy-outbox` (storage read-modify-write), `fy-outbox-flush` (replay).
- API shapes (measured, `src/lib/api-utils.ts`): success is `{ data: { id, status } }`, an unchanged answer `{ data: { id, status }, outcome: 'unchanged' }`; a refusal is `{ error: { message, code } }`, read with `readError(res, fallback)` (`src/lib/client-errors.ts`), which returns `{ code?, message }` in one read.
- Lint (measured): `react-hooks/set-state-in-effect` is active (no synchronous `setState` in an effect body); `@typescript-eslint/no-unused-vars` ignores only `_`-prefixed *arguments* — no unused destructured variables.
- Module singletons: every test file touching the outbox or sync engine runs `beforeEach(() => { localStorage.clear(); resetOutboxForTests(); resetSyncForTests(); })` and uses `vi.useRealTimers()` in `afterEach` when it used fake ones.
- jsdom (measured): `navigator.locks` is absent (stub with `Object.defineProperty(navigator, 'locks', { value, configurable: true })`, delete in `afterEach`); `crypto.randomUUID` and `StorageEvent` work; `AbortSignal.timeout` is NOT driven by fake timers.
- PUT timeout 10 s (a module-local `timeoutSignal(ms)` on `AbortController` + `setTimeout`, never `AbortSignal.timeout`); backoff retry delays 5 s, 15 s, then 60 s repeating; sign-out flush waits at most 3 s.
- Confirmed entries pruned after 24 h; refused entries after 7 days; pending entries never expire.
- Copy, verbatim: "Waiting to sync"; "N waiting to sync" (Attendance heading); "N attendance change(s) waiting to sync" / "… — sign in to sync them"; "Couldn't record <name> as <present | no-show | cancelled late>: <server message>"; sign-out warning "N attendance change(s) haven't synced yet. Signing out discards them." with button "Sign out anyway". Singular when N = 1 ("1 attendance change hasn't synced yet.").
- Design: text only, no badges, no motion, no shadows; danger colour for text only; `type-*` styles only. Nothing the sync adds may move the attendance rows (D9).
- Comment Discipline (CLAUDE.md): comments describe the code they sit on; no counts or rosters in comments; no history ("previously…").
- Every refusal stays the server's own words (`readErrorMessage`, `src/lib/client-errors.ts`).
- Component tests stub `fetch` with `vi.stubGlobal`; `next/navigation` is mocked per file as `attendance-list.test.tsx` does.
- A file under `src/lib/*.test.ts` runs in node; one that needs `window`/`localStorage` starts with `// @vitest-environment jsdom`.

## Review Focus

1. **Two taps on one row while the first is in flight** (attended, then no-show): the server must end on no-show and the row must not show "attended" afterwards. → Task 2 test "a tap during a flush is sent after it, in order"; Task 4 test "second tap before the first confirms".
2. **A page reloaded from the worker's cache while entries are pending**: the rows reapply "Waiting to sync" with no hydration warning. → Task 4 test "pending entry reapplies after remount without a hydration error".
3. **localStorage holding garbage** (a hand-edited or older-format value): the outbox reads as empty for the bad parts, never throws into render. → Task 1 test "malformed stored JSON reads as empty".
4. **A flush whose PUT hangs** (iOS suspends the app mid-request): the next trigger still flushes. → Task 2 test "a hung request times out and the entry is retried".
5. **Sign-out while offline with pending entries**: the warning appears, "Sign out anyway" clears the outbox even though the session DELETE fails. → Task 6 test "sign out anyway clears whatever the DELETE returns".

---

### Task 1: The outbox store

**Files:**
- Create: `src/lib/attendance-outbox.ts`
- Modify: `src/lib/registration-status.ts` (gains `export type AttendanceStatus`), `src/components/class/attendance-list.tsx` (re-exports it instead of defining it)
- Test: `src/lib/attendance-outbox.test.ts` (first line `// @vitest-environment jsdom`)

**Interfaces:**
- Produces (exact):
  ```ts
  export type QueuedStatus = 'attended' | 'no_show' | 'late_cancel';
  export interface PendingEntry {
    id: string; ownerId: string; registrationId: string; classId: string;
    studentName: string; status: QueuedStatus; recordedAt: number;
  }
  export interface ConfirmedEntry { status: QueuedStatus; confirmedAt: number }
  export interface RefusedEntry extends PendingEntry { message: string; refusedAt: number }
  export interface OutboxState {
    pending: Readonly<Record<string, PendingEntry>>;   // keyed by registrationId
    confirmed: Readonly<Record<string, ConfirmedEntry>>; // keyed by registrationId
    refused: Readonly<Record<string, RefusedEntry>>;   // keyed by registrationId
  }
  export const EMPTY_OUTBOX: OutboxState;
  /** `at` is the server's clock (the response's `Date` header), so it compares with the page's server-side `renderedAt`. */
  export type Settlement = { kind: 'confirmed'; at: number } | { kind: 'refused'; message: string } | { kind: 'dropped' };
  export function getOutbox(): OutboxState;
  export function subscribeOutbox(listener: () => void): () => void;
  export function useOutbox(): OutboxState;
  export function enqueueAttendance(input: Omit<PendingEntry, 'id' | 'recordedAt'>): Promise<PendingEntry>;
  export function settleEntry(sent: PendingEntry, settlement: Settlement): Promise<void>;
  export function dismissRefused(registrationId: string): Promise<void>;
  export function clearOutbox(): Promise<void>;
  export function shownStatus(outbox: OutboxState, registrationId: string, rendered: AttendanceStatus, renderedAt: number): { status: AttendanceStatus; pending: boolean };
  export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T>;
  export function resetOutboxForTests(): void;
  ```
  `AttendanceStatus` (`Exclude<RegistrationStatus, 'cancelled'>`) moves from `attendance-list.tsx` into `src/lib/registration-status.ts` (exported there; `attendance-list.tsx` re-exports it so its importers are untouched) — nothing in `src/lib` imports from `src/components`. `QueuedStatus` is derived from the server's schema, not restated: `import type { updateRegistrationSchema } from '@/lib/schemas'; export type QueuedStatus = z.infer<typeof updateRegistrationSchema>['status'];`.

- [ ] **Step 1: Write the failing tests.** In `src/lib/attendance-outbox.test.ts`, `beforeEach(() => { localStorage.clear(); resetOutboxForTests(); })`. Tests, each a separate `it`:
  - `enqueue replaces the pending entry for the same registration` — enqueue `{registrationId:'r1', status:'attended'}` then `{… status:'no_show'}`; `Object.keys(getOutbox().pending)` is `['r1']` and its status is `no_show`, and the two entries' `id`s differ.
  - `settle drops the entry only when it is still the one that was sent` — `a = enqueue(attended)`, `b = enqueue(no_show)`, `settleEntry(a, {kind:'confirmed', at: 1000})`; pending `r1` is still `b`. Then `settleEntry(b, {kind:'confirmed', at: 2000})`; pending is empty and `confirmed.r1.status === 'no_show'`.
  - `a refusal moves the entry to refused with the server message` — `settleEntry(a, {kind:'refused', message:'This booking was cancelled…'})`; pending empty, `refused.r1.message` equals it, `refused.r1.studentName` kept.
  - `dropped removes without recording` — pending, confirmed, refused all empty for `r1`.
  - `dismissRefused removes one refusal`.
  - `clearOutbox empties everything and storage`.
  - `state persists through storage and is re-read after a reset` — enqueue, `resetOutboxForTests()` (clears the in-memory cache, not storage), `getOutbox().pending.r1` still present.
  - `getOutbox returns the same object until a write` — two calls `toBe` each other; after an enqueue, a new object.
  - `a storage event for the key refreshes the snapshot and notifies` — subscribe a `vi.fn()`; write a valid document directly with `localStorage.setItem('fy-outbox-v1', …)`; `window.dispatchEvent(new StorageEvent('storage', { key: 'fy-outbox-v1' }))`; listener called, `getOutbox()` reflects it.
  - `malformed stored JSON reads as empty` — `localStorage.setItem('fy-outbox-v1', '{not json')` → `getOutbox()` equals `EMPTY_OUTBOX` in content; then a document whose pending `r1` is fully well-formed except `status: 'bogus'` (`{ id:'x', ownerId:'a', registrationId:'r1', classId:'c', studentName:'n', status:'bogus', recordedAt:1 }`) → pending empty; then a well-formed entry stored under a key other than its `registrationId` → dropped; no throw.
  - `confirmed older than 24 h and refused older than 7 days are pruned on read` — use `vi.useFakeTimers()` / `vi.setSystemTime`.
  - `storage that throws falls back to memory` — `vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); })`; enqueue still resolves and `getOutbox().pending.r1` is present.
  - `shownStatus: pending wins, then a confirmation newer than the render, then the rendered status` — three cases; a confirmation with `confirmedAt < renderedAt` is ignored.
  - `withLock runs the function when navigator.locks is absent` and `withLock uses navigator.locks.request when present` (stub with `Object.defineProperty(navigator, 'locks', { value: { request: vi.fn((name: string, fn: () => unknown) => fn()) }, configurable: true })`, delete it in `afterEach`, assert called with the name).

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run src/lib/attendance-outbox.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement.** Reference implementation:

```ts
import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import type { updateRegistrationSchema } from '@/lib/schemas';
import type { AttendanceStatus } from '@/lib/registration-status';

export type QueuedStatus = z.infer<typeof updateRegistrationSchema>['status'];
// … interfaces exactly as in the Interfaces block …

const KEY = 'fy-outbox-v1';
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;
const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Tethered to the schema: a status added there fails to compile here until it is listed. */
const QUEUED = { attended: true, no_show: true, late_cancel: true } satisfies Record<QueuedStatus, true>;

export const EMPTY_OUTBOX: OutboxState = Object.freeze({ pending: {}, confirmed: {}, refused: {} });

/** Used when `localStorage` throws (private window, blocked storage): this tab only. */
let memory: string | null = null;
let useMemory = false;
let cached: OutboxState | null = null;
const listeners = new Set<() => void>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isQueued(v: unknown): v is QueuedStatus {
  return typeof v === 'string' && Object.hasOwn(QUEUED, v);
}
function asPending(v: unknown): PendingEntry | null {
  if (!isRecord(v)) return null;
  const { id, ownerId, registrationId, classId, studentName, status, recordedAt } = v;
  if (typeof id !== 'string' || typeof ownerId !== 'string' || typeof registrationId !== 'string'
    || typeof classId !== 'string' || typeof studentName !== 'string' || !isQueued(status)
    || typeof recordedAt !== 'number') return null;
  return { id, ownerId, registrationId, classId, studentName, status, recordedAt };
}
// asConfirmed / asRefused in the same shape.

function readRaw(): string | null {
  if (useMemory) return memory;
  try { return localStorage.getItem(KEY); } catch { useMemory = true; return memory; }
}
function writeRaw(value: string | null): void {
  if (!useMemory) {
    try {
      if (value === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, value);
      return;
    } catch { useMemory = true; }
  }
  memory = value;
}

/** Parses what is stored, keeping only well-formed, unexpired entries. Never throws. */
function parse(raw: string | null, now: number): OutboxState {
  // JSON.parse in try/catch → EMPTY_OUTBOX on failure; each map filtered through
  // its guard; for pending and refused the key must equal the entry's
  // registrationId (confirmed entries carry no id); prune by TTL.
}

export function getOutbox(): OutboxState {
  if (cached === null) cached = parse(readRaw(), Date.now());
  return cached;
}
function commit(next: OutboxState): void {
  writeRaw(JSON.stringify(next));
  cached = next;
  listeners.forEach((l) => l());
}
function onStorage(e: StorageEvent): void {
  if (e.key !== KEY && e.key !== null) return;
  cached = null;
  listeners.forEach((l) => l());
}
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}
export function useOutbox(): OutboxState {
  return useSyncExternalStore(subscribeOutbox, getOutbox, () => EMPTY_OUTBOX);
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(name, fn) : fn();
}

/** Read-modify-write against a fresh read, so another tab's write is never lost. */
async function update(change: (current: OutboxState) => OutboxState): Promise<void> {
  await withLock('fy-outbox', async () => {
    cached = null;
    commit(change(getOutbox()));
  });
}

export async function enqueueAttendance(input: Omit<PendingEntry, 'id' | 'recordedAt'>): Promise<PendingEntry> {
  const entry: PendingEntry = { ...input, id: crypto.randomUUID(), recordedAt: Date.now() };
  await update((s) => ({ ...s, pending: { ...s.pending, [entry.registrationId]: entry } }));
  return entry;
}

export async function settleEntry(sent: PendingEntry, settlement: Settlement): Promise<void> {
  await update((s) => {
    if (s.pending[sent.registrationId]?.id !== sent.id) return s; // a newer tap replaced it
    const pending = { ...s.pending };
    delete pending[sent.registrationId];
    switch (settlement.kind) {
      case 'confirmed':
        return { ...s, pending, confirmed: { ...s.confirmed, [sent.registrationId]: { status: sent.status, confirmedAt: settlement.at } } };
      case 'refused':
        return { ...s, pending, refused: { ...s.refused, [sent.registrationId]: { ...sent, message: settlement.message, refusedAt: Date.now() } } };
      case 'dropped':
        return { ...s, pending };
      default: {
        const unreachable: never = settlement;
        throw new Error(`unhandled settlement: ${JSON.stringify(unreachable)}`);
      }
    }
  });
}
// dismissRefused (through `update`), clearOutbox (under the same `fy-outbox`
// lock as `update`: writeRaw(null); cached = EMPTY_OUTBOX; notify), shownStatus, resetOutboxForTests (cached = null; memory = null; useMemory = false; listeners.clear(); remove the storage listener).
```

  `shownStatus`: `pending[id]` → `{status, pending:true}`; else `confirmed[id]` with `confirmedAt >= renderedAt` → `{status, pending:false}`; else `{status: rendered, pending:false}`.

  Note `navigator.locks` exists in TypeScript's DOM lib as `LockManager`; if the project's `lib` setting lacks it, type it locally rather than casting.

- [ ] **Step 4: Run tests** — PASS. Then `pnpm run typecheck` (or `pnpm exec tsc --noEmit`) — clean.

- [ ] **Step 5: Prove the guards bite.** Each, one at a time; record the failing test's name and message; restore; re-run green; confirm `git status` shows only your intended files:
  - In `settleEntry`, delete the `id !== sent.id` check → "settle drops the entry only when it is still the one that was sent" must fail.
  - In `parse`, skip the `isQueued` guard → "malformed stored JSON reads as empty" must fail.
  - In `shownStatus`, use `>` 0 instead of `confirmedAt >= renderedAt` (i.e. always use confirmed) → the shownStatus test must fail.
  - Remove the `catch { useMemory = true; }` in `writeRaw` → the throwing-storage test must fail.

- [ ] **Step 6: Commit** `src/lib/attendance-outbox.ts`, `src/lib/attendance-outbox.test.ts` — `feat: attendance outbox store (#726)`.

---

### Task 2: The sync engine

**Files:**
- Create: `src/lib/attendance-sync.ts`
- Test: `src/lib/attendance-sync.test.ts` (`// @vitest-environment jsdom`)

**Interfaces:**
- Consumes (Task 1): `getOutbox`, `settleEntry`, `withLock`, `PendingEntry`, `Settlement`, `resetOutboxForTests`, `enqueueAttendance`.
- Consumes (#725): `subscribeConnectionStatus`, `getConnectionStatus` from `src/lib/offline-status.ts`; `readError`, `logRequestFailure` from `src/lib/client-errors.ts`.
- Produces (exact):
  ```ts
  export type ReplayOutcome = Settlement | { kind: 'retry' } | { kind: 'signed_out' };
  export function sendAttendance(entry: PendingEntry): Promise<ReplayOutcome>;
  /** `null` sends every pending entry whoever owns it (sign-out); an owner id sends that owner's and drops the rest unsent. */
  export function flushAttendance(ownerId: string | null): Promise<void>;
  export function startAttendanceSync(ownerId: string): () => void;
  export interface SyncState { needsSignIn: boolean }
  export function useSyncState(): SyncState;
  export function resetSyncForTests(): void;
  ```

**Behaviour (spec D5, D6):**
- `sendAttendance` PUTs `/api/registrations/${entry.registrationId}` with JSON `{status}` and a module-local `timeoutSignal(10_000)` (an `AbortController` aborted by a `setTimeout` with `new DOMException('attendance write timed out', 'TimeoutError')`; clear the timer once the fetch settles). Classify:
  - `res.ok` and the JSON body is `{ data: { id, status } }` with `data.id === entry.registrationId && data.status === entry.status` (with or without `outcome: 'unchanged'`) → `{ kind: 'confirmed', at }`, where `at` is `Date.parse(res.headers.get('date'))` when that is a finite number, else `Date.now()`. `res.ok` with any other body, or a body that fails to parse → `{ kind: 'retry' }`.
  - 401 → `signed_out`; 403 → `dropped`; 429 → `retry`; `>= 500` → `retry`.
  - Any other status: `const { code, message } = await readError(res, 'Could not record attendance.')`; `code === 'CONCURRENT_MODIFICATION'` → `retry`, otherwise `{ kind: 'refused', message }`.
  - A thrown fetch (network, timeout) → `retry`; log with `logRequestFailure('attendance-sync', { registrationId: entry.registrationId, status: entry.status }, err)` unless it was the timeout abort. Never throws.
- `flushAttendance(scope)`:
  - Single-flight per tab. A call while a flush runs records its scope and returns the running promise; the running flush loops `do { … } while (rerun)`, and a rerun's scope is the widest requested since the last pass (`null` wins over an owner id; two different owner ids widen to `null`).
  - Each pass runs under `withLock('fy-outbox-flush', …)`, reads `getOutbox().pending` fresh, and for each entry, in `recordedAt` order: `scope !== null && entry.ownerId !== scope` → `settleEntry(entry, { kind: 'dropped' })` without a request; else `outcome = await sendAttendance(entry)`; `confirmed` / `refused` / `dropped` → `settleEntry(entry, outcome)`; `signed_out` → set `needsSignIn = true`, end the pass; `retry` → leave it.
  - A pass that got any 2xx sets `needsSignIn = false`.
  - After the loop: if any entry got `retry` and `document.visibilityState === 'visible'`, arm the backoff timer for the next delay of 5 s, 15 s, then 60 s repeating, calling `flushAttendance` with the last owner scope; a flush that ends with nothing retried resets the step and clears the timer.
- `startAttendanceSync(ownerId)` flushes once at once and on: `window` `online`; `document` `visibilitychange` to visible; a connection-status change from `offline: true` to `offline: false` (subscribe with `subscribeConnectionStatus`, compare with the previous `getConnectionStatus().offline`). Returns a stop function removing every listener, unsubscribing and clearing the timer.
- `useSyncState` is `useSyncExternalStore` over a stable `{needsSignIn}` object, server snapshot `{ needsSignIn: false }`.

- [ ] **Step 1: Write the failing tests.** Helpers: `ok(data, extra = {})` → `new Response(JSON.stringify({ data, ...extra }), { status: 200, headers: { 'content-type': 'application/json', date: new Date(5_000_000).toUTCString() } })`; `refusal(status, code, message)` → `new Response(JSON.stringify({ error: { message, code } }), { status, headers: { 'content-type': 'application/json' } })`. Tests:
  - `classifies every answer` — table-driven: `ok({id:'r1', status:'attended'})` → confirmed with `at` from the Date header; the same plus `{outcome:'unchanged'}` → confirmed; `ok({id:'other', status:'attended'})` → retry; a 200 with body `'not json'` → retry; 401 → signed_out; 403 → dropped; `refusal(409,'CONCURRENT_MODIFICATION',…)` → retry; `refusal(409,'REGISTRATION_CANCELLED','This booking was cancelled…')` → refused with that message; `refusal(404,'NOT_FOUND',…)` → refused; `refusal(400, undefined, …)` → refused; 429 → retry; 503 → retry; fetch rejects → retry.
  - `confirmed drops the entry and records the confirmation at the server's clock`.
  - `an owner flush drops other owners' entries without a request`.
  - `a null flush sends every owner's entries` — entries for `acct-B` and `acct-A`; B answers 403, A answers ok → both requested, nothing pending, A confirmed.
  - `stops the pass at the first 401 and reports needsSignIn` — two entries, first answers 401; fetch called once; `needsSignIn` true; both pending. A later flush answering ok clears it.
  - `a tap during a flush is sent after it, in order` — the first fetch returns a promise you resolve by hand; while pending, `enqueueAttendance(no_show)` for the same registration and call `flushAttendance('acct-1')` again; resolve the first with `ok({id:'r1', status:'attended'})`; await the first call's promise; fetch called twice, the second body `{"status":"no_show"}`, pending empty, `confirmed.r1.status === 'no_show'`.
  - `a hung request times out and the entry is retried` — fake timers; a fetch that never settles except by rejecting on its `signal`'s `abort`; advance 10 s; the entry is pending; advance 5 s → fetch called a second time.
  - `retries on a backoff while retryable entries remain` — 503 forever: calls at 0, +5 s, +15 s, +60 s, +60 s.
  - `startAttendanceSync flushes on start, online, visible, and reconnect` — mock `@/lib/offline-status` with a controllable subscribe/get pair; four separate assertions.
  - `stop removes every trigger` — after stop, `online`, `visibilitychange` and a reconnect cause no fetch.
- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run src/lib/attendance-sync.test.ts`.
- [ ] **Step 3: Implement** to the behaviour above.
- [ ] **Step 4: Run tests, `pnpm run lint`, typecheck** — PASS, clean.
- [ ] **Step 5: Prove the guards bite** (record each failing test name; restore; `git status` shows only your files):
  - Run one pass only (no rerun loop) → "a tap during a flush is sent after it, in order" fails.
  - Map `CONCURRENT_MODIFICATION` to refused → the classify table fails.
  - Map 403 to refused → the classify table fails.
  - Read `id`/`status` at the top level of the body instead of under `data` → the classify table fails.
  - Remove the 401 end-of-pass → "stops the pass at the first 401" fails.
  - Make a `null` scope behave as "drop everything not owned by the first entry's owner" → "a null flush sends every owner's entries" fails.
- [ ] **Step 6: Commit** — `feat: attendance sync engine with single-flight replay (#726)`.

---

### Task 3: Sync provider and status region in the teacher layout

**Files:**
- Create: `src/components/layout/attendance-sync-status.tsx` — exports `AttendanceSyncProvider`, `AttendanceSyncStatus`, `useAttendanceOwner(): string | null`, `useInlineRefusals(classId: string): void`.
- Modify: `src/app/(teacher)/layout.tsx`
- Test: `src/components/layout/attendance-sync-status.test.tsx`

**Interfaces:**
- Consumes: `startAttendanceSync`, `useSyncState` (Task 2); `useOutbox`, `dismissRefused`, `RefusedEntry`, `QueuedStatus` (Task 1).
- Produces: `<AttendanceSyncProvider ownerId={string}>{children}</AttendanceSyncProvider>` — client component; provides `ownerId` and an inline-refusals registry by context and, in an effect, calls `startAttendanceSync(ownerId)`, returning its stop function. `useAttendanceOwner()` reads the owner (null outside a provider). `useInlineRefusals(classId)` registers, for the life of the calling component, that refusals for `classId` are shown inline (Task 4 calls it); the registry is a set of class ids held in provider state, updated from the hook's effect (add on mount, remove on cleanup — a subscription callback, not a synchronous `setState` in the effect body if lint objects; use a ref-held `Set` plus a version counter set from the cleanup/registration functions). `<AttendanceSyncStatus />` — the region of spec D9's second bullet. Also export a `refusalLine(entry: RefusedEntry): string` helper (Task 4 uses it).
- Tests of later tasks render through `AttendanceSyncProvider` with `vi.mock('@/lib/attendance-sync', async (orig) => ({ ...(await orig<typeof import('@/lib/attendance-sync')>()), startAttendanceSync: () => () => {} }))`.

**Behaviour:**
- Layout: `<AttendanceSyncProvider ownerId={session.accountId}>{children}<AttendanceSyncStatus /></AttendanceSyncProvider>` between `OfflineWorker` and `TabBar`. The root layout (`src/app/layout.tsx`) already sets the 640 px column and `TabBar` adds its own in-flow spacer, so the region needs no container of its own beyond vertical padding.
- `AttendanceSyncStatus` renders nothing when this owner has no pending and no shown refusals. Otherwise:
  - the owner's pending count → `<p role="status" className="type-caption">N attendance change(s) waiting to sync</p>`, with " — sign in to sync them" appended when `needsSignIn`;
  - each refusal of this owner whose `classId` is not in the inline registry: `refusalLine(entry)` = `Couldn't record ${studentName} as ${word}: ${message}` in `type-caption text-danger`, a `Link` "Open class" to `/class/${classId}`, and a `button` "Dismiss" calling `dismissRefused(registrationId)`. `word` from an exhaustive `switch` over `QueuedStatus` with a `never` default: `attended → present`, `no_show → no-show`, `late_cancel → cancelled late`.
- [ ] **Step 1: Failing tests:** the provider starts sync with the owner and stops it on unmount; hidden when empty; singular and plural copy; the sign-in suffix when `needsSignIn` (mock `useSyncState`); another owner's entries not counted and their refusals not shown; refusal copy and Dismiss removes it; a refusal for a class with a mounted `useInlineRefusals(classId)` consumer is not shown, and it shows again once that consumer unmounts; a refusal for a class with no consumer shows.
- [ ] **Step 2–4:** fail, implement, pass; lint; typecheck.
- [ ] **Step 5: Mutations:** drop the owner filter → the other-owner test fails; skip the registry check → the mounted-consumer test fails; never unregister → the unmount test fails.
- [ ] **Step 6: Commit** — `feat: attendance sync provider and status in the teacher layout (#726)`.

---

### Task 4: AttendanceList on the outbox

**Files:**
- Modify: `src/components/class/attendance-list.tsx`, `src/components/class/attendance-list.test.tsx`
- Modify: `src/components/layout/offline-snapshot.test.tsx` (its check-in test renders `AttendanceList`; render it through `AttendanceSyncProvider` with the new props so the suite stays green — Task 5 rewrites that test)
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx` (pass the new props only; Task 5 restructures the page)
- Modify: `tests/e2e/teacher-journey.spec.ts` (the attendance tap: wait for the PUT, see Behaviour)

**Interfaces:**
- Consumes: `useOutbox`, `getOutbox`, `enqueueAttendance`, `shownStatus`, `dismissRefused` (Task 1); `flushAttendance` (Task 2); `useAttendanceOwner`, `useInlineRefusals`, `refusalLine` (Task 3).
- Produces: `AttendanceListProps` gains `classId: string` and `renderedAt: number` (the page's `now`, epoch ms, server clock).

**Behaviour (spec D1, D9):**
- Remove `attendanceState`, `updating` and the direct `fetch`. A row's shown status is `shownStatus(outbox, id, item.status, renderedAt)` with `outbox = useOutbox()`.
- A tap computes `newStatus` from the *shown* status by today's toggle rule (keep its comment), then `await enqueueAttendance({ ownerId, registrationId, classId, studentName, status: newStatus })` and `void flushAttendance(ownerId)`. With no owner (outside the teacher layout) the row buttons are not rendered — one-line comment: the teacher layout always provides it.
- A pending row's caption is `Waiting to sync` (`type-caption`), not the status label; the checkbox reflects the queued status.
- The heading row is `flex items-baseline justify-between`: the `h2` and, while this class has pending entries, `N waiting to sync` (`type-caption`) — same line, nothing below moves.
- `useInlineRefusals(classId)`; then every refusal whose `classId` equals this list's `classId` — whether or not its row is still in `items` (a cancelled booking or class drops the row after the refresh) — shows inline: one `role="alert"` `type-caption text-danger` line with `refusalLine(entry)` and a Dismiss button.
- Refresh on a new refusal: a ref of seen refusal ids, seeded in a mount effect from `getOutbox().refused` (the live store — during hydration `useOutbox` returns the empty server snapshot, so seeding from it would refresh on every reload), declared before the refresh effect; when a refusal for this class appears that is not in the ref, add it and call `router.refresh()`.
- No refresh on success. The "Network error…" message is gone (a network failure is "Waiting to sync").
- Docblock: describe the code as it is now — the server still decides, a refusal still refreshes, a tap is queued (D1). No history.
- `teacher-journey.spec.ts`: wrap the attendance tap in `Promise.all([page.waitForResponse((r) => r.url().includes('/api/registrations/') && r.request().method() === 'PUT'), <the tap>])`, so the next test's completion sees the write.

- [ ] **Step 1: Update and add tests.** Render through `AttendanceSyncProvider ownerId="acct-1"` with `startAttendanceSync` mocked to a no-op (`flushAttendance` real). Global Constraints' `beforeEach` resets apply.
  - existing refusal test: a 409 answer yields the inline `role="alert"` with the server's words, and `refresh` called once.
  - existing unchanged test: `ok`-shaped unchanged answer (`{data:{id,status},outcome:'unchanged'}`) → no alert, no refresh.
  - `shows Waiting to sync until the flush confirms` — fetch held: caption "Waiting to sync", heading "1 waiting to sync"; resolve with a matching `{data:…}` body → caption is the status label, heading count gone.
  - `a confirmation made elsewhere keeps the new status with stale props` — `renderedAt = 1000`; outside the component, `enqueueAttendance` + `settleEntry(e, {kind:'confirmed', at: 2000})`; the row shows the confirmed status.
  - `a confirmation older than the render yields to the props` — `at: 500`, props win.
  - `second tap before the first confirms` — tap (fetch held), tap again; row shows the second status pending; release both; the last PUT body is the second status; the row shows it.
  - `pending entry reapplies after remount without a hydration error` — `renderToString` with an EMPTY outbox (the server never has one); then write the entry to `localStorage` and `resetOutboxForTests()`; then `hydrateRoot(container, …, { onRecoverableError })` with `console.error` spied; assert neither was called, and after `act` the row shows "Waiting to sync".
  - `a stored refusal does not refresh on reload` — store a refusal for this class before render; mount; `refresh` not called; the alert shows.
  - `a refusal for a row no longer in items still shows inline`.
  - `a network failure leaves the row waiting, with no error text`.
- [ ] **Step 2–4:** fail, implement, pass; pass `classId={cls.id}` and `renderedAt={now}` at both call sites in the class page; lint; typecheck.
- [ ] **Step 5: Mutations:** compute the next status from `item.status` instead of the shown status → "second tap before the first confirms" fails; refresh on every settlement → the unchanged test fails; read the outbox with `getOutbox()` during render instead of `useOutbox()` → the hydration test fails; seed the seen ref from `useOutbox()`'s value → "a stored refusal does not refresh on reload" fails; filter inline refusals by `items` → "a refusal for a row no longer in items" fails.
- [ ] **Step 6: Commit** — `feat: attendance list queues every tap through the outbox (#726)`.

---

### Task 5: The class page — fieldset split and the check-in gate

**Files:**
- Modify: `src/components/layout/offline-snapshot.tsx`, `src/components/layout/offline-snapshot.test.tsx`
- Create: `src/components/class/checkin-gate.tsx`, `src/components/class/checkin-gate.test.tsx`
- Modify: `src/lib/finish-window.ts`, `src/lib/finish-window.test.ts` — add `checkinAt: Date` to `ClassPageClock` and its return value (it is already computed for `refreshInstants`), with a docblock line, asserted in the test.
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx`
- Visual baseline `class-detail-open` (this page is its source, `src/lib/visual-baseline-freshness.ts`).

**Interfaces:**
- Produces: `OfflineSnapshot` gains `queueable?: ReactNode` and `after?: ReactNode`. `CheckinGate` props: `{ serverShowCheckin: boolean; checkinAt: number; attendance: ReactNode; registered: ReactNode }`.

**Behaviour (spec D2, D3):**
- `OfflineSnapshot`: `children` in the existing fieldset; then, if given, `queueable` in a plain `<div data-offline-queueable>`; then, if given, `after` in a second `<fieldset data-offline-fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">`. Docblock: the queueable slot is the one region left enabled offline, for writes the page queues.
- `CheckinGate`: `const clockOpen = useSyncExternalStore(subscribe, () => Date.now() >= checkinAt, () => false)` where `subscribe` (memoised on `checkinAt`) arms one `setTimeout` for `min(checkinAt − Date.now(), 2**31 − 1)` when that is positive and finite, plus a `visibilitychange` listener, both calling the callback; it arms nothing when `!Number.isFinite(checkinAt)`. `const open = serverShowCheckin || clockOpen`. Renders `open ? attendance : registered`. No `setState` in effects.
- Class page: `<OfflineSnapshot {...stamp} queueable={…} after={…}>{head}</OfflineSnapshot>`:
  - `head` = `PageHeader`, `RefreshAt`, `ClassInfo`, the finish caption — unchanged.
  - `queueable` = on a live (`open` / `in_progress`, uncancelled) class: `<CheckinGate serverShowCheckin={showCheckin} checkinAt={checkinAt.getTime()} attendance={<AttendanceList … />} registered={<the existing Registered students block, or null when there are none>} />`; on `completed` uncancelled: the locked `AttendanceList`; otherwise `undefined`.
  - `after` = the rest, in today's order: walk-in form and `PricingPreview` under the server's `showCheckin`; the open-not-check-in and draft `PricingPreview`; the completed `PricingBreakdown` and `PaymentChecklist`; the cancelled message; the actions block. Each existing comment stays with its block.
- [ ] **Step 1: Failing tests.**
  - `offline-snapshot.test.tsx`: offline (as the existing tests drive it), a button in `children` and one in `after` are disabled, one in `queueable` is not; online, none is. Replace the existing `AttendanceList`-based check-in test with this.
  - `checkin-gate.test.tsx` (fake timers): server true → attendance; server false, `checkinAt` future → registered, then after advancing past it → attendance; server false, `checkinAt` past at mount → attendance; server true, `checkinAt` future (device clock behind) → attendance; rerender server false → true with `checkinAt` future → attendance; `vi.setSystemTime(checkinAt + 1)` *without advancing timers*, then dispatch `visibilitychange` → attendance; `renderToString` with server false and `checkinAt` past → the registered list (server-first paint); `checkinAt = NaN` → registered, no timer armed.
  - `finish-window.test.ts`: `checkinAt` is start − 15 min.
- [ ] **Step 2–4:** fail, implement, pass; lint; typecheck. Then `pnpm exec vitest run --project integration tests/integration/class-page-offline-marker.test.ts` against the worktree server (`pnpm run worktree:up` if it is down), and `curl` a class page for a 200.
- [ ] **Step 5: Visual baseline.** Follow the repo's visual-baseline procedure for `class-detail-open` (see `package.json` scripts and `src/lib/visual-baseline-freshness.ts`): regenerate it; if byte-identical, attest it with `pnpm run attest-visual-baseline class-detail-open "<why>"`; if it changed, commit the new baseline and say why.
- [ ] **Step 6: Mutations:** render `queueable` inside the first fieldset → the queueable-enabled test fails; `open = clockOpen` (drop `serverShowCheckin ||`) → the device-clock-behind test fails; drop the `visibilitychange` listener → its test fails.
- [ ] **Step 7: Commit** — `feat: class page check-in works offline: queueable slot and clock gate (#726)`.

---

### Task 6: Sign-out flushes, warns, and clears; account deletion clears

**Files:**
- Modify: `src/components/account/sign-out-button.tsx`, `src/components/account/sign-out-button.test.tsx`
- Modify: `src/components/account/data-and-deletion.tsx`, its test
- Modify: `src/lib/offline-client.test.ts` (one test)

**Interfaces:**
- Consumes: `getOutbox`, `clearOutbox` (Task 1); `flushAttendance` (Task 2).

**Behaviour (spec D7):**
- On Sign out, *before* the push teardown: if `getOutbox().pending` is non-empty, `await Promise.race([flushAttendance(null), <3 s timer>])` (the same race shape as the push teardown below it). If entries remain, stop: show `N attendance change(s) haven't synced yet. Signing out discards them.` (`type-caption`, `role="alert"`) and a "Sign out anyway" button; nothing else runs (no push teardown, no DELETE). "Sign out anyway" runs today's whole sequence.
- Today's sequence: in its `finally`, `await clearOutbox()` next to `clearOfflinePages()`, whatever the DELETE returned.
- `data-and-deletion.tsx`: after a successful delete, `await clearOutbox()` next to `clearOfflinePages()`.
- Sign-in sites are unchanged.
- [ ] **Step 1: Failing tests:** no pending → signs out at once; pending that the flush confirms → signs out, no warning; pending that stays (fetch rejects) → the warning with the right count, and neither `disablePush` nor the DELETE called; "Sign out anyway" → DELETE called and `getOutbox().pending` empty even when the DELETE rejects; account deletion clears the outbox. In `src/lib/offline-client.test.ts` (real module): store an outbox entry, `await clearOfflinePages()`, the entry is still there.
- [ ] **Step 2–4:** fail, implement, pass; lint; typecheck.
- [ ] **Step 5: Mutations:** `clearOutbox()` only on a successful DELETE → "Sign out anyway … even when the DELETE rejects" fails; skip the flush → "pending that the flush confirms" fails; warn after the push teardown → the `disablePush` not-called assertion fails.
- [ ] **Step 6: Commit** — `feat: sign-out flushes queued attendance, warns before discarding (#726)`.

---

### Task 7: Money pin, docs, end-to-end

**Files:**
- Modify: `tests/integration/registrations-api.test.ts` (next to `'allows attendance corrections on a completed class'`)
- Modify: `tests/e2e/offline.spec.ts`
- Modify: `docs/technical-architecture.md` (Offline section); `CLAUDE.md` only if a statement there becomes false (expected: none — check "Communication" and "Payment Model")

**Behaviour:**
- Integration test `a post-completion no-show changes no money and sends nothing`: create a class with `status: 'in_progress'` through the file's class fixture, register two students, then `completeClass(prisma, classId, { finishedEarly: true })` exactly as `tests/integration/full-flow.test.ts` does (import from `@/services/class-lifecycle`); assert the result is ok and that `Payment` rows exist, so the snapshot is non-empty. Snapshot every `Payment.amount` for the class, `Class.totalRevenue`, and every notification with `relatedClassId: classId` (type, recipient, body). PUT `{status:'no_show'}` for one student; 200 and the status written. Re-read: everything identical; that student's `payment_request` body does not contain "We missed you". PUT again → 200 with `outcome: 'unchanged'`.
- E2E, a new test in `tests/e2e/offline.spec.ts` with its own data (the existing fixture's class is not in check-in and the first test signs its session out): a second teacher with its own `seedSession`, a class with `status: 'in_progress'` that started 5 minutes ago (clamped to never start before 00:00 UTC of today) with `durationMinutes: 60`, three registered students. Sign in with that session, open `/class/<id>` online, poll `fy-pages-v1` for it as the first test does, `context.setOffline(true)`, tap the three rows, `page.reload()` (served from the worker), assert three "Waiting to sync" captions and "3 attendance changes waiting to sync", `context.setOffline(false)`, wait for that text to go, then read the three statuses with the file's `prisma` client and assert them. Extend `afterAll` to delete the new registrations, class, students, accounts and teacher (guarding every id — see the repo's "undefined Prisma filter deletes everything" lesson: never pass an id that could be `undefined` to a `deleteMany`).
- Docs, `docs/technical-architecture.md` Offline section — new subsection "Queued check-in (#726)": the outbox (key, D4's choice), the one write path (D1), flush triggers and the outcome table (D5/D6), account binding and the sign-out flow (D7), the `queueable` slot and the clock gate (D2/D3), and **the payment-request wording decision (D8)**: a student marked no-show after completion — online or by a late replay — keeps the neutral payment request; only a student marked before completion gets the no-show explanation; nothing re-sends. Link the spec. Make "Read-only: nothing is written while offline." true. Add the new e2e test's time constraint beside the existing 23:00 note in the End-to-end paragraph.
- [ ] Steps: write the integration test; run it against the worktree server (`pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`) — it PASSes at once (it pins existing behaviour); mutate `src/app/api/registrations/[id]/route.ts`'s WHERE `class:` clause to `class: { calendarEntry: { cancelledAt: null }, status: { not: 'completed' } }` → the test fails; restore; `git status` clean. Write the e2e; it needs a production build (the spec file's guard) — run it locally with a production build if feasible, otherwise state that CI runs it. Docs. Commit — `test: post-completion attendance moves no money; e2e queued check-in; docs (#726)`.

---

## Self-review notes

- Spec coverage: D1 → T4; D2/D3 → T5; D4 → T1; D5/D6 → T2; D7 → T2 (`null` scope), T3 (owner context), T6; D8 → T7; D9 → T3, T4; §3 tests distributed per task.
- Task order is load-bearing: 1 → 2 → 3 → 4 → 5 → 6 → 7 (each consumes the previous one's exports).
- A plan review before any code corrected: the PUT's `{data}` wrapping and the refusal's `error.code` (both would have passed self-consistent tests and failed in production), a sign-out flush that dropped the signed-in account's writes, refusals that showed nowhere, two inert mutations, a lint-failing gate, and an e2e that could not share the existing fixture.
