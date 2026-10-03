import type { PrismaClient } from '@prisma/client';
import { dispatchPushes, PUSH_STALE_AFTER_MS, type PushDispatchResult } from './push-dispatch';

/** Failed ticks, each within the quiet window of the last and with no delivery between, before the push job reports itself degraded. */
export const PUSH_MAX_FAILED_TICKS = 3;

/**
 * The alarm stands only while its last failed tick is younger than this: the
 * same age after which a push describes a moment that has passed.
 */
export const PUSH_ALARM_QUIET_MS = PUSH_STALE_AFTER_MS;

/** `lastFailedAt` is null exactly when no tick has failed. */
export type PushHealthState = Readonly<
  | { failedTicks: 0; lastFailedAt: null }
  | { failedTicks: number; lastFailedAt: number }
>;

export function createPushHealthState(): PushHealthState {
  return { failedTicks: 0, lastFailedAt: null };
}

type TickEvidence = Pick<PushDispatchResult, 'sent' | 'failed' | 'unsendable'>;

/**
 * A delivery resets the count, even from a tick that also failed elsewhere:
 * the alarm says push is delivering nothing, not that every send succeeded. A
 * tick that failed or could not send extends it, or starts it over at one when
 * the previous failed tick is a quiet window old. Anything else (idle, or only
 * `gone` / `invalid` verdicts, which a push service answers when it is
 * working) leaves it alone.
 */
export function observePushTick(state: PushHealthState, result: TickEvidence, nowMs: number): PushHealthState {
  if (result.sent > 0) return createPushHealthState();
  if (result.failed > 0 || result.unsendable > 0) {
    const stale = state.lastFailedAt !== null && nowMs - state.lastFailedAt >= PUSH_ALARM_QUIET_MS;
    return { failedTicks: stale ? 1 : state.failedTicks + 1, lastFailedAt: nowMs };
  }
  return state;
}

/** Raised at the threshold and cleared when its last failed tick ages out. */
export function pushAlarm(state: PushHealthState, nowMs: number): boolean {
  return (
    state.lastFailedAt !== null &&
    state.failedTicks >= PUSH_MAX_FAILED_TICKS &&
    nowMs - state.lastFailedAt < PUSH_ALARM_QUIET_MS
  );
}

export class PushDispatchDegradedError extends Error {
  constructor(public readonly failedTicks: number) {
    super(`push delivered nothing in ${failedTicks} failing ticks`);
    this.name = 'PushDispatchDegradedError';
  }
}

/**
 * The job's `run`. The scheduler reads a job's health from whether its run
 * throws (docs/technical-architecture.md, Cron Jobs), so the alarm is checked
 * on every tick, idle ones included: a standing alarm throws, an expired one
 * returns normally.
 */
export function createPushDispatchTick(
  dispatch: (db: PrismaClient) => Promise<PushDispatchResult>,
  clock: () => number = Date.now,
): (db: PrismaClient) => Promise<PushDispatchResult> {
  let state = createPushHealthState();
  return async (db) => {
    let result: PushDispatchResult;
    try {
      result = await dispatch(db);
    } catch (fault) {
      // A fault is a failed tick whatever else the tick delivered, and the
      // fault itself, not the alarm, is what the caller sees.
      state = observePushTick(state, { sent: 0, failed: 1, unsendable: 0 }, clock());
      throw fault;
    }
    const nowMs = clock();
    state = observePushTick(state, result, nowMs);
    if (pushAlarm(state, nowMs)) throw new PushDispatchDegradedError(state.failedTicks);
    return result;
  };
}

export const runPushDispatchTick = createPushDispatchTick((db) => dispatchPushes(db));
