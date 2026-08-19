/**
 * Reconciles waitlists whose spot-freed hook never delivered.
 *
 * `handleSpotFreed` can fail two different ways, and both end with a waiting
 * student silently not told and nothing retrying (#220):
 *
 *   - the broadcast branch aborts at `lockClassRow`'s 2s `SET LOCAL
 *     lock_timeout` with `55P03`, while the contending writer still holds the
 *     row;
 *   - the auto-promote branch aborts the same way now: `promoteNext` (#104)
 *     takes its class row lock through `lockClassRow` too, so the two
 *     branches converged on one failure mechanism, not one branch merging
 *     into the other.
 *
 * HISTORICAL, kept as the evidence for a claim that is still true: before
 * #104 bounded it, the auto-promote branch's `FOR UPDATE` was unbounded and
 * ran inside a bare `db.$transaction(...)`, so a held row instead blew
 * Prisma's default 5s interactive-transaction budget — measured at 7014 ms
 * against a 7 s hold, having waited out the whole hold and failed afterwards
 * with `P2028`. That happened because Prisma's interactive-transaction
 * timeout cannot cancel a statement already blocked inside Postgres, only
 * refuse to start a new one (see `deleteStudentAccount`'s transaction-budget
 * note in `services/gdpr.ts`) — the claim this conversion leaves untouched,
 * since `lockClassRow`'s 2s bound now stops the wait long before that 5s
 * budget would ever be reached here.
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
 *
 * Line numbers are deliberately absent throughout this file. Every reference
 * names a symbol instead: an earlier revision cited sixteen of them and eight
 * were already wrong three commits into the branch that wrote them.
 */
import type { CancelDeadline, PrismaClient } from '@prisma/client';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { classStartInstant } from '@/lib/timezone';
import { DEADLINE_HOURS, getWaitlistWindow, handleSpotFreed } from './waitlist';

/**
 * Why a candidate class was not handed to `handleSpotFreed`. Three reasons,
 * three distinct origins — a caller that cannot tell them apart cannot tell a
 * legitimately idle tick from a gate that has jammed shut.
 */
export type SkipReason =
  /** Past the cancel deadline: the queue is frozen and no promotion may happen. */
  | 'frozen'
  /** No free seat by the unlocked pre-count, so there is nothing to ask about. */
  | 'full'
  /** A broadcast already stands for the currently-free seat (`Class.spotBroadcastAt`). */
  | 'already_broadcast';

export interface SkippedClass {
  readonly classId: string;
  readonly reason: SkipReason;
}

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
 *
 * Every candidate class lands in exactly one of the four lists — `reconciled`,
 * `failed`, `skipped`, or (as a subset of `reconciled`) `repaired`. That is
 * structural rather than documented: the loop computes one `ClassOutcome` per
 * class and this shape is folded from those in a single pass, so disjointness
 * cannot be broken by adding a statement in the wrong place.
 */
export interface ReconcileSummary {
  /** Open classes holding at least one `waiting` entry that were examined. */
  readonly candidates: number;
  /**
   * Classes whose `handleSpotFreed` invocation RETURNED.
   *
   * Membership here means "invoked", not "repaired", and that is load-bearing
   * rather than sloppy: `does not reconcile a class whose window has frozen`
   * proves the frozen filter bites precisely because a frozen class would be
   * invoked and land in this list, while `handleSpotFreed` returns
   * `{ action: 'frozen' }` and writes nothing either way. A list that held only
   * repairs would make that mutation survive.
   *
   * `failedClassIds` is NOT its complement. The per-class `try` covers the
   * whole loop body, so a class can fail before the hook is reached — see the
   * comment on that `try` for why it is drawn there.
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
  /**
   * Candidates deliberately not invoked, each with its reason.
   *
   * Reasons travel with the class rather than being reduced to counters
   * inside this function, following `GenerationResult`/`SkippedSlot` in
   * `lib/generation.ts`. The counters could only ever say "some class was
   * frozen"; this lets a test assert that the class IT built was skipped for
   * the reason under test, rather than settling for `not.toContain` — which
   * passes when the class was skipped for entirely the wrong reason.
   */
  readonly skipped: readonly SkippedClass[];
}

