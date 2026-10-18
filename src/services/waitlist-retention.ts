/**
 * Waitlist retention (#238) — deletes queue entries that never became a
 * booking, on classes that can never change again, once those classes are
 * older than the window.
 *
 * Why the sweep exists, and why deleting on its predicate is safe, are
 * arguments about other modules and the database's triggers:
 * `docs/technical-architecture.md` (Waitlist retention). Policy:
 * `docs/data-model.md` (WaitlistEntry → Retention).
 *
 * One class per transaction, each behind `lockClassRow` before its
 * `deleteMany`. The `Class` row lock is what keeps this sweep out of a cycle
 * with the erasure, at any batch size; one class per transaction only keeps
 * this off the multi-row `Class` lock sites and bounds how long it holds
 * locks against live traffic. The mechanism, rather than the multiplicity, is
 * argued in `docs/lock-order.md` (Known conformance →
 * `reapClosedWaitlistEntries`) — copy that argument, not the shape, into a
 * new site.
 */

import type { Prisma, PrismaClient } from '@/lib/prisma-client';
import { FULFILLED_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import { lockClassRow } from '@/lib/db-locks';
import { transientDbFailure } from '@/lib/api-errors';
import { log } from '@/lib/log';

/**
 * How long a closed, unfulfilled entry is kept after its class ran.
 *
 * 365 days, decided rather than defaulted (#238 parked it as a product/legal
 * call). A full annual cycle of a teacher's schedule is straightforwardly
 * defensible under Art. 5(1)(e), and the asymmetry decided the number: a period
 * can be tightened later by editing this line, while data deleted early cannot
 * be recovered.
 *
 * In code, not in an environment variable, because it is a policy someone
 * should be able to review in a diff.
 */
export const WAITLIST_RETENTION_DAYS = 365;

/**
 * How many classes one run will process.
 *
 * At steady state the daily volume is "classes that turned 366 days old today",
 * a handful, so this is unreachable in normal operation. It exists for the FIRST
 * run against accumulated history, to bound how long that run spends taking
 * `Class` row locks against live traffic on the single 2 GB VPS this project is
 * pinned to. Five hundred short transactions in a row is already a lot of
 * contention to hand a one-vCPU box; unbounded, a first run over years of
 * history would be worse, and every lock it holds is one a teacher's own request
 * may be waiting behind.
 *
 * Not because an unbounded run would stop the job through `scheduler.ts`'s
 * `running` guard. That guard drops ticks while a run is in flight, but the
 * interval is 24 h, so a run would have to exceed a full day to cost even one
 * tick — and the loop is over a finite `groupBy` result, so it terminates
 * regardless. A backlog drains at this rate per day.
 */
export const MAX_CLASSES_PER_RUN = 500;

/**
 * All `readonly`, and constructed exactly once at the end of the run.
 *
 * Built after the loop from locals, never early and mutated: an object built
 * before the loop would let an early return inside it report `deleted: 0`
 * while having permanently deleted rows — a summary that under-reports an
 * irreversible operation, which is the one direction this value must never be
 * wrong in. Constructing once makes that unrepresentable rather than merely
 * absent.
 */
export interface ReapSummary {
  /** Entries actually deleted. */
  readonly deleted: number;
  /** Classes this run attempted, after the cap. */
  readonly classes: number;
  /** Classes whose own transaction threw and were skipped. */
  readonly failed: number;
  /** True when more classes were eligible than the cap allowed. */
  readonly cappedOut: boolean;
  /**
   * How many classes were eligible in total. Exact on both paths.
   *
   * On the uncapped path it is `classes`, and that is the whole eligible set
   * rather than a floor: `take: maxClasses + 1` means a batch below the cap
   * cannot have left anything behind. On the capped path it is a real `COUNT`,
   * taken only there — `candidates.length` cannot answer this: it is always
   * exactly `maxClasses + 1` whenever `cappedOut`, a constant dressed as a
   * measurement. An operator needs the real figure to tell a backlog that drains
   * tomorrow from one that takes a hundred days. Hence `eligible`, not a hedged
   * `eligibleAtLeast`: the number is exact on every path.
   */
  readonly eligible: number;
  /**
   * The cutoff this run used, ISO-8601.
   *
   * For an irreversible policy-driven deletion, the window applied belongs in
   * the only durable record of the run.
   */
  readonly cutoff: string;
}

/** Options for {@link reapClosedWaitlistEntries}. */
export interface ReapOptions {
  /**
   * Clock injection. Production passes nothing; `retentionCutoff` is
   * UTC-boundary-sensitive, so tests pin it rather than letting the hour the
   * suite happens to run at decide the answer.
   */
  readonly now?: Date;
  /**
   * Override `MAX_CLASSES_PER_RUN`. Exists so the cap can be exercised without
   * 501 fixtures; no production caller sets it. Must be >= 1 — a smaller value
   * reaps nothing rather than reaping too much.
   *
   * Deliberately NOT range-checked at runtime: every out-of-range value fails
   * toward under-deletion, which is the safe direction for a permanent delete,
   * and there is no production caller to protect from itself.
   */
  readonly maxClasses?: number;
}

/**
 * Thrown when a run attempted at least one class and most or all of them
 * failed — the two conditions `report` throws on.
 *
 * Swallowing every per-class failure would let `scheduler.ts` stamp
 * `lastSuccessAt`, leave `lastError` null and `/api/health` report the job
 * healthy: an affirmative false statement rather than a missing signal. Unlike
 * `ReconciliationFailedError`, this is transience-blind: the sweep runs once
 * daily over terminal classes nothing routinely contends for, so a run that
 * lost most of its classes is a real signal, with no routine contention for a
 * streak to tell apart from a wedged lock.
 *
 * `classes > 0` is what keeps this cheap: "nothing was eligible" and "found
 * work and accomplished none" are different states the summary already tells
 * apart, and only the second is a failure.
 *
 * Takes the summary rather than two bare numbers, so the counts cannot be
 * passed in the wrong order.
 */
export class RetentionFailedError extends Error {
  readonly classes: number;
  readonly failed: number;

  constructor(summary: Pick<ReapSummary, 'classes' | 'failed'>) {
    const { classes, failed } = summary;
    super(
      failed === classes
        ? `waitlist retention attempted ${classes} class(es) and every one failed`
        : `waitlist retention attempted ${classes} class(es) and ${failed} failed`,
    );
    this.name = 'RetentionFailedError';
    this.classes = classes;
    this.failed = failed;
  }
}

/**
 * The UTC midnight of `now` minus the retention window.
 *
 * UTC midnight on BOTH sides, deliberately. `CalendarEntry.date` is `@db.Date` — a
 * calendar day pinned to midnight UTC — so comparing it against a bare
 * `now - 365 days` would carry the caller's time of day into the comparison and
 * make the boundary depend on the hour the scheduler happened to tick.
 * `prisma/seed.ts` carries a standing warning about exactly that window: a
 * check run at the wrong UTC hour passes for the wrong reason.
 *
 * The comparison is `date < cutoff`, so a class dated exactly
 * `WAITLIST_RETENTION_DAYS` ago is RETAINED and one dated a day earlier is
 * reaped — the entry is reaped on day 366. Both sides of that boundary have a
 * test.
 */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - WAITLIST_RETENTION_DAYS);
  return cutoff;
}

