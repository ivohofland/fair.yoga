/**
 * Stored-timezone audit (#145) — a daily read-only sweep that asks whether
 * every live teacher's `defaultTimezone` still resolves.
 *
 * WHY IT EXISTS. `startOfLocalDay` and `classStartInstant` (`lib/timezone.ts`)
 * both fall back to UTC when a zone will not resolve, rather than throwing —
 * a crashed cron run is a worse failure than a wrong date. The cost of that
 * choice is that every teacher-facing calendar boundary silently becomes UTC:
 * the schedule window, the past/upcoming split, the auto-cancel check, the
 * reporting month cutoff. West of UTC each is wrong for part of every day.
 * Those two fallbacks now log at `error`; this sweep is what finds the bad
 * value without anyone having to be reading logs at the moment it is used.
 *
 * WHAT CAN PUT A BAD VALUE THERE. `updateTeacherSchema` refines the column
 * through `isValidTimeZone`, and that schema gates the only HTTP write path,
 * so validated traffic cannot. Two things can: a direct database edit, which
 * is a normal operation on the single VPS this project targets, and a writer
 * that bypasses the schema — `prisma/seed.ts` already writes the column
 * straight through Prisma, so that is a demonstrated shape rather than a
 * hypothetical one. The column is a bare `String`, so neither gets a
 * compile-time signal.
 *
 * NOT tzdata renames, despite that being the motivating story on the issue.
 * Measured 2026-09-01 on Node v22.22.2 with full ICU: every renamed and
 * deprecated identifier probed still resolves, because ICU ships IANA's
 * `backward` links — `Europe/Kiev` is even present in
 * `Intl.supportedValuesOf('timeZone')`. No identifier is known that ICU
 * accepted once and rejects now. This sweep would catch such a value if one
 * ever appeared; that is not why it is here.
 *
 * WHY IT THROWS rather than only logging. Throwing is what makes the existing
 * machinery carry the signal: `isolatedSweeps` logs it under the sweep name,
 * `makeTick` records `lastError` and withholds `lastSuccessAt`, and
 * `/api/health` reports `healthy: false` with `status: 'degraded'`. The cost
 * is that this job then reports unhealthy indefinitely for a data problem
 * rather than a code one, and `/api/cron/daily-cleanup` answers 500 nightly
 * until the row is fixed. That is deliberate, and the same trade
 * `RetentionFailedError` makes in `waitlist-retention.ts`.
 *
 * LIVE TEACHERS ONLY. Erasure soft-deletes and does not touch this column, so
 * an erased teacher's stale zone would flag forever with nothing to fix and no
 * surface reading it.
 */

import type { PrismaClient } from '@prisma/client';
import { isValidTimeZone } from '@/lib/iana-timezone';
import { log } from '@/lib/log';

/** One run's outcome. All `readonly`, constructed once. */
export interface TimezoneAuditSummary {
  /** Distinct stored zones probed across all live teachers. */
  readonly checked: number;
  /** Live teachers holding one of the `invalid` zones. */
  readonly teachers: number;
  /** The distinct unresolvable zone strings, sorted for a stable log line. */
  readonly invalid: readonly string[];
}

/**
 * Thrown when at least one live teacher holds a zone `Intl` cannot resolve.
 *
 * Carries the zone strings rather than teacher ids: the repair is
 * `UPDATE "Teacher" SET "defaultTimezone" = '<good>' WHERE
 * "defaultTimezone" = '<bad>'`, which needs only these.
 */
export class InvalidTimezoneError extends Error {
  constructor(public readonly zones: readonly string[]) {
    super(`stored teacher timezones no longer resolve: ${zones.join(', ')}`);
    this.name = 'InvalidTimezoneError';
  }
}

export async function auditTeacherTimezones(
  db: PrismaClient,
): Promise<TimezoneAuditSummary> {
  // `groupBy`, not `findMany({ distinct })`, for the reason
  // `waitlist-retention.ts` records at its own opening statement: Prisma does
  // not compile `distinct` into SQL, so that shape would select one row per
  // TEACHER and dedupe in the query engine. The `_count` rides along free and
  // is what lets the summary report affected teachers as well as zones.
  const rows = await db.teacher.groupBy({
    by: ['defaultTimezone'],
    where: { deletedAt: null },
    _count: { _all: true },
  });

  const bad = rows.filter((r) => !isValidTimeZone(r.defaultTimezone));

  const summary: TimezoneAuditSummary = {
    checked: rows.length,
    teachers: bad.reduce((n, r) => n + r._count._all, 0),
    invalid: bad.map((r) => r.defaultTimezone).sort(),
  };

  if (summary.invalid.length > 0) {
    log.error(
      summary,
      'stored teacher timezones are unresolvable — every calendar boundary for these teachers is silently UTC',
    );
    throw new InvalidTimezoneError(summary.invalid);
  }

  log.info(summary, 'teacher timezone audit: every stored zone resolves');
  return summary;
}