/** Exactly one of these per candidate class. The summary is a fold of them. */
type ClassOutcome =
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'invoked'; repaired: boolean }
  | { kind: 'failed' };

/** The candidate shape the per-class body needs, and no more. */
interface CandidateClass {
  id: string;
  date: Date;
  startTime: string;
  cancelDeadline: CancelDeadline;
  maxStudents: number;
  spotBroadcastAt: Date | null;
  teacher: { defaultTimezone: string };
}

/**
 * Thrown when a tick invoked the hook for at least one class and every single
 * one failed.
 *
 * The sweep swallows per-class failures by design, which is what stops one
 * contended class from abandoning the queue behind it. The cost of swallowing
 * ALL of them is that `scheduler.ts` records `lastSuccessAt` and leaves
 * `lastError` null, so `/api/health` reports this job `healthy: true` with a
 * fresh timestamp while it repairs nothing — an affirmative false statement,
 * not merely a missing signal. Rethrowing here is what `isolatedSweeps` does
 * for the same reason ("the first is rethrown so job health still surfaces the
 * failure"), and it costs nothing in the routine case: one contended class
 * among several still returns normally.
 */
export class ReconciliationFailedError extends Error {
  constructor(public readonly failedClassIds: readonly string[]) {
    super(
      `waitlist reconciliation invoked ${failedClassIds.length} class(es) and every one failed`,
    );
    this.name = 'ReconciliationFailedError';
  }
}

