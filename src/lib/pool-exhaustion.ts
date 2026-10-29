import { logDegraded } from '@/lib/degradation';
import type { FireAndForget } from '@/lib/fire-and-forget';
import type { PoolCounters } from '@/lib/prisma-client';

/** The window `poolExhaustedWithin` answers for, after the last pool exhaustion. */
export const POOL_EXHAUSTION_HEALTH_WINDOW_MS = 15 * 60_000;

declare global {
  var __fairYogaPoolExhaustion: { lastAt: Date | null } | undefined;
}

// Process-wide, so every module instance in the process reads the same stamp
// (CLAUDE.md, "State the whole process must share lives on globalThis"). Read
// per call, so a holder replaced or cleared is the one the next call sees.
function holder(): { lastAt: Date | null } {
  return (globalThis.__fairYogaPoolExhaustion ??= { lastAt: null });
}

/**
 * The shared client's `onPoolExhausted`: stamps the time, then records
 * `DATABASE_POOL_EXHAUSTED`. Never throws.
 */
export function recordPoolExhaustion(counters: PoolCounters): FireAndForget {
  holder().lastAt = new Date();
  logDegraded('DATABASE_POOL_EXHAUSTED', counters, 'a database query timed out waiting for a pooled connection');
}

/** When this process last saw a pool wait time out; null if never since it started. */
export function lastPoolExhaustionAt(): Date | null {
  return holder().lastAt;
}

/** True when the last pool exhaustion is less than `POOL_EXHAUSTION_HEALTH_WINDOW_MS` before `now`. */
export function poolExhaustedWithin(now: Date): boolean {
  const { lastAt } = holder();
  return lastAt !== null && now.getTime() - lastAt.getTime() < POOL_EXHAUSTION_HEALTH_WINDOW_MS;
}
