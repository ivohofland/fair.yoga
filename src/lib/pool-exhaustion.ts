import { logDegraded } from '@/lib/degradation';
import type { PoolCounters } from '@/lib/prisma-client';

/** How long `/api/health` reads `degraded` after the last pool exhaustion. */
export const POOL_EXHAUSTION_HEALTH_WINDOW_MS = 15 * 60_000;

declare global {
  var __fairYogaPoolExhaustion: { lastAt: Date | null } | undefined;
}

// Process-wide: the writer is the shared client's hook, in whichever layer
// built it, and the reader is the health route, in another (CLAUDE.md,
// "State the whole process must share lives on globalThis").
const state = (globalThis.__fairYogaPoolExhaustion ??= { lastAt: null });

/**
 * The shared client's `onPoolExhausted`: stamps the time for the health
 * check, then records `DATABASE_POOL_EXHAUSTED`. Never throws and returns
 * nothing to await; the recording is `logDegraded`'s fire-and-forget write,
 * which meets the same dry pool and may itself time out.
 */
export function recordPoolExhaustion(counters: PoolCounters): void {
  state.lastAt = new Date();
  logDegraded('DATABASE_POOL_EXHAUSTED', counters, 'a database query timed out waiting for a pooled connection');
}

/** When this process last saw a pool wait time out; null if never since it started. */
export function lastPoolExhaustionAt(): Date | null {
  return state.lastAt;
}

/** True when the last pool exhaustion is less than `POOL_EXHAUSTION_HEALTH_WINDOW_MS` before `now`. */
export function poolExhaustedWithin(now: Date): boolean {
  return state.lastAt !== null && now.getTime() - state.lastAt.getTime() < POOL_EXHAUSTION_HEALTH_WINDOW_MS;
}
