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

/**
 * The last dated entry a pause leaves standing, as the teacher is told about
 * it.
 *
 * `date` is `CalendarEntry.date` straight through, and it is `@db.Date`: a
 * calendar date pinned to midnight UTC, never an instant. That is the one
 * property of this type a producer can actually violate, and it is what
 * licenses `pauseMessage` to render it through `formatDayHeader`, which reads
 * its argument with `getUTC*` accessors (`src/lib/format.ts`). Fill this from
 * a raw `new Date()` instead and the rendered day slips back one west of UTC.
 *
 * `startTime` is HH:mm — the wire spelling, not the `Date` the column holds
 * — because this crosses into a response body unchanged.
 *
 * `TemplateToggleResponse.lastScheduled` in `template-action-messages.ts` is
 * NOT this type and must not be folded into it — it carries `date: string`,
 * the post-`JSON.parse` wire form, converted back inside that file's two
 * `resolve*Confirmation` functions.
 */
export type LastScheduledClass = { date: Date; startTime: string };

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
 * This hook does its work INSIDE the transaction and reports nothing. That is
 * the property that makes it expressible at all: no family-specific refusal
 * reaches `ArchiveRuleResult`.
 */
export type WithdrawHook = {
  /**
   * Runs the shared delete and whatever this family needs around it.
   *
   * Returns nothing. The delete's row count is already captured by the closure
   * that owns `deleteEntries`, so a hook handing it back would be reporting a
   * number the caller holds either way — and the caller would then have to
   * police the copy against the original. `deleteEntries` still resolves to
   * the count, for a hook that wants to branch on it.
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
  ) => Promise<void>;
};

/**
 * Everything `archiveOrUnarchiveRule` needs in order to run over one family.
 *
 * A dispatch table, not a runtime discriminator: each family's entry is
 * complete on its own, and nothing in this module ever asks which family it is
 * holding. An `if (family.kind === <a ClassFamily literal>)` anywhere below is
 * the stop condition issue 332 names, not an implementation detail — the
 * literal is spelled out of line here on purpose, so that grepping this file
 * for one stays a clean signal.
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
   * Narrowed to the template children rather than left at `Prisma.ModelName`,
   * which admits every model in the schema: the type below is the tether, so
   * nothing outside it can reach that splice, and a third family becomes a
   * deliberate edit here rather than a silent widening. Pinned by
   * `rule-lifecycle.test.ts`, `@ts-expect-error` on a model name that is not a
   * template child — a claim about what the compiler refuses is worth only the
   * pin that makes the compiler refuse it.
   */
  childTable: Extract<Prisma.ModelName, 'ClassTemplate' | 'StudioClassTemplate'>;
  /**
   * The noun this family's log lines use. A union rather than `string`: the
   * log messages composed from it below are asserted verbatim by tests keyed
   * on the exact string, so the roster belongs to the compiler rather than to
   * a sentence naming its members.
   */
  logNoun: 'recurring class' | 'studio class';
  readChild: (
    client: PrismaClient | TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild> | null>;
  readChildOrThrow: (
    client: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild>>;
  /**
   * The entries an archive of this family withdraws: this rule's, dated
   * strictly after the teacher's `today`, minus whatever else this family
   * spares.
   *
   * Whole and final. The shared `deleteMany` passes this straight through and
   * composes nothing onto it, so no conjunct crosses the boundary and there is
   * nothing for a family to declare and then fail to apply. Two required
   * predicates rather than one boundary-taking predicate plus a droppable
   * extra filter, and that is the whole reason for the shape.
   */
  deleteWhere: (scheduleRuleId: string, today: Date) => Prisma.CalendarEntryWhereInput;
  /**
   * The entries of this family that stand at or after the boundary — this
   * rule's, dated on or after the teacher's `today`.
   *
   * `today` INCLUSIVE, where `deleteWhere` above excludes it. The delete
   * deliberately spares a class dated today — "a class hours from starting
   * should not shift under its students", which since #194 is what a template
   * EDIT does for every instance rather than only for today's: an edit moves
   * nothing at all, and that delete is the one verb left that can take a
   * generated class out from under a waiting student. Counting with the
   * delete's own boundary would exclude that same survivor and tell the
   * teacher nothing is left while the class is still open on their public
   * page.
   */
  standingWhere: (scheduleRuleId: string, today: Date) => Prisma.CalendarEntryWhereInput;
  /**
   * Takes the JOINED row, not a bare child, and each family destructures in its
   * own adapter — where `TChild` is concrete and the compiler can prove the
   * remainder is a `TChild`. Handed a bare child instead, this module would have
   * to strip `scheduleRule` itself under a naked type parameter, which needs a
   * cast (measured: `Omit<TChild & {…}, 'scheduleRule'>` is not reducible to
   * `TChild`).
   *
   * The shape also makes one property structural rather than conventional:
   * nothing in this module ever holds a bare child, so it cannot spread a
   * joined `scheduleRule` into a response by accident. The adapters can —
   * each family's own lifecycle test pins that its adapter does not.
   *
   * `rule` is declared `ScheduleRule`, and the call sites below pass something
   * WIDER than that: every one except the archiving arm's hands over
   * `template.scheduleRule`, which carries the joined
   * `teacher: { defaultTimezone }` this function's date boundary needs. An
   * adapter that spreads `rule` therefore puts a `teacher` object on the wire
   * while typechecking clean, which is the second thing those tests pin.
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
 * Held by `@ts-expect-error` call arguments in `rule-lifecycle.test.ts`, the
 * way `template-action-messages.test.ts` holds the discriminator this is
 * modelled on: a claim about what the compiler refuses is worth only the pin
 * that makes the compiler refuse it.
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
   * Not only a `lock_timeout` expiry, though that is the case the copy is
   * written for. The arm is produced by `isTransientDbError`, whose whole
   * matcher — `TRANSIENT_SQLSTATES` and `TRANSIENT_PRISMA_CODES`
   * (`src/lib/api-errors.ts`) — reaches here, and each member carries its own
   * calibration where it is declared, including which of them cannot fire in
   * this repo at all. Reading a `busy` in the logs and hunting for a 2s lock
   * wait that never happened is the mistake this paragraph exists to prevent.
   *
   * What a deadlock here means is a per-family question, not a property of
   * this arm: the lock a family takes on top of the shared ones is its
   * `withdraw` hook's business, so the deadlock calibration for a family that
   * has one is argued there — for the class family, in `CLASS_FAMILY.withdraw`
   * (`class-template-lifecycle.ts`). A family whose `withdraw` is `null` takes
   * no such lock and carries no such exposure.
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
        // first among them, the `deleteMany` further down, and everything a
        // family's `withdraw` hook issues around it. That last part is not
        // incidental: a hook may take locks of its own that this transaction
        // knows nothing about, and the 2s bound is what keeps those waits from
        // being unbounded. Pinned wherever such a hook exists —
        // `class-generator.test.ts`, "the bound reaches its pre-lock", which
        // drives this bound through a wait no hookless family can reach. What
        // any one hook's locks buy is argued where that hook is written — for
        // the class family, in `CLASS_FAMILY.withdraw`
        // (`class-template-lifecycle.ts`).
        //
        // The `deleteMany` below can wait even behind a family that pre-locks,
        // two ways:
        //
        //   - **Cascade children.** The entries it deletes cascade into their
        //     child rows and beyond (`prisma/schema.prisma`), so it takes row
        //     locks a `Class`-row pre-lock never holds.
        //   - **Rows a pre-lock never covered.** Its predicate is re-evaluated
        //     at execution time by design — see the statement's own comment —
        //     so a row that enters scope after the hook ran is matched and
        //     locked here regardless.
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
        // further down. Before issue 298 each family's CAS wrote its own child
        // table directly and so held, as a side effect of a plain
        // `updateMany`, the same row that family's generation claim
        // (`claimTemplateForGeneration`, `class-generator.ts`;
        // `claimStudioTemplateForGeneration`, `studio-class-generator.ts`)
        // takes `FOR UPDATE` on — which is what serialised an archive against
        // a sweep in progress (#95). `isArchived`/`isActive` moved to
        // `ScheduleRule` with the rest of the calendar identity, so no CAS
        // touches a child table any more; this statement is what takes their
        // place, for both families at once. See `docs/lock-order.md`, "The
        // child row is the lock node for the template families" for the
        // decision this implements, and why the lock sits on the child rather
        // than on `ScheduleRule` itself.
        //
        // Row count checked, not discarded: `ScheduleRule` carries no FK back
        // to either child table, so a child deleted out from under this
        // transaction leaves an orphaned rule row the CAS below would still
        // match, and the CAS cannot tell that apart from a real one. Whether
        // any production path deletes a child at all is a repo-wide question
        // with a repo-wide answer — `docs/data-model.md`, Design Notes, which
        // carries it with the grep that re-derives it.
        //
        // `Prisma.raw` because `$queryRaw`'s placeholders bind a value, never an
        // identifier. What bounds the splice is `childTable`'s type, not this
        // comment.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM ${Prisma.raw(`"${family.childTable}"`)} WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) {
          // Logged at `error`, not returned quietly. The pre-transaction read
          // above found this child, so reaching here means it was deleted
          // between that read and this lock — the invariant `docs/data-model.md`
          // records (Design Notes, with the grep that re-derives it) says no
          // production path does that. The teacher still gets a plain 404; the
          // first firing of this line is the signal to revisit every site that
          // rests on the invariant.
          log.error(
            { templateId, scheduleRuleId: template.scheduleRuleId, kind: family.kind, teacherId },
            'archive found no child row to lock for a template it had just read',
          );
          return { ok: false, reason: 'not_found' };
        }

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
        // No P2025 guard here, unlike `updateClassTemplate` (#100).
        // `pauseOrResumeTemplate` (`class-template-lifecycle.ts`) has this
        // same guard-free shape, and #116 is where it got it.
        // Not an omission: `updateMany` returns
        // `{ count: 0 }` rather than throwing when nothing matches, and the
        // zero-count branch below already answers `not_found` by re-reading.
        // Two sites further down can raise P2025 — `readChildOrThrow` and the
        // record `update` — and they run only after this CAS matched. A
        // DIFFERENT lock covers each, and the split is the load-bearing part:
        //
        //   - The record `update` writes THIS `ScheduleRule` row, which this
        //     CAS holds `FOR UPDATE` until commit — `FOR NO KEY UPDATE` until
        //     issue 272 made `live` an FK-referenced key column, which upgrades
        //     every statement touching `isActive`/`isArchived` (see the read
        //     below for the measurement). It conflicted with the
        //     `FOR UPDATE`-strength lock a concurrent `DELETE` needs at the
        //     weaker mode already, and still does, so the delete blocks rather
        //     than wins.
        //   - `readChildOrThrow` reads the CHILD row, which this CAS's lock
        //     does not touch at all. What covers it is the explicit child
        //     `FOR UPDATE` taken above, before this statement ran — the same
        //     lock the orphaned-rule reasoning up there turns on. That lock is
        //     therefore not redundant with this one, and deleting it would put
        //     an unguarded P2025 under `readChildOrThrow`.
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
          // transaction race tests construct. So a missed CAS may not be read
          // as holding no lock, and nothing may be added here on the strength
          // of the row being pinned either.
          //
          // Re-read rather than reusing the snapshot from the top of this
          // function: that one still says `isArchived: !archiving`, which is
          // the exact value the winner just falsified. What the re-read says
          // is then CHECKED, not assumed — the two states it can be in are
          // different answers.
          const current = await family.readChild(tx, templateId);
          if (!current) {
            // Same impossible-by-invariant shape as the child lock above, and
            // logged for the same reason: the child `FOR UPDATE` this
            // transaction still holds means no other transaction can have
            // deleted this row since.
            log.error(
              { templateId, scheduleRuleId: template.scheduleRuleId, kind: family.kind, teacherId },
              'archive re-read found no child row while holding its row lock',
            );
            return { ok: false, reason: 'not_found' };
          }

          // The target state was reached — by this request's loser-twin, or by
          // another tab. `unchanged` is the honest answer: this request changed
          // nothing and the state it asked for is the state that stands.
          if (current.scheduleRule.isArchived === archiving) {
            return {
              ok: true,
              action: 'unchanged',
              template: family.withSlot(current, current.scheduleRule),
            };
          }

          // The fourth state, and it is NOT `unchanged`. With three concurrent
          // requests the winner applies the transition and a third request
          // reverses it, so this read finds `isArchived: !archiving` — the
          // value this request asked to move AWAY from. Answering `unchanged`
          // here told the teacher nothing at all: the route renders that arm
          // 200 with no confirmation copy, so an "Archive" click left the
          // button unchanged, the page silent and the template live and still
          // generating.
          //
          // `busy` instead, which every route already renders as a 503 saying
          // nothing was changed and to try again. That is exactly what
          // happened — this transaction wrote nothing and rolls back clean —
          // and a retry re-reads and wins. Same answer, same reasoning, as the
          // residual CAS miss in both families' pause/resume; the argument for
          // it is one about other modules and lives in `docs/lock-order.md`,
          // "A CAS miss no re-read can classify answers `busy`, not a throw".
          //
          // Logged with the observed row because that is the half of `busy` no
          // `err` carries: a steady trickle here with no concurrent writer
          // means the CAS predicate and this classification have drifted.
          log.warn(
            {
              templateId,
              teacherId,
              target,
              observed: {
                isArchived: current.scheduleRule.isArchived,
                isActive: current.scheduleRule.isActive,
              },
            },
            `${family.logNoun} archive CAS missed and the re-read found the transition reversed`,
          );
          return { ok: false, reason: 'busy' };
        }

        if (!archiving) {
          // `updateMany` returns a count, not a row, and every arm of the
          // contract carries a template. TWO different locks make this
          // read-back safe, and they are not interchangeable — crediting one
          // with the other's job is what makes the child `FOR UPDATE` above
          // look redundant:
          //
          //   - The rule columns are current because the CAS above holds a
          //     rule-row lock until commit, so nothing can move
          //     `isArchived`/`isActive` between that write and this read. It
          //     is `FOR UPDATE`, not `FOR NO KEY UPDATE`: the migration's 272
          //     change made `live` an FK-referenced key column, which upgrades
          //     every statement touching it (measured: `pg_stat_activity`
          //     shows a concurrent rule write parked in `Lock:transactionid`).
          //   - `OrThrow` is safe because the child `FOR UPDATE` taken at the
          //     head of this transaction is still held, so no concurrent
          //     `DELETE` can take the child row out from under this read. The
          //     CAS's lock is on `ScheduleRule` and would not stop that — the
          //     same split the compare-and-swap's own comment draws for P2025,
          //     and the same lock-then-read pattern each family's generation
          //     claim uses.
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
        // The predicate is `family.deleteWhere`'s whole answer: this module
        // adds no conjunct of its own to it and no hook is handed one to apply,
        // so the delete's predicate has exactly one author AND exactly one
        // application site.
        let deleteCalls = 0;
        let deletedRows = 0;
        const deleteEntries = async () => {
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
            where: family.deleteWhere(template.scheduleRuleId, today),
          });
          // Both assignments AFTER the await, deliberately. Counting the call
          // on entry would credit a hook that wrapped this in
          // `try { … } catch { }` — the statement never completed, no rows
          // were removed, and the guard below would still read one clean call.
          // Counted here, a swallowed delete reads as zero calls and gets the
          // guard's own message instead of whatever opaque failure the aborted
          // transaction produces next.
          deleteCalls += 1;
          deletedRows = count;
          return count;
        };

        if (family.withdraw) {
          await family.withdraw.around(tx, ctx, deleteEntries);
        } else {
          await deleteEntries();
        }
        // The delete's own count, read out of this function's closure rather
        // than handed back by the hook. `withdrawnCount` below is a durable
        // record (#97) of what a teacher is told was withdrawn, and the
        // shortest path from the statement that produced the number to the
        // column that stores it is the one with nothing to police.
        const deleted = deletedRows;

        // #97's record guarantee, enforced here rather than trusted to the
        // hook.
        //
        // Exactly one thing is checked, and the contract is no wider than it:
        // that the shared delete ran exactly once. A hook that skipped it, ran
        // it twice, or swallowed its failure is caught. A hook that runs it
        // once while ALSO issuing a `calendarEntry.deleteMany` of its own is
        // NOT — those rows would go unrecorded and nothing here can see them.
        //
        // Throwing rolls the transaction back whole, so a caught hook does not
        // leave the archive half-applied either. Pinned by
        // `rule-lifecycle.test.ts`, which runs a synthetic family through it.
        if (deleteCalls !== 1) {
          throw new Error(
            `archiveOrUnarchiveRule: template ${templateId}'s ${family.logNoun} withdraw hook must run the shared delete exactly once; it ran it ${deleteCalls} time(s)`,
          );
        }

        // A separate predicate from the delete's, on the same clock reading:
        // the two boundaries differ, and `standingWhere`'s own docblock
        // (above) carries why a class dated today is spared by one and counted
        // by the other.
        const remaining = await tx.calendarEntry.count({
          where: family.standingWhere(template.scheduleRuleId, today),
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
        // even runs (see above), not the CAS's own lock on `ScheduleRule`
        // (`FOR UPDATE` since issue 272), which the sweep never touches.
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
      // The child row lock above is what a generation sweep serialises
      // against: each family's claim (`claimTemplateForGeneration`,
      // `class-generator.ts`; `claimStudioTemplateForGeneration`,
      // `studio-class-generator.ts`) holds that same row `FOR UPDATE` for the
      // duration of its own per-template transaction, so an archive can block
      // on a sweep in progress. Not the CAS's own lock (`FOR UPDATE` since
      // issue 272), which is on `ScheduleRule` and which no sweep touches —
      // see the record write above. The wait itself is bounded by the transaction's own
      // `setLockTimeout` (2s); this budget covers the transaction's own work —
      // the delete, whatever the family's `withdraw` hook does around it, and
      // the record write — not the wait. Matching
      // the sweep's 10s transaction timeout still matters: a loaded VPS can
      // exceed Prisma's 5s default and turn an ordinary archive click into an
      // opaque P2028.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first. Reordering these two branches would be behaviour-neutral
    // today — `isTransientDbError` and `isExclusionConflictOn` below match
    // disjoint SQLSTATEs, so a code that misses one falls to the NEXT branch
    // rather than to the rethrow, and no mutation could show otherwise. The
    // order is kept explicit anyway, because it is safe ONLY because those two
    // predicates are disjoint, and widening either would end that silently.
    // `classifyApiError` (`src/lib/api-errors.ts`) orders itself the same way
    // for the same defensive reason.
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
