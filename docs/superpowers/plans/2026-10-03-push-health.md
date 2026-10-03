# Push health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/health` reports a sustained all-failed push state within a stated bound and clears it on its own, and a slow push service can no longer make `push-dispatch` read as stalled.

**Architecture:** `dispatchPushes` claims each notification just before sending it, through a pool of 4 workers that stop claiming 10 s into a tick, so a tick is bounded at deadline + one send timeout and the scheduler's stall threshold stays at 2. A small pure module (`push-health.ts`) tracks a streak of ticks that tried to send and delivered nothing; the job throws `PushDispatchDegradedError` while that streak stands and its last failed tick is younger than 15 minutes.

**Tech Stack:** TypeScript strict, Vitest (`unit` and `unit-sweeps` projects), Prisma.

**Spec:** `docs/superpowers/specs/2026-10-03-push-health-design.md`

## Global Constraints

- `STALLED_AFTER_SKIPPED_TICKS` stays `2`; no per-job threshold is added (spec, "Why the obvious shapes are wrong").
- `PUSH_WORKERS = 4`; `PUSH_CLAIM_DEADLINE_MS = 10_000`; the send timeout is the existing `DEFAULT_TIMEOUT_MS = 5_000` in `src/lib/push/send.ts`.
- `PUSH_MAX_FAILED_TICKS = 3`; `PUSH_ALARM_QUIET_MS = PUSH_STALE_AFTER_MS` (15 minutes).
- Only a delivery (`sent > 0`) resets the failed-tick count. `gone` / `invalid` / idle ticks leave it unchanged. `failed > 0` or `unsendable > 0` with `sent === 0` extends it.
- A VAPID configuration that is *unset* is neutral; any other `VapidConfigProblem` is a failure (`unsendable`). An explicit `null` sender passed by a caller is *not* a misconfiguration.
- A claimed row is never abandoned: once `pushHandledAt` is stamped, its sends run to an outcome. Only unclaimed rows are deferred.
- Per-send `warn` and the per-tick `info` line are unchanged.
- Comments state what is true now (CLAUDE.md, Comment Discipline): no counts or rosters in prose; arithmetic lives in the spec and `docs/technical-architecture.md`.
- Stage exact paths; never `git add -A`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A tick where some devices deliver and some fail is not a total failure: the count resets (Task 2, `observePushTick` table).
2. One failed send after the alarm has expired re-raises it at once, not from 1 (Task 2, `createPushDispatchTick`).
3. A misconfigured `VAPID_*` is a failure but an unset one is not, and an explicit `null` sender is neither (Task 1, `unsendable` tests).
4. A deadline hit mid-tick leaves every claimed row with an outcome and every unclaimed row `pushHandledAt: null` (Task 1, deadline test).
5. One worker's claim failure still waits for the other workers' in-flight sends before the tick rejects (Task 1, the existing "holds every send" test must keep passing unedited).

---

## Task 0: Environment

Run once in the worktree; not a commit.

