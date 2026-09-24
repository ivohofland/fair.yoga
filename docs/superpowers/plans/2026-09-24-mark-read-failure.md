# Mark-read failure handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed `POST /api/notifications/[id]/read` is no longer ignored: `NotificationList` rolls back its optimistic read state, both components say so inline, and a 401 refreshes the page so the server guard redirects to sign-in (#670).

**Architecture:** One client-safe helper, `postMarkRead(id)`, owns the fetch and classifies the outcome (`'marked' | 'session-expired' | 'failed'`), so the two components cannot drift on what counts as a failure or on the 401 rule. Each component keeps its own per-row `failed` state and renders a `role="alert"` line under the row's body. `NotificationList` additionally rolls back `readState[id]`; `UpdatesStrip` has no optimistic state (the row leaves only when the server re-renders), so for it the change is the message, the 401 refresh and a caught rejection.

**Tech Stack:** React 19 client components, Vitest (`unit` for the helper, `components` project for the two components), Testing Library.

**Spec:** none — one obvious design, single subsystem, no changed invariant (see the solve-issue spec gate). Issue #670 carries the acceptance criteria; the pattern mirrored is the older-page fetch in `notification-list.tsx` (`showOlder`, #669).

## Global Constraints

- TypeScript `strict`, no `any`.
- Message copy: `Couldn't mark this message read.` — same register as `Couldn't load older messages.`; rendered with `role="alert"` and classes `type-caption text-danger`, as the show-older control does.
- A 401 calls `router.refresh()`; every other failure (non-2xx, rejected fetch) does not.
- Success behaves exactly as today: `router.refresh()` after an ok response.
- Comments: default none; one short line only where the WHY is non-obvious. No counts or member lists in prose (CLAUDE.md, *Comment Discipline*).
- `@/lib/log` is server-only — do not import it in the helper.
- Stage exact paths; never `git add -A`.

## Review Focus

- A retry after a failure: the second click must go optimistic again, clear the message, and succeed. (Task 1 test.)
- A rejected `fetch` (network down): must roll back and show the message, not throw out of an un-awaited call from `handleNavigate`. (Task 1 and 2 tests.)
- Clicking the row itself (not "Mark read") on a failed mark: navigation must still happen — the failure is not a reason to strand the reader. (Task 1 test.)
- A non-401 failure must not refresh the page (the message would vanish with the re-render only if the server state changed; refreshing on every failure would also mask a persistent 500). (Task 1 and 2 tests.)
- Rows loaded by "Show older messages" take the same path as first-page rows. (Existing #663 test keeps covering success; Task 1 adds a failed one on a loaded row.)

Not in scope (from the issue): whether the tab-bar dot should be optimistic. Not done here and named in the PR: a 404 (row removed by the retention sweep) shows the same message and a retry answers 404 again.

---

### Task 1: `postMarkRead` helper and `NotificationList`

**Files:**
- Create: `src/lib/mark-notification-read.ts`
- Create: `src/lib/mark-notification-read.test.ts`
- Modify: `src/components/layout/notification-list.tsx` (`markRead`, row markup)
- Modify: `src/components/layout/notification-list.test.tsx` (new `describe` at the end)

**Interfaces:**
- Produces: `export type MarkReadOutcome = 'marked' | 'session-expired' | 'failed'` and `export async function postMarkRead(id: string): Promise<MarkReadOutcome>` in `@/lib/mark-notification-read`. Never rejects. Task 2 imports both.

- [ ] **Step 1: Write the failing helper test** (`src/lib/mark-notification-read.test.ts`)

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { postMarkRead } from './mark-notification-read';

afterEach(() => { vi.unstubAllGlobals(); });

describe('postMarkRead (#670)', () => {
  it('POSTs to the read route and answers marked on 2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await expect(postMarkRead('n-1')).resolves.toBe('marked');
    expect(fetchMock).toHaveBeenCalledWith('/api/notifications/n-1/read', { method: 'POST' });
  });

  it('answers session-expired on 401 and only on 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(postMarkRead('n-1')).resolves.toBe('session-expired');
    for (const status of [403, 404, 500]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
      await expect(postMarkRead('n-1')).resolves.toBe('failed');
    }
  });

  it('answers failed, and does not reject, when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(postMarkRead('n-1')).resolves.toBe('failed');
  });
});
```

- [ ] **Step 2: Run it, see it fail**

Run: `pnpm exec vitest run --project unit src/lib/mark-notification-read.test.ts`
Expected: FAIL — cannot resolve `./mark-notification-read`.

- [ ] **Step 3: Implement the helper**

```ts
export type MarkReadOutcome = 'marked' | 'session-expired' | 'failed';

