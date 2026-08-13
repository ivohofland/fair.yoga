/**
 * Reconciles waitlists whose spot-freed hook never delivered.
 *
 * `handleSpotFreed` can fail two different ways, and both end with a waiting
 * student silently not told and nothing retrying (#220):
 *
 *   - the broadcast branch aborts at `lockClassRow`'s 2s `SET LOCAL
 *     lock_timeout` with `55P03`, while the contending writer still holds the
 *     row;
 *   - the auto-promote branch blows Prisma's default 5s interactive-transaction
 *     budget with `P2028`, measured at 7014 ms against a 7 s hold — it waits out
 *     the whole hold and fails afterwards, because Prisma cannot cancel a
 *     statement already blocked inside Postgres (`gdpr.ts:602`).
 *
 * Both of those callers log and swallow, so this sweep is the only thing that
 * makes either loss recoverable. It is also the answer to a July 2026 audit
 * observation that no sweep re-checked waitlists against free seats — stated
 * here rather than cited, because the audit notes live outside the repository
 * and a reference no other clone can open is not a reference.
 *
 * **This module detects; `handleSpotFreed` decides.** It resolves the window to
 * choose which classes to ASK about, but makes no promote-vs-broadcast decision
 * and takes no authoritative capacity reading — both of those stay inside the
 * hook, under the class row lock. That division is what makes the auto-promote
 * half covered without a line addressing it, and it is why re-running the hook
 * is the whole action.
 */
import type { CancelDeadline, PrismaClient } from '@prisma/client';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { classStartInstant } from '@/lib/timezone';
import { DEADLINE_HOURS, getWaitlistWindow, handleSpotFreed } from './waitlist';

/**
 * What one sweep did, by class rather than by count.
 *
 * Counts are deliberately absent. This sweep is database-wide, so `reconciled:
 * 1` is a claim about every row in the database and a test asserting it is only
 * correct while nothing else qualifies — which couples every test to every
 * other one and to whatever a killed run left behind. Ids let a caller assert
 * the outcome for the class it built: stricter than a count, and immune to rows
 * it did not create. Anything wanting a number reads `.length`, which cannot
 * drift from the list it counts.
 */
export interface ReconcileSummary {
  /** Open classes holding at least one `waiting` entry that were examined. */
  readonly candidates: number;
  /**
   * Classes whose `handleSpotFreed` invocation RETURNED — not the invocation
   * count, which is this plus `failedClassIds`.
   *
   * Membership here means "invoked", not "repaired", and that is load-bearing
   * rather than sloppy: `does not reconcile a class whose window has frozen`
   * proves the frozen filter bites precisely because a frozen class would be
   * invoked and land in this list, while `handleSpotFreed` returns
   * `{ action: 'frozen' }` and writes nothing either way. A list that held only
   * repairs would make that mutation survive.
   */
  readonly reconciledClassIds: readonly string[];
  /**
   * The subset of `reconciledClassIds` whose invocation actually changed
   * something — `promoted` or `broadcast`.
   *
   * This is the only list a log line may honestly describe as a repair. An
   * invocation returning `none` is in `reconciledClassIds` and not here.
   */
  readonly repairedClassIds: readonly string[];
  /** Classes whose invocation threw. Disjoint from `reconciledClassIds`. */
  readonly failedClassIds: readonly string[];
}

