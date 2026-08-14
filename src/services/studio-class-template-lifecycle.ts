/**
 * Studio Class Template lifecycle — pause/resume and archive/un-archive for
 * `PATCH /api/studio-class-templates/[id]` (#86, #98).
 *
 * The studio sibling of `class-template-lifecycle.ts`'s pause/archive section.
 * Deliberately not sharing an implementation with it — PR #92 found the two
 * families had already drifted apart in their guards, and their registration
 * semantics genuinely differ. Three differences from the class family matter
 * here:
 *
 *   - Where the class family's deletable predicate spreads a `status: {
 *     in: ['draft', 'open'] }` clause, the studio predicate has no status to
 *     filter on. It uses `cancelledAt: null` instead — an already-cancelled
 *     future class is an income record, not a bookable offer, and archiving
 *     must leave it standing exactly like the class family leaves a charged
 *     registration standing.
 *   - Where the class family excludes any class with a registration in a
 *     CHARGED status, the studio family has no registrations to consult at
 *     all — `studentCount` is a plain, unconnected `Int?`. So every future
 *     uncancelled studio class the delete's boundary can reach is deletable.
 *     That boundary deliberately spares a class dated today — the same
 *     carve-out the class family has — so `remaining` is a real query keyed
 *     at the start of the teacher's today, not a hardcoded 0: today's
 *     survivor is the one row it can ever find.
 *   - `pauseOrResumeStudioTemplate`'s resume write is a compare-and-swap, not
 *     a plain `update`, and takes a claim
 *     (`claimStudioTemplateForGeneration`, `studio-class-generator.ts`)
 *     before generating — see that function's own doc comment for why both
 *     matter (#94). The class family's `pauseOrResumeTemplate`
 *     (`class-template-lifecycle.ts`) also generates inside its own
 *     `$transaction` on resume — that part is not a difference — but with a
 *     plain `update` and no claim first (#116).
 */

import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
import { countSkipReasons } from '@/lib/generation';
// Server-only (pino). Safe here: this module's sole importer is
// `api/studio-class-templates/[id]/route.ts`, and it already pulls `@/lib/log`
// transitively through `studio-class-generator`. No `'use client'` component
// value-imports anything in this chain.
import { log } from '@/lib/log';
import type { LastScheduledClass } from './class-template-lifecycle';
import {
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';

/**
 * Outcome of a pause/resume PATCH. `paused` carries the furthest-out class
 * still on the schedule, for the pause confirmation; `active` carries what the
 * window holds and what this resume added (#119); `unchanged` reports nothing
 * beyond the template itself.
 *
 * `active` mirrors `PauseTemplateResult`'s own `active` arm exactly: both
 * families now report `scheduled`, `added`, `blockedByCancelled` and
 * `slotTaken`.
 *
 * This used to say the class family was "deliberately not fixed alongside
 * this", because its resume generates *without* taking the claim and a count
 * from an unclaimed generation would be a racy count. That reason has not gone
 * away — `pauseOrResumeTemplate` still takes no claim, and **#116 is still
 * open** — but it stopped being a reason to withhold the numbers: since #164
 * a lost race costs one date and reports it, rather than aborting the
 * transaction, so the count is honest about a smaller window instead of being
 * a count of rows that were rolled back. #116 makes the race rarer; it is no
 * longer what makes the number safe to publish.
 */
export type PauseStudioTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: StudioClassTemplate;
      lastScheduled: LastScheduledClass | null;
    }
  | {
      ok: true;
      action: 'active';
      template: StudioClassTemplate;
      /**
       * Uncancelled studio classes for this template from the start of the
       * teacher's today onward — the same predicate and boundary
       * `ArchiveStudioTemplateResult`'s `remaining` uses, so the two numbers a
       * teacher sees from archiving and from resuming mean the same thing.
       * Unbounded above; see `resumeStudioMessage` for why the copy therefore
       * promises no window.
       */
      scheduled: number;
      /**
       * Rows this resume created. `scheduled >= added`, always — and by
       * construction rather than by assertion, which is why no test tries to
       * pin the relation directly. The count runs *after* generation, inside
       * the same transaction, over a strict superset of what generation
       * inserts: same `templateId`, `cancelledAt: null` (new rows default to
       * null), and `date: { gte: today }` (the generator keeps only dates whose
       * start instant is still ahead, so none can predate the teacher's local
       * today). Nothing else can insert for this `templateId` while the claim
       * holds it, and this transaction's own uncommitted rows cannot be
       * cancelled by anyone else. See the count below for the one input that
       * could break it — a second, disagreeing read of `defaultTimezone`.
       */
      added: number;
      /**
       * Candidate dates a cancelled instance of this template holds (#192).
       * The count that makes the `scheduled === 0` operator warn, and the
       * resume copy, a measured number rather than an inference.
       *
       * These two counts do **not** sum with `added` to the window: they are
       * two of the four `SkipReason` members (`src/lib/generation.ts`), and
       * they omit `already_generated` — the common case — and `raced`. On a
       * steady-state hourly sweep all three of these numbers are zero while
       * the window still has four candidate dates. The invariant that does
       * hold is `GenerationResult`'s own: `created + skipped.length` is the
       * candidate count.
       */
      blockedByCancelled: number;
      /**
       * Candidate dates another of this teacher's studio classes holds (#196).
       */
      slotTaken: number;
    }
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' }
  | { ok: false; reason: 'busy' };

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all — see
 * `ArchiveTemplateResult` for why the un-archiving and unchanged arms carry
 * no counts.
 */
