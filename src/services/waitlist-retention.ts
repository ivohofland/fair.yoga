/**
 * Waitlist retention (#238) — deletes queue entries that never became a
 * booking, on classes that can never change again, once those classes are
 * older than the window.
 *
 * WHY THIS EXISTS. Nothing else removes a `WaitlistEntry`. The only other
 * production remover is `deleteStudentAccount` (`gdpr.ts`), which runs once per
 * account at that account's request; `onDelete: Cascade` from `Class` fires
 * only from one deleter, scoped to FUTURE instances
 * (`archiveOrUnarchiveTemplate`'s `date > today`), so it cannot reach a
 * terminal class. There were two until #194 deleted the template sync's
 * wrong-day cleanup; the argument is one participant shorter and otherwise
 * unchanged. `Student`'s cascade
 * never fires at all, because erasure anonymises rather than deletes. So
 * without this sweep the population grows for the life of each account.
 *
 * That growth is most of what makes the erasure's `Class` lock set grow with
 * account age — see the budget rationale in `deleteStudentAccount`. Only most:
 * that pre-lock joins `WaitlistEntry` with no status predicate, while this
 * sweep reaps only UNFULFILLED entries, so the lock set is shrunk rather than
 * bounded and still grows for a student who queues and gets promoted week
 * after week. This is also a storage-limitation problem in its own right
 * (GDPR Art. 5(1)(e)): an entry for a class that ran two years ago, which never
 * became a booking, has no remaining purpose, and the Article 15 export
 * publishes every one of them verbatim.
 *
 * WHY IT IS SAFE. Two arguments — neither of which covers `date`, the sweep's
 * other filter column. That half has its own section, BOTH HALVES OF THE
 * PREDICATE ARE ENFORCED, below; it was the open residual until #247:
 *
 *  - `TERMINAL_CLASS_STATUSES` is derived from `VALID_TRANSITIONS`, and the DB
 *    trigger `class_terminal_status_guard` makes a terminal class's status
 *    physically unchangeable from any client, raw SQL included.
 *    `class-terminal-status.test.ts` pins the derived set against that trigger.
 *  - Every `WaitlistEntry` write site falls into one of three buckets, and none
 *    of them can write a row this sweep would then wrongly reap. To re-derive
 *    the roster:
 *    `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`, excluding
 *    tests and the comment lines among the hits. Classify each:
 *
 *      1. GUARDED BY CLASS STATUS — requires the class to be `open` (or
 *         `open`/`in_progress` for the walk-in resolver), or runs inside the
 *         CAS that makes the class terminal. A terminal class is out of reach.
 *      2. SCOPED TO `status: 'waiting'` — `removeFromWaitlist`,
 *         `withdrawWaitingEntriesForTeacher`, `reorderWaitingEntries`. On a
 *         terminal class a `waiting` row exists only as pre-#216 legacy, and
 *         reaping is what removes that legacy population.
 *      3. DELETERS — `deleteStudentAccount` (`gdpr.ts`) and this sweep's own
 *         `deleteMany` below. A DELETE needs no status guard of its own: it is
 *         the population this sweep exists to shrink, not a writer this
 *         argument has to account for.
 *
 *    The classification is what makes the argument; a headcount of each bucket
 *    is not. An earlier revision hand-maintained one and it went stale on the
 *    very commit that added this sweep — the grep is self-updating, the
 *    arithmetic was not.
 *
 * BOTH HALVES OF THE PREDICATE ARE ENFORCED. This sweep filters on
 * `class.status` AND `class.date`. The status half is the trigger named above,
 * `class_terminal_status_guard` — a `BEFORE UPDATE OF status`, whose own SQL
 * says updates to other columns of a completed class are unaffected, so `date`
 * needed enforcement of its own. #247 gave it two layers, deliberately
 * different in width:
 *
 *  - `updateClass` (`class-lifecycle.ts`) refuses EVERY edit to a class in
 *    `TERMINAL_CLASS_STATUSES` — the class is frozen, not a list of columns —
 *    and returns `{ ok: false, reason: 'terminal' }`, which
 *    `PUT /api/classes/[id]` answers as 409. The layer that holds against a
 *    race is the compare-and-swap: `status: { notIn: [...] }` sits in the
 *    `updateMany` filter, so a completion committing between that function's
 *    opening read and its write is still refused.
 *  - `class_terminal_date_guard` (#247,
 *    `prisma/migrations/20260817120000_class_terminal_date_trigger/`) is a
 *    `BEFORE UPDATE OF date` raising `23514` when a terminal class's `date`
 *    would move — from any client, raw SQL included, the same reach the status
 *    trigger has. `class-terminal-date.test.ts` pins it, and pins
 *    `TERMINAL_CLASS_STATUSES` against the statuses its SQL hard-codes.
 *
 * The asymmetry is the design, not an oversight, and it is worth keeping
 * straight: the SERVICE holds the POLICY (which fields a teacher may edit at
 * which lifecycle stage — a product question, and its answer here is "none"),
 * the DATABASE holds the one INVARIANT this deleting sweep depends on.
 *
 * ONE CORRECTION TO THE MIGRATION'S OWN COMMENT, recorded here because an
 * applied migration is checksummed and cannot be edited to carry it. That
 * comment justifies the narrowness partly on the grounds that a wider trigger
 * "would put `spotBroadcastAt` and the completion write at risk". It would
 * not, and the sentence immediately before it in the same comment is why: a
 * wider trigger keeps the same `WHEN (OLD.status IN ('completed',
 * 'cancelled'))` gate, `completeClass` writes its totals in the same
 * statement as the status flip so `OLD.status` is `in_progress` there, and
 * both `spotBroadcastAt` writers are behind an `open` check. Neither can trip
 * a gate keyed on a terminal OLD.status at any column width. The half of that
 * sentence that does hold is "would gain nothing" — the service already
 * refuses every field, so a wider trigger would duplicate policy in a file
 * that can never be edited, and would have to be re-derived every time a
 * column is added. That is the reason for `date` alone; the risk claim is
 * not. So the
 * trigger covers `date` and nothing else: the database still permits column
 * writes other than `status` and `date` on a terminal class — those two have
 * a trigger each — which `class-terminal-status.test.ts` asserts on purpose,
 * in a case whose name carries the exclusion ('leaves a non-status, non-date
 * update to a completed class alone'). Do not read the two guards as the same
 * rule stated twice.
 *
 * What this buys the sweep is that "more than 365 days past" is a property of
 * the row rather than a snapshot a client can move underneath it — ONCE THE
 * CLASS IS TERMINAL, and only then.
 *
 * THE PRE-TERMINAL PATH IS CLOSED TOO, as of #249, and this paragraph used to
 * say the opposite. A teacher could edit a still-live class's `date` into the
 * past, and the class would then reach a terminal status legitimately — by
 * whichever route came first. Naming one route here (the transition sweep, then
 * the completion sweep) understated it: a manual cancel gets there in a single
 * request with no sweep involved, `autoCancelClasses` is a third route, and
 * `POST …/complete` with `finishedEarly` a fourth. That mattered, because a
 * defence designed against the two sweeps would have left the one-request route
 * open while looking complete.
 *
 * #249 guards at the doors where a past start can be WRITTEN rather than at the
 * routes out of them, which covers all four routes equally: `updateClass`
 * refuses a `date`/`startTime` edit whose resulting start instant has already
 * passed, and `transitionClass` refuses a `draft -> open` publish of a class
 * whose start has passed. Both are service policy, deliberately not a trigger —
 * an `open` class whose start has passed is a state `generateClassInstances`
 * legitimately produces, so there is no invariant for the database to hold.
 * See `docs/superpowers/specs/2026-08-18-past-start-guard-design.md` §3.
 *
 * TWO DOORS, AND SINCE #194 THEY ARE ALL OF THEM — but the correction that
 * got here is worth keeping, because the sentence was wrong once in each
 * direction. It first went in as "the two doors where a past start can be
 * written", which was an inventory it had not earned: the template sync was a
 * third writer, rewriting `startTime` on every instance of a template with a
 * bare `updateMany`, past no such guard, selecting those instances with
 * `date: { gt: now }` — a `@db.Date` column compared against an instant, the
 * UTC-calendar mistake `timezone.ts` exists to name. That filter was not the
 * same predicate as "the start is still ahead". Measured: for a
 * `Pacific/Auckland` teacher at 2026-08-18T20:00Z, a class dated 2026-08-19 at
 * 00:30 local started at 12:30Z — eight hours earlier — and still satisfied
 * `date > now`. #194 deleted that function on 2026-08-20, and the two doors
 * became the inventory the first version claimed they were: re-derived from
 * the `class.` write sites in `src/`, `updateClass` is the only statement that
 * moves an existing class's `date`/`startTime`, and it is guarded. #257 is the
 * issue that recorded the third writer; it is moot rather than fixed, and the
 * measurement above is kept because the UTC-calendar trap it names outlived
 * the function that fell into it.
 *
 * WHAT THAT COST THIS SWEEP WAS NOTHING, which is why it was recorded here
 * rather than fixed here. This delete-safety argument needs the class's `date`
 * to be immovable once TERMINAL, and it gets that from
 * `class_terminal_date_guard`, a trigger — never from the door count above.
 * The sync wrote `startTime`, never `date`, and filtered to `draft`/`open`
 * besides, so it could not move the column this sweep reads on a class this
 * sweep would consider. The gap was in the #249 rule's coverage, not in this
 * one's, and it closed with the function rather than by being fixed: the
 * residual filed under `2026-08-18-past-start-guard-design.md` §11 asked what
 * a template edit should do to an instance that has already started, and #194
 * answered "nothing at all".
 *
 * WHY IT CANNOT DEADLOCK AGAINST THE ERASURE. `deleteStudentAccount` deletes
 * waitlist entries with an UNSCOPED `deleteMany({ where: { studentId } })` —
 * every status, terminal classes included — so its write set and this one
 * overlap, and Postgres picks the victim of any cycle: it can be the erasure,
 * which means a student's Art. 17 request failing because a background sweep
 * raced it.
 *
 * What removes that cycle is the `Class` ROW LOCK, not the batch size. The
 * erasure PRE-LOCKS every `Class` it will delete entries from before its first
 * write (`gdpr.ts`, joined on `w."studentId"` with no status predicate), and
 * this sweep takes `lockClassRow(tx, classId)` before its `deleteMany`. So
 * every `WaitlistEntry` row in either write set sits under a `Class` row lock
 * that both transactions must hold first — the two can never contend on the
 * same `WaitlistEntry` row at all, and that holds regardless of how many
 * classes this sweep batched. Do not read one-class-at-a-time as the deadlock
 * argument; it is not, and a future site copying it as one would be misled.
 *
 * WHAT ONE CLASS PER TRANSACTION ACTUALLY BUYS is two smaller things: it keeps
 * `docs/lock-order.md`'s "five sites lock more than one `Class` row" count
 * true, and it bounds how long this sweep holds locks against live traffic.
 *
 * ARGUED ON THE MECHANISM, NOT ON MULTIPLICITY. `docs/lock-order.md`
 * classifies lock sites by MULTIPLICITY — a transaction holding two `Class` row
 * locks carries an ordering obligation, one holding a single row lock carries
 * none — and then withdraws that in the next breath: since #196 a single-row
 * write can be half of a slot-key deadlock without ever holding a second
 * `Class` row lock, `updateClass` being the example. Taking one row lock is
 * therefore NOT on its own a safety argument. This is worth stating rather than
 * passing over, because the multiplicity reading is the one a future author is
 * most likely to copy from this file. What actually makes this sweep edge-free
 * is three mechanical facts:
 *
 *  - it never `INSERT`s or `UPDATE`s a `Class` row, so it takes no
 *    `Class_teacher_slot_unique` index-entry lock and cannot join a slot-key
 *    wait chain;
 *  - deleting a CHILD row takes no FK lock on the parent (only inserting or
 *    updating one takes `FOR KEY SHARE`), so the `deleteMany` adds no `Class`
 *    edge beyond the `lockClassRow` this transaction took deliberately;
 *  - no production writer holds a `WaitlistEntry` row lock while requesting a
 *    `Class` lock, so there is no reverse edge for this one to close a cycle
 *    against.
 *
 * The shape is `autoCancelClasses`' (`class-transitions.ts`), whose own docblock
 * argues it on the axis that matters here: a slow lock wait on one class costs
 * only that class's transaction.
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { FULFILLED_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import { lockClassRow } from '@/lib/db-locks';
import { isTransientDbError } from '@/lib/api-errors';
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
 * Not, as an earlier revision claimed, because an unbounded run would "stop the
 * job for ever" through `scheduler.ts`'s `running` guard. That guard drops ticks
 * while a run is in flight, but the interval is 24 h, so a run would have to
 * exceed a full day to cost even one tick — and the loop is over a finite
 * `groupBy` result, so it terminates regardless. A backlog drains at this rate
 * per day.
 */