export async function reconcileWaitlists(
  db: PrismaClient,
  opts: { now?: Date } = {},
): Promise<ReconcileSummary> {
  // Start from the waiting entries, not from the classes: most classes have no
  // queue, and this is the narrowest set that can possibly need reconciling.
  //
  // `class: { status: 'open' }` is not a duplicate of the filter below — it is
  // what BOUNDS this set. Nothing closes a queue when a class completes:
  // `class-lifecycle.ts` never touches `WaitlistEntry`, and only
  // `autoCancelClasses` (`class-transitions.ts:322`) and the manual-cancel
  // route mark entries `removed`. So every class that simply runs full with an
  // unfulfilled queue leaves its `waiting` rows `waiting` forever, and
  // completed classes are never deleted. Without this join the candidate list
  // would grow monotonically for the life of the deployment and be rebuilt,
  // and passed inline to the queries below, every sixty seconds — on the single
  // 2 GB VPS this project is pinned to.
  const queued = await db.waitlistEntry.findMany({
    where: { status: 'waiting', class: { status: 'open' } },
    select: { classId: true },
    distinct: ['classId'],
  });
  const candidateIds = queued.map((q) => q.classId);
  if (candidateIds.length === 0) {
    log.debug({ candidates: 0 }, 'waitlist reconciliation found no waiting entries');
    return emptySummary(0);
  }

  // Re-read status here rather than trusting the join above: a class can
  // complete between the two queries, and this is the filter `handleSpotFreed`
  // itself applies (`waitlist.ts:639`).
  const classes = await db.class.findMany({
    where: { id: { in: candidateIds }, status: 'open' },
    select: {
      id: true,
      date: true,
      startTime: true,
      cancelDeadline: true,
      maxStudents: true,
      teacher: { select: { defaultTimezone: true } },
    },
  });
  if (classes.length === 0) {
    log.debug({ candidates: 0 }, 'waitlist reconciliation found no open candidate class');
    return emptySummary(0);
  }

  // One grouped count for the whole candidate set, not one count per class: this
  // runs every minute on a 2 GB VPS. Keyed on the classes actually iterated
  // rather than on `candidateIds`, so a class that closed between the two
  // queries costs nothing here.
  const counts = await db.registration.groupBy({
    by: ['classId'],
    where: {
      classId: { in: classes.map((c) => c.id) },
      status: { in: [...ACTIVE_REGISTRATION_STATUSES] },
    },
    _count: { _all: true },
  });
  const activeByClass = new Map(counts.map((c) => [c.classId, c._count._all]));

  const reconciledClassIds: string[] = [];
  const repairedClassIds: string[] = [];
  const failedClassIds: string[] = [];
  // Why a tick did nothing, which the counts alone cannot say. A tick reporting
  // 40 candidates and no work is otherwise indistinguishable between "40
  // classes were legitimately full" and "a gate is broken and rejected all 40"
  // — the exact ambiguity `waitlist.ts:750` added its own `debug` line to
  // remove, for a guard whose firing was likewise invisible.
  const skipped = { frozen: 0, full: 0, alreadyBroadcast: 0 };

  for (const cls of classes) {
    // The `try` opens here, not at the `handleSpotFreed` call: the broadcast
    // gate below is a database round-trip, and a `P2024` pool timeout on it —
    // a code this project already classifies as transient
    // (`api-errors.ts:124`) — would otherwise escape the loop and abandon every
    // class queued behind this one, recording nothing about which class failed.
    // That is the property this loop exists to hold.
    try {
      const window = getWaitlistWindow(
        cls.date,
        cls.startTime,
        cls.cancelDeadline,
        cls.teacher.defaultTimezone,
        opts.now,
      );
      if (window === 'frozen') {
        skipped.frozen += 1;
        continue;
      }

      // A class ABSENT from the groupBy has zero active registrations, not zero
      // free seats. `?? 0` is what keeps the emptiest classes — the ones most
      // obviously in need of reconciling — inside the candidate set. Defaulting
      // the other way, or skipping the misses, inverts this filter exactly where
      // it matters most.
      const activeCount = activeByClass.get(cls.id) ?? 0;

      // Deliberately NOT `readSeatCount`: that helper takes `TransactionClientOnly`
      // and documents the Class row lock as a precondition (`capacity.ts:68`).
      // The predicate is `SeatCount.isFull`'s (`freeSeats <= 0`) written out, and
      // that duplication is the cost of not being able to call the helper here.
      //
      // This unlocked read is NOT the mistake #212 existed to remove, and the
      // difference is worth stating because it looks identical. #212's finding was
      // that an unlocked count is meaningless AS A GUARD — it moves the race
      // rather than closing it. This is not a guard. It decides only whether to
      // ASK, and `handleSpotFreed` re-counts through `readSeatCount` under
      // `lockClassRow` before it acts. Stale in either direction costs almost
      // nothing: reads full when free, the seat waits one more tick; reads free
      // when full, the hook's locked count suppresses it, as designed.
      //
      // "Almost", because there is one seat this loses: a class read as full on
      // the last tick before its cancel deadline is `frozen` on the next one and
      // never reconciled. One minute wide, and the queue was already past
      // saving by then — but it is not literally free, and the `skipped.full`
      // tally above is what would make it visible if it ever mattered.
      //
      // It is therefore an equivalent mutant and has no mutation test. Said out
      // loud so the next reader does not mutation-test it, find nothing, and
      // conclude this suite is weak — the same reason `waitlist.ts:715` says it
      // about its own `waiting.length === 0` line.
      if (activeCount >= cls.maxStudents) {
        skipped.full += 1;
        continue;
      }

      // Only the broadcast needs a gate. A promotion fills one seat, so the
      // auto-promote branch consumes its own trigger; a broadcast leaves the
      // seat free and would go out again every tick. (A class with two free
      // seats and two waiters does re-fire — once per tick, promoting one each
      // time, which is the intended behaviour and not a re-broadcast.)
      if (window === 'first_come_first_claimed' && (await alreadyBroadcastInWindow(db, cls))) {
        skipped.alreadyBroadcast += 1;
        continue;
      }

      const result = await handleSpotFreed(db, cls.id, opts.now);
      reconciledClassIds.push(cls.id);
      // Reading the result at all is the point spec §4.1 makes: the two live
      // callers discard it (`waitlist.ts:626-628`), and that is what made a
      // fired guard indistinguishable from an unreached one. `none` is
      // reachable from this sweep several ways — `promoteNext` losing a
      // `WaitlistPromotionError` race, or returning `null` after draining an
      // all-stale queue (`waitlist.ts:439`), and the locked recount at
      // `waitlist.ts:706` suppressing a broadcast, or its `empty` branch
      // (`waitlist.ts:719`) when the last `waiting` row vanishes between the
      // candidate query and the invocation. The list is illustrative; the
      // distinction it draws is not.
      if (result.action === 'promoted' || result.action === 'broadcast') {
        repairedClassIds.push(cls.id);
      }
    } catch (err) {
      // Per class, mirroring `deleteStudentAccount`'s post-commit loop
      // (`gdpr.ts:654`). `isolatedSweeps` isolates sweeps from each other, NOT
      // items within one sweep — and this job is not registered through it in
      // any case, so nothing outside this loop protects the classes behind a
      // contended one.
      //
      // Classified, not blanket-`warn`: `api-errors.ts:222` reserves `error`
      // for what should page someone, and a lock timeout on a contended row is
      // the system doing what it was configured to do — retried on the next
      // tick, which is what makes a separate retry unnecessary. That reasoning
      // covers lock races and nothing else. A schema drift, a dangling FK, a
      // `P2002` regression inside `promoteNext` — none of those clear on retry,
      // and the trigger condition is not consumed by the failure, so the class
      // fails again every sixty seconds forever. Blanket `warn` would make a
      // permanently broken promotion path invisible, which is the shape of the
      // defect this whole module exists to remove. Both live callers split on
      // exactly this line (`route.ts:238`, `gdpr.ts:661`).
      const transient = isTransientDbError(err);
      failedClassIds.push(cls.id);
      log[transient ? 'warn' : 'error'](
        { err, classId: cls.id, transient },
        transient
          ? 'waitlist reconciliation lost a lock race for one class — retrying next tick'
          : 'waitlist reconciliation failed for one class and will not recover by retrying',
      );
    }
  }

  const summary: ReconcileSummary = {
    candidates: classes.length,
    reconciledClassIds,
    repairedClassIds,
    failedClassIds,
  };
  const payload = {
    candidates: summary.candidates,
    reconciled: reconciledClassIds.length,
    repaired: repairedClassIds.length,
    failed: failedClassIds.length,
    skipped,
  };

  if (failedClassIds.length > 0 && reconciledClassIds.length === 0) {
    // Every class it tried, it failed. Individually each of those may be a
    // routine lock race at `warn`; collectively, a tick that accomplished
    // nothing is a different statement and deserves its own line.
    log.warn(payload, 'waitlist reconciliation repaired nothing — every class it tried failed');
  } else if (reconciledClassIds.length > 0 || failedClassIds.length > 0) {
    // `info`, not `warn`: a reconciliation firing means the LIVE path failed and
    // this repaired it. That belongs in the record without paging anyone — the
    // lines at both live `handleSpotFreed` call sites already record the
    // failure itself, and this records the repair.
    //
    // "ran the hook" rather than "repaired", because `reconciled` cannot tell
    // those apart; `repaired` in the payload is the figure that can.
    log.info(payload, 'waitlist reconciliation ran the spot-freed hook');
  } else {
    // `debug` for a tick that found nothing, and for the reason `waitlist.ts:750`
    // gives for its own: `debug` is off by default (`LOG_LEVEL`, `lib/log.ts`)
    // so it costs nothing in production, and it is the difference between "the
    // sweep ran and had nothing to do" and "the sweep did not run" — otherwise
    // visible only as a timestamp in `/api/health`. `skipped` is what says
    // WHICH nothing, since every candidate may have been gated rather than
    // genuinely idle.
    log.debug(payload, 'waitlist reconciliation invoked the hook for no class');
  }

  return summary;
}

