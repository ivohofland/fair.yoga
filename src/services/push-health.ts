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