export const MAX_CLASSES_PER_RUN = 500;

/**
 * All `readonly`, and constructed exactly once at the end of the run.
 *
 * The sibling `ReconcileSummary` (`waitlist-reconciliation.ts`) argues the same
 * point and it is sharper here: an earlier revision built this object early,
 * mutated `failed` inside the loop, and carried a SECOND accumulator for
 * `deleted` in a local `let` that was reconciled onto the field only after the
 * loop. Any future early return inside that loop would have reported
 * `deleted: 0` while having permanently deleted rows — a summary that
 * under-reports an irreversible operation, which is the one direction this
 * value must never be wrong in. Accumulating into locals and constructing once
 * makes that unrepresentable rather than merely absent.
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
   * taken only there — `candidates.length` cannot answer this, and an earlier
   * revision logged that length as if it could: it is always exactly
   * `maxClasses + 1` whenever `cappedOut`, i.e. a constant dressed as a
   * measurement. An operator needs the real figure to tell a backlog that drains
   * tomorrow from one that takes a hundred days.
   *
   * Named `eligible` and not `eligibleAtLeast` for that reason. The hedge
   * described no path this code has, and the log line below already emitted the
   * value under the honest key — one number under two names, one of them weaker
   * than the truth, is a smaller version of the same defect the paragraph above
   * records.
   */
  readonly eligible: number;
  /**
   * The cutoff this run used, ISO-8601.
   *
   * For an irreversible policy-driven deletion, the window applied belongs in
   * the only durable record of the run. Neither this nor `now` reached the log
   * line or the route's JSON before.
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
 * Thrown when a run attempted at least one class and every single one failed.
 *
 * Mirrors `ReconciliationFailedError` (`waitlist-reconciliation.ts`) and exists
 * for the same reason. Per-class failures are swallowed by design — that is what
 * stops one contended class abandoning the classes behind it — but swallowing
 * ALL of them means `scheduler.ts` stamps `lastSuccessAt`, leaves `lastError`
 * null, and `/api/health` reports this job `healthy: true`. That is the field
 * `DEPLOYMENT.md` tells operators to monitor, so `{classes: 500, failed: 500,
 * deleted: 0}` returning normally is an affirmative false statement rather than
 * a missing signal.
 *
 * `classes > 0` is what keeps this cheap: "nothing was eligible" and "found work
 * and accomplished none" are different states the summary can already tell
 * apart, and only the second is a failure. In the routine case — one contended
 * class among several — nothing throws.
 */