export type ArchiveStudioTemplateResult =
  | {
      ok: true;
      action: 'archived';
      template: StudioClassTemplate;
      deleted: number;
      remaining: number;
    }
  | { ok: true; action: 'unarchived'; template: StudioClassTemplate }
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'slot_conflict' }
  /**
   * The template row was held by another writer — the generation sweep, or
   * another tab's archive or resume — for longer than the 2s `lock_timeout`.
   * The whole transaction rolled back, so nothing was applied and the
   * identical request can win the next attempt.
   */
  | { ok: false; reason: 'busy' };

/**
 * Studio classes still on the schedule for a template, from the given
 * calendar-date boundary onward. The studio analogue of `scheduledWhere` in
 * `class-template-lifecycle.ts`, but keyed on `cancelledAt` rather than
 * `status` because that is the only lifecycle column `StudioClass` has.
 *
 * The boundary is a parameter for the same reason as there: the delete uses
 * `gt` (today's class is spared) and the counts use `gte` (today's class is
 * the survivor they must report), against a calendar date from
 * `startOfLocalDay` rather than a raw instant.
 */
const scheduledWhere = (templateId: string, date: { gt: Date } | { gte: Date }) => ({
  templateId,
  date,
  cancelledAt: null,
});

/**
 * One arm per way `pauseOrResumeStudioTemplate`'s transaction can resolve.
 * Internal only — mapped to the public `PauseStudioTemplateResult` after the
 * transaction commits. None of these ever carries the stale pre-transaction
 * snapshot the CAS exists to stop being trusted, but they get there
 * differently: `paused`/`active` are read back under the lock the successful
 * CAS is still holding; `unchanged` (in the count-0 miss branch) is a plain
 * re-read that may or may not run under a lock this transaction already
 * holds — a miss leaves nothing locked if the conflicting change committed
 * before this transaction's `updateMany` even ran, but a miss reached by
 * that `updateMany` first blocking on the conflicting change and only then
 * losing its recheck leaves the row locked to commit regardless (Postgres
 * takes the lock before the recheck, not after). Either way the plain
 * re-read's correctness does not depend on which happened, exactly like
 * `archiveOrUnarchiveStudioTemplate`'s own miss branch.
 */
type ResumeTransactionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'unchanged'; template: StudioClassTemplate }
  | { outcome: 'paused'; template: StudioClassTemplate }
  | {
      outcome: 'active';
      template: StudioClassTemplate;
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    };

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 *
 * Unlike before #94, resuming generates. It still does not call
 * `generateStudioClassInstances` — that takes no `teacherId` and sweeps every
 * active template platform-wide, across every teacher, which is not
 * something a single PATCH may do. It calls
 * `generateStudioInstancesForTemplate` instead, which is scoped to one
 * template and accepts this transaction's client.
 *
 * The write is a compare-and-swap, not a plain `update` — mirroring
 * `archiveOrUnarchiveStudioTemplate`, see that function for the fuller
 * account. The two guards below are read outside any lock and are fast
 * paths only, not the guarantee: a concurrent archive can commit between
 * those reads and the write. Without the CAS a plain `update` here — keyed
 * on `{ id }` alone — would not notice: it would re-read the new row version
 * and set `isActive: true` on a template that had just been archived. The
 * CAS makes that transition itself impossible instead of merely unlikely; a
 * miss is disambiguated with a plain re-read below rather than assumed — see
 * there and `ResumeTransactionOutcome` above for why that re-read is correct
 * whether or not the miss happens to leave a lock behind.
 *
 * The write and the generation share one transaction, so a generation
 * failure rolls the flip back rather than leaving a template flagged live
 * with an empty window — the state this issue was filed about. That sharing
 * has a cost the old autocommit `update` did not: this can now fail outright
 * rather than only wait for a contended row. The CAS itself takes `FOR NO
 * KEY UPDATE`, which conflicts with a sweep's claim (`FOR UPDATE`) or a
 * concurrent archive's own CAS (also `FOR NO KEY UPDATE`), and can queue
 * behind either. The transaction's own `setLockTimeout(tx)` — its first
 * statement — bounds that wait at the same 2s `lock_timeout`, so the 10s
 * budget covers this transaction's own work, not the wait. Once the CAS
 * succeeds this transaction already
 * holds `FOR NO KEY UPDATE`, so the claim's own `FOR UPDATE` below can then
 * only be blocked by something compatible with that but not with `FOR
 * UPDATE` — a concurrent `StudioClass` insert's `FOR KEY SHARE` FK check —
 * and that 2s is what bounds that wait, never a sweep or an archive. The
 * claim's `SET LOCAL lock_timeout` governs every statement left in this
 * transaction, not just its own `SELECT … FOR UPDATE`, so the same 2s also
 * bounds each generated `StudioClass` insert's own `FOR KEY SHARE` on the
 * `Teacher` row for its FK. `Teacher.email`, `pageSlug` and `accountId` are
 * all `@unique`, so an update touching any of them — a teacher changing their
 * page slug in another tab, say — takes `FOR UPDATE` there instead of `FOR NO
 * KEY UPDATE`, which conflicts; negligible odds, but this paragraph exists to
 * enumerate exactly this class of thing.
 */
