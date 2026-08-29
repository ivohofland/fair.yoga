/**
 * The lifecycle a `ScheduleRule` child undergoes — archive/un-archive (issue
 * 332) and pause/resume (issue 336) — written once for both template families.
 * A family hands in a `TemplateFamily` descriptor and nothing below ever asks
 * which family it is holding.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, ScheduleRule, ClassFamily } from '@prisma/client';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { setLockTimeout } from '@/lib/db-locks';
import { startOfLocalDay } from '@/lib/timezone';
import { timeToHHmm } from '@/lib/time-of-day';
import { countSkipReasons, type GenerationResult, type SkipCounts } from '@/lib/generation';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';

/**
 * A `ScheduleRule` as every joined read in this module returns it: with the one
 * `Teacher` column the date boundaries need.
 */
export type JoinedRule = ScheduleRule & { teacher: { defaultTimezone: string } };

/**
 * A child template with the calendar identity its rule holds, plus the one
 * `Teacher` column the date boundaries below need.
 */
export type ChildWithRule<TChild> = TChild & {
  scheduleRuleId: string;
  scheduleRule: JoinedRule;
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
 * Everything the shared lifecycle functions below need in order to run over one
 * family.
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
 *
 * `TChild` appears in a return position (`withSlot`'s), so the type is
 * invariant in it: `TemplateFamily<never>` is a perfectly good type
 * expression, and no family descriptor is assignable to it. Measured, not
 * reasoned. `TKind` appears only in a property position, so it is covariant.
 */
export type TemplateFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  kind: TKind;
  /**
   * The child's table, spliced as a raw identifier into the row locks below —
   * `archiveOrUnarchiveRule`'s and `pauseOrResumeRule`'s, each of which takes
   * one for whichever family it was handed.
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
   *
   * Read by both verbs below rather than by the archive alone, which is what
   * makes "archiving and resuming report on one basis" a property of this
   * field rather than a promise two call sites keep separately.
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
   * each family's own lifecycle test file pins that its adapter does not.
   *
   * `rule` is the JOINED row, and each adapter destructures `teacher` off it
   * the way it destructures `scheduleRule` off the child. What actually keeps
   * `teacher` off the wire is neither that destructure nor this type: it is
   * that the `withSlot` each adapter delegates to composes its result by
   * PICKING the rule's columns by name rather than spreading the rule. Drop
   * the destructure on its own and `tsc` exits 0 and every pin stays green,
   * because nothing leaked.
   *
   * The joined parameter type still earns its place: it makes the shipped
   * adapters provably teacher-free, and narrowing the joined read later is a
   * compile error rather than a silent change. What it does NOT buy is a
   * compile error on a leak, and the reason is broader than spreads — an
   * adapter is written as an arrow whose return type comes from a contextual
   * function type, and in that position TypeScript applies no excess-property
   * check at all. Measured: an adapter that spreads `rule` whole compiles, and
   * so does one that writes `teacher:` by hand. The runtime pins in both
   * lifecycle test files are therefore the first line and the last, not a
   * backstop behind a compile-time one.
   */
  withSlot: (child: ChildWithRule<TChild>, rule: JoinedRule) => WithSlot<TChild>;
  /**
   * Claim this template's row for generation, and generate its window. A pair
   * rather than one hook because the claimed row is what the resume's `active`
   * arm reports on: its rule id feeds `standingWhere`, its joined teacher feeds
   * the date boundary, and it feeds `withSlot`.
   *
   * Typed over `ChildWithRule<TChild>` rather than over a third type parameter
   * for the claimed payload. Both families' real functions satisfy these
   * signatures directly — the claimed payload is the same joined shape
   * `readChild` returns — and a parameter naming it would sit in a return
   * position (`claim`'s) and a parameter position (`generate`'s) at once, the
   * same invariance that rules out the `before`/`after` pair `WithdrawHook.around`
   * replaces.
   */
  claim: (
    tx: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild> | null>;
  generate: (
    tx: TransactionClientOnly,
    claimed: ChildWithRule<TChild>,
  ) => Promise<GenerationResult>;
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
        // No P2025 guard here, unlike `updateClassTemplate`
        // (`class-template-lifecycle.ts`, #100). `pauseOrResumeRule` below has
        // this same guard-free shape. Not an omission: `updateMany` returns
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
          template: family.withSlot(template, { ...recordedRule, teacher: template.scheduleRule.teacher }),
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
    // Everything else is rethrown, and `withErrorHandler` (`src/lib/api-utils.ts`)
    // does log it — with `err`, `method` and `path`, which on this route name
    // neither the template, the teacher, nor the direction. This line is what
    // makes a rethrow attributable. The pause verb's catch carries its twin.
    log.error(
      { err, templateId, teacherId, target, kind: family.kind },
      'template archive/un-archive failed',
    );
    throw err;
  }
}

/**
 * Outcome of a pause/resume. `paused` carries the furthest-out entry still on
 * the schedule, for the pause confirmation; `active` carries what the window
 * holds and what this resume added (#119); `unchanged` reports nothing beyond
 * the template itself.
 *
 * Generic in the child rather than one type per family, and for the reasons
 * `ArchiveRuleResult` above sets out: the two families' pause unions were
 * measured arm-for-arm identical, and the two instantiations stay
 * non-interchangeable anyway because they differ in `template`. Held the same
 * way the archive's claim is, by `@ts-expect-error` call arguments in
 * `rule-lifecycle.test.ts`.
 */
export type PauseRuleResult<TChild> =
  | {
      ok: true;
      action: 'paused';
      template: WithSlot<TChild>;
      lastScheduled: LastScheduledClass | null;
    }
  | {
      ok: true;
      action: 'active';
      template: WithSlot<TChild>;
      /**
       * Live entries this rule still has from the start of the teacher's today
       * onward — `TemplateFamily.standingWhere`'s predicate and boundary,
       * which is also what `ArchiveRuleResult`'s `remaining` counts, so the
       * two numbers a teacher sees from archiving and from resuming mean the
       * same thing. Unbounded above: it counts what stands, not what this
       * resume's window reached.
       */
      scheduled: number;
      /**
       * Rows this resume created. `scheduled >= added`, always — and it holds
       * by construction, not by assertion. **No test pins the relation,
       * deliberately — know that before trusting it.** The argument below is
       * the entire guard; break a step of it and nothing will stop you.
       *
       * The count runs *after* generation, inside the same transaction, over a
       * superset of what generation inserts: the same rule, live (a row this
       * transaction just created is), dated at or after a boundary the
       * generator's own date filter already cleared, and — where a family's
       * `standingWhere` filters on its child's status too — in a status that
       * same predicate admits. That last conjunct is a property of how one
       * descriptor pairs its `standingWhere` with its `generate`, which is
       * where it has to be checked; nothing here can check it. Nothing else
       * can insert for this rule while the claim holds it, and this
       * transaction's own uncommitted rows cannot be cancelled by anyone else.
       * See the `scheduled` count in `pauseOrResumeRule` below for the one
       * input that could break it — a second, disagreeing read of
       * `defaultTimezone`.
       */
      added: number;
      /**
       * The skip breakdown, whole (#296) — one field rather than its members
       * re-listed, so a member added to `SkipCounts` arrives here with no edit
       * at this site.
       *
       * `SkipCounts` does not name every `SkipReason` (`src/lib/generation.ts`
       * carries which, and why a new one fails the build there rather than
       * vanishing), so these counts do **not** sum with `added` to the window.
       * The invariant that does hold is `GenerationResult`'s own: `created +
       * skipped.length` is the candidate count.
       */
      counts: SkipCounts;
    }
  | { ok: true; action: 'unchanged'; template: WithSlot<TChild> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' }
  /**
   * See `ArchiveRuleResult`'s `busy` arm above — same guarantee, same causes,
   * and the same reason the copy names no writer on the other side.
   *
   * What this arm adds is where the bound bites, and it is the same for every
   * family: `setLockTimeout` governs every statement left in
   * `pauseOrResumeRule`'s transaction, so it reaches PAST the CAS to the
   * generation claim's `SELECT … FOR UPDATE` and to generation's own inserts.
   * A resume contending with a concurrent writer therefore rolls the whole
   * transaction back and answers `busy`, rather than running on and reporting
   * that date as `raced`. Which statement gives up first is measured rather
   * than reasoned, and lives with its measurement — `class-generator.test.ts`,
   * "answers busy when the clash outlives the lock timeout, instead of
   * reporting it raced".
   */
  | { ok: false; reason: 'busy' };

/**
 * One arm per way `pauseOrResumeRule`'s transaction can resolve, mapped to the
 * public `PauseRuleResult` above once it has committed. None of these ever
 * carries the stale pre-transaction snapshot the CAS exists to stop being
 * trusted, but they get there differently: `paused`/`active` are read back
 * under the lock the successful CAS is still holding; `unchanged` (in the
 * count-0 miss branch) is a plain re-read that may or may not run under a lock
 * this transaction already holds — a miss leaves nothing locked if the
 * conflicting change committed before the `updateMany` even ran, but a miss
 * reached by that `updateMany` first blocking on the conflicting change and
 * only then losing its recheck leaves the row locked to commit regardless
 * (Postgres takes the lock before the recheck, not after) — either way the
 * plain re-read's correctness does not depend on which happened, exactly like
 * the miss branch `archiveOrUnarchiveRule` above runs; and `busy` carries no
 * template at all, so the question does not arise for it.
 */
export type PauseRuleOutcome<TChild> =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'busy' }
  | { outcome: 'unchanged'; template: WithSlot<TChild> }
  | { outcome: 'paused'; template: WithSlot<TChild> }
  | {
      outcome: 'active';
      template: WithSlot<TChild>;
      scheduled: number;
      added: number;
      counts: SkipCounts;
    };

/**
 * Pause or resume generation for one `ScheduleRule` child, for whichever
 * family `family` describes. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 *
 * Resuming generates, through `family.claim`/`family.generate` rather than
 * through the family's platform-wide sweep: a sweep takes no `teacherId` and
 * runs across every teacher, which is not something a single PATCH may do.
 *
 * Nothing here knows about rooms, and a resume onto an archived room is
 * refused elsewhere: `docs/lock-order.md`, "Where a resume onto an archived
 * room is refused", names the constraint that enforces it, the route that
 * words it and the family that cannot raise it.
 *
 * The write is a compare-and-swap, not a plain `update` — mirroring the CAS
 * `archiveOrUnarchiveRule` above runs, see that function for the fuller
 * account. The two guards below are read outside any lock and are fast paths
 * only, not the guarantee: a concurrent archive can commit between those reads
 * and the write. Without the CAS a plain `update` here — keyed on `{ id }`
 * alone — would not notice: it would re-read the new row version and set
 * `isActive: true` on a template that had just been archived. The CAS makes
 * that transition itself impossible instead of merely unlikely; a miss is
 * disambiguated with a plain re-read below rather than assumed — see there and
 * `PauseRuleOutcome` above for why that re-read is correct whether or not the
 * miss happens to leave a lock behind.
 *
 * The write and the generation share one transaction, so a generation failure
 * rolls the flip back rather than leaving a template flagged live with an
 * empty window. That sharing has a cost an autocommit `update` did not: this
 * can fail outright rather than only wait for a contended row. The CAS itself
 * takes `FOR UPDATE` on the rule row — `FOR NO KEY UPDATE` until issue 272
 * made `live` an FK-referenced key column, and both families share
 * `ScheduleRule`, so both took the upgrade — which conflicts with a sweep's
 * claim (`FOR UPDATE`) or a concurrent archive's own CAS, and can queue behind
 * either. The transaction's own `setLockTimeout(tx)` — its first statement —
 * bounds that wait at the same 2s `lock_timeout`, so the 10s budget covers
 * this transaction's own work, not the wait. Once the CAS succeeds this
 * transaction already holds the rule row, so the claim's own `FOR UPDATE` can
 * then only be blocked by something compatible with that but not with `FOR
 * UPDATE` — a concurrent insert's `FOR KEY SHARE` FK check on the child row —
 * and that 2s is what bounds that wait, never a sweep or an archive. The
 * claim's `SET LOCAL lock_timeout` governs every statement left in this
 * transaction, not just its own `SELECT … FOR UPDATE`, so the same 2s also
 * bounds each generated row's own `FOR KEY SHARE` on the `Teacher` row for its
 * FK. `Teacher.email`, `pageSlug` and `accountId` are all `@unique`, so an
 * update touching any of them — a teacher changing their page slug in another
 * tab, say — takes `FOR UPDATE` there instead of `FOR NO KEY UPDATE`, which
 * conflicts; negligible odds, but this paragraph exists to enumerate exactly
 * this class of thing.
 */
export async function pauseOrResumeRule<TChild>(
  db: PrismaClient,
  family: TemplateFamily<TChild>,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseRuleResult<TChild>> {
  const template = await family.readChild(db, templateId);
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const desiredActive = target === 'active';

  // Fast path, not the guarantee — read outside any lock, before the
  // transaction below opens. A request racing between this read and the CAS
  // inside that transaction is not closed by this check; see the CAS's own
  // comment for what actually closes it. Before the archived guard,
  // deliberately: archiving forces `isActive: false`, so `?state=paused` on an
  // archived template is already true and there is nothing to refuse — only
  // `?state=active` is the transition the guard below exists to block.
  if (template.scheduleRule.isActive === desiredActive) {
    return {
      ok: true,
      action: 'unchanged',
      template: family.withSlot(template, template.scheduleRule),
    };
  }

  // Also a fast path only, for the same reason: a concurrent archive can
  // commit between this read and the transaction's CAS. That race is closed by
  // the CAS's disambiguation below, not by this check.
  if (template.scheduleRule.isArchived) return { ok: false, reason: 'archived' };

  let result: PauseRuleOutcome<TChild>;
  try {
    result = await db.$transaction(
      async (tx): Promise<PauseRuleOutcome<TChild>> => {
        // Bounds every statement left in this transaction, the child lock
        // immediately below first among them, then the CAS.
        //
        // Without it the wait is bounded by NOTHING, which is a stronger
        // statement than the 10s budget and the one that is true: Prisma
        // checks that budget at statement boundaries, so it "cannot roll back
        // a statement already blocked inside Postgres, only refuse to start a
        // new one" (`db-locks.ts`). The mutation records measure it — removing
        // this line ends in a hung test, never a 10s abort.
        await setLockTimeout(tx);

        // The child's row lock, taken explicitly and first — before the CAS
        // below touches `ScheduleRule` at all. `isActive`/`isArchived` live on
        // `ScheduleRule` since issue 298, so a bare `updateMany` there locks
        // nothing a concurrent `family.claim` or archive waits on; those
        // serialise through this same statement instead. See
        // `docs/lock-order.md`, "The child row is the lock node for the
        // template families" for the decision this implements.
        //
        // Row count checked, not discarded: `ScheduleRule` carries no FK back
        // to either child table, so a child deleted out from under this
        // transaction leaves an orphaned rule row the CAS below would still
        // match, and the CAS cannot tell that apart from a real one.
        //
        // `Prisma.raw` because `$queryRaw`'s placeholders bind a value, never
        // an identifier. What bounds the splice is `childTable`'s type, not
        // this comment.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM ${Prisma.raw(`"${family.childTable}"`)} WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) {
          // Logged at `error` rather than returned quietly, for the reason
          // `archiveOrUnarchiveRule`'s twin of this branch sets out above: the
          // pre-transaction read found this child, so reaching here means it
          // was deleted between that read and this lock, and both verbs' CAS
          // rests on the same invariant. The teacher still gets a plain 404.
          log.error(
            { templateId, scheduleRuleId: template.scheduleRuleId, kind: family.kind, teacherId },
            'pause/resume found no child row to lock for a template it had just read',
          );
          return { outcome: 'not_found' };
        }

        // Compare-and-swap, mirroring the one `archiveOrUnarchiveRule` above
        // runs: constraining the write to the exact `isActive`/`isArchived`
        // values already read above makes the transition itself — not just
        // this request — what can happen only once, closing the race the two
        // fast paths above cannot.
        //
        // No P2025 guard here: `updateMany` returns `{ count: 0 }` rather than
        // throwing when nothing matches, and the zero-count branch below
        // already answers `not_found` by re-reading. The `findUniqueOrThrow`
        // on the paused arm below, and whatever read `family.claim` makes on
        // the active arm, *can* raise P2025, but only run after this CAS
        // matched — which, as this function's own docblock notes, holds this
        // row until commit (`FOR UPDATE` since issue 272). That conflicts with
        // the `FOR UPDATE`-strength lock a concurrent `DELETE` needs, so it
        // blocks rather than wins. What a plain single-record `update` would
        // change is not the lock — it takes the same mode — but the first
        // limb: it raises P2025 where `updateMany` returns `{ count: 0 }`, so
        // the write itself becomes a P2025 source needing its own guard.
        //
        // No `23P01` guard here either, and this one is worth proving rather
        // than asserting. `data` below is `{ isActive: desiredActive }` —
        // nothing else — and `ScheduleRule_teacher_slot_excl` excludes on
        // `(teacherId, dayOfWeek, slot)` `WHERE isArchived = false`. None of
        // the columns that key names is in this write's `data`, so the
        // excluded values themselves are unchanged: a row that already
        // satisfied the constraint still does, regardless of which mechanism
        // Postgres uses to re-check it. That exemption is local to this write,
        // not to the module: `archiveOrUnarchiveRule`'s CAS DOES write
        // `isArchived`, and un-archiving into a slot another live rule holds is
        // exactly what makes that one raise `23P01` — see its `catch`.
        const swapped = await tx.scheduleRule.updateMany({
          where: { id: template.scheduleRuleId, isArchived: false, isActive: !desiredActive },
          data: { isActive: desiredActive },
        });

        if (swapped.count === 0) {
          // The fast paths above missed a race. A miss here may or may not
          // leave this transaction holding a lock on the row, and this plain
          // re-read is correct either way. See the miss branch inside
          // `archiveOrUnarchiveRule` above for the full account rather than
          // repeating it here, and see there for why taking a lock here on
          // purpose would not be worth it.
          const current = await family.readChild(tx, templateId);
          if (!current) {
            // Same impossible-by-invariant shape as the child lock above, and
            // logged for the same reason the archive's twin is: the child
            // `FOR UPDATE` this transaction still holds means no other
            // transaction can have deleted this row since.
            log.error(
              { templateId, scheduleRuleId: template.scheduleRuleId, kind: family.kind, teacherId },
              'pause/resume re-read found no child row while holding its row lock',
            );
            return { outcome: 'not_found' };
          }
          // `isActive === desiredActive` before `isArchived`, deliberately —
          // the same order as the fast paths above, and for the same reason:
          // archiving forces `isActive: false`, so an archived row racing a
          // *pause* is simultaneously "already the desired state" and
          // "archived". Checking already-desired first answers that case
          // `unchanged`, matching the fast path and the guard order this
          // function documents there; checking `isArchived` first would answer
          // a plain pause with a 409 meant for resuming an archived template.
          // A racing *resume* is not already-desired (its `isActive` is still
          // `false`), so it falls through to the `isArchived` check below
          // regardless of order.
          if (current.scheduleRule.isActive === desiredActive) {
            return {
              outcome: 'unchanged',
              template: family.withSlot(current, current.scheduleRule),
            };
          }
          if (current.scheduleRule.isArchived) return { outcome: 'archived' };
          // Residual, and REACHABLE — measured, not conceded. The CAS's
          // `where` is `isArchived: false AND isActive: !desiredActive`; a miss
          // means one of those held *when the CAS ran*, and both are checked
          // above against a second, later read. Under READ COMMITTED each
          // statement takes its own snapshot, so a row that changed back in
          // between reaches here.
          //
          // `busy`, not a throw. Why that is the right answer, what the route
          // renders it as, and why both families must answer alike are one
          // argument about three other modules, so it lives in
          // `docs/lock-order.md`, "A CAS miss no re-read can classify answers
          // `busy`, not a throw". What belongs beside the code is only that
          // this branch is that case: the CAS matched ZERO rows, so this
          // transaction has written nothing and rolls back clean.
          //
          // Logged rather than silent: the observed row is the half of `busy`
          // that no `err` carries, and a steady trickle here with no
          // concurrent writer would mean the CAS predicate and this
          // classification have drifted apart.
          log.warn(
            {
              templateId,
              teacherId,
              target,
              observed: {
                isActive: current.scheduleRule.isActive,
                isArchived: current.scheduleRule.isArchived,
              },
              desiredActive,
            },
            `${family.logNoun} pause/resume CAS missed and the re-read matched no classification`,
          );
          return { outcome: 'busy' };
        }

        if (!desiredActive) {
          // `updateMany` returns a count, not a row. Safe to read back here
          // specifically because the CAS above holds the rule row's lock until
          // we commit — the same lock-then-read pattern `family.claim` uses.
          // The child half comes from the pre-transaction read instead:
          // pausing writes nothing on a child table, so that snapshot is still
          // current.
          const pausedRule = await tx.scheduleRule.findUniqueOrThrow({
            where: { id: template.scheduleRuleId },
          });
          return {
            outcome: 'paused',
            // `teacher` composed in from the row already in scope rather than
            // re-queried: this read asks for the rule's own columns, and the
            // teacher's zone is not one of them and cannot have moved under a
            // lock this transaction holds.
            template: family.withSlot(template, {
              ...pausedRule,
              teacher: template.scheduleRule.teacher,
            }),
          };
        }

        // Take the row lock before generating. The CAS above only flipped
        // `isActive`, a non-key column, so Postgres grants it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent child insert takes on this template for FK integrity.
        // Without this claim that race is live; `FOR UPDATE` makes the
        // collision impossible instead of leaving it to the generator's
        // `ON CONFLICT DO NOTHING`, which would cost that date's class with no
        // error (#94).
        const claimed = await family.claim(tx, templateId);
        if (!claimed) {
          // Genuinely unreachable, not just believed to be. The CAS above just
          // proved `isArchived: false` and `isActive: true` in the same
          // statement that took this row's write lock, and that lock is still
          // held here — nothing else can have archived, paused or deleted the
          // row since. A null here would mean the claim's eligibility
          // predicate and this CAS's have drifted apart from each other, not
          // that a race slipped past either one.
          throw new Error(
            `pauseOrResumeRule: claim returned null for ${family.logNoun} template ${templateId} ` +
              "right after this transaction's own CAS confirmed it eligible — " +
              'the claim predicate and the CAS predicate have diverged',
          );
        }
        // Must be `tx`, not `db` — the two are not interchangeable here even
        // though a family's real generator accepts both. The claim above holds
        // `FOR UPDATE` on this row on `tx`'s connection; an insert issued
        // through `db` runs on a separate connection and needs `FOR KEY SHARE`
        // on the same row for its FK check, which cannot be granted while `FOR
        // UPDATE` is open. `tx` cannot close to release it because it is
        // awaiting this very call. Passing `db` here therefore does not fail
        // fast or cleanly: it blocks for the full 10s transaction timeout
        // below, then throws — Postgres's deadlock detector does not step in,
        // because this is one connection waiting on a lock, not a wait-for
        // cycle between two backends. Measured, not reasoned: swapping `tx`
        // for `db` and running this shape standalone fails at 10.0s with
        // Prisma's P2028 ("transaction already closed").
        //
        // Under vitest it looks like 5s instead, because vitest's own default
        // `testTimeout` is 5000ms and fires first — a property of the harness,
        // not of Prisma or of this code. Do not read that 5s as the real
        // budget, and do not "correct" the 10s above to match it.
        const generation = await family.generate(tx, claimed);
        const added = generation.created;
        // `countSkipReasons` (`@/lib/generation`) is the one place the skip
        // counts are reduced from `generation.skipped` — see its docblock for
        // why a further `SkipReason` fails the build here instead of vanishing.
        //
        // Kept whole rather than destructured (#296): naming the members here
        // is what made every count after the first a hand-thread through four
        // hops, and carrying the object means the next one needs no edit at
        // this site at all. A member this family's generator cannot yet produce
        // is carried the same way rather than replaced with a literal 0.
        const counts = countSkipReasons(generation.skipped);

        // `standingWhere`, the same predicate and boundary the archive's
        // `remaining` reads, so archiving and resuming report on one basis. It
        // takes `today` inclusive: this path deletes nothing, so there is no
        // spare-today carve-out to mirror — an entry dated today is on the
        // schedule and must be counted.
        //
        // `claimed`'s zone, and it must be that read rather than any other of
        // the same column. Not because it is locked — it is not: the claim's
        // `FOR UPDATE` is on the child row, while `defaultTimezone` lives on
        // `Teacher`, reached by the claim's own join, and it is not a unique
        // column, so a concurrent change to it takes `FOR NO KEY UPDATE` and
        // commits straight past us. The reason is stronger than a lock:
        // `family.generate` filtered its candidate dates against this same
        // `claimed`, so keying the count's boundary to a *different* read of
        // that column is the one way `scheduled < added` becomes reachable.
        // Concretely, a filter that admitted today-in-`Pacific/Niue` (UTC-11)
        // against a count whose `today` came from `Pacific/Kiritimati` (UTC+14)
        // would put the just-added row a day outside the boundary. Do not
        // "simplify" this to `template.scheduleRule.teacher.…`.
        const today = startOfLocalDay(new Date(), claimed.scheduleRule.teacher.defaultTimezone);
        const scheduled = await tx.calendarEntry.count({
          where: family.standingWhere(claimed.scheduleRuleId, today),
        });

        // The state a create's own transaction exists to prevent — a template
        // flagged live that produces no classes — is reachable here *without
        // failing*: every candidate date already holds a cancelled row, so
        // generation creates nothing and there is no throw for
        // `withErrorHandler` to classify. The teacher is told
        // (`template-action-messages.ts`, the `scheduled === 0` branch); this
        // line carries the measured breakdown to the operator side. Rare
        // enough not to be noise: it only fires on a resume that leaves the
        // window empty.
        if (scheduled === 0) {
          log.warn(
            { templateId, teacherId, added, ...counts },
            `${family.logNoun} template resumed live with an empty window`,
          );
        }

        return {
          outcome: 'active',
          template: family.withSlot(claimed, claimed.scheduleRule),
          scheduled,
          added,
          counts,
        };
      },
      // Three 10s budgets: the claim's own transaction, this transaction, and
      // this wait at the head of one of the sweep's. They do not compose as a
      // chain — a family's claim selects only live rules, and the resume below
      // only runs on a paused template (its CAS constrains `isActive: false`),
      // so a resume can never sit between two claims as the middle link; it
      // can only be the HEAD that waits out a sweep's claim. Matching the
      // sweep's 10s transaction timeout still matters, because Prisma's 5s
      // default can be exceeded by a loaded VPS and turn an ordinary resume
      // click into an opaque P2028.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient is the one branch that RETURNS, and a returned failure never
    // reaches `withErrorHandler`, so the line inside it is the only record of
    // that case. The message names this VERB because the wrapper cannot — a
    // pause and an archive reach the same route with the same method and the
    // same path, and the query parameter that separates them is deliberately
    // excluded from request logs.
    if (isTransientDbError(err)) {
      // `target` because the message names the verb and stops there: it reads
      // "pause/resume", so this field is the only thing telling a pause from a
      // resume. The route's copy does distinguish the two.
      log.warn(
        { err, templateId, teacherId, target },
        `${family.logNoun} pause/resume lost the template lock race`,
      );
      return { ok: false, reason: 'busy' };
    }
    // Everything else is rethrown, and `withErrorHandler` (`src/lib/api-utils.ts`)
    // does log it — with `err`, `method` and `path`, which on this route name
    // neither the template, the teacher, nor the direction. This line is what
    // makes a rethrow attributable.
    log.error(
      { err, templateId, teacherId, target, kind: family.kind },
      'template pause/resume failed',
    );
    throw err;
  }

  // A `switch` rather than a chain of `if`s, because such a chain's
  // exhaustiveness is accidental: it ends in a bare fall-through to the
  // `paused` work below, so a new `PauseRuleOutcome` arm carrying a `template`
  // compiles clean, falls past every `if`, and is answered `action: 'paused'`
  // — with a `lastScheduled` query it never asked for. Only an arm *without* a
  // `template` is caught that way. The `default` below is the same `never`
  // idiom the template routes use for their public unions; `paused` breaks out
  // to the post-transaction work it needs, which is the one thing that cannot
  // be expressed as a `return` here.
  switch (result.outcome) {
    case 'not_found':
      return { ok: false, reason: 'not_found' };
    case 'archived':
      return { ok: false, reason: 'archived' };
    case 'busy':
      return { ok: false, reason: 'busy' };
    case 'unchanged':
      return { ok: true, action: 'unchanged', template: result.template };
    case 'active':
      return {
        ok: true,
        action: 'active',
        template: result.template,
        scheduled: result.scheduled,
        added: result.added,
        counts: result.counts,
      };
    case 'paused':
      break;
    default: {
      const unhandled: never = result;
      throw new Error(
        `pauseOrResumeRule: unhandled transaction outcome ${JSON.stringify(unhandled)}`,
      );
    }
  }

  // `standingWhere` again, so the entry this names is one of the ones the
  // resume arm would have counted: pause deletes nothing, so there is no
  // spare-today carve-out to mirror here — today's class is still on the
  // schedule and must be reported as such.
  const today = startOfLocalDay(new Date(), template.scheduleRule.teacher.defaultTimezone);
  const lastScheduledRow = await db.calendarEntry.findFirst({
    where: family.standingWhere(template.scheduleRuleId, today),
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    select: { date: true, startTime: true },
  });
  const lastScheduled: LastScheduledClass | null = lastScheduledRow && {
    date: lastScheduledRow.date,
    startTime: timeToHHmm(lastScheduledRow.startTime),
  };
  return { ok: true, action: 'paused', template: result.template, lastScheduled };
}
