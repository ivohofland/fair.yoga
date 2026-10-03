import type { PrismaClient } from '@prisma/client';
import { dispatchPushes, PUSH_STALE_AFTER_MS, type MisconfiguredVapid, type PushDispatchResult } from './push-dispatch';

/** Failed ticks, each within the quiet window of the last and with no delivery between, before the push job reports itself degraded. */
export const PUSH_MAX_FAILED_TICKS = 3;

/**
 * The alarm stands only while its last failed tick is younger than this: the
 * same age after which a push describes a moment that has passed.
 */
export const PUSH_ALARM_QUIET_MS = PUSH_STALE_AFTER_MS;

/** Why the last failing tick failed. */
export type PushFailureCause =
  | { kind: 'misconfigured'; reason: MisconfiguredVapid }
  | { kind: 'send-failed' }
  | { kind: 'fault'; name: string };

/** `lastFailedAt` and `lastCause` are null exactly when no tick has failed. */
export type PushHealthState = Readonly<
  | { failedTicks: 0; lastFailedAt: null; lastCause: null }
  | { failedTicks: number; lastFailedAt: number; lastCause: PushFailureCause }
>;

export function createPushHealthState(): PushHealthState {
  return { failedTicks: 0, lastFailedAt: null, lastCause: null };
}

/** What a tick did: it returned a result, or it threw (a fault, whose `name` is all the health state keeps of it). */
export type PushTickObservation =
  | { kind: 'completed'; result: Pick<PushDispatchResult, 'sent' | 'failed' | 'misconfigured'> }
  | { kind: 'threw'; faultName: string };

function failureCause(observation: PushTickObservation): PushFailureCause | null {
  if (observation.kind === 'threw') return { kind: 'fault', name: observation.faultName };
  const { misconfigured, failed } = observation.result;
  if (misconfigured !== null) return { kind: 'misconfigured', reason: misconfigured };
  return failed > 0 ? { kind: 'send-failed' } : null;
}

/**
 * A delivery resets the count, even from a tick that also failed elsewhere:
 * the alarm says push is delivering nothing, not that every send succeeded. A
 * tick that threw, failed a send, or ran under a `VAPID_*` that cannot send
 * (claimed rows or not) extends it, or starts it over at one when the previous
 * failed tick is a quiet window old, and its cause replaces the last one.
 * Anything else (idle, or only `gone` / `invalid` verdicts, which a push
 * service answers when it is working) leaves count and cause alone.
 */
export function observePushTick(state: PushHealthState, observation: PushTickObservation, nowMs: number): PushHealthState {
  if (observation.kind === 'completed' && observation.result.sent > 0) return createPushHealthState();
  const lastCause = failureCause(observation);
  if (lastCause === null) return state;
  const stale = state.lastFailedAt !== null && nowMs - state.lastFailedAt >= PUSH_ALARM_QUIET_MS;
  return { failedTicks: stale ? 1 : state.failedTicks + 1, lastFailedAt: nowMs, lastCause };
}

/** Raised at the threshold and cleared when its last failed tick ages out. */
export function pushAlarm(state: PushHealthState, nowMs: number): boolean {
  return (
    state.lastFailedAt !== null &&
    state.failedTicks >= PUSH_MAX_FAILED_TICKS &&
    nowMs - state.lastFailedAt < PUSH_ALARM_QUIET_MS
  );
}

function describeCause(cause: PushFailureCause): string {
  switch (cause.kind) {
    case 'misconfigured':
      return `VAPID_* misconfigured (${cause.reason})`;
    case 'send-failed':
      return 'sends failed';
    case 'fault':
      return `tick threw ${cause.name}`;
    default: {
      const _exhaustive: never = cause;
      throw new Error(`unhandled push failure cause ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export class PushDispatchDegradedError extends Error {
  constructor(
    public readonly failedTicks: number,
    public readonly lastCause: PushFailureCause,
  ) {
    super(`push delivered nothing in ${failedTicks} failing ticks (last: ${describeCause(lastCause)})`);
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
      state = observePushTick(state, { kind: 'threw', faultName: fault instanceof Error ? fault.name : 'a non-Error' }, clock());
      throw fault;
    }
    const nowMs = clock();
    state = observePushTick(state, { kind: 'completed', result }, nowMs);
    if (state.lastCause !== null && pushAlarm(state, nowMs)) throw new PushDispatchDegradedError(state.failedTicks, state.lastCause);
    return result;
  };
}

export const runPushDispatchTick = createPushDispatchTick((db) => dispatchPushes(db));