export async function pauseOrResumeStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Dropped rather than leaked back to the caller — `PauseStudioTemplateResult`
  // carries a plain `StudioClassTemplate`, and this early-return path never
  // reaches the write below that would otherwise need the join.
  const { teacher: _t, ...bare } = template;
  void _t;

  const desiredActive = target === 'active';

  // Fast path, not the guarantee — read outside any lock, before the
  // transaction below opens. A request racing between this read and the
  // CAS inside that transaction is not closed by this check; see the CAS's
  // own comment for what actually closes it. Before the archived guard,
  // deliberately, for the same reason as the class family's
  // `pauseOrResumeTemplate`: archiving forces `isActive: false`, so
  // `?state=paused` on an archived template is already true and there is
  // nothing to refuse — only `?state=active` is the transition the guard
  // below exists to block.
  if (template.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: bare };
  }

  // Also a fast path only, for the same reason: a concurrent archive can
  // commit between this read and the transaction's CAS. That race is closed
  // by the CAS's disambiguation below, not by this check.
  if (template.isArchived) return { ok: false, reason: 'archived' };

  let result: ResumeTransactionOutcome;
  try {
    result = await db.$transaction(
      async (tx): Promise<ResumeTransactionOutcome> => {
        // Bounds every statement left in this transaction, the CAS below first
        // among them — the sweep's claim holds this row `FOR UPDATE`, and
        // without this the wait is bounded only by the 10s budget.
        await setLockTimeout(tx);

        // Compare-and-swap, mirroring `archiveOrUnarchiveStudioTemplate`:
        // constraining the write to the exact `isActive`/`isArchived` values
        // already read above makes the transition itself — not just this
        // request — what can happen only once, closing the race the two fast
        // paths above cannot.
        //
        // No P2025 guard here, unlike `updateClassTemplate` and
        // `pauseOrResumeTemplate` in the class family (#100). Not an omission:
        // `updateMany` returns `{ count: 0 }` rather than throwing when nothing
        // matches, and the zero-count branch below already answers `not_found`
        // by re-reading. The `findUniqueOrThrow` on the paused arm below, and
        // `claimStudioTemplateForGeneration`'s own read on the active arm, *can*
        // raise P2025, but only run after this CAS matched, which — as this
        // function's own docstring above notes — holds `FOR NO KEY UPDATE` on
        // this row until commit. That conflicts with the `FOR UPDATE`-strength
        // lock a concurrent `DELETE` needs, so it blocks rather than wins.
        // What a plain single-record `update` would change is not the lock —
        // it takes the same mode — but the first limb: it raises P2025 where
        // `updateMany` returns `{ count: 0 }`, so the write itself becomes a
        // P2025 source needing its own guard.
        //
        // No P2002 guard here either, and this one is worth proving rather
        // than asserting — the class family's `pauseOrResumeTemplate`
        // (`class-template-lifecycle.ts`) carries the identical proof for its
        // own CAS, and it never got ported here. `data` below is
        // `{ isActive: desiredActive }` — nothing else — and
        // `StudioClassTemplate_teacher_slot_unique` covers `(teacherId,
        // dayOfWeek, startTime)` `WHERE isArchived = false`. None of those four
        // columns is in this write's `data`, so the indexed values themselves
        // are unchanged: a row that already satisfied the constraint still
        // does, regardless of which mechanism Postgres uses to re-check it.
        // That exemption is local to this write, not to the file:
        // `archiveOrUnarchiveStudioTemplate`'s own CAS, further down, DOES
        // write `isArchived`, and un-archiving into a slot another live
        // template holds is exactly what makes that one raise P2002 — see its
        // own `catch` for where that is handled.
        const swapped = await tx.studioClassTemplate.updateMany({
          where: { id: templateId, isArchived: false, isActive: !desiredActive },
          data: { isActive: desiredActive },
        });

        if (swapped.count === 0) {
          // The fast paths above missed a race. A miss here may or may not
          // leave this transaction holding a lock on the row, and the plain
          // re-read below does not depend on which: if the conflicting change
          // committed before this `updateMany`'s own snapshot, the `where`
          // simply evaluated against, and was rejected by, that already-
          // committed version, and nothing was locked. If instead the change
          // committed while this `updateMany` was already blocked waiting on
          // it — the exact interleaving the race tests in
          // `studio-class-template-lifecycle.test.ts` construct — Postgres
          // locks the newest row version first and only then re-checks the
          // `where` against it; a rejection at that point still leaves the lock
          // held to commit. Disambiguate with a plain re-read either way,
          // exactly as `archiveOrUnarchiveStudioTemplate`'s own miss branch
          // does — and see there for why taking a lock here on purpose would
          // not be worth it. Follow that hop with the paragraph above in hand,
          // though: it forwards to `class-template-lifecycle.ts`, whose version
          // of this comment asserts flatly that a missed CAS "holds no lock:
          // the CAS matched nothing, so it acquired none". That sentence is
          // wrong for exactly the blocked-then-rejected case described here,
          // and #117 owns correcting it — the reasoning about whether to lock
          // survives it, the claim about what is already held does not.
          const current = await tx.studioClassTemplate.findUnique({ where: { id: templateId } });
          if (!current) return { outcome: 'not_found' };
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
          if (current.isActive === desiredActive) {
            return { outcome: 'unchanged', template: current };
          }
          if (current.isArchived) return { outcome: 'archived' };
          // Residual, not provably unreachable this time — said plainly after
          // getting that claim wrong once already on this branch. The CAS's own
          // `where` is `isArchived: false AND isActive: !desiredActive`; a miss
          // means `isArchived` OR `isActive === desiredActive` held *when the
          // CAS ran* — both checked above against a *second*, later read. Under
          // READ COMMITTED each statement gets its own snapshot, so a row that
          // could change back between those two snapshots — a second race
          // stacked on the first — could in principle reach here. Surfacing
          // that rather than silently falling through to the code below, which
          // assumes the CAS actually succeeded.
          throw new Error(
            `pauseOrResumeStudioTemplate: template ${templateId} matched neither the CAS ` +
              'nor any of its disambiguated misses — its state changed again between them',
          );
        }

        if (!desiredActive) {
          // `updateMany` returns a count, not a row. Safe to read back here
          // specifically because the CAS above holds this row's lock until we
          // commit — the same lock-then-read pattern the generator's claim
          // uses.
          const paused = await tx.studioClassTemplate.findUniqueOrThrow({
            where: { id: templateId },
          });
          return { outcome: 'paused', template: paused };
        }

        // Take the row lock before generating. The CAS above only flipped
        // `isActive`, a non-key column, so Postgres grants it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent `StudioClass` insert takes on this template for FK
        // integrity. Without this claim that race is live; `FOR UPDATE` makes
        // the collision impossible instead of leaving it to the generator's
        // `ON CONFLICT DO NOTHING`, which would cost that date's class with no
        // error (#94).
        const claimed = await claimStudioTemplateForGeneration(tx, templateId);
        if (!claimed) {
          // Genuinely unreachable now, not just believed to be. The CAS above
          // just proved `isArchived: false` and `isActive: true` in the same
          // statement that took this row's write lock, and that lock is still
          // held here — nothing else can have archived, paused or deleted the
          // row since. A null here would mean the claim's eligibility
          // predicate and this CAS's have drifted apart from each other, not
          // that a race slipped past either one.
          throw new Error(
            `pauseOrResumeStudioTemplate: claim returned null for template ${templateId} ` +
              "right after this transaction's own CAS confirmed it eligible — " +
              'the claim predicate and the CAS predicate have diverged',
          );
        }
        // Must be `tx`, not `db` — the two are not interchangeable here even
        // though both satisfy the parameter's type. The claim above holds
        // `FOR UPDATE` on this row on `tx`'s connection; a `StudioClass`
        // insert issued through `db` runs on a separate connection and needs
        // `FOR KEY SHARE` on the same row for its FK check, which cannot be
        // granted while `FOR UPDATE` is open. `tx` cannot close to release it
        // because it is awaiting this very call. Passing `db` here therefore
        // does not fail fast or cleanly: it blocks for the full 10s
        // transaction timeout below, then throws — Postgres's deadlock
        // detector does not step in, because this is one connection waiting
        // on a lock, not a wait-for cycle between two backends. Measured, not
        // reasoned: swapping `tx` for `db` and running this shape standalone
        // fails at 10.0s with Prisma's P2028 ("transaction already closed").
        //
        // Under vitest it looks like 5s instead, because vitest's own default
        // `testTimeout` is 5000ms and fires first — a property of the harness,
        // not of Prisma or of this code. Do not read that 5s as the real
        // budget, and do not "correct" the 10s above to match it.
        const generation = await generateStudioInstancesForTemplate(tx, claimed);
        const added = generation.created;
        // `countSkipReasons` (`@/lib/generation`) is the one place
        // `blockedByCancelled`/`slotTaken` are reduced from
        // `generation.skipped` — see its docblock for why a fifth
        // `SkipReason` fails the build here instead of vanishing.
        const { blockedByCancelled, slotTaken } = countSkipReasons(generation.skipped);

        // Same helper and same boundary as `archiveOrUnarchiveStudioTemplate`'s
        // `remaining`, so archiving and resuming report on one basis. `gte`, not
        // `gt`: this path deletes nothing, so there is no spare-today carve-out
        // to mirror — a class dated today is on the schedule and must be counted.
        //
        // `claimed.teacher.defaultTimezone`, and it must be that value rather
        // than any other read of the same column. Not because it is locked — it
        // is not: the claim's `FOR UPDATE` is on the `StudioClassTemplate` row,
        // while `defaultTimezone` lives on `Teacher`, reached by the claim's
        // `include` join, and it is not a unique column, so a concurrent change
        // to it takes `FOR NO KEY UPDATE` and commits straight past us. The
        // reason is stronger than a lock: `generateStudioInstancesForTemplate`
        // filtered its candidate dates with `classStartInstant(date, startTime,
        // template.teacher.defaultTimezone)` off this same `claimed`, so keying
        // the count's boundary to a *different* read of that column is the one
        // way `scheduled < added` becomes reachable. Concretely, a filter that
        // admitted today-in-`Pacific/Niue` (UTC-11) against a count whose `today`
        // came from `Pacific/Kiritimati` (UTC+14) would put the just-added row a
        // day outside `gte`. Do not "simplify" this to `template.teacher.…`.
        const today = startOfLocalDay(new Date(), claimed.teacher.defaultTimezone);
        const scheduled = await tx.studioClass.count({
          where: scheduledWhere(templateId, { gte: today }),
        });

        // The state the POST's own transaction exists to prevent — a template
        // flagged live that produces no classes — is reachable here *without
        // failing*: every candidate date already holds a cancelled row, so
        // generation creates nothing and there is no throw for `withErrorHandler`
        // to classify. The teacher is told (`resumeStudioMessage`'s
        // `scheduled === 0` branch); this line carries the measured breakdown to
        // the operator side — the counting that used to stop at "every candidate
        // date is blocked" without saying which mechanism blocked them. Rare
        // enough not to be noise: only fires on a resume that leaves the window
        // empty.
        if (scheduled === 0) {
          log.warn(
            { templateId, teacherId, added, blockedByCancelled, slotTaken },
            'studio template resumed live with an empty window',
          );
        }

        const { teacher: _claimTeacher, ...bareClaimed } = claimed;
        void _claimTeacher;
        return {
          outcome: 'active',
          template: bareClaimed,
          scheduled,
          added,
          blockedByCancelled,
          slotTaken,
        };
      },
      // Three 10s budgets: the claim's own transaction, this transaction, and
      // this wait at the head of one of the sweep's. They used to compose as a
      // chain — each 10s "waits at most as long as the next link runs" — but
      // they do not: `claimStudioTemplateForGeneration` selects `WHERE
      // "isActive" = true`, and the resume below only runs on a paused template
      // (its CAS constrains `isActive: false`), so a resume can never sit
      // between two claims as the middle link — it can only be the HEAD that
      // waits out a sweep's claim. Matching the sweep's 10s transaction timeout
      // still matters, because Prisma's 5s default can be exceeded by a loaded
      // VPS and turn an ordinary resume click into an opaque P2028.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first, and this is the one lifecycle function that had no
    // catch at all — a P2028 from a contended wait used to escape as a 500.
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId },
        'studio class pause/resume lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
    throw err;
  }

  // A `switch` rather than the four-`if` chain this replaces, because that
  // chain's exhaustiveness was accidental. It ended in a bare fall-through to
  // the `paused` work below, so a new `ResumeTransactionOutcome` arm carrying
  // a `template` compiled clean, fell past every `if`, and was answered
  // `action: 'paused'` — with a `lastScheduled` query it never asked for.
  // Only an arm *without* a `template` was caught, and three of the five arms
  // carry one. The `default` below is the same `never` idiom
  // `api/studio-class-templates/[id]/route.ts` uses twice for its public
  // unions; `paused` breaks out to the post-transaction work it needs, which
  // is the one thing that cannot be expressed as a `return` here.
  switch (result.outcome) {
    case 'not_found':
      return { ok: false, reason: 'not_found' };
    case 'archived':
      return { ok: false, reason: 'archived' };
    case 'unchanged':
      return { ok: true, action: 'unchanged', template: result.template };
    case 'active':
      return {
        ok: true,
        action: 'active',
        template: result.template,
        scheduled: result.scheduled,
        added: result.added,
        blockedByCancelled: result.blockedByCancelled,
        slotTaken: result.slotTaken,
      };
    case 'paused':
      break;
    default: {
      const unhandled: never = result;
      throw new Error(
        `pauseOrResumeStudioTemplate: unhandled transaction outcome ${JSON.stringify(unhandled)}`,
      );
    }
  }

  // `gte` today, not `gt`: pause deletes nothing, so there is no
  // spare-today carve-out to mirror here — today's class is still on the
  // schedule and must be reported as such.
  const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
  const lastScheduled = await db.studioClass.findFirst({
    where: scheduledWhere(templateId, { gte: today }),
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    select: { date: true, startTime: true },
  });
  return { ok: true, action: 'paused', template: result.template, lastScheduled };
}