export async function reconcileWaitlists(
  db: PrismaClient,
  opts: { now?: Date } = {},
): Promise<ReconcileSummary> {
  // Start from the waiting entries, not from the classes: most classes have no
  // queue, and this is the narrowest set that can possibly need reconciling.
  //
  // `class: { status: 'open' }` is not a duplicate of the filter below — it
  // USED TO be what BOUNDS this set. Since #216 it is a cost bound rather
  // than a correctness guard: removing it fails no test by design (#222).
  // Before #216, nothing closed a queue when a class left `open` by starting
  // — `class-lifecycle.ts` never touched `WaitlistEntry` on that path, and a
  // queue only forms at `maxStudents`, so "a full class that starts" is the
  // ordinary case, not an edge one — so the candidate list grew
  // monotonically for the life of the deployment, rebuilt and passed inline
  // to the queries below every sixty seconds, on the single 2 GB VPS this
  // project is pinned to.
  //
  // `closeQueueOnStart` (`waitlist.ts`, #216) closes that growth at the
  // source now: atomic with each of the three `open -> in_progress` exits
  // (`autoTransitionToInProgress`, `transitionClass`, and `completeClass`'s
  // inline bump when a teacher completes an `open` class directly), it
  // writes `expired` over every `waiting` row before the class can leave
  // `open` any way but to `cancelled`. That is the property this join relies
  // on, not a fixed roster of writers to keep in sync: every path that takes
  // a `waiting` entry out of contention WITHOUT fulfilling it — a
  // cancellation, a withdrawal, an erasure, or the class starting — either
  // writes a terminal status (`removed` or `expired`) or deletes the row
  // outright — `deleteStudentAccount` (`gdpr.ts`) and, since #238,
  // `reapClosedWaitlistEntries` (`waitlist-retention.ts`) are both hard
  // deletes rather than status writes. The reaper cannot affect THIS query's
  // candidate set: it only touches classes in a terminal status, and this
  // reads `status: 'waiting'` on `open` ones. It does drain the pre-#216
  // legacy `waiting` rows on terminal classes. Those are not the last rows that
  // could make the join below do any work, though — it additionally excludes
  // `waiting` rows on `in_progress` classes, which the reaper never touches.
  // FULFILMENT —
  // `promoteNext`'s own promotion, `claimSpot`,
  // or a queued student booking directly through `POST /api/registrations`
  // (all of which write `promoted`/`claimed`) — is a different, self-limiting
  // category this paragraph is not about: a fulfilled entry leaves `waiting`
  // because the student got a seat, not because the queue closed under them.
  // To re-derive either roster:
  // `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`,
  // excluding tests, then read each hit for which status it writes, or
  // whether it deletes the row. Two of them are production DELETERS rather
  // than one. (`waitlist-retention.ts`'s header classifies the same roster by
  // whether each site can reach a terminal class. Neither place states a
  // headcount any more: the hand-maintained partition went stale on the very
  // commit that added the fifteenth site, while the grep recipe and the
  // classification do not.) The `class: { status: 'open' }` join is kept
  // anyway — it still narrows the scan to classes whose queue could still
  // matter, which is worth avoiding even though nothing downstream depends on
  // it for correctness any more.
  //
  // `groupBy`, not `findMany({ distinct })`: Prisma does not compile `distinct`
  // into SQL. It selects the rows (plus `id`, which it needs to compare) and
  // dedupes in the query engine, so `distinct` would fetch one row per waiting
  // STUDENT to produce one id per CLASS. `groupBy` pushes it into Postgres.
  const queued = await db.waitlistEntry.groupBy({
    by: ['classId'],
    where: { status: 'waiting', class: { status: 'open' } },
  });
  const candidateIds = queued.map((q) => q.classId);
  if (candidateIds.length === 0) {
    log.debug({ candidates: 0 }, 'waitlist reconciliation found no waiting entries');
    return emptySummary(0);
  }

  // Re-read status here rather than trusting the join above: a class can
  // complete between the two queries, and this is the filter `handleSpotFreed`
  // itself applies through its own `cls.status !== 'open'` early return.
  //
  // `orderBy` is not cosmetic. Without it Postgres may return these in any
  // order, which makes the position of a given class in the sweep depend on the
  // heap — and the two tests that hold a row lock against a wall clock then
  // race against however much work happens before their target is reached.
  const classes = await db.class.findMany({
    where: { id: { in: candidateIds }, status: 'open' },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      date: true,
      startTime: true,
      cancelDeadline: true,
      maxStudents: true,
      spotBroadcastAt: true,
      teacher: { select: { defaultTimezone: true } },
    },
  });
  if (classes.length === 0) {
    // `queuedClasses`, not a hardcoded zero: `candidateIds.length` is >= 1 here
    // by construction, and it is the interesting number. One or two is an
    // ordinary race with a completing class. Two hundred means the query above
    // and the one here disagree about `status` — a drift worth seeing, and the
    // figure that distinguishes them is exactly the one an earlier revision
    // threw away by logging `candidates: 0` on both paths.
    log.debug(
      { candidates: 0, queuedClasses: candidateIds.length },
      'waitlist reconciliation found no open candidate class',
    );
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

  const outcomes: Array<{ classId: string; outcome: ClassOutcome }> = [];
  for (const cls of classes) {
    outcomes.push({
      classId: cls.id,
      outcome: await reconcileOne(db, cls, activeByClass.get(cls.id) ?? 0, opts.now),
    });
  }

  const summary = foldOutcomes(classes.length, outcomes);
  report(summary);
  return summary;
}

/**
 * One class, start to finish, reduced to a single outcome.
 *
 * Extracted so the outcome is a RETURN VALUE rather than three pushes into
 * three arrays at three points in a loop body. That is what makes the summary's
 * disjointness structural: a class has one outcome because this function
 * returns one, not because the pushes happen to be arranged correctly.
 */