export async function postMarkRead(id: string): Promise<MarkReadOutcome> {
  try {
    const res = await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    if (res.ok) return 'marked';
    return res.status === 401 ? 'session-expired' : 'failed';
  } catch {
    return 'failed';
  }
}
```

- [ ] **Step 4: Run it, see it pass**

Run: `pnpm exec vitest run --project unit src/lib/mark-notification-read.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing `NotificationList` tests**

Append to `src/components/layout/notification-list.test.tsx` a `describe('NotificationList — a failed mark-read (#670)', …)` with `afterEach(() => { vi.unstubAllGlobals(); })`. Reuse the file's `notification`, `olderResponse`, `at` helpers. Tests (each renders `<NotificationList notifications={[notification({ id: 'a', title: 'Booked' })]} />` unless stated; the button under test is `screen.getByRole('button', { name: 'Mark "Booked" read' })`):

1. `keeps the optimistic read state while the request is in flight, then rolls back on a 500` — `fetch` returns a deferred promise; click; assert the button `toHaveClass('invisible')` and no alert; resolve `{ ok: false, status: 500 }`; `await screen.findByRole('alert')` has text `Couldn't mark this message read.`; button `not.toHaveClass('invisible')`; `routerRefresh` not called.
2. `rolls back and says so when fetch rejects` — `mockRejectedValue(new TypeError('Failed to fetch'))`; same end-state assertions as 1.
3. `refreshes the page on a 401, and still rolls back and says so` — `{ ok: false, status: 401 }`; `await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1))`; alert present; button visible.
4. `does not refresh on a non-401 failure` — `{ ok: false, status: 404 }`; alert present; `expect(routerRefresh).not.toHaveBeenCalled()`.
5. `a retry after a failure goes optimistic again, clears the message and marks read` — `mockResolvedValueOnce({ ok: false, status: 500 })` then `mockResolvedValue({ ok: true, status: 200 })`; click, `findByRole('alert')`; click again; `await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())`; button `toHaveClass('invisible')`; `routerRefresh` called once.
6. `still opens the row when the mark fails` — a `booking_confirmed` row with `relatedClassId: 'class-9'`, title `Anna booked`; `fetch` → `{ ok: false, status: 500 }`; click `screen.getByRole('button', { name: /^Anna booked/ })`; `await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/class/class-9'))`; alert eventually present.
7. `shows no alert when the mark succeeds` — `{ ok: true, status: 200 }`; after `routerRefresh` called, `screen.queryByRole('alert')` is null.
8. `treats a row loaded by Show older like a first-page row` — first fetch `olderResponse([notification({ id: 'b', title: 'Old unread', createdAt: at(5) })], null)`, second `{ ok: false, status: 500 }`; load older, click `Mark "Old unread" read`; alert present, button not `invisible`.

Note: the existing `{ ok: true }` mocks in this file have no `status`; that is fine for `res.ok`.

- [ ] **Step 6: Run, see them fail**

Run: `pnpm exec vitest run --project components src/components/layout/notification-list.test.tsx`
Expected: the new tests FAIL (no alert; button stays `invisible`), the existing ones pass.

- [ ] **Step 7: Implement in `notification-list.tsx`**

- `import { postMarkRead } from '@/lib/mark-notification-read';`
- Add `const [readFailed, setReadFailed] = useState<Record<string, boolean>>({});`
- Replace `markRead`:

```ts
  async function markRead(id: string) {
    if (readState[id]) return;
    setReadState((prev) => ({ ...prev, [id]: true }));
    setReadFailed((prev) => ({ ...prev, [id]: false }));
    const outcome = await postMarkRead(id);
    if (outcome === 'marked') {
      // Re-runs the layout server component so the tab bar's unread dot updates.
      router.refresh();
      return;
    }
    setReadState((prev) => ({ ...prev, [id]: false }));
    setReadFailed((prev) => ({ ...prev, [id]: true }));
    // An expired session cannot be retried into success; the page's own
    // server guard sends the reader to sign in.
    if (outcome === 'session-expired') router.refresh();
  }
```

- Row markup: wrap the row's left `<button id={rowButtonId(...)}>` in `<div className="flex flex-col min-w-0 flex-1">` (move `flex-1` off the button to the wrapper; keep `text-left flex items-start min-w-0` on the button) and render, after the button, `{readFailed[notification.id] && (<p role="alert" className="type-caption text-danger">Couldn&apos;t mark this message read.</p>)}`. The alert must sit outside the button.
- Keep `handleNavigate` as is: `markRead(notification.id)` is un-awaited, which is now safe because `postMarkRead` never rejects.

- [ ] **Step 8: Run, see them pass; typecheck and lint**

Run: `pnpm exec vitest run --project components src/components/layout/notification-list.test.tsx && pnpm exec tsc --noEmit && pnpm exec eslint src/lib/mark-notification-read.ts src/lib/mark-notification-read.test.ts src/components/layout/notification-list.tsx src/components/layout/notification-list.test.tsx`
Expected: all green, including the pre-existing retention-note tests that read `parentElement` of the row button.

- [ ] **Step 9: Prove every guard bites** — apply each mutation, record the failing test names, restore by re-applying the exact original text (commit first; never `git checkout` a file holding other uncommitted work). Warm nothing needed (unit/components only).
  - Delete the `setReadState(... [id]: false)` rollback → tests 1–3, 8 fail.
  - Delete the `setReadFailed(... true)` line → tests 1–4, 6, 8 fail.
  - Delete `if (outcome === 'session-expired') router.refresh();` → test 3 fails.
  - Change it to refresh on every non-`marked` outcome → test 4 fails.
  - In the helper, return `'session-expired'` for every non-ok → helper test 2 and component test 4 fail.
  - In the helper, remove the `try/catch` → helper test 3 and component test 2 fail.
  - Delete the `setReadFailed(... false)` line at the top of `markRead` → test 5 fails.
  Run `git status` after the sweep and assert it is clean of mutations.

- [ ] **Step 10: Commit**

```bash
git add src/lib/mark-notification-read.ts src/lib/mark-notification-read.test.ts src/components/layout/notification-list.tsx src/components/layout/notification-list.test.tsx
git commit -m "fix(inbox): roll back and say so when marking a message read fails (#670)"
```

---

### Task 2: `UpdatesStrip`

**Files:**
- Modify: `src/components/student/updates-strip.tsx` (`markRead`, row markup)
- Create: `src/components/student/updates-strip.test.tsx`

**Interfaces:**
- Consumes: `postMarkRead(id: string): Promise<'marked' | 'session-expired' | 'failed'>` from `@/lib/mark-notification-read` (Task 1). Never rejects.

- [ ] **Step 1: Write the failing tests** (`src/components/student/updates-strip.test.tsx`)

Imports: `describe, it, expect, vi, afterEach` from vitest; `render, screen, fireEvent` from `@testing-library/react`; `routerRefresh`, `routerPush` from `'../../../tests/setup/components'`; `UpdatesStrip, type StudentUpdate` from `'./updates-strip'`. A `update(over)` factory: `{ id: 'u-1', title: 'Spot opened', body: 'Body', createdAt: '2026-09-15T10:00:00.000Z', href: null, ...over }`. `afterEach(() => { vi.unstubAllGlobals(); })`. The button under test is `screen.getByRole('button', { name: 'Mark "Spot opened" read' })`. Render `<UpdatesStrip updates={[update({})]} hasHistory />`.

