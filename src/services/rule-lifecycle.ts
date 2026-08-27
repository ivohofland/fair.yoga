/**
 * The archive/un-archive one `ScheduleRule` child undergoes, written once for
 * both template families (issue 332). A family hands in a `TemplateFamily`
 * descriptor and nothing below ever asks which family it is holding.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ScheduleRule, ClassFamily } from '@prisma/client';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { setLockTimeout } from '@/lib/db-locks';
import { startOfLocalDay } from '@/lib/timezone';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';

/**
 * A child template with the calendar identity its rule holds, plus the one
 * `Teacher` column the archive's date boundary needs.
 */
export type ChildWithRule<TChild> = TChild & {
  scheduleRuleId: string;
  scheduleRule: ScheduleRule & { teacher: { defaultTimezone: string } };
};

/**
 * A child template with its rule's columns flattened onto it, `startTime`
 * converted to the wire's `"HH:MM"`. Structurally what both families'
 * `ClassTemplateWithSlot` / `StudioClassTemplateWithSlot` already are.
 */
export type WithSlot<T> = T & {
  teacherId: string;
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  isActive: boolean;
  isArchived: boolean;
  archivedAt: Date | null;
  withdrawnCount: number | null;
};

/** What the withdraw hook is handed. */
export type WithdrawContext = { scheduleRuleId: string; today: Date };

/**
 * The family-specific work that brackets the archive's shared delete.
 *
 * One hook wrapped around the delete rather than a pair on either side of it,
 * because the halves share state: the class family reads its
 * about-to-be-withdrawn waitlist entries before the delete and diffs them
 * against the survivors after it. Wrapping keeps that state a local in the
 * family's own closure — see `around` below for the type-level reason a pair
 * does not work.
 *
 * This hook does its work INSIDE the transaction and reports only the delete's
 * row count. That is the property that makes it expressible at all: no
 * family-specific refusal reaches `ArchiveRuleResult`.
 */
export type WithdrawHook = {
  /**
   * Extra `Class`-side conjunct for the delete's predicate. The class family
   * spares classes carrying a charged registration; the studio family has no
   * registrations and supplies no hook at all.
   */
  deleteFilter: Prisma.ClassWhereInput;
  /**
   * Runs the shared delete and whatever this family needs around it, returning
   * the delete's own row count.
   *
   * A single `around` rather than a `before`/`after` pair, and the reason is a
   * type one: a pair has to name the state that crosses the delete, which puts
   * that type in a return position and a parameter position at once. That makes
   * the hook invariant, and an invariant hook cannot be collected into a union
   * over both families. Measured — the pair form fails with `TS2322`. Around a
   * callback, the state is an ordinary local in this family's own closure and
   * no type parameter exists to go wrong.
   */
  around: (
    tx: TransactionClientOnly,
    ctx: WithdrawContext,
    deleteEntries: () => Promise<number>,
  ) => Promise<number>;
};

/**
 * Everything `archiveOrUnarchiveRule` needs in order to run over one family.
 *
 * A dispatch table, not a runtime discriminator: each family's entry is
 * complete on its own, and nothing in this module ever asks which family it is
 * holding. An `if (family.kind === 'regular')` anywhere below is the stop
 * condition issue 332 names, not an implementation detail.
 *
 * NO FIELD IS OPTIONAL, deliberately. `withdraw` is `WithdrawHook | null` —
 * required and explicitly null for the family without one — because an
 * optional field is exactly the hole where a third family is half-defined and
 * nothing complains.
 */
