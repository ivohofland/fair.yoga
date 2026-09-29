/**
 * How long a generation sweep may keep skipping one template for lock
 * contention before the job reports itself unhealthy (#354).
 *
 * A skip is routine: a teacher's edit can hold the template row at the moment
 * the sweep claims it (#122). A row that stays locked on every sweep looks
 * identical inside any one sweep, and only repetition tells the two apart, so
 * the memory lives with the caller that persists across sweeps. Same shape
 * as `ReconciliationStreaks` (`waitlist-reconciliation.ts`).
 */

import { log } from '@/lib/log';

/**
 * Consecutive contended sweeps of ONE template before the job reports itself
 * degraded. Means "this has stood for a while"; the job's interval
 * (`scheduler.ts`) is what makes it a duration. `DEPLOYMENT.md` §7 states the
 * operator-facing tolerance.
 */
export const MAX_CONSECUTIVE_CONTENDED_SWEEPS = 3;

/** What one caller remembers between sweeps: consecutive contended sweeps per template id. */
export interface ContentionStreaks {
  readonly byTemplate: ReadonlyMap<string, number>;
}

/** This module's writable view of the tracker; callers hold only the readonly one. */
interface MutableContentionStreaks {
  byTemplate: Map<string, number>;
}

export interface ContendedTemplate {
  readonly templateId: string;
  readonly teacherId: string;
}

export function createContentionStreaks(): ContentionStreaks {
  return { byTemplate: new Map() } satisfies MutableContentionStreaks;
}

/** Thrown by a sweep in which at least one template reached the streak threshold. */
export class GenerationContendedError extends Error {
  constructor(
    logNoun: string,
    public readonly templateIds: readonly string[],
  ) {
    super(
      `${logNoun} generation skipped ${templateIds.length} template(s) for lock contention on ${MAX_CONSECUTIVE_CONTENDED_SWEEPS} or more consecutive sweeps`,
    );
    this.name = 'GenerationContendedError';
  }
}

/**
 * Folds one sweep's contended templates into the tracker and returns the error
 * the sweep should throw, or `null`.
 *
 * The map is REBUILT from this sweep's skips, so a template that was not
 * contended this sweep leaves it (its streak restarts) and the map's size is
 * bounded by the candidate set rather than by uptime. A template at or past
 * the threshold is logged at `error` on every such sweep, so the job stays
 * unhealthy for as long as the row stays locked.
 *
 * Because the map is rebuilt from the skips it is given, a tracker must see
 * every sweep of ONE candidate set: a sweep scoped to fewer templates that
 * shares the tracker resets the others' streaks. The tick wrappers are
 * unscoped, and scoped calls use their own tracker.
 */
export function recordSweepContention(
  streaks: ContentionStreaks,
  skipped: readonly ContendedTemplate[],
  logNoun: string,
): GenerationContendedError | null {
  // The one place the readonly view is set aside; see `MutableContentionStreaks`.
  const mutable = streaks as MutableContentionStreaks;
  const next = new Map<string, number>();
  const stuck: string[] = [];
  for (const { templateId, teacherId } of skipped) {
    const streak = (mutable.byTemplate.get(templateId) ?? 0) + 1;
    next.set(templateId, streak);
    if (streak >= MAX_CONSECUTIVE_CONTENDED_SWEEPS) {
      log.error(
        { templateId, teacherId, streak },
        `${logNoun} generation has skipped this template for lock contention on consecutive sweeps`,
      );
      stuck.push(templateId);
    }
  }
  mutable.byTemplate = next;
  return stuck.length > 0 ? new GenerationContendedError(logNoun, stuck) : null;
}