1. `marks read through the read route and refreshes the page` — `fetch` → `{ ok: true, status: 200 }`; click; `expect(fetchMock).toHaveBeenCalledWith('/api/notifications/u-1/read', { method: 'POST' })`; `await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1))`; no alert.
2. `says so, keeps the row and does not refresh on a 500` — `{ ok: false, status: 500 }`; `await screen.findByRole('alert')` has text `Couldn't mark this message read.`; the row's button still present; `routerRefresh` not called.
3. `says so when fetch rejects` — `mockRejectedValue(new TypeError('Failed to fetch'))`; alert present.
4. `refreshes on a 401 and still says so` — `{ ok: false, status: 401 }`; `routerRefresh` called once; alert present.
5. `a retry clears the message` — 500 then ok; second click; alert gone; `routerRefresh` called once.
6. `still follows the link when the mark fails` — `update({ href: '/book/c-1' })`; 500; click the link (`getByRole('link', { name: /^Spot opened/ })`) — jsdom does not navigate a `next/link` click by itself, so assert only that the alert appears and no unhandled rejection surfaces (`fetch` rejects variant).

- [ ] **Step 2: Run, see them fail**

Run: `pnpm exec vitest run --project components src/components/student/updates-strip.test.tsx`
Expected: tests 2–5 FAIL (no alert / refresh always called); test 1 passes.

- [ ] **Step 3: Implement in `updates-strip.tsx`**

- `import { useState } from 'react';` and `import { postMarkRead } from '@/lib/mark-notification-read';`
- `const [failed, setFailed] = useState<Record<string, boolean>>({});`
- Replace `markRead`:

```ts
  async function markRead(id: string) {
    setFailed((prev) => ({ ...prev, [id]: false }));
    const outcome = await postMarkRead(id);
    if (outcome === 'marked') {
      // Server component re-render drops the row from the strip.
      router.refresh();
      return;
    }
    setFailed((prev) => ({ ...prev, [id]: true }));
    // An expired session cannot be retried into success; the page's own
    // server guard sends the reader to sign in.
    if (outcome === 'session-expired') router.refresh();
  }
```

- In the row's left column, after the body `<span className="type-caption">`, render `{failed[update.id] && (<span role="alert" className="type-caption text-danger">Couldn&apos;t mark this message read.</span>)}`.

- [ ] **Step 4: Run, see them pass; typecheck and lint**

Run: `pnpm exec vitest run --project components src/components/student/updates-strip.test.tsx && pnpm exec tsc --noEmit && pnpm exec eslint src/components/student/updates-strip.tsx src/components/student/updates-strip.test.tsx`
Expected: green.

- [ ] **Step 5: Prove every guard bites** — commit first, then:
  - Delete `setFailed(... true)` → tests 2–4 fail.
  - Delete `if (outcome === 'session-expired') router.refresh();` → test 4 fails.
  - Refresh on every outcome → test 2 fails.
  - Delete `setFailed(... false)` at the top → test 5 fails.
  Assert `git status` clean of mutations afterwards.

- [ ] **Step 6: Commit**

```bash
git add src/components/student/updates-strip.tsx src/components/student/updates-strip.test.tsx
git commit -m "fix(student): say so when marking an update read fails (#670)"
```

---

## Self-review

- Issue AC 1 (rollback + inline message, `role="alert"`): Task 1 steps 5–7. AC 2 (`UpdatesStrip`): Task 2. AC 3 (401 refresh): both, tests 3/4. AC 4 (failed POST leaves the row unread and shows the message; success as today; each fails if the rollback is removed): Task 1 tests 1–3, 7 and the step 9 mutations; Task 2 tests.
- Interfaces match: `postMarkRead` / `MarkReadOutcome` named identically in both tasks.
- No placeholders.