export class RetentionFailedError extends Error {
  constructor(public readonly classes: number) {
    super(`waitlist retention attempted ${classes} class(es) and every one failed`);
    this.name = 'RetentionFailedError';
  }
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
  opts: ReapOptions = {},
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
    // behind it, which is the same trade `reconcileWaitlists` makes. Unlike an
    // earlier revision, an all-failed run IS rethrown after the loop — see
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
      // Classified, not blanket-`error`, for the reason `reconcileOne` sets out
      // at length: `api-errors.ts` reserves `error` for what should page
      // someone, and a lock timeout on a contended row is the system doing what
      // it was configured to do — retried on the next run. That matters here
      // specifically because this module's OWN isolation test provokes `55P03`
      // and calls it "the realistic failure for this code", so the routine
      // failure was logging at paging level.
      //
      // `failed` and `classes` ride along so a line reads as one of N rather
      // than as an isolated incident.
      const transient = isTransientDbError(err);
      failed += 1;
      log[transient ? 'warn' : 'error'](
        { err, classId, transient, failed, classes: batch.length },
        transient
          ? 'waitlist retention lost a lock race for one class — retrying next run'
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
 * Four branches, mirroring `report()` in `waitlist-reconciliation.ts`.
 *
 * An unconditional `log.info` said "swept" whatever happened, which is the
 * wrong statement for three of the four outcomes below.
 *
 * WHY THE THRESHOLD IS PROPORTIONAL AND NOT TOTAL. Only the all-failed branch
 * threw at first, and the argument for it was that `{classes: 500, failed:
 * 500, deleted: 0}` returning normally is an affirmative false statement
 * rather than a missing signal. `{classes: 500, failed: 499, deleted: 2}` is
 * the same false statement with one fewer decimal place, and it took the
 * `failed > 0` branch: a `warn`, a normal return, `makeTick` stamping
 * `lastSuccessAt` and clearing `lastError`, and `/api/health` — the surface
 * `docs/DEPLOYMENT.md` tells operators to watch — reporting this job
 * `healthy: true`. All-or-nothing was the weakest version of the check this
 * module argues for.
 *
 * The failure direction is worth stating because it is the reason this is a
 * reporting fix and not a data fix: every failure mode here is UNDER-
 * deletion, which is the safe side for a permanent delete. Nothing is lost by
 * failing; what was lost was the operator's ability to find out.
 */
function report(summary: ReapSummary): void {
  if (summary.classes > 0 && summary.failed === summary.classes) {
    // `error`, whatever each individual failure was classified as above.
    // Individually each may be a routine lock race; a run that attempted N
    // classes and failed all N is a different statement at any N, and the one
    // that must not be swallowed.
    log.error(summary, 'waitlist retention reaped nothing — every class it tried failed');
    throw new RetentionFailedError(summary.classes);
  }

  if (summary.failed > summary.classes / 2) {
    // Strictly greater, so an exact half stays a warning: at two classes with
    // one failure the sample is too small to mean anything, and the sweep runs
    // daily.
    log.error(summary, 'waitlist retention failed for most of the classes it tried');
    throw new RetentionFailedError(summary.classes);
  }

  if (summary.failed > 0) {
    log.warn(summary, 'waitlist retention swept, but some classes could not be reaped');
    return;
  }

  log.info(summary, 'waitlist retention swept');
}