function emptySummary(candidates: number): ReconcileSummary {
  return {
    candidates,
    reconciledClassIds: [],
    repairedClassIds: [],
    failedClassIds: [],
  };
}

/**
 * True when this class's current claim window already carries a broadcast.
 *
 * Exact rather than approximate: the broadcast is one `createMany` with no
 * `skipDuplicates` (`waitlist.ts:732`), so a class's waiting students either all
 * received a `spot_available` notification or none did. There is no partial
 * state for a class-level check to be wrong about, and so no per-recipient query
 * and no new column.
 *
 * `claimWindowStart` is derived from the class rather than stored: it is
 * `classStart - (deadlineHours + 1) h`, the same boundary `getWaitlistWindow`
 * computes to decide the window in the first place. The lower bound is not
 * decoration — a class can be rescheduled after its settings lock (`date` and
 * `startTime` are absent from `ECONOMIC_FIELDS`, `lib/class-fields.ts`), which
 * opens a NEW claim window while the old `spot_available` rows persist. Without
 * the bound the gate would be permanently shut for such a class and the sweep
 * could never repair a dropped broadcast in its new window.
 *
 * Served by `Notification_relatedClassId_type_createdAt_idx`, added with this
 * sweep: the table's only other index is on the recipient, so unindexed this
 * would be a sequential scan of every notification ever written, once per gated
 * class, every sixty seconds.
 *
 * **The one race this does not close.** The read is outside the Class row lock,
 * so: this reads the gate → the live hook broadcasts → this invokes the hook →
 * a second broadcast. The sweep cannot race ITSELF — the `job.running` guard in
 * `lib/scheduler.ts` refuses a tick while one is running — only the live path.
 * The cost is one duplicate notification against a current cost of no
 * notification at all, and that trade was made deliberately.
 *
 * (Cited by name rather than by line: that guard has moved twice during this
 * branch alone, once because this branch registered a job above it and once
 * because it extracted `buildJobs`. A symbol survives what a line number does
 * not.)
 */
async function alreadyBroadcastInWindow(
  db: PrismaClient,
  cls: {
    id: string;
    date: Date;
    startTime: string;
    cancelDeadline: CancelDeadline;
    teacher: { defaultTimezone: string };
  },
): Promise<boolean> {
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const claimWindowStart = new Date(
    classStart.getTime() - (DEADLINE_HOURS[cls.cancelDeadline] + 1) * 60 * 60 * 1000,
  );

  const existing = await db.notification.findFirst({
    where: {
      relatedClassId: cls.id,
      type: 'spot_available',
      createdAt: { gte: claimWindowStart },
    },
    select: { id: true },
  });
  return existing !== null;
}
