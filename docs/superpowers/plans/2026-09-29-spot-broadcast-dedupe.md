# Spot broadcast dedupe under the class row lock (#691) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the reconciliation sweep and a route's post-cancel hook from both
broadcasting `spot_available` for one freed seat. `handleSpotFreed`'s broadcast
branch declines, under the class row lock, when a broadcast already stands for
the current claim window.

**Architecture:** `broadcastStillStands` moves from
`waitlist-reconciliation.ts` into `waitlist.ts` and is exported. The broadcast
transaction re-reads `spotBroadcastAt` and the entry's schedule after
`lockClassRow`, and returns a new internal `already_broadcast` outcome, which
maps to `{ action: 'none' }`. The sweep's unlocked pre-read of the same
predicate stays as a shortcut.

**Tech Stack:** TypeScript strict, Prisma, PostgreSQL, Vitest (`unit-sweeps` project).

**Spec:** `docs/superpowers/specs/2026-09-29-spot-broadcast-dedupe-design.md`.
Read §2 for why suppressing for every caller loses no notification, and §4 for
the mutation list.

## Global Constraints

- `SpotFreedResult`'s union does not change. `already_broadcast` is internal to
  `handleSpotFreed` and answers `{ action: 'none' }`.
- The locked re-read comes **after** `lockClassRow`, inside the same
  transaction. Never reuse the pre-lock `cls` for the flag or the schedule.
- Comment Discipline (CLAUDE.md): comments state what is true now. No history
  ("previously…", "#220 accepted…"): that goes in the PR body. No counts or
  rosters. A claim reaching past its own file links to the spec instead of
  restating it.
- Tests assert per recipient (`spotNotifications(classId, studentId)`), never
  a class-wide count. That file's own docblock says why.
- Sweep invocations in new tests go through `scopeSweep` (`tests/scoped-sweep.ts`).
- Mutation steps: commit first, apply the mutation as the exact text given,
  run, record the failing assertion verbatim, restore with
  `git checkout -- <file>`, and confirm `git status --short` is clean.
- Stage exact paths. Never `git add -A` or `git add .`.
- Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

**Task order is load-bearing:** Task 2's harness test is only GREEN once
Task 1's check exists.

---

### Task 1: The under-lock gate, its deterministic pins, and the prose it changes

**Files:**
- Modify: `src/services/waitlist.ts`: add the exported `broadcastStillStands`
  beside `claimWindowStart`; add the locked re-check to `handleSpotFreed`'s
  `first_come_first_claimed` transaction; add a debug line; update
  `handleSpotFreed`'s docblock.
- Modify: `src/services/waitlist-reconciliation.ts`: delete the local
  `broadcastStillStands` and its docblock, import it from `./waitlist`, and
  update `reconcileOne`'s unlocked-read paragraph.
- Test: `src/services/waitlist-reconciliation.test.ts`: new nested `describe`
  inside `reconcileWaitlists (DB)`, reusing `makeFreedSeat`, `windowClocks`,
  `spotNotifications`, `broadcastFlag`.

**Interfaces:**
- Produces:
  ```ts
  // src/services/waitlist.ts
  export function broadcastStillStands(cls: {
    spotBroadcastAt: Date | null;
    calendarEntry: { date: Date; startTime: Date; teacher: { defaultTimezone: string } };
  }): boolean;
  ```
  The debug message string, used by Task 2's reviewers and by the test:
  `'waitlist broadcast suppressed — a broadcast already stands for this claim window'`.

- [ ] **Step 1: Write the three tests**

Add inside `describe('reconcileWaitlists (DB)', …)`, after
`broadcasts despite a broadcast flag stamped before the claim window`:

```ts
  /**
   * The gate `handleSpotFreed` applies under the class row lock (#691). The
   * sweep's own gate reads `spotBroadcastAt` unlocked, and the live hook has
   * none, so without this the lock orders two callers for one freed seat
   * without telling the second that the first already announced it. Spec:
   * `docs/superpowers/specs/2026-09-29-spot-broadcast-dedupe-design.md`.
   */
  describe('the broadcast gate under the class row lock', () => {
    /**
     * Two route cancels in one claim window, the first broadcast unclaimed.
     * Every waiter was told at the first; a second "A spot opened up" tells
     * them nothing (spec §2 has the argument that no one is left out).
     */
    it('announces a second freed seat to nobody while the first broadcast stands', async () => {
      const cls = await makeFreedSeat('SecondCancel', { waiters: 2 });
      const clocks = windowClocks(cls.startTime);
      const debug = vi.spyOn(log, 'debug').mockImplementation(() => undefined);
      onTestFinished(() => debug.mockRestore());

      const first = await handleSpotFreed(prisma, cls.id, clocks.inClaimWindow);
      expect(first).toEqual({ action: 'broadcast', notified: 2 });

      // A second cancel frees the surviving seat too; nobody has claimed the first.
      await prisma.registration.updateMany({
        where: { classId: cls.id, status: 'registered' },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      const second = await handleSpotFreed(prisma, cls.id, clocks.inClaimWindow);

      expect(second).toEqual({ action: 'none' });
      for (const waiter of cls.waiters) {
        expect(await spotNotifications(cls.id, waiter)).toBe(1);
      }
      expect(debug).toHaveBeenCalledWith(
        expect.objectContaining({ classId: cls.id }),
        'waitlist broadcast suppressed — a broadcast already stands for this claim window',
      );
    });

    /**
     * The sweep broadcasts first, then the route's hook arrives for the same
     * seat. Sequential is enough here: the hook has no pre-lock gate, so a
     * race and a sequence reach the lock with the same state.
     */
    it('does not re-announce from the live hook a seat the sweep already announced', async () => {
      const cls = await makeFreedSeat('SweepFirst', { waiters: 2 });
      const clocks = windowClocks(cls.startTime);
      const scoped = scopeSweep(prisma, { WaitlistEntry: { classId: { in: [cls.id] } } });

      const summary = await reconcileWaitlists(scoped.db, {
        now: clocks.inClaimWindow,
        streaks: createReconciliationStreaks(),
      });
      expect(summary.repairedClassIds).toEqual([cls.id]);

      const hook = await handleSpotFreed(prisma, cls.id, clocks.inClaimWindow);

      expect(hook).toEqual({ action: 'none' });
      for (const waiter of cls.waiters) {
        expect(await spotNotifications(cls.id, waiter)).toBe(1);
      }
    });

    /**
     * The claim-window bound, on the hook's side of the gate. A flag from an
     * earlier window (a rescheduled class) must not silence this one.
     */
    it('broadcasts from the live hook despite a flag stamped before the claim window', async () => {
      const cls = await makeFreedSeat('HookOldFlag');
      const clocks = windowClocks(cls.startTime);

      // Thirty-one hours before class start; `claimWindowStart` is classStart − 1h.
      await prisma.class.update({
        where: { id: cls.id },
        data: { spotBroadcastAt: new Date(clocks.classStart.getTime() - 31 * H) },
      });

      const hook = await handleSpotFreed(prisma, cls.id, clocks.inClaimWindow);

      expect(hook).toEqual({ action: 'broadcast', notified: 1 });
      expect(await spotNotifications(cls.id, cls.waiter)).toBe(1);
      expect(await broadcastFlag(cls.id)).toEqual(clocks.inClaimWindow);
    });
  });
```

- [ ] **Step 2: Run them and confirm the expected RED**

Run: `pnpm exec vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts -t "the broadcast gate under the class row lock"`

Expected:
- `announces a second freed seat…`: FAIL. `second` is
  `{ action: 'broadcast', notified: 2 }`, not `{ action: 'none' }`.
- `does not re-announce from the live hook…`: FAIL. `hook` is
  `{ action: 'broadcast', notified: 2 }`.
- `broadcasts from the live hook despite a flag…`: PASS. Today's hook has no
  gate at all, so this is a guard against over-suppression, not a RED-first
  test. Mutation 2 in Step 7 is its RED proof. Record this in the task report
  rather than treating a pass as a problem.

- [ ] **Step 3: Move the predicate into `waitlist.ts`**

In `src/services/waitlist.ts`, directly after `claimWindowStart`, add the
function below. Carry over the docblock of the current `broadcastStillStands`
in `waitlist-reconciliation.ts`, with these edits:
- the opening sentence becomes: "True when a first-come-first-claimed broadcast
  already stands for the seat that is currently free. The one gate both the
  reconciliation sweep and `handleSpotFreed`'s broadcast branch apply (#691)."
- "precisely the loss this module exists to repair" becomes "precisely the loss
  the reconciliation sweep exists to repair".
- "which is this branch's own defect reintroduced for rescheduled classes"
  becomes "which would silence every later broadcast for a rescheduled class".
- "It also costs no query: this is a column on a row the sweep has already
  loaded…" becomes "It also costs no extra query: it is a column on the row
  each caller already reads."