async function reconcileOne(
  db: PrismaClient,
  cls: CandidateClass,
  activeCount: number,
  now: Date | undefined,
): Promise<ClassOutcome> {
  // The whole body is inside the `try`, not just the `handleSpotFreed` call —
  // and today nothing before that call can actually throw. `getWaitlistWindow`
  // is arithmetic over a total `DEADLINE_HOURS` lookup, and `classStartInstant`
  // catches an invalid stored timezone and degrades to UTC (#145) rather than
  // raising. So this is a scope kept deliberately wider than its current need,
  // not a live catch, and the reason is history: the gate used to be a database
  // round-trip sitting ABOVE the `try`, where a `P2024` pool timeout escaped
  // the loop, abandoned every class queued behind this one, and recorded
  // nothing about which class failed. Drawing the boundary at the top of the
  // body is what makes that unreachable by construction rather than by the
  // current body happening to be infallible.
  try {
    const window = getWaitlistWindow(
      cls.date,
      cls.startTime,
      cls.cancelDeadline,
      cls.teacher.defaultTimezone,
      now,
    );
    if (window === 'frozen') return { kind: 'skipped', reason: 'frozen' };

    // A class ABSENT from the groupBy has zero active registrations, not zero
    // free seats, and its caller defaults accordingly. `?? 0` there is what
    // keeps the emptiest classes — the ones most obviously in need of
    // reconciling — inside the candidate set. Defaulting the other way, or
    // skipping the misses, inverts this filter exactly where it matters most.
    //
    // Deliberately NOT `readSeatCount`: that helper takes `TransactionClientOnly`
    // and documents the Class row lock as a precondition. The predicate is
    // `SeatCount.isFull`'s (`freeSeats <= 0`) written out, and that duplication
    // is the cost of not being able to call the helper here.
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
    // saving by then — but it is not literally free, and the `full` skip
    // reason above is what would make it visible if it ever mattered.
    //
    // It is therefore an equivalent mutant and has no mutation test. Said out
    // loud so the next reader does not mutation-test it, find nothing, and
    // conclude this suite is weak — the same reason `handleSpotFreed` says it
    // about its own `waiting.length === 0` line.
    if (activeCount >= cls.maxStudents) return { kind: 'skipped', reason: 'full' };

    // Only the broadcast needs a gate. A promotion fills one seat, so the
    // auto-promote branch consumes its own trigger; a broadcast leaves the
    // seat free and would go out again every tick.
    if (window === 'first_come_first_claimed' && broadcastStillStands(cls)) {
      return { kind: 'skipped', reason: 'already_broadcast' };
    }

    // Reading the result at all is the point spec §4.1 makes: the two live
    // callers discard it, and that is what made a fired guard indistinguishable
    // from an unreached one. `none` is reachable from this sweep several ways —
    // `promoteNext` losing a `WaitlistPromotionError` race, or returning `null`
    // after draining an all-stale queue, and `handleSpotFreed`'s locked recount
    // suppressing a broadcast, or its `empty` branch when the last `waiting` row
    // vanishes between the candidate query and the invocation. The list is
    // illustrative; the distinction it draws is not.
    const result = await handleSpotFreed(db, cls.id, now);
    return {
      kind: 'invoked',
      repaired: result.action === 'promoted' || result.action === 'broadcast',
    };
  } catch (err) {
    // Per class, mirroring `deleteStudentAccount`'s post-commit loop in
    // `services/gdpr.ts`. `isolatedSweeps` isolates sweeps from each other, NOT
    // items within one sweep — and this job is not registered through it in
    // any case, so nothing outside this loop protects the classes behind a
    // contended one.
    //
    // Classified, not blanket-`warn`: `api-errors.ts` reserves `error` for what
    // should page someone, and a lock timeout on a contended row is the system
    // doing what it was configured to do — retried on the next tick, which is
    // what makes a separate retry unnecessary. That reasoning covers lock races
    // and nothing else. A schema drift, a dangling FK, a `P2002` regression
    // inside `promoteNext` — none of those clear on retry, and the trigger
    // condition is not consumed by the failure, so the class fails again every
    // sixty seconds forever. Blanket `warn` would make a permanently broken
    // promotion path invisible, which is the shape of the defect this whole
    // module exists to remove. Both live callers split on exactly this call —
    // see `promoteAfterCancel` in the registrations route and
    // `deleteStudentAccount`'s post-commit loop.
    //
    // What `error` does NOT currently buy: `lib/log.ts` is pino to stdout with
    // no transport, so nothing pages anyone off either level today (#157). The
    // level is the correct classification for when that is fixed; the thing
    // that actually surfaces a broken sweep NOW is `ReconciliationFailedError`,
    // which reaches `/api/health` through the scheduler.
    const transient = isTransientDbError(err);
    log[transient ? 'warn' : 'error'](
      { err, classId: cls.id, transient },
      transient
        ? 'waitlist reconciliation lost a lock race for one class — retrying next tick'
        : 'waitlist reconciliation failed for one class and will not recover by retrying',
    );
    return { kind: 'failed' };
  }
}

