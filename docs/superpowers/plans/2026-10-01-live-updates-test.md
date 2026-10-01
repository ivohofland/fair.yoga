# LiveUpdates client test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the client logic of `src/components/layout/live-updates.tsx` — debounce, reconnect with backoff, reset on open, teardown on unmount — in a components-project test (#731).

**Architecture:** One new test file, `src/components/layout/live-updates.test.tsx`, with a fake `EventSource` stubbed as a global and vitest fake timers. No production code changes: this is a coverage issue, and every behaviour the issue names already exists. The component is mutated only temporarily, to prove each pin bites, and restored before every commit.

**Tech Stack:** Vitest 4 (`components` project, jsdom), `@testing-library/react`, React 19.

**Spec:** none — gated off. Test-only, one file, one reasonable design. The requirement is the issue body (`gh issue view 731`), corrected by the premise check below.

## Premise check (measured 2026-10-01 against `origin/main` 883a2c1f)

- **Holds:** nothing tests the component. `grep -rn LiveUpdates src` finds only the component, its two mount sites (`src/app/(student)/layout.tsx`, `src/app/(teacher)/layout.tsx`), and a comment in `add-walk-in.test.tsx`.
- **Holds:** jsdom has no `EventSource` (`'EventSource' in new JSDOM('').window` → `false`), so a stub is required, not optional — without one, the component's `new EventSource(...)` throws on mount.
- **Corrected — the first delay is 4 s, not 2 s.** `onerror` runs `attempts += 1` *before* computing `min(60_000, 2_000 × 2^min(attempts, 5))`, so the delays are: attempt 1 → 4 000, 2 → 8 000, 3 → 16 000, 4 → 32 000, 5 → min(60 000, 64 000) = 60 000, 6+ → 60 000. "One success restores the short delay" means 4 s.
- **Corrected — the inner `Math.min(attempts, 5)` is an equivalent mutant.** The outer 60 000 cap already binds at attempt 5 (64 000 > 60 000), and for huge `attempts` `2 ** n` becomes `Infinity`, which `Math.min(60_000, Infinity)` still caps. No test can distinguish it; the mutation-checked cap is the outer `60_000`.
- **Corrected — `closed` is not what stops a pending reconnect on unmount; `clearTimeout(reconnect)` is.** The cleanup clears the only timer that could call `connect()` again, so `if (closed) return` is reached only if that timer survives. The two are redundant guards: each removed alone should leave the unmount test green, both removed should turn it red. Task 2 measures this rather than assuming it.

## Global Constraints

- TypeScript `strict: true` — no `any`, no `as unknown as`, no `@ts-expect-error` in the test.
- Comment discipline (CLAUDE.md): a comment annotates the code it sits on; no counts or rosters in prose; no correction history. Mutation results go in the PR body, never in the test file.
- Test assertions never compare a literal `error.message`.
- Mutations of `live-updates.tsx` are temporary. The mutation sweep ends with `git status --porcelain src/components/layout/live-updates.tsx` printing nothing. Commit the test file **before** mutating, so restoring the component cannot discard test edits.
- Run tests on Node 24: prefix commands with `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH` (the agent shell defaults to Node 22, and `pnpm` refuses to run on it).

## Review Focus

1. **Debounce is trailing and restarting, not fixed-window.** Messages spaced 100 ms apart must produce one refresh 500 ms after the *last* message, not 500 ms after the first — a "keep the first timer" mutation passes a test that only checks the count.
2. **A rebuilt stream is fully wired.** After a reconnect, a message on the *new* source must still refresh, and a permanent close on it must still reconnect — the handlers are attached per `connect()` call.
3. **An error on a source that is still `CONNECTING` must not close it.** That source belongs to the browser's own retry; closing it would end live updates the browser was about to restore.
4. **Unmount during the reconnect wait.** A user who navigates out of the teacher/student layout while the stream is down must not leave a timer that later opens an orphaned stream.
5. **Exact boundaries.** Every delay is asserted "not a millisecond before, and at" (`advanceTimersByTime(d - 1)` then `(1)`), the pattern `refresh-at.test.tsx` uses — a test advancing well past the delay cannot see an off-by-one in the backoff.

---

### Task 1: Fake EventSource, mount, debounce, unmount

**Files:**
- Create: `src/components/layout/live-updates.test.tsx`
- Read-only (mutated temporarily in Step 4): `src/components/layout/live-updates.tsx`

**Interfaces:**
- Consumes: `LiveUpdates` from `./live-updates` (no props, renders `null`).
- Produces (Task 2 extends the same file): `class FakeEventSource` with statics `CONNECTING = 0`, `OPEN = 1`, `CLOSED = 2`; instance fields `url: string`, `readyState: number`, `onopen`, `onmessage`, `onerror`, `close` (a `vi.fn`); helper methods `open(): void`, `message(): void`, `dropAndRetry(): void`, `failPermanently(): void`. A module-level `sources: FakeEventSource[]` (every constructed instance, in order, reset in `beforeEach`) and `latest(): FakeEventSource`. A stable `routerRefresh` mock.