```ts
export function broadcastStillStands(cls: {
  spotBroadcastAt: Date | null;
  calendarEntry: { date: Date; startTime: Date; teacher: { defaultTimezone: string } };
}): boolean {
  if (cls.spotBroadcastAt === null) return false;

  return cls.spotBroadcastAt >= claimWindowStart(cls.calendarEntry, cls.calendarEntry.teacher.defaultTimezone);
}
```

In `src/services/waitlist-reconciliation.ts`: delete the local function and its
docblock, and add `broadcastStillStands` to the existing `./waitlist` import
list, alphabetically first. `CandidateClass` already satisfies the parameter
type; no call-site change.

- [ ] **Step 4: Add the locked re-check**

In `handleSpotFreed`'s `first_come_first_claimed` transaction, immediately
after the `if (seats.isFull) { … }` block and before the `waiting` `findMany`:

```ts
      // A broadcast already standing for this claim window covers this seat
      // too, so a second one would tell every waiter what they were already
      // told. Read here, not from `cls` above: `spotBroadcastAt` is written
      // under this row lock, and so is any reschedule that moves the window
      // (`docs/lock-order.md`), so only a read taken after the lock sees
      // either. The lock alone orders two callers for one freed seat; this is
      // what tells the second about the first. Why declining loses no
      // recipient: `docs/superpowers/specs/2026-09-29-spot-broadcast-dedupe-design.md` §2.
      const current = await tx.class.findUniqueOrThrow({
        where: { id: classId },
        select: {
          spotBroadcastAt: true,
          calendarEntry: {
            select: { date: true, startTime: true, teacher: { select: { defaultTimezone: true } } },
          },
        },
      });
      if (broadcastStillStands(current)) {
        return { kind: 'already_broadcast' as const, spotBroadcastAt: current.spotBroadcastAt };
      }
```

After the existing `if (outcome.kind === 'suppressed') { … }` block, and before
the `return`, add:

```ts
    if (outcome.kind === 'already_broadcast') {
      // `debug` for the reason the `suppressed` line above gives: both
      // outcomes are correct, and neither live caller reads the result.
      log.debug(
        { classId, spotBroadcastAt: outcome.spotBroadcastAt },
        'waitlist broadcast suppressed — a broadcast already stands for this claim window',
      );
    }
```

The final `return outcome.kind === 'sent' ? … : { action: 'none' }` needs no
change.

- [ ] **Step 5: Rewrite the prose this changes**

1. `handleSpotFreed`'s docblock, the "final hour before class" bullet: after
   "broadcast to all waiting students (first to claim gets the spot)", add:
   "unless a broadcast already stands for this claim window (#691), which
   covers the new seat too".