export async function reapClosedWaitlistEntries(
  db: PrismaClient,
  opts: ReapOptions = {},
): Promise<ReapSummary> {
  const now = opts.now ?? new Date();
  const maxClasses = opts.maxClasses ?? MAX_CLASSES_PER_RUN;
  const cutoff = retentionCutoff(now);

  const reapable = {
    registrationId: null,
    status: { notIn: [...FULFILLED_WAITLIST_STATUSES] },
    class: {
      calendarEntry: {
        date: { lt: cutoff },
        // Terminality, in the same shape `entry_frozen_schedule_guard`
        // enforces: the entry is frozen iff its class completed, or it is a
        // cancelled regular entry. One predicate, one row, one guard.
        OR: [
          { classCompletedAt: { not: null } },
          { kind: 'regular', cancelledAt: { not: null } },
        ],
      },
    },
  } satisfies Prisma.WaitlistEntryWhereInput;

  // `groupBy`, not `findMany({ distinct })`, for the reason
  // `waitlist-reconciliation.ts` records at its own opening statement: Prisma
  // does not compile `distinct` into SQL. It would select one row per matching
  // ENTRY and dedupe in the client to produce one id per CLASS.
  //
  // `maxClasses + 1` rather than `maxClasses`, so `cappedOut` is exact rather
  // than "possibly": at exactly the cap a plain `take` cannot tell a full run
  // from a truncated one.
  const candidates = await db.waitlistEntry.groupBy({
    by: ['classId'],
    where: reapable,
    orderBy: { classId: 'asc' },
    take: maxClasses + 1,
  });

  const cappedOut = candidates.length > maxClasses;
  const batch = candidates.slice(0, maxClasses);

  // The real eligible count, taken ONLY on the capped path.
  //
  // `candidates.length` cannot answer this: `take: maxClasses + 1` pins it to
  // exactly `maxClasses + 1` whenever `cappedOut`, so reporting it says only
  // "more than the cap" in a shape that looks like a measurement.
  //
  // A SECOND `groupBy` and not a scalar `count`, which is the opposite of what
  // it looks like it should be. MEASURED, at 5,000 terminal classes / 50,000
  // entries on postgres:16-alpine, warm, `EXPLAIN (ANALYZE, BUFFERS)`:
  //
  //   this `groupBy`                          21.5 ms   926 buffers
  //   db.class.count({ waitlistEntries:
  //     { some: reapable } })                 46.0 ms  35137 buffers
  //   raw COUNT(DISTINCT w."classId")         60.2 ms   929 buffers
  //
  // Review proposed the scalar `count` to avoid materialising one row per
  // eligible class in the Node heap on the one path where the set is large by
  // definition. The reasoning was sound and the measurement contradicted it:
  // Prisma compiles a nested relation filter under `some` into a semi-join whose
  // inner side re-joins `Class` to itself, so it runs a nested loop over every
  // `Class` row — 2.1x the time and 38x the buffer traffic to save a list that
  // is 5,000 short strings here. `COUNT(DISTINCT)` is worse again: it sorts all
  // 50,000 matching rows where this hash-aggregates them.
  //
  // So the row list stays, and the thing that bounds it is `MAX_CLASSES_PER_RUN`
  // being small enough that the eligible set behind it is too. If a backlog ever
  // makes this list itself the problem, the answer is a smaller cap or a bounded
  // "at least N" report — not a different shape of count, both of which were
  // tried here and are slower.
  let eligible = batch.length;
  if (cappedOut) {
    eligible = (await db.waitlistEntry.groupBy({ by: ['classId'], where: reapable })).length;
    const drainDays = Math.ceil(eligible / maxClasses);
    // Logged, not merely returned. A sweep that silently processes 500 of 900
    // eligible classes reads as "covered everything" in every downstream
    // report, and `isolatedSweeps` throws the return value away.
    log.warn(
      { cap: maxClasses, eligible, drainDays },
      'waitlist retention hit its per-run class cap; the remainder waits for the next run',
    );
  }

  let deleted = 0;
  let failed = 0;

  for (const { classId } of batch) {
    // One transaction per class. NOT the deadlock argument — see the header:
    // the `Class` row lock is what removes the cycle, and it does so at any
    // batch size. This bounds lock-holding against live traffic.
    //
    // Swallowed PER CLASS: one contended class must not abandon the classes
    // behind it, which is the same trade `reconcileWaitlists` makes. A run
    // that mostly or wholly failed IS rethrown after the loop — see
    // `RetentionFailedError` for why `isolatedSweeps` cannot substitute for
    // that (it only ever sees errors that ESCAPE the sweep, and this catch
    // guarantees none do).
    try {
      const count = await db.$transaction(async (tx) => {
        await lockClassRow(tx, classId);
        // The predicate is re-applied under the lock rather than trusting the
        // candidate read: that read took no lock, and a delete scoped only by
        // `classId` would widen the write set past what was actually selected.
        const result = await tx.waitlistEntry.deleteMany({
          where: { classId, ...reapable },
        });
        return result.count;
      });
      deleted += count;
    } catch (err) {
      // Classified by kind, not blanket-`error`, for the reason `reconcileOne`
      // (`waitlist-reconciliation.ts`) sets out at length: `TRANSIENT_KIND_LEVEL`
      // (`lib/api-errors.ts`) is the alerting contract, and a lock timeout on a
      // contended row is the system doing what it was configured to do —
      // retried on the next run — while some transient kinds log at `error`
      // even though a retry can win them; `TRANSIENT_KIND_LEVEL` says which.
      // That matters here specifically because this module's OWN isolation
      // test provokes `55P03`, which is exactly the routine, `warn`-level
      // case — "the realistic failure for this code".
      //
      // `failed` and `classes` ride along so a line reads as one of N rather
      // than as an isolated incident.
      const failure = transientDbFailure(err);
      const transient = failure !== null;
      failed += 1;
      log[failure?.level ?? 'error'](
        { err, classId, transient, transientKind: failure?.kind ?? null, failed, classes: batch.length },
        transient
          ? 'waitlist retention hit a transient database failure for one class — retrying next run'
          : 'waitlist retention failed for one class and will not recover by retrying',
      );
    }
  }

  const summary: ReapSummary = {
    deleted,
    classes: batch.length,
    failed,
    cappedOut,
    eligible,
    cutoff: cutoff.toISOString(),
  };
  report(summary);
  return summary;
}