/**
 * True when a first-come-first-claimed broadcast already stands for the seat
 * that is currently free.
 *
 * Two conditions, and they answer different questions.
 *
 * `spotBroadcastAt !== null` is the real gate. It is set inside
 * `handleSpotFreed`'s broadcast transaction and cleared by
 * `activateRegistration` — that is, by any seat being FILLED. What invalidates
 * a broadcast is not time passing but the seat it announced being taken, so
 * that is where the clear belongs.
 *
 * This replaced a gate that asked whether a `spot_available` notification
 * existed anywhere in the current claim window, and the difference is the
 * whole point: a claim window is sixty minutes wide and can hold more than one
 * seat-freeing event. Seat frees, live broadcast succeeds, a waiter claims,
 * the seat frees AGAIN, and the live hook drops the second broadcast — the old
 * gate found the first notification still inside the window and suppressed the
 * sweep for the rest of the hour, so the remaining waiters were never told.
 * That is precisely the loss this module exists to repair, in a state the
 * module could not repair. A flag cleared by the claim cannot make that
 * mistake. It also costs no query: this is a column on a row the sweep has
 * already loaded, where the old gate was a round-trip per gated class per tick
 * and needed an index on the app's highest-volume table to be affordable.
 *
 * The claim-window lower bound survives as a secondary check, in memory and
 * for free. `date` and `startTime` are absent from `ECONOMIC_FIELDS`
 * (`lib/class-fields.ts`), so a class can be rescheduled after its settings
 * lock — which opens a NEW claim window while a flag from the old one still
 * stands. Without the bound the gate would be permanently shut for such a
 * class, which is this branch's own defect reintroduced for rescheduled
 * classes.
 */
function broadcastStillStands(cls: CandidateClass): boolean {
  if (cls.spotBroadcastAt === null) return false;

  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const claimWindowStart = new Date(
    classStart.getTime() - (DEADLINE_HOURS[cls.cancelDeadline] + 1) * 60 * 60 * 1000,
  );
  return cls.spotBroadcastAt >= claimWindowStart;
}

