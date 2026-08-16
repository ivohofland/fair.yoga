/**
 * Waitlist retention (#238) — deletes queue entries that never became a
 * booking, on classes that can never change again, once those classes are
 * older than the window.
 *
 * WHY THIS EXISTS. Nothing else removes a `WaitlistEntry`. The only other
 * production remover is `deleteStudentAccount` (`gdpr.ts`), which runs once per
 * account at that account's request; `onDelete: Cascade` from `Class` fires
 * only from two deleters, both scoped to FUTURE instances
 * (`template-sync.ts`'s wrong-day cleanup and `archiveOrUnarchiveTemplate`'s
 * `date > today`), so neither can reach a terminal class. `Student`'s cascade
 * never fires at all, because erasure anonymises rather than deletes. So
 * without this sweep the population grows for the life of each account.
 *
 * That growth is what made the erasure's `Class` lock set unbounded — see the
 * budget rationale in `deleteStudentAccount` — and it is a storage-limitation
 * problem in its own right (GDPR Art. 5(1)(e)): an entry for a class that ran
 * two years ago, which never became a booking, has no remaining purpose, and
 * the Article 15 export publishes every one of them verbatim.
 *
 * WHY IT IS SAFE. Two independent arguments, and both are enforced rather than
 * asserted:
 *
 *  - `TERMINAL_CLASS_STATUSES` is derived from `VALID_TRANSITIONS`, and the DB
 *    trigger `class_terminal_status_guard` makes a terminal class's status
 *    physically unchangeable from any client, raw SQL included.
 *    `class-terminal-status.test.ts` pins the derived set against that trigger.
 *  - Ten of the fourteen `WaitlistEntry` write sites require the class to be
 *    `open` (or `open`/`in_progress` for the walk-in resolver), or run inside
 *    the CAS that makes the class terminal. Three more — `removeFromWaitlist`,
 *    `withdrawWaitingEntriesForTeacher` and `reorderWaitingEntries` — are
 *    scoped to `status: 'waiting'`, which on a terminal class exists only as
 *    pre-#216 legacy. Reaping is what removes that legacy population. The
 *    fourteenth, `deleteStudentAccount`'s unscoped `deleteMany` (`gdpr.ts`),
 *    is neither: it is a DELETE, so it needs no status guard of its own —
 *    it is the population this sweep exists to shrink, not a writer this
 *    argument has to account for.
 *    To re-derive the roster:
 *    `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`, excluding
 *    tests.
 *
 * ONE CLASS PER TRANSACTION, and that is structural rather than stylistic.
 * `deleteStudentAccount` deletes waitlist entries with an UNSCOPED
 * `deleteMany({ where: { studentId } })` — every status, terminal classes
 * included — so its write set and this one overlap. Two multi-row deletes
 * taking row locks in different plan orders is an AB-BA cycle, and Postgres
 * picks the victim: it can be the erasure, which means a student's Art. 17
 * request failing because a background sweep raced it. `docs/lock-order.md`
 * classifies lock sites by MULTIPLICITY — a transaction that can hold two
 * `Class` row locks carries an ordering obligation, one that holds a single row
 * lock carries none. Holding one at a time removes the cycle instead of
 * ordering around it, and it keeps that document's "five sites lock more than
 * one `Class` row" count true. The shape is `autoCancelClasses`'
 * (`class-transitions.ts`), whose own docblock argues it on the axis that
 * matters here: a slow lock wait on one class costs only that class's
 * transaction.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { FULFILLED_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import { lockClassRow } from '@/lib/db-locks';
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
 * a handful, so this is unreachable in normal operation. It exists so a first
 * run against accumulated history cannot wedge the daily job: `scheduler.ts`'s
 * `running` guard drops every tick while one is in flight, so an unbounded loop
 * here would stop the job for ever rather than merely take a while. A backlog
 * drains at this rate per day.
 */
export const MAX_CLASSES_PER_RUN = 500;

export interface ReapSummary {
  /** Entries actually deleted. */
  deleted: number;
  /** Classes this run attempted, after the cap. */
  classes: number;
  /** Classes whose own transaction threw and were skipped. */
  failed: number;
  /** True when more classes were eligible than the cap allowed. */
  cappedOut: boolean;
}

/**
 * The UTC midnight of `now` minus the retention window.
 *
 * UTC midnight on BOTH sides, deliberately. `Class.date` is `@db.Date` — a
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
  opts: { now?: Date; maxClasses?: number } = {},
): Promise<ReapSummary> {
  const now = opts.now ?? new Date();
  const maxClasses = opts.maxClasses ?? MAX_CLASSES_PER_RUN;
  const cutoff = retentionCutoff(now);

  const reapable = {
    registrationId: null,
    status: { notIn: [...FULFILLED_WAITLIST_STATUSES] },
    class: {
      status: { in: [...TERMINAL_CLASS_STATUSES] },
      date: { lt: cutoff },
    },
  } satisfies Prisma.WaitlistEntryWhereInput;

  // `groupBy`, not `findMany({ distinct })`, for the reason
  // `waitlist-reconciliation.ts` records at its own opening statement: Prisma
  // does not compile `distinct` into SQL. It would select one row per matching
  // ENTRY and dedupe in the query engine to produce one id per CLASS.
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

  if (cappedOut) {
    // Logged, not merely returned. A sweep that silently processes 500 of 900
    // eligible classes reads as "covered everything" in every downstream
    // report, and `isolatedSweeps` throws the return value away.
    log.warn(
      { cap: maxClasses, eligibleAtLeast: candidates.length },
      'waitlist retention hit its per-run class cap; the remainder waits for the next run',
    );
  }

  let deleted = 0;
  const summary: ReapSummary = {
    deleted: 0,
    classes: batch.length,
    failed: 0,
    cappedOut,
  };

  for (const { classId } of batch) {
    // One transaction per class — see this module's header for why that is
    // the whole deadlock argument and not a style choice.
    //
    // Swallowed PER CLASS, and rethrown by nobody: one contended class must
    // not abandon the classes behind it, which is the same trade
    // `reconcileWaitlists` makes. Unlike that sweep this does NOT rethrow when
    // every class failed, because `isolatedSweeps` (`scheduler.ts`) is the
    // caller and it already logs and rethrows the first error it sees — and
    // because a retention sweep repairing nothing for one day is not the
    // affirmative false statement a reconciliation sweep repairing nothing is.
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
      log.error({ err, classId }, 'waitlist retention could not reap a class');
      summary.failed += 1;
    }
  }

  summary.deleted = deleted;
  log.info(summary, 'waitlist retention swept');
  return summary;
}