2. The same docblock's closing sentence, "Nothing about this function's
   signature or behaviour changed for it; it is a caller, not a coupling.",
   becomes: "Its signature did not change for it. The broadcast branch's
   under-lock gate on a standing broadcast is what keeps this sweep and a live
   caller from both announcing one freed seat (#691)."
3. `reconcileOne`'s unlocked-read paragraph in `waitlist-reconciliation.ts`
   (the one ending "…the hook's locked count suppresses it, as designed."):
   append, as its own sentence: "`spotBroadcastAt` on the same pre-read is
   stale in the same harmless way: read as unset while another caller's
   broadcast commits, the call re-checks it under the lock and declines."
4. The comment just above `if (window === 'first_come_first_claimed' &&
   broadcastStillStands(cls))` ("Only the broadcast needs a gate…"): append
   "`handleSpotFreed` applies the same gate again under the lock; this one
   only saves the round-trip."

Then read the whole docblock of every function touched in this task
(`handleSpotFreed`, `broadcastStillStands`, `reconcileOne`), not just the
edited lines, for any other sentence now false. A grep finds a stale name,
not a stale description.

- [ ] **Step 6: Run to GREEN, then the neighbours**

Run: `pnpm exec vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts`
Expected: the whole file PASSES, including the pre-existing gate tests
(`does not re-broadcast while a broadcast still stands`,
`re-broadcasts once a claim has consumed the seat and another frees`,
`broadcasts despite a broadcast flag stamped before the claim window`).

Then run every other unit-tier file that invokes `handleSpotFreed`:
`pnpm exec vitest run src/services/waitlist.test.ts src/services/waitlist-lock-order.test.ts src/services/class-transitions.test.ts src/services/gdpr.test.ts src/services/sweep-page-ceiling.test.ts src/lib/api-errors.test.ts "src/app/api/registrations/[id]/promote-after-cancel.test.ts" "src/app/api/registrations/[id]/route.test.ts" src/app/api/registrations/route-lock-order.test.ts`

Expected: PASS. A failure asserting a **second** `spot_available` per waiter in
one claim window, with no fill in between, is this change's intended
behaviour. Report it to the controller with the test name rather than editing
it silently. Any other failure is a defect.

Then `pnpm run typecheck && pnpm run lint`. Expected: clean.

- [ ] **Step 7: Commit, then prove each guard bites**

```bash
git add src/services/waitlist.ts src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "fix(waitlist): decline a spot broadcast under the lock when one already stands (#691)"
```

Mutation 1: in `handleSpotFreed`, replace
`if (broadcastStillStands(current)) {` with `if (false && broadcastStillStands(current)) {`.
Run the `-t "the broadcast gate under the class row lock"` command from Step 2.
Expected: the first two tests FAIL with 2 notifications per waiter (or `second`
/ `hook` being `{ action: 'broadcast', … }`). Record the assertion text.
Restore: `git checkout -- src/services/waitlist.ts`.

Mutation 2: in `broadcastStillStands`, replace
`return cls.spotBroadcastAt >= claimWindowStart(cls.calendarEntry, cls.calendarEntry.teacher.defaultTimezone);`
with `return true;`. Run the whole file. Expected: `broadcasts from the live
hook despite a flag stamped before the claim window` FAILS, and so does the
sweep's own `broadcasts despite a broadcast flag stamped before the claim
window`. Record both. Restore: `git checkout -- src/services/waitlist.ts`.

Confirm `git status --short` prints nothing.

---

### Task 2: The interleaving pin, in both orders

**Files:**
- Test: `src/services/waitlist-reconciliation.test.ts`: add to the nested
  `describe('the broadcast gate under the class row lock', …)` from Task 1.

**Interfaces:**
- Consumes: Task 1's under-lock gate in `handleSpotFreed`. The test is RED
  without it.
- Consumes (existing): `lockClassRow` from `@/lib/db-locks`, spied on through
  the module namespace, the pattern `src/app/api/classes/[id]/complete/route-lock-order.test.ts`
  uses; `joinOrThrow` from `tests/lock-order-teardown.ts`.

Why this test exists, since Task 1's pins do not cover it: the sequential
tests read state after the previous call committed. So reading
`spotBroadcastAt` from the **pre-lock** `cls` instead of the locked re-read
passes all of them. Only a caller that did its pre-lock reads while the other
side held the lock, before the flag was written, can tell the two apart.

- [ ] **Step 1: Add the harness helpers**

Imports at the top of the test file:

```ts
import * as dbLocks from '@/lib/db-locks';
import { joinOrThrow } from '../../tests/lock-order-teardown';
```

Inside the nested `describe`, before its first `it`:

```ts
    function latch(): { promise: Promise<void>; open: () => void } {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      return { promise, open };
    }

    /**
     * Pauses the FIRST `lockClassRow` on `classId` right after it holds the
     * row, before the caller reads anything under it, and records that
     * backend's pid. Later calls lock normally, so they park behind it. The
     * paused side holds the lock rather than waiting on one, so only the
     * parked side is on `lockClassRow`'s 2s `lock_timeout` clock, and only
     * from the moment it parks.
     */
    function pauseFirstLockOn(classId: string): {
      reached: Promise<void>;
      pid: () => number;
      release: () => void;
    } {
      const reached = latch();
      const held = latch();
      let pid = 0;
      let paused = false;
      const original = dbLocks.lockClassRow;
      const spy = vi.spyOn(dbLocks, 'lockClassRow').mockImplementation(async (tx, id) => {
        const lock = await original(tx, id);
        if (id === classId && !paused) {
          paused = true;
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
          if (row === undefined) throw new Error('pg_backend_pid returned no row');
          pid = row.pid;
          reached.open();
          await held.promise;
        }
        return lock;
      });
      onTestFinished(() => spy.mockRestore());
      return { reached: reached.promise, pid: () => pid, release: held.open };
    }

    async function within(signal: Promise<void>, ms: number, label: string): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          signal,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} never happened within ${ms}ms`)), ms);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /** Polls until some backend is parked on a lock `holderPid` holds. */
    async function parkedBehind(holderPid: number): Promise<number> {
      const deadline = Date.now() + 1_500;
      while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND ${holderPid} = ANY(pg_blocking_pids(pid))
           LIMIT 1`;
        if (row !== undefined) return row.pid;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`nothing parked behind backend ${holderPid} within 1500ms`);
    }