- [ ] **Step 1:** `pnpm install --frozen-lockfile` (a fresh worktree has no `node_modules`, and every `pnpm run` exits 1 until it does).
- [ ] **Step 2:** `pnpm run worktree:setup`, then `pnpm run worktree:up` (the `unit-sweeps` tier needs the worktree's own database).
- [ ] **Step 3:** Baseline: `pnpm exec vitest run --project unit-sweeps src/services/push-dispatch.test.ts` and `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`. Expected: both green. Record the pass counts in the ledger; Task 1 must not lower the first.

---

## Task 1: `dispatchPushes` claims just in time, stops at a deadline, counts `unsendable`

**Files:**
- Modify: `src/lib/push/send.ts` (export the timeout constant)
- Modify: `src/services/push-dispatch.ts`
- Test: `src/services/push-dispatch.test.ts` (runs in `unit-sweeps`; already registered in `SWEEP_TESTS`)

**Interfaces:**
- Produces, from `push-dispatch.ts`: `PUSH_WORKERS: number`, `PUSH_CLAIM_DEADLINE_MS: number`; `PushDispatchResult` gains `unsendable: number`; `dispatchPushes(db, send?, now?, clock?)` where `clock: () => number` defaults to `Date.now`.
- Produces, from `lib/push/send.ts`: `DEFAULT_TIMEOUT_MS` (now exported; value unchanged).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing tests** in `src/services/push-dispatch.test.ts`.

Extend the import line:

```ts
import { dispatchPushes, PUSH_BATCH, PUSH_CLAIM_DEADLINE_MS, PUSH_STALE_AFTER_MS, PUSH_WORKERS, PushSendFault, type PushSender } from './push-dispatch';
import { DEFAULT_TIMEOUT_MS, PUSH_TTL_SECONDS, sendPush } from '@/lib/push/send';
```

Add inside `describe('dispatchPushes', …)`, directly after the `'claims the oldest candidates first…'` test:

```ts
  describe('the claim deadline', () => {
    /** One notification per candidate, all for the one-device student account. */
    async function seedBatch(total: number): Promise<string[]> {
      await subscribe(studentAccountId, 'deadline');
      const now = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < total; i++) {
        const n = await notify({
          recipientType: 'student',
          recipientId: studentId,
          type: 'spot_available',
          createdAt: new Date(now - 60_000 + i * 1000),
        });
        ids.push(n.id);
      }
      return ids;
    }

    it('stops claiming once the deadline passes, leaving the rest unclaimed and every claimed row with an outcome', async () => {
      const ids = await seedBatch(20);
      // Each send "takes" one send timeout on a clock the test owns, the way
      // a push service that never answers does.
      let fakeNow = 1_000_000;
      const send: PushSender = vi.fn(async () => {
        fakeNow += DEFAULT_TIMEOUT_MS;
        return { outcome: 'failed' as const, status: null };
      });

      const result = await dispatchPushes(scoped(ids).db, send, new Date(), () => fakeNow);

      // Every worker claims once before any send can move the clock, and a
      // worker finishing after the clock has run one deadline's worth of
      // sends claims no more.
      expect(result.claimed).toBeGreaterThanOrEqual(PUSH_WORKERS);
      expect(result.claimed).toBeLessThanOrEqual(PUSH_WORKERS * Math.ceil(PUSH_CLAIM_DEADLINE_MS / DEFAULT_TIMEOUT_MS));
      expect(result.failed).toBe(result.claimed);
      const rows = await prisma.notification.findMany({ where: { id: { in: ids } }, select: { pushHandledAt: true } });
      expect(rows.filter((r) => r.pushHandledAt !== null)).toHaveLength(result.claimed);
    });

    it('serves the deferred rows on the next tick', async () => {
      const ids = await seedBatch(12);
      let fakeNow = 1_000_000;
      const slow: PushSender = vi.fn(async () => {
        fakeNow += DEFAULT_TIMEOUT_MS;
        return { outcome: 'failed' as const, status: null };
      });
      const first = await dispatchPushes(scoped(ids).db, slow, new Date(), () => fakeNow);
      expect(first.claimed).toBeLessThan(12);

      const { send, calls } = recordingSender();
      const second = await dispatchPushes(scoped(ids).db, send);

      expect(second.claimed).toBe(12 - first.claimed);
      expect(calls).toHaveLength(12 - first.claimed);
    });

    it('claims nothing when the clock is exactly at the deadline', async () => {
      const ids = await seedBatch(3);
      let reads = 0;
      const clock = () => (reads++ === 0 ? 0 : PUSH_CLAIM_DEADLINE_MS);
      const { send } = recordingSender();

      const result = await dispatchPushes(scoped(ids).db, send, new Date(), clock);

      expect(result.claimed).toBe(0);
    });

    it('claims while the clock is one millisecond short of the deadline', async () => {
      const ids = await seedBatch(3);
      let reads = 0;
      const clock = () => (reads++ === 0 ? 0 : PUSH_CLAIM_DEADLINE_MS - 1);
      const { send } = recordingSender();

      const result = await dispatchPushes(scoped(ids).db, send, new Date(), clock);

      expect(result.claimed).toBe(3);
    });
  });

  it('sends to a recipient\'s devices in parallel, so one slow device does not hold the others', async () => {
    await subscribe(studentAccountId, 'par-1');
    await subscribe(studentAccountId, 'par-2');
    await subscribe(studentAccountId, 'par-3');
    const n = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
    // Each send waits for all three to be in flight; a sender that ran them
    // one after another would wait on the first forever.
    const allArrived = deferred<void>();
    let inFlight = 0;
    const send: PushSender = vi.fn(async () => {
      inFlight += 1;
      if (inFlight === 3) allArrived.resolve();
      await allArrived.promise;
      return { outcome: 'delivered' as const, status: 201 };
    });

    const result = await dispatchPushes(scoped([n.id]).db, send);

    expect(result.sent).toBe(3);
  });
```

Inside `describe('reporting a VAPID environment it cannot use', …)`, add after `'only warns when no VAPID variable is set'`:

```ts
    it('counts the rows it claimed as unsendable for a misconfiguration, never for an unset environment', async () => {
      const n1 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      const n2 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      vi.stubEnv('VAPID_PUBLIC_KEY', generateVapidKeyPair().publicKey);
      vi.stubEnv('VAPID_PRIVATE_KEY', generateVapidKeyPair().privateKey);
      vi.stubEnv('VAPID_SUBJECT', 'mailto:ops@fair.yoga');
      const misconfigured = await freshModule();

      const bad = await misconfigured.freshDispatch(scoped([n1.id, n2.id]).db);

      expect(bad).toMatchObject({ claimed: 2, unsendable: 2, sent: 0 });

      const n3 = await notify({ recipientType: 'student', recipientId: studentId, type: 'spot_available' });
      vi.stubEnv('VAPID_PUBLIC_KEY', undefined);
      vi.stubEnv('VAPID_PRIVATE_KEY', undefined);
      vi.stubEnv('VAPID_SUBJECT', undefined);
      const unset = await freshModule();

      const none = await unset.freshDispatch(scoped([n3.id]).db);

      expect(none).toMatchObject({ claimed: 1, unsendable: 0 });
    });
```

In the existing test `'retires rows without sending when push is not configured'`, change the assertion to pin that an explicit `null` is not a misconfiguration:

```ts
      expect(result).toMatchObject({ claimed: 1, sent: 0, unsendable: 0 });
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project unit-sweeps src/services/push-dispatch.test.ts`
Expected: the new tests FAIL (`PUSH_CLAIM_DEADLINE_MS`/`PUSH_WORKERS`/`DEFAULT_TIMEOUT_MS` not exported, so the file fails to compile or the values are `undefined`). Record the failure text.

- [ ] **Step 3: Export the timeout.** In `src/lib/push/send.ts` change `const DEFAULT_TIMEOUT_MS = 5_000;` to `export const DEFAULT_TIMEOUT_MS = 5_000;`.

- [ ] **Step 4: Implement** in `src/services/push-dispatch.ts`.

Replace the imports and constants block (drop `createConcurrencyLimit`, and `SEND_CONCURRENCY`):

```ts
import type { PrismaClient, PushSubscription, RecipientType } from '@prisma/client';
import { log } from '@/lib/log';
import { diagnoseVapidConfig, type VapidConfigProblem } from '@/lib/push/config';
import { sendPush, type PushSendResult, type PushTarget } from '@/lib/push/send';
import { buildPushPayload, pushUrgency, shouldPush, type PushPayload, type PushRecipient, type PushUrgency } from '@/lib/push-policy';

/** A push older than this would describe a moment that has passed (a seat already claimed). */
export const PUSH_STALE_AFTER_MS = 15 * 60 * 1000;
export const PUSH_BATCH = 50;
/** Notifications in flight at once; each fans out to its recipient's devices in parallel. */
export const PUSH_WORKERS = 4;
/**
 * No notification is claimed once a tick has run this long. A tick therefore
 * ends within one send timeout of it, which is what keeps the job under the
 * scheduler's stall line (derivation in `docs/technical-architecture.md`,
 * Cron Jobs; pinned in `scheduler.test.ts`).
 */
export const PUSH_CLAIM_DEADLINE_MS = 10_000;
```

Add `unsendable` to the result type:

```ts
export interface PushDispatchResult {
  retired: number;
  claimed: number;
  sent: number;
  gone: number;
  invalid: number;
  failed: number;
  /** Rows claimed while push was misconfigured (not merely unset): nobody could be told. */
  unsendable: number;
}
```

Replace `defaultSender` with:

```ts
interface ResolvedSender {
  sender: PushSender | null;
  /** True when `VAPID_*` is set but unusable; an unset environment is a choice, not a fault. */
  misconfigured: boolean;
}

function resolveSender(send: PushSender | null | undefined): ResolvedSender {
  if (send !== undefined) return { sender: send, misconfigured: false };
  const diagnosis = diagnoseVapidConfig();
  if (!diagnosis.ok) {
    reportUnconfigured(diagnosis.reason);
    return { sender: null, misconfigured: diagnosis.reason !== 'unset' };
  }
  const { keys } = diagnosis;
  return { sender: (target, payload, urgency) => sendPush(target, payload, keys, { urgency }), misconfigured: false };
}
```

Replace `dispatchPushes` from its signature through its final `return result;` with:

```ts
export async function dispatchPushes(
  db: PrismaClient,
  send: PushSender | null | undefined = undefined,
  now: Date = new Date(),
  clock: () => number = Date.now,
): Promise<PushDispatchResult> {
  const { sender, misconfigured } = resolveSender(send);
  const cutoff = new Date(now.getTime() - PUSH_STALE_AFTER_MS);
  const result: PushDispatchResult = { retired: 0, claimed: 0, sent: 0, gone: 0, invalid: 0, failed: 0, unsendable: 0 };

  const retired = await db.notification.updateMany({
    where: { pushHandledAt: null, createdAt: { lte: cutoff } },
    data: { pushHandledAt: now },
  });
  result.retired = retired.count;

  const candidates = await db.notification.findMany({
    where: { pushHandledAt: null, createdAt: { gt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: PUSH_BATCH,
    select: { id: true, recipientType: true, recipientId: true, type: true, title: true, body: true },
  });

  const claimDeadline = clock() + PUSH_CLAIM_DEADLINE_MS;
  const failures: TaskFailure[] = [];
  let next = 0;

  // Never rejects: a send's fault is carried as a RESOLVED `TaskFailure`
  // naming its notification and subscription, so nothing here can become a
  // process-level `unhandledRejection` while another worker still awaits.
  async function sendTo(
    notificationId: string,
    sub: PushSubscription,
    deliver: PushSender,
    payload: PushPayload,
    urgency: PushUrgency,
  ): Promise<TaskFailure | undefined> {
    try {
      // A throw here is a fault, not a verdict on the subscription: it
      // fails this tick and the row stays.
      const { outcome, status, cause, reason } = await deliver(sub, payload, urgency);
      switch (outcome) {
        case 'delivered':
          result.sent += 1;
          await db.pushSubscription.updateMany({ where: { id: sub.id }, data: { lastUsedAt: now } });
          return undefined;
        case 'gone':
          result.gone += 1;
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
          return undefined;
        case 'invalid':
          result.invalid += 1;
          await db.pushSubscription.deleteMany({ where: { id: sub.id } });
          return undefined;
        case 'failed':
          result.failed += 1;
          log.warn({ notificationId, subscriptionId: sub.id, status, cause, reason }, 'push send failed; not retried');
          return undefined;
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`unhandled push outcome ${String(_exhaustive)}`);
        }
      }
    } catch (err: unknown) {
      return { err, notificationId, subscriptionId: sub.id };
    }
  }

  // A worker claims a notification only when it is about to send it, so a
  // row nobody reached before the deadline is still unclaimed and the next
  // tick takes it. A claimed row is never given back: its sends always run
  // to an outcome.
  async function worker(): Promise<void> {
    for (;;) {
      if (clock() >= claimDeadline) return;
      const n = candidates[next];
      next += 1;
      if (n === undefined) return;
      const claim = await db.notification.updateMany({
        where: { id: n.id, pushHandledAt: null },
        data: { pushHandledAt: now },
      });
      if (claim.count !== 1) continue;
      result.claimed += 1;
      if (!sender) {
        if (misconfigured) result.unsendable += 1;
        continue;
      }

      const resolved = await resolveRecipient(db, n.recipientType, n.recipientId);
      if (!resolved || !shouldPush(resolved.recipient, n.type)) continue;

      const subscriptions = await db.pushSubscription.findMany({ where: { accountId: resolved.accountId } });
      const payload = buildPushPayload(n);
      const urgency = pushUrgency(n.recipientType, n.type);
      const outcomes = await Promise.all(subscriptions.map((sub) => sendTo(n.id, sub, sender, payload, urgency)));
      failures.push(...outcomes.filter(isTaskFailure));
    }
  }

  // Every worker is awaited whether another threw or not — a send must never
  // outlive its tick on either path.
  const settled = await Promise.allSettled(Array.from({ length: PUSH_WORKERS }, () => worker()));
  const crashed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
  const [firstCrash, ...otherCrashes] = crashed;
  if (firstCrash) {
    // A worker's own failure (a claim or a read) is the error that
    // propagates; every send fault is still logged.
    logTaskFailures(failures);
    for (const other of otherCrashes) log.error({ err: other.reason as unknown }, 'push dispatch worker failed');
    const reason: unknown = firstCrash.reason;
    throw reason;
  }

  const [firstFailure, ...otherFailures] = failures;
  if (firstFailure) {
    logTaskFailures(otherFailures);
    throw new PushSendFault(firstFailure.notificationId, firstFailure.subscriptionId, firstFailure.err);
  }

  if (result.failed + result.gone + result.invalid + result.retired + result.unsendable > 0) {
    log.info({ ...result }, 'push dispatch tick');
  }
  return result;
}
```

Keep `TaskFailure`, `PushSendFault`, `isTaskFailure`, `logTaskFailures` and `resolveRecipient` exactly as they are. Remove the now-unused `reportedUnconfigured`-adjacent `defaultSender` function (replaced above); keep `reportUnconfigured`.

Update the `dispatchPushes` docblock's last sentence only if it names the concurrency limit; it should state what the function does now (claims per notification, just before sending).

- [ ] **Step 5: Run the file.**

Run: `pnpm exec vitest run --project unit-sweeps src/services/push-dispatch.test.ts`
Expected: PASS, including every pre-existing test **unedited** except the one `unsendable: 0` assertion. If a pre-existing `toEqual` on the whole result fails for lack of `unsendable`, add `unsendable: 0` to that expectation and note it in the ledger. The three tests that pin error propagation (`'never leaves an early task rejection unhandled…'`, `'holds every send for the tick before surfacing a claim failure…'`, `'logs a send fault when a claim failure is the error that propagates'`) must pass without any edit.

- [ ] **Step 6: Typecheck and lint the touched files.**

Run: `pnpm exec tsc --noEmit` and `pnpm exec eslint src/services/push-dispatch.ts src/services/push-dispatch.test.ts src/lib/push/send.ts`
Expected: clean. (`createConcurrencyLimit` still has another importer, `src/services/teacher-photo.ts`, so `src/lib/concurrency-limit.ts` stays.)

- [ ] **Step 7: Commit the green state, then mutate.**

```bash
git add src/lib/push/send.ts src/services/push-dispatch.ts src/services/push-dispatch.test.ts
git commit -m "feat(push): claim each notification just before sending, stop at a deadline, count unsendable (#743)"
```

Then, one at a time, apply each mutation, run `pnpm exec vitest run --project unit-sweeps src/services/push-dispatch.test.ts`, record the failing test name and message, and restore with `git checkout -- src/services/push-dispatch.ts`. Warm nothing; these are unit tests.

| # | Mutation | Expected red |
|---|---|---|
| M1 | delete the `if (clock() >= claimDeadline) return;` line | `stops claiming once the deadline passes…` (claimed 20 > 8) |
| M2 | change `>=` to `>` in that line | `claims nothing when the clock is exactly at the deadline` |
| M3 | in `resolveSender` set `misconfigured: true` for the unset case (drop the `!== 'unset'`) | `counts the rows it claimed as unsendable…` (unset case) |
| M4 | in the `!sender` branch delete `if (misconfigured)` so it always counts | the explicit-`null` test (`unsendable: 0`) |
| M5 | replace `Promise.allSettled(` with `Promise.all(` | `holds every send for the tick before surfacing a claim failure…` |
| M6 | replace `Promise.all(subscriptions.map(` with a `for…of` loop that awaits each send | `sends to a recipient's devices in parallel…` (times out) |

- [ ] **Step 8: Assert the sweep ended clean.** `git status --short` must print nothing. If it prints a modified file, a mutation was left behind — `git checkout -- <file>` and re-run Step 5.

---

## Task 2: The failure streak and the job's tick

**Files:**
- Create: `src/services/push-health.ts`
- Test: `src/services/push-health.test.ts` (pure; runs in the parallel `unit` tier, which includes `src/**/*.test.ts`)

**Interfaces:**
- Consumes, from Task 1: `PushDispatchResult` (with `unsendable`), `PUSH_STALE_AFTER_MS`, `dispatchPushes` from `./push-dispatch`.
- Produces: `PUSH_MAX_FAILED_TICKS: number`, `PUSH_ALARM_QUIET_MS: number`, `PushHealthState`, `createPushHealthState(): PushHealthState`, `observePushTick(state, result, nowMs): PushHealthState`, `pushAlarm(state, nowMs): boolean`, `PushDispatchDegradedError`, `createPushDispatchTick(dispatch, clock?)`, `runPushDispatchTick(db): Promise<PushDispatchResult>`.

- [ ] **Step 1: Write the failing tests** — `src/services/push-health.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PushDispatchResult } from './push-dispatch';
import {
  createPushDispatchTick,
  createPushHealthState,
  observePushTick,
  pushAlarm,
  PushDispatchDegradedError,
  PUSH_ALARM_QUIET_MS,
  PUSH_MAX_FAILED_TICKS,
  type PushHealthState,
} from './push-health';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const NONE = { sent: 0, failed: 0, unsendable: 0 };
const T0 = 1_000_000;

function after(state: PushHealthState, results: Array<Partial<typeof NONE>>, startMs = T0): PushHealthState {
  return results.reduce((s, r, i) => observePushTick(s, { ...NONE, ...r }, startMs + i * 10_000), state);
}

describe('observePushTick', () => {
  it.each([
    ['a tick that only failed', { failed: 2 }, 1],
    ['a tick that only could not send', { unsendable: 3 }, 1],
    ['a tick where nothing was attempted', {}, 0],
  ])('%s moves the count to %i', (_label, result, expected) => {
    expect(observePushTick(createPushHealthState(), { ...NONE, ...result }, T0).failedTicks).toBe(expected);
  });

  it('is not a total failure when some devices delivered, so the count resets', () => {
    const failing = after(createPushHealthState(), [{ failed: 1 }, { failed: 1 }]);
    expect(failing.failedTicks).toBe(2);
    expect(observePushTick(failing, { sent: 1, failed: 4, unsendable: 0 }, T0 + 30_000).failedTicks).toBe(0);
  });

  it('leaves the count alone for an idle tick', () => {
    const failing = after(createPushHealthState(), [{ failed: 1 }, { failed: 1 }]);
    expect(observePushTick(failing, NONE, T0 + 60_000)).toBe(failing);
  });

  it('records when the last failed tick was', () => {
    const state = after(createPushHealthState(), [{ failed: 1 }, {}, { failed: 1 }, {}]);
    expect(state.lastFailedAt).toBe(T0 + 20_000);
  });
});

describe('pushAlarm', () => {
  const failedTicks = (n: number) => after(createPushHealthState(), Array.from({ length: n }, () => ({ failed: 1 })));
  const lastFailed = (n: number) => T0 + (n - 1) * 10_000;

  it('is quiet one failed tick short of the threshold and raised at it', () => {
    expect(pushAlarm(failedTicks(PUSH_MAX_FAILED_TICKS - 1), lastFailed(PUSH_MAX_FAILED_TICKS - 1))).toBe(false);
    expect(pushAlarm(failedTicks(PUSH_MAX_FAILED_TICKS), lastFailed(PUSH_MAX_FAILED_TICKS))).toBe(true);
  });

  it('stands until its last failed tick is exactly the quiet window old, then clears', () => {
    const state = failedTicks(PUSH_MAX_FAILED_TICKS);
    const at = lastFailed(PUSH_MAX_FAILED_TICKS);
    expect(pushAlarm(state, at + PUSH_ALARM_QUIET_MS - 1)).toBe(true);
    expect(pushAlarm(state, at + PUSH_ALARM_QUIET_MS)).toBe(false);
  });

  it('is never raised for a state that has never failed', () => {
    expect(pushAlarm(createPushHealthState(), T0)).toBe(false);
  });
});

describe('createPushDispatchTick', () => {
  const db = {} as PrismaClient;
  const result = (r: Partial<PushDispatchResult>): PushDispatchResult => ({
    retired: 0, claimed: 0, sent: 0, gone: 0, invalid: 0, failed: 0, unsendable: 0, ...r,
  });

  function harness(...results: Array<Partial<PushDispatchResult>>) {
    const queue = results.map(result);
    let nowMs = T0;
    const dispatch = vi.fn(async () => {
      const next = queue.shift();
      if (!next) throw new Error('harness: out of results');
      return next;
    });
    const tick = createPushDispatchTick(dispatch, () => nowMs);
    return { tick, advance: (ms: number) => { nowMs += ms; } };
  }

  it('returns the dispatch result untouched while the streak is short', async () => {
    const { tick } = harness({ failed: 1 }, { failed: 1 });
    await expect(tick(db)).resolves.toMatchObject({ failed: 1 });
    await expect(tick(db)).resolves.toMatchObject({ failed: 1 });
  });

  it('throws on the threshold tick and keeps throwing on idle ticks inside the window', async () => {
    const { tick, advance } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 }, {}, {});
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    advance(PUSH_ALARM_QUIET_MS - 1);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    advance(1);
    await expect(tick(db)).resolves.toBeDefined();
  });

  it('re-raises on the very next failed tick after expiry, not from one', async () => {
    const { tick, advance } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 }, {}, { failed: 1 });
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    advance(PUSH_ALARM_QUIET_MS);
    await expect(tick(db)).resolves.toBeDefined();
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
  });

  it('clears for good on a delivery, and the next failure starts from one', async () => {
    const { tick } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 }, { sent: 1 }, { failed: 1 });
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    await expect(tick(db)).resolves.toBeDefined();
    await expect(tick(db)).resolves.toBeDefined();
  });

  it('counts rows claimed under a misconfiguration the same as failed sends', async () => {
    const { tick } = harness({ unsendable: 1 }, { unsendable: 1 }, { unsendable: 1 });
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
  });

  it('names how many ticks it has seen fail', async () => {
    const { tick } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 });
    await tick(db);
    await tick(db);
    const err: unknown = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).failedTicks).toBe(PUSH_MAX_FAILED_TICKS);
  });

  it('does not observe a tick that threw, and passes the throw through', async () => {
    const fault = new Error('send fault');
    const tick = createPushDispatchTick(async () => { throw fault; }, () => T0);
    await expect(tick(db)).rejects.toBe(fault);
  });

  it('keeps each tick function\'s streak to itself', async () => {
    const a = harness({ failed: 1 }, { failed: 1 });
    const b = harness({ failed: 1 });
    await a.tick(db);
    await a.tick(db);
    await expect(b.tick(db)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm exec vitest run --project unit src/services/push-health.test.ts`
Expected: FAIL — cannot resolve `./push-health`.

- [ ] **Step 3: Implement** `src/services/push-health.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { dispatchPushes, PUSH_STALE_AFTER_MS, type PushDispatchResult } from './push-dispatch';

/** Ticks that tried to send and delivered nothing, in a row, before the push job reports itself degraded. */
export const PUSH_MAX_FAILED_TICKS = 3;

/**
 * The alarm stands only while its last failed tick is younger than this: the
 * same age after which a push describes a moment that has passed.
 */
export const PUSH_ALARM_QUIET_MS = PUSH_STALE_AFTER_MS;

export interface PushHealthState {
  /** Ticks since the last delivery that failed at least once or could not send. */
  failedTicks: number;
  lastFailedAt: number | null;
}

export function createPushHealthState(): PushHealthState {
  return { failedTicks: 0, lastFailedAt: null };
}

type TickEvidence = Pick<PushDispatchResult, 'sent' | 'failed' | 'unsendable'>;

/**
 * A delivery resets the count; a tick that failed or could not send extends it;
 * anything else (idle, or only `gone` / `invalid` verdicts, which a push
 * service answers when it is working) leaves it alone.
 */
export function observePushTick(state: PushHealthState, result: TickEvidence, nowMs: number): PushHealthState {
  if (result.sent > 0) return createPushHealthState();
  if (result.failed > 0 || result.unsendable > 0) {
    return { failedTicks: state.failedTicks + 1, lastFailedAt: nowMs };
  }
  return state;
}

/** Raised at the threshold and cleared when its last failed tick ages out; the count itself survives the silence. */
export function pushAlarm(state: PushHealthState, nowMs: number): boolean {
  return (
    state.lastFailedAt !== null &&
    state.failedTicks >= PUSH_MAX_FAILED_TICKS &&
    nowMs - state.lastFailedAt < PUSH_ALARM_QUIET_MS
  );
}

export class PushDispatchDegradedError extends Error {
  constructor(public readonly failedTicks: number) {
    super(`push delivered nothing in ${failedTicks} consecutive ticks that tried to send`);
    this.name = 'PushDispatchDegradedError';
  }
}

/**
 * The job's `run`. The alarm check happens on every tick, idle ones included,
 * because `makeTick` clears the job's error on any tick that does not throw:
 * throwing while the alarm stands is what keeps health red, and not throwing
 * once it has aged out is what clears it.
 */
export function createPushDispatchTick(
  dispatch: (db: PrismaClient) => Promise<PushDispatchResult>,
  clock: () => number = Date.now,
): (db: PrismaClient) => Promise<PushDispatchResult> {
  let state = createPushHealthState();
  return async (db) => {
    const result = await dispatch(db);
    const nowMs = clock();
    state = observePushTick(state, result, nowMs);
    if (pushAlarm(state, nowMs)) throw new PushDispatchDegradedError(state.failedTicks);
    return result;
  };
}

export const runPushDispatchTick = createPushDispatchTick((db) => dispatchPushes(db));
```

- [ ] **Step 4: Run to verify it passes.**

Run: `pnpm exec vitest run --project unit src/services/push-health.test.ts`
Expected: PASS. Then `pnpm exec tsc --noEmit` and `pnpm exec eslint src/services/push-health.ts src/services/push-health.test.ts`: clean.

- [ ] **Step 5: Commit, then mutate.**

```bash
git add src/services/push-health.ts src/services/push-health.test.ts
git commit -m "feat(push): an expiring streak of failed ticks raises PushDispatchDegradedError (#743)"
```

| # | Mutation (in `push-health.ts`) | Expected red |
|---|---|---|
| M1 | `result.sent > 0` → `result.sent > 1` | the `is not a total failure when some devices delivered` test |
| M2 | delete `|| result.unsendable > 0` | `counts rows claimed under a misconfiguration…` and the `could not send` table row |
| M3 | `state.failedTicks >= PUSH_MAX_FAILED_TICKS` → `>` | `is quiet one failed tick short…` |
| M4 | `nowMs - state.lastFailedAt < PUSH_ALARM_QUIET_MS` → `<=` | `stands until its last failed tick is exactly the quiet window old…` |
| M5 | in `observePushTick` the idle branch returns `createPushHealthState()` instead of `state` | `leaves the count alone for an idle tick` and `re-raises on the very next failed tick…` |
| M6 | in the `sent > 0` branch return `state` unchanged | `clears for good on a delivery…` |
| M7 | move `state`'s declaration to module scope (shared across ticks) | `keeps each tick function's streak to itself` |

Restore each with `git checkout -- src/services/push-health.ts`. End with `git status --short` printing nothing.

---

## Task 3: Wire the job, and pin the stall arithmetic

**Files:**
- Modify: `src/lib/scheduler.ts` (the `SchedulerSweeps` slot, `startScheduler`'s import and pass-through, the job table entry and its comment)
- Modify: `src/lib/scheduler.test.ts`

**Interfaces:**
- Consumes: `runPushDispatchTick` (Task 2), `PUSH_CLAIM_DEADLINE_MS` (Task 1), `DEFAULT_TIMEOUT_MS` (Task 1).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests** in `src/lib/scheduler.test.ts`.

In `SWEEP_NAMES` replace `'dispatchPushes'` with `'runPushDispatchTick'`. In the job→sweep routing expectation replace `'push-dispatch': ['dispatchPushes'],` with `'push-dispatch': ['runPushDispatchTick'],`. Add the imports:

```ts
import { PUSH_CLAIM_DEADLINE_MS } from '@/services/push-dispatch';
import { DEFAULT_TIMEOUT_MS } from '@/lib/push/send';
```

Add inside the `describe` that holds `'registers each job under its name at its intended interval'`, right after it:

```ts
  /**
   * The push job is not given a stall budget of its own: its tick is bounded
   * instead. A tick ends within one send timeout of the claim deadline, so
   * the longest it can run must leave the next tick refused at most once.
   * Retuning the deadline, the timeout or the interval past this line would
   * bring back the false stall (#743) with nothing else failing.
   */
  it('keeps a push tick shorter than the scheduler\'s stall line', () => {
    const job = buildJobs(buildStubs(() => async () => {})).find((j) => j.name === 'push-dispatch');
    if (!job) throw new Error('push-dispatch is not in the job table');
    expect(PUSH_CLAIM_DEADLINE_MS + DEFAULT_TIMEOUT_MS).toBeLessThan(STALLED_AFTER_SKIPPED_TICKS * job.intervalMs);
  });
```

- [ ] **Step 2: Run to verify it fails.**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
Expected: FAIL — `SchedulerSweeps` has no `runPushDispatchTick` (type error / routing mismatch: the table still routes `dispatchPushes`).

- [ ] **Step 3: Implement** in `src/lib/scheduler.ts`. Find each site with `grep -n "dispatchPushes" src/lib/scheduler.ts` and change:

- the `SchedulerSweeps` member `dispatchPushes: (db: PrismaClient) => Promise<unknown>;` → `runPushDispatchTick: (db: PrismaClient) => Promise<unknown>;`
- in `startScheduler`: `const { dispatchPushes } = await import('@/services/push-dispatch');` → `const { runPushDispatchTick } = await import('@/services/push-health');`, and the pass-through key `dispatchPushes,` → `runPushDispatchTick,`
- in `buildJobs`: the destructured `dispatchPushes,` → `runPushDispatchTick,`, and the entry:

```ts
    {
      // Push is a best-effort layer ahead of email; this interval is its
      // latency. The tick is bounded below the stall line by its claim
      // deadline rather than by a threshold of its own, and an all-failed
      // streak surfaces as a thrown `PushDispatchDegradedError`
      // (`docs/technical-architecture.md`, Cron Jobs).
      name: 'push-dispatch',
      intervalMs: 10 * 1000,
      run: (db) => runPushDispatchTick(db),
    },
```

- [ ] **Step 4: Run to verify it passes.**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
Expected: PASS. Then `pnpm exec tsc --noEmit`: clean (the compile-time pins that tie `SWEEP_NAMES` to `SchedulerSweeps` fail first if a name is missed).

- [ ] **Step 5: Commit, then mutate.**

```bash
git add src/lib/scheduler.ts src/lib/scheduler.test.ts
git commit -m "feat(push): wire the push job through runPushDispatchTick and pin its tick under the stall line (#743)"
```

| # | Mutation | Expected red |
|---|---|---|
| M1 | `PUSH_CLAIM_DEADLINE_MS = 15_000` in `push-dispatch.ts` (15 + 5 = 20, not < 20) | `keeps a push tick shorter than the scheduler's stall line` |
| M2 | `intervalMs: 10 * 1000` → `5 * 1000` for push-dispatch in `scheduler.ts` | the same test, and `registers each job under its name…` |
| M3 | in `scheduler.ts` pass `dispatchPushes` instead of `runPushDispatchTick` in the job entry | the routing test |

Restore with `git checkout -- <file>`; end with `git status --short` printing nothing.

---

## Task 4: Docs, and the whole-branch verification

**Files:**
- Modify: `docs/technical-architecture.md` (Cron Jobs, the Push dispatch row; Web Push, the `dispatchPushes` bullet)

- [ ] **Step 1: Update the Cron Jobs row.** `grep -n "^| Push dispatch" docs/technical-architecture.md`. Keep its existing sentence about what the sweep reads, sends and retires, and replace the trailing clause about the tick's `info` line with:

```
; a tick that retired a row or had a send come back `failed`, `gone` or `invalid` logs one `info` line with the tick's counts. **Tick bound:** four workers each claim a notification just before sending it, in parallel across its devices, and stop claiming `PUSH_CLAIM_DEADLINE_MS` (10 s) into the tick, so a tick ends within one send timeout (`DEFAULT_TIMEOUT_MS`, 5 s) of that: at most 10 s + 5 s = 15 s, under the 20 s that `STALLED_AFTER_SKIPPED_TICKS` (2) × the 10 s interval allows. A timeout burst of any size therefore stays healthy; the rows it did not reach are unclaimed and wait for the next tick (or are retired as stale after 15 minutes). `scheduler.test.ts` ("keeps a push tick shorter than the scheduler's stall line") re-derives the inequality from the constants. **Degraded:** a tick that tried to send and delivered nothing (`sent === 0` with `failed > 0`, or rows claimed while `VAPID_*` is set but unusable) extends a streak; a delivery resets it; idle ticks and `gone` / `invalid` verdicts leave it alone. At 3 such ticks the job throws `PushDispatchDegradedError` and `/api/health` reports it degraded, on every tick until its last failed tick is 15 minutes old (`PUSH_ALARM_QUIET_MS`), then clears; the count survives that, so one failed send later re-raises it at once. Bound: about 30 s of continuous fast failures (the 3rd failed tick), at most 55 s when every send times out (ticks start 20 s apart because a 15 s tick refuses the next one); under sparse traffic it is the 3rd failed tick however far apart, since nothing can be observed without sends. While it stands the job logs one `error` per 10 s tick. A restart resets the streak.
```

- [ ] **Step 2: Update the Web Push bullet** (`grep -n "dispatchPushes" docs/technical-architecture.md`). Change "`services/push-dispatch.ts`'s `dispatchPushes` is the sweep wired into the scheduler" to say that `services/push-health.ts`'s `runPushDispatchTick` is wired into the scheduler and wraps `services/push-dispatch.ts`'s `dispatchPushes`; add that a worker claims each row just before its sends and that rows it never reached are left unclaimed. Leave the rest of the bullet alone.

- [ ] **Step 3: Sweep for what changed.** Run `grep -rn "dispatchPushes\|SEND_CONCURRENCY\|four sends\|concurrency" docs CLAUDE.md src --include="*.md" --include="*.ts" --include="*.tsx" | grep -v "docs/superpowers"`. Give every hit a verdict: `docs/data-model.md`'s "(`dispatchPushes`, `push-dispatch.ts`)" is still true; any remaining sentence describing a send-concurrency limit of 4 or a pre-claimed batch is stale — replace it. `docs/superpowers/**` are records and stay.

- [ ] **Step 4: Commit.**

```bash
git add docs/technical-architecture.md
git commit -m "docs: the push tick bound, the failed-tick streak and its expiry (#743)"
```

- [ ] **Step 5: Whole-branch verification.** Run `pnpm run verify` (typecheck, lint, the whole suite; the worktree runs against its own app after `pnpm run worktree:up`). Record the pass counts with their arithmetic. Then `pnpm run build` (CI also runs it, and `@/lib/log` imports `server-only`). Expected: green; `git status --short` empty.
