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
    ['a tick that only failed', 1, { failed: 2 }],
    ['a tick that only could not send', 1, { unsendable: 3 }],
    ['a tick where nothing was attempted', 0, {}],
  ])('%s moves the count to %i', (_label, expected, result) => {
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

  it('a tick whose dispatch throws leaves the streak where it was, and the throw reaches the caller', async () => {
    const fault = new Error('send fault');
    const outcomes: Array<PushDispatchResult | Error> = [result({ failed: 1 }), fault, result({ failed: 1 })];
    const tick = createPushDispatchTick(async () => {
      const next = outcomes.shift();
      if (!next) throw new Error('harness: out of results');
      if (next instanceof Error) throw next;
      return next;
    }, () => T0);
    await tick(db);
    await expect(tick(db)).rejects.toBe(fault);
    // Counted, the thrown tick would make this the 3rd failed tick.
    await expect(tick(db)).resolves.toBeDefined();
  });

  it('keeps each tick function\'s streak to itself', async () => {
    const a = harness({ failed: 1 }, { failed: 1 });
    const b = harness({ failed: 1 });
    await a.tick(db);
    await a.tick(db);
    await expect(b.tick(db)).resolves.toBeDefined();
  });
});
