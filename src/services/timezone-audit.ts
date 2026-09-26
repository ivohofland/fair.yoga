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
 * WHAT CAN PUT A BAD VALUE THERE. Every HTTP write path parses the column
 * through `isValidTimeZone`, refusing or dropping a zone it fails (the write
 * paths are listed in `docs/data-model.md`, Design Notes → "Teacher timezones
 * are stored under their current IANA name"), so validated traffic cannot.
 * Two things can: a direct database edit, which is a normal operation on the
 * single VPS this project targets, and a writer
 * that bypasses the schema — `prisma/seed.ts` already writes the column
 * straight through Prisma, so that is a demonstrated shape rather than a
 * hypothetical one. The column is a bare `String`, so neither gets a
 * compile-time signal.
 *
 * OFFSET IDENTIFIERS FLAG TOO. `isValidTimeZone` refuses `+18:00` and its
 * kin although `Intl` resolves them, so a stored one fails this audit. Its
 * calendar boundaries are correct — it is not silently UTC — but it is not a
 * real IANA zone, and `cancelCandidateDates` bounds its window by the IANA
 * offset range, so an offset beyond it is never read by auto-cancel.
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
 * rather than a code one, and `/api/cron/daily-cleanup` answers 500 on every
 * call until the row is fixed. That is deliberate, and the same trade
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
  /** The distinct zone strings `isValidTimeZone` refuses, sorted for a
   * stable log line. */
  readonly invalid: readonly string[];
}

/**
 * Thrown when at least one live teacher holds a zone `isValidTimeZone`
 * refuses: one `Intl` cannot resolve, or an offset identifier.
 *
 * Carries the zone strings rather than teacher ids: the repair is
 * `UPDATE "Teacher" SET "defaultTimezone" = '<good>' WHERE
 * "defaultTimezone" = '<bad>'`, which needs only these.
 */
export class InvalidTimezoneError extends Error {
  constructor(public readonly zones: readonly string[]) {
    super(`stored teacher timezones are unresolvable or offset identifiers: ${zones.join(', ')}`);
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
      'stored teacher timezones are unresolvable or offset identifiers — an unresolvable zone makes every calendar boundary silently UTC; an offset can escape the auto-cancel window',
    );
    throw new InvalidTimezoneError(summary.invalid);
  }

  log.info(summary, 'teacher timezone audit: every stored zone is a valid IANA zone');
  return summary;
}