```

If the spy's parameter types do not line up with `lockClassRow`'s under
`strict`, match whatever the `complete/route-lock-order.test.ts` spy does.
Never add a cast that widens `tx`. A cast passes every type check, which is
exactly how a harness stops testing anything.

- [ ] **Step 2: Write the test**

```ts
    /**
     * The race the issue describes, staged rather than hoped for, in both
     * orders. The first caller holds the class row lock and is paused before it
     * reads anything under it. The second then does all of its pre-lock
     * reading (the sweep's candidate query and gate, `handleSpotFreed`'s own
     * `findUnique`) and parks. Everything it read says no broadcast stands,
     * because none has been written yet. Only the locked re-read can find the
     * first caller's broadcast, which is what the sequential tests above cannot
     * distinguish from a read of the pre-lock `cls`.
     */
    it.each([{ first: 'hook' as const }, { first: 'sweep' as const }])(
      'announces one freed seat once when the $first holds the lock and the other caller parks behind it',
      async ({ first }) => {
        const cls = await makeFreedSeat(`Race${first}`, { waiters: 2 });
        const clocks = windowClocks(cls.startTime);
        const scoped = scopeSweep(prisma, { WaitlistEntry: { classId: { in: [cls.id] } } });
        const hook = () => handleSpotFreed(prisma, cls.id, clocks.inClaimWindow);
        const sweep = () =>
          reconcileWaitlists(scoped.db, { now: clocks.inClaimWindow, streaks: createReconciliationStreaks() });

        // Installed after the fixture, whose `addToWaitlist` calls take this lock too.
        const pause = pauseFirstLockOn(cls.id);
        let firstRun: Promise<unknown> | undefined;
        let secondRun: Promise<unknown> | undefined;
        try {
          firstRun = first === 'hook' ? hook() : sweep();
          await within(pause.reached, 2_000, `the ${first} holding the class row`);
          secondRun = first === 'hook' ? sweep() : hook();
          await parkedBehind(pause.pid());
        } finally {
          pause.release();
          await joinOrThrow(firstRun, secondRun);
        }

        for (const waiter of cls.waiters) {
          expect(await spotNotifications(cls.id, waiter)).toBe(1);
        }
        expect(await broadcastFlag(cls.id)).toEqual(clocks.inClaimWindow);
      },
      30_000,
    );
```

- [ ] **Step 3: Run it and confirm GREEN, three times**

Run: `pnpm exec vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts -t "announces one freed seat once"`
Expected: both cases PASS. Run it three times. A harness that passes once and
times out the next run is not done. If `parkedBehind` throws, the second caller
never parked: either the spy did not intercept (so `within` would have thrown
first), or the second caller returned early. Diagnose which before touching the
timeouts.

- [ ] **Step 4: Commit, then prove it catches what Task 1's pins cannot**

```bash
git add src/services/waitlist-reconciliation.test.ts
git commit -m "test(waitlist): stage the sweep/hook race for one freed seat, in both orders (#691)"
```

Mutation 1 again (disable the gate): replace `if (broadcastStillStands(current)) {`
with `if (false && broadcastStillStands(current)) {`. Run Step 3's command.
Expected: both cases FAIL with 2 per waiter. Record the text. Restore with
`git checkout -- src/services/waitlist.ts`.

Mutation 3 (read the flag before the lock): replace
`if (broadcastStillStands(current)) {` with
`if (broadcastStillStands({ ...current, spotBroadcastAt: cls.spotBroadcastAt })) {`.
Run Step 3's command, then the Task 1 `-t "the broadcast gate under the class row lock"`
command.
Expected: **both** interleaving cases FAIL with 2 per waiter, because the
second caller's pre-lock `cls` read `null`. Task 1's sequential tests PASS,
because each call's `cls` read came after the previous commit. That split is
the reason this task exists; record both halves. Restore with
`git checkout -- src/services/waitlist.ts`.

Confirm `git status --short` prints nothing.

---

## Branch verification (controller, after both tasks)

- `pnpm run worktree:setup` (once), then `pnpm run worktree:up`, so the
  integration tier runs against this worktree's own app. Then
  `pnpm run verify`. The integration files that exercise the cancel hook
  (`tests/integration/registrations-api.test.ts`,
  `tests/integration/waitlist-api.test.ts`) are covered by that run and are not
  touched by this branch.
- `pnpm run worktree:down` when done.
- The PR body records: that #220's spec (§4.3) accepted only the
  sweep-reads-first ordering; that both orderings are closed; the mutation
  results with their exact failing assertions; that Task 1's third test passes
  pre-fix by design; and **#680 is unaffected**.