- [ ] **Step 1: Write the test file**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { LiveUpdates } from './live-updates';

// One router object for every render, as Next's `useRouter` gives. The shared
// setup's mock builds a new one per call, and `router` is this effect's
// dependency, so any re-render there would tear the stream down and reopen it.
const { routerRefresh, router } = vi.hoisted(() => {
  const refresh = vi.fn();
  return { routerRefresh: refresh, router: { refresh } };
});
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/**
 * Stands in for the browser's `EventSource`, which jsdom does not implement.
 * The helpers drive the state transitions the component reacts to; nothing
 * here retries on its own, so every reconnect a test sees is the component's.
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly url: string;
  readyState: number = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    sources.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  message(): void {
    this.onmessage?.(new MessageEvent('message', { data: '{}' }));
  }

  /** A transient drop: the browser is already reconnecting on its own. */
  dropAndRetry(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.(new Event('error'));
  }

  /** A non-2xx response (an expired session's 401): closed for good, no retry. */
  failPermanently(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

let sources: FakeEventSource[] = [];

function latest(): FakeEventSource {
  const source = sources.at(-1);
  if (!source) throw new Error('no EventSource was constructed');
  return source;
}

/**
 * #731. `LiveUpdates` keeps the inbox, the tab-bar unread dot and open lists
 * current by refreshing the page when the notification stream speaks. A
 * regression here fails silently: the page keeps working, it just stops
 * updating.
 */
describe('LiveUpdates', () => {
  beforeEach(() => {
    sources = [];
    routerRefresh.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens one stream to the notification endpoint on mount', () => {
    render(<LiveUpdates />);

    expect(sources).toHaveLength(1);
    expect(latest().url).toBe('/api/notifications/stream');
  });

  it('collapses a burst into one refresh, 500 ms after the last message', () => {
    render(<LiveUpdates />);
    const source = latest();

    // Five messages, 100 ms apart: the last lands at t = 400.
    source.message();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(100);
      source.message();
    }

    // t = 899: 500 ms after the first message has long passed; after the last, not yet.
    vi.advanceTimersByTime(499);
    expect(routerRefresh).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes again for a message after the previous refresh', () => {
    render(<LiveUpdates />);
    const source = latest();

    source.message();
    vi.advanceTimersByTime(500);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    source.message();
    vi.advanceTimersByTime(500);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('closes the stream on unmount and drops a refresh still pending', () => {
    const { unmount } = render(<LiveUpdates />);
    const source = latest();

    source.message();
    unmount();

    expect(source.close).toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it — expect PASS** (the behaviour exists; Step 4 is what proves the tests can fail)

Run: `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH pnpm exec vitest run --project components src/components/layout/live-updates.test.tsx`
Expected: 4 passed.

- [ ] **Step 3: Commit the test before mutating anything**

```bash
git add src/components/layout/live-updates.test.tsx
git commit -m "test(live-updates): pin the stream's mount, debounce and unmount (#731)"
```

- [ ] **Step 4: Mutation-check each pin, one mutation at a time**

For each row: apply the edit to `live-updates.tsx`, run the Step 2 command, record the failing test name and the first assertion line of the failure verbatim, then restore with `git checkout -- src/components/layout/live-updates.tsx` and confirm `git status --porcelain src/components/layout/live-updates.tsx` prints nothing.

| # | Mutation (exact text) | Expected |
|---|---|---|
| 1a | In `onmessage`, delete the line `if (timer.current) clearTimeout(timer.current);` | RED: "collapses a burst" (5 refreshes) |
| 1b | In `onmessage`, replace `if (timer.current) clearTimeout(timer.current);` with `if (timer.current) return;` (keeps the first timer — a fixed window) | RED: "collapses a burst" at the `t = 899` assertion. This mutation also leaves `timer.current` set after it fires, so "refreshes again" should turn RED too. Record both. |
| 1c | In the cleanup, delete `if (timer.current) clearTimeout(timer.current);` | RED: "closes the stream on unmount" |
| 1d | In the cleanup, delete `source?.close();` | RED: "closes the stream on unmount" |
| 1e | Replace `'/api/notifications/stream'` with `'/api/notifications'` | RED: "opens one stream" |

Any row that stays GREEN is a finding: stop and report it rather than strengthening the test to fit.

- [ ] **Step 5: Report** the five mutation results (mutation, RED/GREEN, failing test, error line) in the task report. Nothing to commit — the tree must be clean.

---

### Task 2: Reconnect after a permanent close — backoff, cap, reset, unmount mid-wait

**Files:**
- Modify: `src/components/layout/live-updates.test.tsx` (add a nested `describe` inside the existing `describe('LiveUpdates', …)`)
- Read-only (mutated temporarily in Step 4): `src/components/layout/live-updates.tsx`

**Interfaces:**
- Consumes from Task 1: `FakeEventSource` (`dropAndRetry`, `failPermanently`, `open`, `message`, `close`), `sources`, `latest()`, `routerRefresh`, the `beforeEach`/`afterEach` installing fake timers and the global stub.
- Produces: nothing new.

- [ ] **Step 1: Add the tests** inside `describe('LiveUpdates', …)`, after the unmount test:

```tsx
  describe('after an error', () => {
    /** Fails the newest stream for good and asserts the reconnect lands at exactly `delay`. */
    function expectReconnectAfter(delay: number): void {
      const failed = latest();
      const before = sources.length;

      failed.failPermanently();
      expect(failed.close).toHaveBeenCalled();

      vi.advanceTimersByTime(delay - 1);
      expect(sources).toHaveLength(before);

      vi.advanceTimersByTime(1);
      expect(sources).toHaveLength(before + 1);
    }

    it('leaves a stream the browser is still retrying alone', () => {
      render(<LiveUpdates />);
      const source = latest();

      source.dropAndRetry();
      vi.advanceTimersByTime(10 * 60_000);

      expect(source.close).not.toHaveBeenCalled();
      expect(sources).toHaveLength(1);
    });

    it('rebuilds a closed stream after 4 s, doubling per attempt, capped at 60 s', () => {
      render(<LiveUpdates />);

      // 2 s × 2^attempts, with attempts counted before the first delay; 2 s × 2^5 = 64 s is the first capped step.
      for (const delay of [4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]) {
        expectReconnectAfter(delay);
      }
    });

    it('restarts the backoff from 4 s once a rebuilt stream opens', () => {
      render(<LiveUpdates />);

      expectReconnectAfter(4_000);
      expectReconnectAfter(8_000);
      expectReconnectAfter(16_000);

      latest().open();
      expectReconnectAfter(4_000);
    });

    it('wires the rebuilt stream to refresh', () => {
      render(<LiveUpdates />);
      expectReconnectAfter(4_000);

      latest().message();
      vi.advanceTimersByTime(500);

      expect(routerRefresh).toHaveBeenCalledTimes(1);
    });

    it('opens no stream after an unmount during the reconnect wait', () => {
      const { unmount } = render(<LiveUpdates />);

      latest().failPermanently();
      unmount();
      vi.advanceTimersByTime(10 * 60_000);

      expect(sources).toHaveLength(1);
    });
  });
```

- [ ] **Step 2: Run the file — expect PASS**

Run: `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH pnpm exec vitest run --project components src/components/layout/live-updates.test.tsx`
Expected: 9 passed.

- [ ] **Step 3: Commit before mutating**

```bash
git add src/components/layout/live-updates.test.tsx
git commit -m "test(live-updates): pin the reconnect backoff, its cap and its reset (#731)"
```

- [ ] **Step 4: Mutation-check, one at a time** — same procedure as Task 1 Step 4 (apply, run, record verbatim, `git checkout -- src/components/layout/live-updates.tsx`, confirm clean).

| # | Mutation (exact text) | Expected |
|---|---|---|
| 2a | **Cap.** In the `delay` line, replace `Math.min(60_000,` with `Math.min(600_000,` | RED: "doubling per attempt, capped at 60 s" at the fifth step (the reconnect lands at 64 000, not 60 000) |
| 2b | **CONNECTING early return.** Delete the line `if (source?.readyState !== EventSource.CLOSED) return;` | RED: "leaves a stream the browser is still retrying alone" |
| 2c | **Reset.** In `onopen`, delete `attempts = 0;` | RED: "restarts the backoff from 4 s" (lands at 32 000) |
| 2d | **Inner cap — expected inert.** Replace `2 ** Math.min(attempts, 5)` with `2 ** attempts` | GREEN — equivalent mutant (see the plan's premise check). Record that it stayed green. |
| 2e | **Pending-reconnect guard alone.** In the cleanup, delete `if (reconnect) clearTimeout(reconnect);` | Expected GREEN — `closed` still stops `connect()`. Record. |
| 2f | **`closed` alone.** In `connect`, delete `if (closed) return;` | Expected GREEN — the cleared timer never fires. Record. |
| 2g | **Both guards.** Apply 2e and 2f together | RED: "opens no stream after an unmount during the reconnect wait" |
| 2h | **Rebuilt stream wiring.** In `onerror`, replace `reconnect = setTimeout(connect, delay);` with `reconnect = setTimeout(() => { source = new EventSource('/api/notifications/stream'); }, delay);` | RED: "wires the rebuilt stream to refresh", and the backoff tests at their second step |

2a and 2b are the two the issue's acceptance names. A GREEN in any row expected RED is a finding: report it rather than editing the test to fit. A RED in 2d/2e/2f contradicts the premise check: report that too.

- [ ] **Step 5: Final state check**

Run: `git status --porcelain` — expected: nothing (both commits made, component restored).
Run: `PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH pnpm exec tsc --noEmit -p . && PATH=$HOME/.nvm/versions/node/v24.21.0/bin:$PATH pnpm exec eslint src/components/layout/live-updates.test.tsx` — expected: clean.

- [ ] **Step 6: Report** the eight mutation results (mutation, RED/GREEN, failing test, error line).
