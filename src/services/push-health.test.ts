import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { MisconfiguredVapid, PushDispatchResult } from './push-dispatch';
import {
  createPushDispatchTick,
  createPushHealthState,
  observePushTick,
  pushAlarm,
  PushDispatchDegradedError,
  PUSH_ALARM_QUIET_MS,
  PUSH_MAX_FAILED_TICKS,
  runPushDispatchTick,
  type PushHealthState,
} from './push-health';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const dispatchPushes = vi.hoisted(() => vi.fn());
vi.mock('./push-dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./push-dispatch')>()),
  dispatchPushes,
}));

const NONE: { sent: number; failed: number; misconfigured: MisconfiguredVapid | null } = { sent: 0, failed: 0, misconfigured: null };
const T0 = 1_000_000;

function completed(r: Partial<typeof NONE>) {
  return { kind: 'completed', result: { ...NONE, ...r } } as const;
}

function after(state: PushHealthState, results: Array<Partial<typeof NONE>>, startMs = T0): PushHealthState {
  return results.reduce((s, r, i) => observePushTick(s, completed(r), startMs + i * 10_000), state);
}

describe('observePushTick', () => {
  it.each([
    ['a tick that only failed', 1, { failed: 2 }],
    ['a tick under a misconfiguration, claimed rows or not', 1, { misconfigured: 'partial' as const }],
    ['a tick where nothing was attempted', 0, {}],
  ])('%s moves the count to %i', (_label, expected, result) => {
    expect(observePushTick(createPushHealthState(), completed(result), T0).failedTicks).toBe(expected);
  });

  it('is not a total failure when some devices delivered, so the count resets', () => {
    const failing = after(createPushHealthState(), [{ failed: 1 }, { failed: 1 }]);
    expect(failing.failedTicks).toBe(2);
    expect(observePushTick(failing, completed({ sent: 1, failed: 4 }), T0 + 30_000).failedTicks).toBe(0);
  });

  it('leaves the count alone for an idle tick', () => {
    const failing = after(createPushHealthState(), [{ failed: 1 }, { failed: 1 }]);
    expect(observePushTick(failing, completed({}), T0 + 60_000)).toBe(failing);
  });

  it('restarts the count from one when the last failed tick is a quiet window old, not before', () => {
    const failing = after(createPushHealthState(), [{ failed: 1 }, { failed: 1 }]);
    const last = failing.lastFailedAt as number;
    expect(observePushTick(failing, completed({ failed: 1 }), last + PUSH_ALARM_QUIET_MS - 1).failedTicks).toBe(3);
    expect(observePushTick(failing, completed({ failed: 1 }), last + PUSH_ALARM_QUIET_MS).failedTicks).toBe(1);
  });

  describe('lastCause', () => {
    it('is null while nothing has failed', () => {
      expect(createPushHealthState().lastCause).toBeNull();
      expect(after(createPushHealthState(), [{}, { sent: 1 }]).lastCause).toBeNull();
    });

    it.each([
      ['failed sends', { failed: 1 }, { kind: 'send-failed' }],
      ['a misconfiguration, with its reason', { misconfigured: 'pair-mismatch' as const }, { kind: 'misconfigured', reason: 'pair-mismatch' }],
    ])('names %s', (_label, result, cause) => {
      expect(after(createPushHealthState(), [result]).lastCause).toEqual(cause);
    });

    it('names the fault of a tick that threw', () => {
      const state = observePushTick(createPushHealthState(), { kind: 'threw', faultName: 'PushSendFault' }, T0);
      expect(state).toMatchObject({ failedTicks: 1, lastFailedAt: T0, lastCause: { kind: 'fault', name: 'PushSendFault' } });
    });

    it('is replaced by the next failing tick and kept through quiet ones', () => {
      const faulted = observePushTick(createPushHealthState(), { kind: 'threw', faultName: 'PushSendFault' }, T0);
      expect(observePushTick(faulted, completed({}), T0 + 10_000).lastCause).toEqual({ kind: 'fault', name: 'PushSendFault' });
      expect(observePushTick(faulted, completed({ failed: 1 }), T0 + 10_000).lastCause).toEqual({ kind: 'send-failed' });
    });

    it('is dropped with the count when a delivery resets it', () => {
      const failing = after(createPushHealthState(), [{ failed: 1 }]);
      expect(observePushTick(failing, completed({ sent: 1 }), T0 + 10_000).lastCause).toBeNull();
    });
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
    retired: 0, claimed: 0, sent: 0, gone: 0, invalid: 0, failed: 0, unsendable: 0, misconfigured: null, ...r,
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

  it('starts a new streak from one after the alarm has expired', async () => {
    const { tick, advance } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 }, {}, { failed: 1 }, { failed: 1 }, { failed: 1 });
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    advance(PUSH_ALARM_QUIET_MS);
    await expect(tick(db)).resolves.toBeDefined();
    await expect(tick(db)).resolves.toBeDefined();
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

  it('raises the alarm for a misconfiguration on ticks that claim nothing', async () => {
    const { tick } = harness({ misconfigured: 'partial' }, { misconfigured: 'partial' }, { misconfigured: 'partial' });
    await tick(db);
    await tick(db);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
  });

  it('says why in the error: the misconfiguration and its reason', async () => {
    const { tick } = harness(...Array.from({ length: PUSH_MAX_FAILED_TICKS }, () => ({ misconfigured: 'pair-mismatch' as const })));
    let err: unknown;
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS; i++) err = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).lastCause).toEqual({ kind: 'misconfigured', reason: 'pair-mismatch' });
    expect((err as PushDispatchDegradedError).message).toContain('VAPID_* misconfigured (pair-mismatch)');
  });

  it('says why in the error: failed sends', async () => {
    const { tick } = harness(...Array.from({ length: PUSH_MAX_FAILED_TICKS }, () => ({ failed: 1 })));
    let err: unknown;
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS; i++) err = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).message).toContain('(last: sends failed)');
  });

  it('keeps naming the fault on the quiet ticks after it, where the fault itself has stopped', async () => {
    class SomeFault extends Error {
      constructor() {
        super('boom');
        this.name = 'SomeFault';
      }
    }
    let n = 0;
    const tick = createPushDispatchTick(async () => {
      n += 1;
      if (n <= PUSH_MAX_FAILED_TICKS) throw new SomeFault();
      return result({});
    }, () => T0);
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS; i++) await tick(db).catch(() => undefined);
    const err: unknown = await tick(db).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushDispatchDegradedError);
    expect((err as PushDispatchDegradedError).message).toContain('(last: tick threw SomeFault)');
  });

  it('names a non-Error throw without leaking its value', async () => {
    let n = 0;
    const tick = createPushDispatchTick(async () => {
      n += 1;
      if (n <= PUSH_MAX_FAILED_TICKS) throw 'a secret string';
      return result({});
    }, () => T0);
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS; i++) await tick(db).catch(() => undefined);
    const err: unknown = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).message).toContain('(last: tick threw a non-Error)');
    expect((err as PushDispatchDegradedError).message).not.toContain('secret');
  });

  it('names how many ticks it has seen fail', async () => {
    const { tick } = harness({ failed: 1 }, { failed: 1 }, { failed: 1 });
    await tick(db);
    await tick(db);
    const err: unknown = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).failedTicks).toBe(PUSH_MAX_FAILED_TICKS);
  });

  it('names the whole streak, not just the threshold', async () => {
    const { tick } = harness(...Array.from({ length: PUSH_MAX_FAILED_TICKS + 2 }, () => ({ failed: 1 })));
    let err: unknown;
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS + 2; i++) err = await tick(db).catch((e: unknown) => e);
    expect((err as PushDispatchDegradedError).failedTicks).toBe(PUSH_MAX_FAILED_TICKS + 2);
    expect((err as PushDispatchDegradedError).message).not.toMatch(/consecutive/);
  });

  it('counts a tick whose dispatch throws as a failed tick, and the fault itself reaches the caller', async () => {
    const fault = new Error('send fault');
    const outcomes: Array<PushDispatchResult | Error> = [result({ failed: 1 }), fault, result({ failed: 1 })];
    const tick = createPushDispatchTick(async () => {
      const next = outcomes.shift();
      if (!next) throw new Error('harness: out of results');
      if (next instanceof Error) throw next;
      return next;
    }, () => T0);
    await tick(db);
    // The second failed tick is the fault; the caller still sees the fault.
    await expect(tick(db)).rejects.toBe(fault);
    // Uncounted, this would be only the second failed tick.
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
  });

  it('keeps the alarm standing on the quiet ticks after repeated faults, where the fault itself stops', async () => {
    const fault = new Error('send fault');
    let n = 0;
    const tick = createPushDispatchTick(async () => {
      n += 1;
      if (n <= PUSH_MAX_FAILED_TICKS) throw fault;
      return result({});
    }, () => T0);
    for (let i = 0; i < PUSH_MAX_FAILED_TICKS; i++) await expect(tick(db)).rejects.toBe(fault);
    await expect(tick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
  });

  it('keeps each tick function\'s streak to itself', async () => {
    const a = harness({ failed: 1 }, { failed: 1 });
    const b = harness({ failed: 1 });
    await a.tick(db);
    await a.tick(db);
    await expect(b.tick(db)).resolves.toBeDefined();
  });
});

describe('runPushDispatchTick', () => {
  it('is the health-wrapped dispatchPushes: it hands dispatchPushes the db and alarms on a failing streak', async () => {
    const db = { identity: 'the singleton run' } as unknown as PrismaClient;
    dispatchPushes.mockResolvedValue({ retired: 0, claimed: 1, sent: 0, gone: 0, invalid: 0, failed: 1, unsendable: 0, misconfigured: null });
    await runPushDispatchTick(db);
    await runPushDispatchTick(db);
    await expect(runPushDispatchTick(db)).rejects.toBeInstanceOf(PushDispatchDegradedError);
    expect(dispatchPushes).toHaveBeenCalledTimes(PUSH_MAX_FAILED_TICKS);
    for (const call of dispatchPushes.mock.calls) expect(call[0]).toBe(db);
  });
});