/**
 * One branch per outcome, mirroring `report()` in `waitlist-reconciliation.ts`;
 * a bare "swept" would be the wrong statement for every outcome but a clean
 * run.
 *
 * WHY THE THRESHOLD IS PROPORTIONAL AND NOT TOTAL. `{classes: 500, failed:
 * 500, deleted: 0}` returning normally is an affirmative false statement
 * rather than a missing signal, and `{classes: 500, failed: 499, deleted: 2}`
 * is the same false statement with one fewer decimal place. Returning it
 * normally would let `makeTick` stamp `lastSuccessAt`, clear `lastError`, and
 * have `/api/health` — the surface `DEPLOYMENT.md` tells operators to watch —
 * report this job `healthy: true`.
 *
 * Every failure mode here is UNDER-deletion, which is the safe side for a
 * permanent delete: nothing is lost by failing, so what the throw protects is
 * the operator's ability to find out.
 */
function report(summary: ReapSummary): void {
  if (summary.classes > 0 && summary.failed === summary.classes) {
    // `error`, whatever each individual failure was classified as above.
    // Individually each may be a routine transient database failure; a run
    // that attempted N classes and failed all N is a different statement at
    // any N, and the one that must not be swallowed.
    log.error(summary, 'waitlist retention reaped nothing — every class it tried failed');
    throw new RetentionFailedError(summary);
  }

  if (summary.failed > summary.classes / 2) {
    // Strictly greater, so an exact half stays a warning: at two classes with
    // one failure the sample is too small to mean anything, and the sweep runs
    // daily.
    log.error(summary, 'waitlist retention failed for most of the classes it tried');
    throw new RetentionFailedError(summary);
  }

  if (summary.failed > 0) {
    log.warn(summary, 'waitlist retention swept, but some classes could not be reaped');
    return;
  }

  log.info(summary, 'waitlist retention swept');
}