export type TemplateFamily<TChild> = {
  kind: ClassFamily;
  /**
   * The child's table, spliced as a raw identifier into the row lock below.
   * `Prisma.ModelName`, not `string`: the type is the tether, so nothing but a
   * model name can ever reach that splice.
   */
  childTable: Prisma.ModelName;
  /** The noun this family's log lines use: "recurring class" / "studio class". */
  logNoun: string;
  readChild: (
    client: PrismaClient | TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild> | null>;
  readChildOrThrow: (
    client: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild>>;
  scheduledWhere: (
    scheduleRuleId: string,
    date: { gt: Date } | { gte: Date },
    alsoOnClass?: Prisma.ClassWhereInput,
  ) => Prisma.CalendarEntryWhereInput;
  /**
   * Takes the JOINED row, not a bare child, and each family destructures in its
   * own adapter — where `TChild` is concrete and the compiler can prove the
   * remainder is a `TChild`. Handed a bare child instead, this module would have
   * to strip `scheduleRule` itself under a naked type parameter, which needs a
   * cast (measured: `Omit<TChild & {…}, 'scheduleRule'>` is not reducible to
   * `TChild`).
   *
   * The shape also makes a property this code used to defend with prose
   * structural: nothing in this module ever holds a bare child, so it cannot
   * spread a joined `scheduleRule` into a response by accident.
   */
  withSlot: (child: ChildWithRule<TChild>, rule: ScheduleRule) => WithSlot<TChild>;
  withdraw: WithdrawHook | null;
};

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all. `deleted`/
 * `remaining` exist only on the archiving arm — un-archiving removes nothing,
 * and a no-op removes nothing twice.
 *
 * Generic in the child rather than one type per family: the two families'
 * archive unions were measured arm-for-arm identical. They stay
 * non-interchangeable anyway, because `ArchiveRuleResult<ClassTemplate>` and
 * `ArchiveRuleResult<StudioClassTemplate>` differ in `template` — the same job
 * `templateKind` does for the wire types in `template-action-messages.ts`.
 */
export type ArchiveRuleResult<TChild> =
  | { ok: true; action: 'archived'; template: WithSlot<TChild>; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: WithSlot<TChild> }
  | { ok: true; action: 'unchanged'; template: WithSlot<TChild> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  /**
   * A live rule occupies the requested slot (#196/#296) — enforced by
   * `ScheduleRule_teacher_slot_excl`, one exclusion constraint spanning both
   * class families (issue 298), in place of the partial unique index and the
   * cross-family trigger this reason used to split across two. `heldBy` is
   * what tells the two apart now: the constraint's `23P01` cannot say which
   * family raised it, so a fresh probe of `ScheduleRule` answers separately
   * (`ruleSlotHolder`, `src/lib/rule-slot-holder.ts`).
   */
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  /**
   * This transaction lost a contention race and rolled back whole, so nothing
   * was applied and the identical request can win the next attempt.
   *
   * Not only a `lock_timeout` expiry, though that is the case this branch
   * added and the one the copy is written for. The arm is produced by
   * `isTransientDbError`, which also matches a deadlock the detector broke
   * (`40P01`), Prisma's own write-conflict code (`P2034`), an exhausted
   * connection pool (`P2024`) and the transaction budget expiring (`P2028`).
   * Reading a `busy` in the logs and hunting for a 2s lock wait that never
   * happened is the mistake this paragraph exists to prevent.
   *
   * Two calibrations, so this list does not send anyone the other way. This
   * function used to have a reproduced `40P01` cycle against
   * `deleteStudentAccount`'s ascending `Class`-row lock order — closed by
   * this function's own ordered pre-lock (issue 180, atomic-template-update)
   * — while the branch's headline case, an archive queued behind the sweep's
   * claim, has no cycle and ends in `55P03`. A `40P01` seen here now most
   * likely points at the still-open `{Class, ClassTemplate}` ordering
   * question this function is one side of (`docs/lock-order.md`, "Known
   * violation, not fixed here"; the decision is issue #229) rather than at a
   * confirmed, already-reproduced pairing — that inversion is recorded as an
   * unresolved ordering disagreement, not itself reproduced as a live
   * deadlock. And `40001` is in the matcher but cannot fire yet: nothing here
   * uses a serializable or repeatable-read transaction, as `api-errors.ts`
   * says where it lists the code.
   *
   * The writer on the other side is equally unknown — the generation sweep, or
   * another tab's archive, pause or resume — which is why the copy names none
   * of them.
   */
  | { ok: false; reason: 'busy' };

/**
 * Archive or un-archive one `ScheduleRule` child, for whichever family
 * `family` describes. Archiving withdraws that rule's future calendar entries
 * and records how many it took (`archivedAt`/`withdrawnCount`); un-archiving
 * clears the record. Both directions force `isActive: false`.
 *
 * The transaction below takes the child's `FOR UPDATE` lock first, then runs a
 * compare-and-swap rather than a plain update, so the transition can only be
 * applied once even when two requests race — see the statement itself for
 * why the pre-transaction guard cannot do that job on its own.
 */
export async function archiveOrUnarchiveRule<TChild>(
  db: PrismaClient,
  family: TemplateFamily<TChild>,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveRuleResult<TChild>> {
  const template = await family.readChild(db, templateId);
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  // No write, no delete. Archiving twice must not withdraw twice — the
  // withdrawal is a consequence of the transition, not of the request.
  //
  // A fast path, not the guarantee: this row was read before the transaction
  // below opened, so it is outside the row lock and two concurrent archives
  // both clear it. The compare-and-swap inside the transaction is the
  // authoritative one; this only saves them a transaction in the common case.
  //
  // The one place "already there" and "apply the transition" differ
  // observably: both archiving and un-archiving force `isActive: false`
  // below, but this early return touches nothing. So `?state=unarchived`
  // against a template that is already unarchived but still active answers
  // `unchanged` and leaves it active, where a real un-archive would have
  // paused it. That is correct — `isArchived` and `isActive` are independent
  // axes, and no button ever sends that combination — but it deserves to be
  // written down rather than left for a future reader to derive.
  if (template.scheduleRule.isArchived === archiving) {
    return {
      ok: true,
      action: 'unchanged',
      template: family.withSlot(template, template.scheduleRule),
    };
  }

  const timeZone = template.scheduleRule.teacher.defaultTimezone;

  // Un-archiving (`archiving === false`) flips `isArchived` from `true` to
  // `false` in the CAS below — the one write in this function that can newly
  // enter `ScheduleRule_teacher_slot_excl`'s scope (`WHERE isArchived =
  // false`, #196/#298). Archiving only ever leaves that scope, which cannot
  // collide. Wrapped around the whole `$transaction`, not just the CAS
  // statement: a `23P01` raised inside a Postgres transaction aborts it, and
  // the driver surfaces that failure from `$transaction` itself rather than
  // from the individual `await` that triggered it.
  try {
    return await db.$transaction(
      async (tx): Promise<ArchiveRuleResult<TChild>> => {
        // Bounds every statement left in this transaction — the CAS below
        // first among them, and the ordered pre-lock further down too, which
        // is not incidental: that one can lose to an ordinary booking holding
        // a `Class` row, so the 2s answer reaches a path the sweep never
        // touches (`class-generator.test.ts`, "the bound reaches its
        // pre-lock" — issue 180 task 4 moved what that test actually blocks
        // on from the `deleteMany` to the pre-lock ahead of it; see that
        // test's own updated comment). The `deleteMany` below no longer waits
        // on an external holder OF A `Class` ROW THE PRE-LOCK COVERED — that
        // much the pre-lock does buy. It can still wait, two ways, and an
        // earlier version of this comment claimed otherwise on both:
        //
        //   - **Cascade children.** `Registration.class` and
        //     `WaitlistEntry.class` are `onDelete: Cascade`
        //     (`prisma/schema.prisma`), so the delete takes row locks on child
        //     rows no `Class` pre-lock holds. Spec §2.4 counts exactly this
        //     ("the `deleteMany` can then wait only on cascade children"), and
        //     `class-generator.test.ts`'s 15s derivation counts the sync's
        //     equivalent statement as a waiting one for the same reason.
        //   - **Rows the pre-lock never covered.** The `deleteMany` predicate
        //     is re-evaluated at execution time by design, and the pre-lock
        //     stops at `date > today` — see that statement's own comment for
        //     the `updateClass` window, which is measured, not theorised.
        //
        // The distinction matters for budgeting, not just for accuracy:
        // someone trimming this transaction's 10s on the strength of "nothing
        // it touches is still contested" would under-size it.
        //
        // Without it the wait is bounded by NOTHING, not by the 10s budget:
        // Prisma checks that budget at statement boundaries, so it "cannot
        // roll back a statement already blocked inside Postgres, only refuse
        // to start a new one" (`db-locks.ts`).
        await setLockTimeout(tx);

        // The child's row lock, taken explicitly and first — before the CAS
        // below touches `ScheduleRule` at all, and before the `deleteMany`
        // further down. Before issue 298 this CAS wrote `ClassTemplate`
        // directly and so held, as a side effect of a plain `updateMany`, the
        // same row `claimTemplateForGeneration` (class-generator.ts) takes
        // `FOR UPDATE` on — which is what serialised an archive against a
        // sweep in progress (#95). `isArchived`/`isActive` moved to
        // `ScheduleRule` with the rest of the calendar identity, so that CAS
        // no longer touches `ClassTemplate` at all; this statement is what
        // takes its place. See `docs/lock-order.md`, "The child row is the
        // lock node for the template families" for the decision this
        // implements, and why the lock sits on the child rather than on
        // `ScheduleRule` itself.
        //
        // Row count checked, not discarded: `ScheduleRule` carries no FK back
        // to `ClassTemplate`, so a `ClassTemplate` deleted out from under this
        // transaction leaves an orphaned rule row the CAS below would still
        // match — reachable only through a test double today (nothing in
        // `src/` deletes a `ClassTemplate`), but the CAS cannot tell that
        // apart from a real one, so the check is made here rather than relied
        // on to never come up.
        //
        // `Prisma.raw` because `$queryRaw`'s placeholders bind a value, never an
        // identifier. What bounds the splice is `childTable`'s type, not this
        // comment.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM ${Prisma.raw(`"${family.childTable}"`)} WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) return { ok: false, reason: 'not_found' };

        // Compare-and-swap, the pattern `updateClass` already uses for #72.
        // Constraining the write to `isArchived: !archiving` makes the
        // *transition* the thing that can happen only once: two archives that
        // both cleared the guard above reach here, and exactly one of them
        // matches a row. Without it the loser overwrote the winner's
        // `archivedAt`/`withdrawnCount` with its own timestamp and a `0` its
        // `deleteMany` produced only because the winner had already deleted
        // those classes — a durable record (#97) of a withdrawal that says it
        // withdrew nothing.
        //
        // The contended case resolves in Postgres, not here: the loser blocks
        // inside this statement, and when the winner commits, READ COMMITTED
        // re-evaluates this WHERE against the row version the winner left
        // (EvalPlanQual). `isArchived` now equals `archiving`, the row is
        // skipped, and `count` is 0. That re-evaluation applies to the CAS
        // predicate itself only because Prisma emits this as a single `UPDATE
        // … WHERE "id" = $1 AND "isArchived" = $2` — a filter it compiled to a
        // subquery would be re-run under the same snapshot and match anyway.
        //
        // No P2025 guard here, unlike `updateClassTemplate` (#100) — and
        // unlike `pauseOrResumeTemplate` only until #116 gave it this same
        // shape, which is why the sentence below now describes both of them.
        // Not an omission: `updateMany` returns
        // `{ count: 0 }` rather than throwing when nothing matches, and the
        // zero-count branch below already answers `not_found` by re-reading. The
        // `findUniqueOrThrow`/`update` sites further down *can* raise P2025, but
        // only run after this CAS matched, which holds `FOR NO KEY UPDATE` on
        // this row until commit. That conflicts with the `FOR UPDATE`-strength
        // lock a concurrent `DELETE` needs, so it blocks rather than wins.
        //
        // What a plain single-record `update` would change is not the lock — it
        // takes the same mode — but the first limb: it raises P2025 where
        // `updateMany` returns `{ count: 0 }`, so the write itself becomes a
        // P2025 source needing its own guard.
        const swapped = await tx.scheduleRule.updateMany({
          where: { id: template.scheduleRuleId, isArchived: !archiving },
          data: {
            isArchived: archiving,
            isActive: false,
            // Folded in rather than issued as a second `update`: `null` depends
            // on nothing this transaction has yet to do, unlike the archiving
            // arm's `withdrawnCount`, which does not exist until the delete has
            // run. See the record write at the bottom for that asymmetry.
            ...(archiving ? {} : { archivedAt: null, withdrawnCount: null }),
          },
        });

        if (swapped.count === 0) {
          // Both clauses of the CAS constrain the row, so a zero count means
          // either another request already applied the transition or the row is
          // gone — read which rather than assuming, the same distinction #72
          // had to make.
          //
          // This read takes a fresh READ COMMITTED snapshot. Whether it also
          // runs under a lock this transaction already holds depends on which
          // interleaving produced the miss, and the re-read is correct either
          // way — which is the point, because the two differ:
          //
          //   - the conflicting change committed BEFORE this statement's own
          //     snapshot → the `where` evaluated against, and was rejected by,
          //     that already-committed version, and nothing was locked;
          //   - the conflicting change committed WHILE this statement was
          //     already blocked waiting on it → Postgres takes
          //     `LockTupleExclusive` on the newest row version *before*
          //     running the EvalPlanQual re-check, so a rejection at that
          //     point still leaves the lock held to commit.
          //
          // Settled by experiment during #94 — three Prisma connections and a
          // `FOR UPDATE NOWAIT` probe — not from the docs. The second row is
          // not exotic: it is the interleaving this repo's own three-
          // transaction race tests construct. The sentence this replaces said
          // flatly that a missed CAS "holds no lock: the CAS matched nothing,
          // so it acquired none" (#117), which invites a contributor to add a
          // read-then-write here believing the row is pinned. The reasoning
          // about whether to lock on purpose survives that correction; the
          // claim about what is already held does not.
          //
          // With three concurrent
          // requests a fourth state is possible — the winner archives, someone
          // un-archives, and this read returns `isArchived: !archiving`. The
          // answer is still `unchanged` for *this* request, which changed
          // nothing, and the returned row is a real row; only the flag a caller
          // reads off it may already be stale. Locking here to close that would
          // serialise the no-op path against the sweep for no gain.
          //
          // Re-read rather than reusing the snapshot from the top of this
          // function: that one still says `isArchived: !archiving`, which is
          // the exact value the winner just falsified.
          const current = await family.readChild(tx, templateId);
          if (!current) return { ok: false, reason: 'not_found' };
          return {
            ok: true,
            action: 'unchanged',
            template: family.withSlot(current, current.scheduleRule),
          };
        }

        if (!archiving) {
          // `updateMany` returns a count, not a row, and every arm of the
          // contract carries a template. Reading it back is safe here
          // specifically because the CAS above holds the rule row's lock until
          // we commit, so nothing can change or delete it in between — the same
          // lock-then-read pattern `claimTemplateForGeneration` uses, and
          // `OrThrow` for the same reason: the update just matched this row.
          //
          // A template that is no longer archived has no withdrawal to report.
          // Not a *live* one — the CAS above forced `isActive: false` in the
          // same write, so what is standing here is paused. Leaving a stale
          // count on it would be worse than having none (#97).
          const cleared = await family.readChildOrThrow(tx, templateId);
          return {
            ok: true,
            action: 'unarchived',
            template: family.withSlot(cleared, cleared.scheduleRule),
          };
        }

        // One clock reading serves both the calendar boundary and the
        // timestamp recorded below. `CalendarEntry.date` is `@db.Date`, so both sides
        // of every comparison below are calendar dates — the comparison the
        // generator that created these rows already makes (`class-generator.ts`
        // filters on `classStartInstant`). Comparing the column to a raw
        // instant instead would, east of UTC, delete a class running that same
        // evening, and west of UTC leave tomorrow's class bookable under an
        // archived template — the exact leak #86 exists to close.
        const now = new Date();
        const today = startOfLocalDay(now, timeZone);
        const ctx: WithdrawContext = { scheduleRuleId: template.scheduleRuleId, today };

        // Built here, run by the hook — or directly, for a family with none.
        // The family's own extra conjunct is folded in here rather than left to
        // the hook, so the delete's predicate has exactly one author.
        let deleteCalls = 0;
        let deletedRows = 0;
        const deleteEntries = async () => {
          deleteCalls += 1;
          // Deliberately one statement, not a `findMany` followed by a
          // `deleteMany({ id: { in: ids } })`: a two-step read-then-delete lets a
          // registration commit in the gap between them under READ COMMITTED, and
          // the delete — keyed only on the ids already read — does not re-check it,
          // destroying a class (and cascading away a now-charged registration) that
          // became booked after the read. Passing the predicate straight to
          // `deleteMany` makes Postgres re-evaluate it at execution time, and its
          // returned `count` is the number of rows that actually matched then — not
          // a stale count from an earlier read. Do not "optimise" this back into a
          // read-then-delete.
          const { count } = await tx.calendarEntry.deleteMany({
            where: family.scheduledWhere(
              template.scheduleRuleId,
              { gt: today },
              family.withdraw?.deleteFilter,
            ),
          });
          deletedRows = count;
          return count;
        };

        const deleted = family.withdraw
          ? await family.withdraw.around(tx, ctx, deleteEntries)
          : await deleteEntries();

        // #97's record guarantee, enforced here rather than trusted to the
        // hook. `deleted` reaches `withdrawnCount` below — a durable record of
        // what a teacher is told was withdrawn — and it arrives through a
        // callback this module does not own. A hook that skipped the shared
        // delete, ran it twice, or answered with a number of its own would
        // otherwise write that number into the record. Throwing rolls the
        // transaction back whole, so the archive is not half-applied either.
        if (deleteCalls !== 1 || deleted !== deletedRows) {
          throw new Error(
            `archiveOrUnarchiveRule: the ${family.logNoun} withdraw hook must run the shared delete exactly once and report its count; it ran it ${deleteCalls} time(s) and reported ${deleted} against ${deletedRows} row(s) removed`,
          );
        }

        // `gte`, where the delete used `gt`. The delete deliberately spares a
        // class dated today — "a class hours from starting should not shift
        // under its students", which since #194 is what a template EDIT does
        // for every instance rather than only for today's: an edit moves
        // nothing at all, and this delete is the one verb left that can take a
        // generated class out from under a waiting student — so counting with
        // the delete's own boundary would exclude that
        // same survivor and tell the teacher nothing is left while the class is
        // still open on their public page.
        const remaining = await tx.calendarEntry.count({
          where: family.scheduledWhere(template.scheduleRuleId, { gte: today }),
        });

        // Written from the delete's own `count`, inside the same transaction, so
        // the record cannot claim a number the delete did not produce and cannot
        // survive a rollback that withdrew nothing (#97).
        //
        // A second statement rather than folded into the CAS above, on data
        // dependency alone: `deleted` does not exist until the `deleteMany` has
        // run, and the CAS runs before it. The lock ordering does not add a
        // second constraint here — the row lock the sweep serialises against
        // (#95) is the child's `FOR UPDATE`, taken explicitly before the CAS
        // even runs (see above), not the CAS's own `FOR NO KEY UPDATE` on
        // `ScheduleRule`, which the sweep never touches.
        //
        // A plain single-record `update` is enough here: the CAS's lock on the
        // rule row is still held, so nothing can have moved it since.
        // `archivedAt`/`withdrawnCount` live on `ScheduleRule` now (issue 298).
        const recordedRule = await tx.scheduleRule.update({
          where: { id: template.scheduleRuleId },
          data: { archivedAt: now, withdrawnCount: deleted },
        });

        return {
          ok: true,
          action: 'archived',
          // `recordedRule`, not `template.scheduleRule`: the archive just wrote
          // `archivedAt`/`withdrawnCount`, and this is the row version carrying
          // them. The child half comes from the pre-transaction read instead,
          // which is still current — the archiving write touches no child
          // column.
          template: family.withSlot(template, recordedRule),
          deleted,
          remaining,
        };
      },
      // The compare-and-swap above locks the same row the generator sweep's
      // `claimTemplateForGeneration` (class-generator.ts) holds `FOR UPDATE` for
      // the duration of its own per-template transaction. The CAS's own `FOR NO
      // KEY UPDATE` conflicts with that, so an archive can block on a sweep in
      // progress. The wait itself is now bounded by the transaction's own
      // `setLockTimeout` (2s); this budget covers the transaction's own work —
      // the delete, the notifications, the record write — not the wait. Matching
      // the sweep's 10s transaction timeout still matters: a loaded VPS can
      // exceed Prisma's 5s default and turn an ordinary archive click into an
      // opaque P2028.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first — and the honest reason is narrower than the one this
    // comment used to give, which the spec, the plan and the handover all
    // repeated. It claimed that testing for a slot conflict first would let a
    // transient code "fall past a branch that cannot match it into the
    // rethrow". It would not: `isTransientDbError` and `isExclusionConflictOn`
    // below match disjoint SQLSTATEs, and a non-match falls to the NEXT branch
    // rather than to the rethrow. Reordering these two is behaviour-neutral
    // today, and no mutation could show otherwise.
    //
    // Kept explicit anyway, for the reason `pauseOrResumeTemplate`
    // (`class-template-lifecycle.ts`) states correctly: it is safe today only
    // BECAUSE those codes differ, and
    // either predicate widening would end that silently. `classifyApiError`
    // orders itself the same way for the same defensive reason.
    //
    // Logged here rather than left to the API wrapper: returning instead of
    // throwing means the wrapper never sees this, and its automatic line
    // disappears with it. The message names the operation because the wrapper
    // cannot — an archive and a resume reach the same route with the same
    // method and the same path, and the query parameter that separates them is
    // deliberately excluded from request logs.
    if (isTransientDbError(err)) {
      // `target` because this function serves both directions and the message
      // cannot name which: the wrapper's own line could not tell an archive
      // from an un-archive either, and the route's copy does distinguish them.
      log.warn(
        { err, templateId, teacherId, target },
        `${family.logNoun} archive lost the template lock race`,
      );
      return { ok: false, reason: 'busy' };
    }
    // Only reachable un-archiving: `isArchived` flips false in the same CAS
    // that re-enters `ScheduleRule_teacher_slot_excl`'s scope (`WHERE
    // isArchived = false`), and another live rule — either family — can
    // already hold this slot. Neither `dayOfWeek` nor `startTime` moves here,
    // so the probe reads them straight off the pre-transaction `template`
    // read rather than merging in a PUT body the way `updateClassTemplate`'s
    // twin has to.
    //
    // Logged for the same reason the branch above is, and it predates that
    // branch only because nothing had stated the rule yet: a RETURNED
    // failure never reaches `withErrorHandler`, and `respondError` does not
    // log, so without this line an un-archive refused by the slot exclusion
    // is a 409 to the teacher and complete silence on the server.
    // `classifyApiError` logs this same `23P01` at `warn` when it escapes;
    // catching it here must not be what removes that.
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(db, {
        teacherId,
        dayOfWeek: template.scheduleRule.dayOfWeek,
        startMinutes: minutesSinceMidnight(template.scheduleRule.startTime),
        durationMinutes: template.scheduleRule.durationMinutes,
        excludeRuleId: template.scheduleRuleId,
      });
      log.warn(
        { err, templateId, teacherId, heldBy },
        `${family.logNoun} un-archive refused: that slot is taken`,
      );
      return { ok: false, reason: 'slot_conflict', heldBy };
    }
    throw err;
  }
}