/**
 * Archive or un-archive. Archiving withdraws the future studio classes nobody
 * booked and leaves the rest standing (#86), mirroring
 * `archiveOrUnarchiveTemplate`'s reasoning for the class family: generated
 * instances stay publicly listed on the teacher's schedule until removed, so
 * without this an archived template keeps up to four weeks of studio classes
 * looking live.
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-listed state this exists to prevent.
 *
 * That transaction opens with a compare-and-swap rather than a plain update,
 * so the transition can only be applied once even when two requests race —
 * see `archiveOrUnarchiveTemplate` for the full reasoning, which holds here
 * unchanged.
 */
export async function archiveOrUnarchiveStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveStudioTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

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
  if (template.isArchived === archiving) {
    const { teacher: _t, ...bare } = template;
    void _t;
    return { ok: true, action: 'unchanged', template: bare };
  }

  const timeZone = template.teacher.defaultTimezone;

  // Un-archiving (`archiving === false`) flips `isArchived` from `true` to
  // `false` in the CAS below, which is the one write in this function that
  // can newly enter `StudioClassTemplate_teacher_slot_unique`'s partial scope
  // (`WHERE isArchived = false`, #196) — archiving only ever leaves it, which
  // cannot collide. Wrapped around the whole `$transaction`, not just the
  // CAS statement, because a P2002 raised inside a Postgres transaction
  // aborts it and the driver surfaces that failure from `$transaction`
  // itself, not from the individual `await` that triggered it.
  try {
    return await db.$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction, the CAS below first
        // among them — the sweep's claim holds this row `FOR UPDATE`, and
        // without this the wait is bounded only by the 10s budget.
        await setLockTimeout(tx);

        // Compare-and-swap, mirroring `archiveOrUnarchiveTemplate` — see there
        // for what a plain `update` cost: the loser of a race overwrote the
        // winner's `archivedAt`/`withdrawnCount` with a `0` its own
        // `deleteMany` produced only because the winner had already deleted
        // those classes. Constraining the write to `isArchived: !archiving`
        // makes the transition itself the thing that can happen only once.
        //
        // Still the transaction's first statement, deliberately: this is what
        // locks the row `claimStudioTemplateForGeneration`
        // (studio-class-generator.ts) locks with its `FOR UPDATE`. Not the same
        // lock mode — an `updateMany` touching no key column takes `FOR NO KEY
        // UPDATE` — but the two *conflict*, and the timeout below exists for
        // the wait that conflict can impose.
        //
        // No P2025 guard here, unlike `updateClassTemplate` and
        // `pauseOrResumeTemplate` in the class family (#100). Not an omission:
        // `updateMany` returns `{ count: 0 }` rather than throwing when nothing
        // matches, and the zero-count branch below already answers `not_found`
        // by re-reading. The `findUniqueOrThrow`/`update` sites further down
        // *can* raise P2025, but only run after this CAS matched, which holds
        // `FOR NO KEY UPDATE` on this row until commit — `pauseOrResumeStudioTemplate`'s
        // own docstring above already names this CAS's mode in passing ("a
        // concurrent archive's own CAS"). That conflicts with the `FOR
        // UPDATE`-strength lock a concurrent `DELETE` needs, so it blocks
        // rather than wins. What a plain single-record `update` would change is
        // not the lock — it takes the same mode — but the first limb: it raises
        // P2025 where `updateMany` returns `{ count: 0 }`, so the write itself
        // becomes a P2025 source needing its own guard.
        const swapped = await tx.studioClassTemplate.updateMany({
          where: { id: templateId, isArchived: !archiving },
          data: {
            isArchived: archiving,
            isActive: false,
            // Folded in rather than issued as a second `update`: `null` depends
            // on nothing this transaction has yet to do, unlike the archiving
            // arm's `withdrawnCount` below.
            ...(archiving ? {} : { archivedAt: null, withdrawnCount: null }),
          },
        });

        if (swapped.count === 0) {
          // Another request already applied the transition, or the row is gone.
          // Read which rather than assuming. Re-read rather than reusing the
          // snapshot from the top of this function — that one still carries the
          // value the winner just falsified. See the class family's twin for why
          // the flag on the returned row can still be stale under three
          // concurrent requests, and why locking here would not be worth it.
          const current = await tx.studioClassTemplate.findUnique({ where: { id: templateId } });
          if (!current) return { ok: false as const, reason: 'not_found' as const };
          return { ok: true as const, action: 'unchanged' as const, template: current };
        }

        if (!archiving) {
          // `updateMany` returns a count, not a row, and every arm of the
          // contract carries a template. Safe to read back here specifically
          // because the CAS above holds this row's lock until we commit — the
          // same lock-then-read pattern the generator's claim uses.
          //
          // A template that is no longer archived has no withdrawal to report.
          // Not a *live* one — the CAS above forced `isActive: false` in the
          // same write, so what is standing here is paused. Leaving a stale
          // count on it would be worse than having none (#97).
          const cleared = await tx.studioClassTemplate.findUniqueOrThrow({
            where: { id: templateId },
          });
          return { ok: true as const, action: 'unarchived' as const, template: cleared };
        }

        // One clock reading serves both the calendar boundary and the
        // timestamp recorded below. `StudioClass.date` is `@db.Date`, so both
        // sides of every comparison below are calendar dates. See
        // `archiveOrUnarchiveTemplate` for what comparing the column to a raw
        // instant costs in each direction.
        const now = new Date();
        const today = startOfLocalDay(now, timeZone);

        // Deliberately one statement, not a `findMany` followed by a
        // `deleteMany({ id: { in: ids } })`: a two-step read-then-delete lets a
        // class get cancelled in the gap between them under READ COMMITTED, and
        // the delete — keyed only on the ids already read — would not re-check
        // it, destroying a class that became an income record after the read.
        // Passing the predicate straight to `deleteMany` makes Postgres
        // re-evaluate it at execution time, and its returned `count` is the
        // number of rows that actually matched then — not a stale count from an
        // earlier read. Do not "optimise" this back into a read-then-delete.
        const { count: deleted } = await tx.studioClass.deleteMany({
          where: scheduledWhere(templateId, { gt: today }),
        });

        // `gte`, where the delete used `gt`: the delete spares a class dated
        // today, and counting with its boundary would undercount that same
        // survivor. No charged-status filter is needed here, unlike the class
        // sibling — `StudioClass` has no registrations to consult, so every
        // uncancelled row in scope counts.
        const remaining = await tx.studioClass.count({
          where: scheduledWhere(templateId, { gte: today }),
        });

        // Written from the delete's own `count`, inside the same transaction
        // (#97). A second statement rather than folded into the CAS above, on
        // data dependency alone: `deleted` does not exist until the `deleteMany`
        // has run, and the CAS runs before it — see `archiveOrUnarchiveTemplate`
        // for the separate lock-ordering point that keeps the CAS first. A plain
        // single-record `update` is enough: the CAS's lock is still held, so
        // nothing can have moved this row since.
        const recorded = await tx.studioClassTemplate.update({
          where: { id: templateId },
          data: { archivedAt: now, withdrawnCount: deleted },
        });

        return { ok: true as const, action: 'archived' as const, template: recorded, deleted, remaining };
      },
      // The compare-and-swap above locks the same row
      // `claimStudioTemplateForGeneration` (studio-class-generator.ts) holds
      // `FOR UPDATE` for the duration of its own per-template transaction, and
      // the CAS's own `FOR NO KEY UPDATE` conflicts with that — the conflict is
      // what gives this the claim-and-lock treatment, not the
      // timeout below; this archive can block on a sweep in progress today, or
      // now on a pause or resume: `pauseOrResumeStudioTemplate`'s own CAS holds
      // this same row from its `updateMany` through generation to commit, on
      // the same 10s budget, so a user-facing PATCH can make an archive wait
      // exactly as a background sweep can (#94).
      //
      // The wait itself is now bounded by this transaction's own
      // `setLockTimeout` (2s), so the 10s figure no longer governs the wait —
      // it governs this transaction's own work once the lock is won: the
      // delete, the notifications, the record write, which a loaded VPS can
      // push past Prisma's 5s default and turn into an opaque P2028. Three 10s
      // budgets used not to compose: a sweep holding the row, a pause queued
      // behind it and this archive queued behind that pause meant the last
      // link's own clock ran while it waited its turn, and it was the one most
      // likely to exhaust its budget without ever reaching its own work. The
      // bound is what took that apart — every link now waits at most 2s and
      // answers `busy`.
      //
      // A *resume* cannot be that middle link: the claim selects
      // `WHERE "isActive" = true` while a resume only ever runs on a paused
      // template (its CAS constrains `isActive: false`), so no claim is ever
      // waiting on a row a resume holds — a resume can only ever be the HEAD
      // of a wait chain, never a middle link. The sweep at the head holds
      // rather than waits, so it is a chain of three participants but only two
      // waiters.
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first, ahead of the slot-conflict branch — see the class
    // family's twin (`archiveOrUnarchiveTemplate`) for why that ordering is
    // load-bearing rather than stylistic, and for why the log line lives here
    // rather than being left to the API wrapper.
    if (isTransientDbError(err)) {
      log.warn({ err, templateId, teacherId }, 'studio class archive lost the template lock race');
      return { ok: false, reason: 'busy' };
    }
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return { ok: false, reason: 'slot_conflict' };
    }
    throw err;
  }
}