/** The single pass that turns per-class outcomes into the summary. */
function foldOutcomes(
  candidates: number,
  outcomes: ReadonlyArray<{ classId: string; outcome: ClassOutcome }>,
): ReconcileSummary {
  const reconciledClassIds: string[] = [];
  const repairedClassIds: string[] = [];
  const failedClassIds: string[] = [];
  const skipped: SkippedClass[] = [];

  for (const { classId, outcome } of outcomes) {
    switch (outcome.kind) {
      case 'skipped':
        skipped.push({ classId, reason: outcome.reason });
        break;
      case 'invoked':
        reconciledClassIds.push(classId);
        if (outcome.repaired) repairedClassIds.push(classId);
        break;
      case 'failed':
        failedClassIds.push(classId);
        break;
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled class outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  return { candidates, reconciledClassIds, repairedClassIds, failedClassIds, skipped };
}

/**
 * The one log line per tick, and the rethrow when the tick accomplished
 * nothing.
 *
 * Why a tick did nothing is what the counts alone cannot say. A tick reporting
 * 40 candidates and no work is otherwise indistinguishable between "40 classes
 * were legitimately full" and "a gate is broken and rejected all 40" — the
 * exact ambiguity `handleSpotFreed` added its own `debug` line to remove, for a
 * guard whose firing was likewise invisible.
 */
function report(summary: ReconcileSummary): void {
  const skipCounts = countSkipReasons(summary.skipped);
  const payload = {
    candidates: summary.candidates,
    reconciled: summary.reconciledClassIds.length,
    repaired: summary.repairedClassIds.length,
    failed: summary.failedClassIds.length,
    skipped: skipCounts,
  };

  if (summary.failedClassIds.length > 0 && summary.reconciledClassIds.length === 0) {
    // `error`, not `warn`, whatever each individual failure was classified as.
    // Individually each may be a routine lock race; a tick that invoked N
    // classes and failed all N is a different statement at any N, and the one
    // that must not be swallowed.
    log.error(payload, 'waitlist reconciliation repaired nothing — every class it tried failed');
    throw new ReconciliationFailedError(summary.failedClassIds);
  }

  if (summary.reconciledClassIds.length > 0 || summary.failedClassIds.length > 0) {
    // `info`, not `warn`: a reconciliation firing means the LIVE path failed and
    // this repaired it. That belongs in the record without paging anyone — the
    // lines at both live `handleSpotFreed` call sites already record the
    // failure itself, and this records the repair.
    //
    // "ran the hook" rather than "repaired", because `reconciled` cannot tell
    // those apart; `repaired` in the payload is the figure that can.
    log.info(payload, 'waitlist reconciliation ran the spot-freed hook');
    return;
  }

  const gated = skipCounts.frozen + skipCounts.alreadyBroadcast;
  if (gated > 0) {
    // `info`, and this is the branch the skip reasons exist for. A tick where
    // every candidate was GATED is not an idle tick — it is the state that
    // looks identical to a jammed gate, and an earlier revision logged it at
    // `debug`, which is off by default. The diagnostic existed in the source
    // and never in the output.
    log.info(
      { ...payload, gatedClassIds: summary.skipped.filter((s) => s.reason !== 'full') },
      'waitlist reconciliation invoked no class — every candidate was gated',
    );
    return;
  }

  // `debug` for a tick that genuinely found nothing to do — every candidate
  // simply full — and for the reason `handleSpotFreed` gives for its own:
  // `debug` is off by default (`LOG_LEVEL`, `lib/log.ts`) so it costs nothing
  // in production, and it is the difference between "the sweep ran and had
  // nothing to do" and "the sweep did not run" — otherwise visible only as a
  // timestamp in `/api/health`.
  log.debug(payload, 'waitlist reconciliation invoked the hook for no class');
}

interface SkipCounts {
  frozen: number;
  full: number;
  alreadyBroadcast: number;
}

/**
 * Reduces skip reasons to counts for the log payload, with the exhaustive
 * `switch` + `never` idiom `countSkipReasons` in `lib/generation.ts` uses: a
 * fourth `SkipReason` member becomes a compile error here rather than
 * vanishing silently from the one line an operator reads.
 */
function countSkipReasons(skipped: readonly SkippedClass[]): SkipCounts {
  const counts: SkipCounts = { frozen: 0, full: 0, alreadyBroadcast: 0 };
  for (const { reason } of skipped) {
    switch (reason) {
      case 'frozen':
        counts.frozen += 1;
        break;
      case 'full':
        counts.full += 1;
        break;
      case 'already_broadcast':
        counts.alreadyBroadcast += 1;
        break;
      default: {
        const unhandled: never = reason;
        throw new Error(`unhandled skip reason: ${String(unhandled)}`);
      }
    }
  }
  return counts;
}

function emptySummary(candidates: number): ReconcileSummary {
  return {
    candidates,
    reconciledClassIds: [],
    repairedClassIds: [],
    failedClassIds: [],
    skipped: [],
  };
}
