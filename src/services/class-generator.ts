/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import { Prisma } from '@prisma/client';
import type { ClassTemplate, PrismaClient } from '@prisma/client';
import type { GenerationResult } from '@/lib/generation';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';
import { log } from '@/lib/log';

import { generateEntriesForRule, type GeneratorFamily } from './entry-generation';

// ---------------------------------------------------------------------------
// generateClassInstances
// ---------------------------------------------------------------------------

type TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{
  include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
}>;

/**
 * The class family's half of the shared generator (`generateEntriesForRule`,
 * `entry-generation.ts`).
 *
 * A dispatch table, not a runtime discriminator — `GeneratorFamily`'s own
 * docblock carries the stop condition and the reason no field is optional.
 * `readChildOrThrow` has no caller yet: it is the `findUniqueOrThrow`
 * `claimTemplateForGeneration` below already runs, lifted here so the
 * descriptor is written once rather than grown a field at a time.
 */
export const CLASS_GENERATOR: GeneratorFamily<ClassTemplate, 'regular'> = {
  kind: 'regular',
  logNoun: 'recurring class',
  childTable: 'ClassTemplate',
  readChildOrThrow: (tx, templateId) =>
    tx.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  createChildren: async (db, template, entries) => {
    await db.class.createMany({
      data: entries.map((entry) => ({
        calendarEntryId: entry.id,
        kind: 'regular' as const,
        teacherRoomId: template.teacherRoomId,
        description: template.description,
        roomCost: template.roomCost,
        minRate: template.minRate,
        targetRate: template.targetRate,
        minStudents: template.minStudents,
        maxStudents: template.maxStudents,
        cancelDeadline: template.cancelDeadline,
        autoCancelCheck: template.autoCancelCheck,
        status: 'open' as const,
      })),
    });
  },
};

/**
 * Generates the rolling 4-week window for ONE class template — see
 * `generateEntriesForRule` (`entry-generation.ts`), which carries every
 * argument for the shape, the week key and the absent `catch`.
 *
 * Kept as its own exported name and its own parameter type because both are
 * named from outside this file: `TemplateWithTimezone` is what
 * `claimTemplateForGeneration` below hands back, and several call sites and
 * comments name this function.
 */
export const generateInstancesForTemplate = (
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> => generateEntriesForRule(db, CLASS_GENERATOR, template, from);

/**
 * Claims a template for generation, or reports it is no longer eligible.
 *
 * `FOR UPDATE OF ct` is the point, not the `SELECT`. It locks the same
 * `ClassTemplate` row `updateClassTemplate` and both shared verbs
 * (`archiveOrUnarchiveRule` and `pauseOrResumeRule`, `rule-lifecycle.ts`)
 * each take as their own first statement (issue 298 / #315,
 * `docs/lock-order.md`, "The child row is the lock node for the template
 * families") — every one of them a plain `SELECT … FOR UPDATE`, the same
 * exclusive mode this statement takes, so the sweep and any of the three
 * serialise on that row rather than interleaving:
 *
 *   - claim first  → the other statement's own `FOR UPDATE` waits; we
 *                    generate and commit; the archive's own `deleteMany` (if
 *                    it was an archive waiting) then withdraws what we made —
 *                    all but a class dated today. Its boundary is `gt: today`
 *                    (`scheduledWhere` in `class-template-lifecycle.ts`), the
 *                    same deliberate spare-today carve-out applied everywhere
 *                    else: a class hours from starting should not disappear
 *                    out from under students who already see it as open.
 *                    `remaining` counts with `gte`, so the teacher is told
 *                    honestly that one class survived rather than being
 *                    handed a total that quietly excludes it. One publicly
 *                    bookable class under a just-archived template is this
 *                    interleaving's correct outcome, not a gap this lock
 *                    failed to close. The studio side reaches this same
 *                    outcome at the same rate, not more often (#94):
 *                    `generateStudioInstancesForTemplate`
 *                    (`studio-class-generator.ts`) now applies the same
 *                    `classStartInstant` "start is still ahead" filter this
 *                    file's `generateInstancesForTemplate` does, so neither
 *                    family generates an already-started today's instance.
 *   - archive first → we wait on the child row, then re-verify eligibility
 *                    against a FRESH read once we hold it (see below) and
 *                    skip.
 *
 * A plain re-read would not do this. Under READ COMMITTED each statement takes
 * a fresh snapshot, so an archive committing between the re-read and the
 * `create` is invisible to the re-read and still lost. Do not "simplify" the
 * locking `SELECT` above into a plain `findUnique`.
 *
 * The `sr."isActive"`/`sr."isArchived"` predicate in that `SELECT` is a fast
 * path, not the guarantee, and the distinction is load-bearing rather than
 * pedantic. `FOR UPDATE OF ct` locks only `ct` — deliberately, per the
 * decision linked above, which rejected locking `sr` too — so when this
 * statement itself has to WAIT for that lock, Postgres's WHERE clause was
 * already evaluated against the snapshot taken when the statement STARTED,
 * before the wait. On unblock, `EvalPlanQual` re-verifies the columns of the
 * row actually being locked (`ct`) if THAT row changed; it does not re-fetch
 * `sr` on `ct`'s account, because `sr` was never part of the lock set. So a
 * `ct` row that was eligible when this statement started, and still IS `ct`
 * itself unchanged, can come back as a "match" via `rows.length === 1` even
 * though the archive that made it wait committed `sr."isArchived" = true`
 * while this statement was parked. Measured directly, isolated from Prisma:
 * two throwaway tables shaped like `ClassTemplate`/`ScheduleRule`, one session
 * holding the child row `FOR UPDATE` and updating (but never committing) the
 * parent's flag, a second session's joined `FOR UPDATE OF` blocking on the
 * first and then unblocking on commit — the second session's join predicate
 * still read the PRE-commit flag, in six of six runs, and stayed stale even
 * when the first session also issued a real `UPDATE` on the child row itself
 * (to force `EvalPlanQual`) rather than only locking it. `rows.length === 1`
 * is therefore necessary but not sufficient for eligibility whenever this
 * statement actually waited — which is exactly the interleaving above one
 * finds itself needing "archive first" to work.
 *
 * `findUniqueOrThrow` below is what closes it, because it is a SEPARATE
 * statement issued only after this one returns — i.e., only after the lock is
 * actually held, wait or no wait — and a separate statement takes its own
 * fresh READ COMMITTED snapshot regardless of what the statement before it
 * waited on. Its own `scheduleRule.isActive`/`isArchived` are re-checked
 * against THAT snapshot before this function trusts the row, which is what
 * "archive first → skip" above actually depends on, not the raw statement's
 * own `WHERE`.
 *
 * Must be called with a transaction client, never a bare `PrismaClient` —
 * `Prisma.TransactionClient` is structurally just `Omit<PrismaClient,
 * ITXClientDenyList>`, so `claimTemplateForGeneration(prisma, id)` type-checks
 * without complaint. It would make `SET LOCAL` a no-op (there is no
 * transaction for "local" to scope to) and release the row lock the instant
 * the `SELECT` completes. That used to mean the claim returned `true` while
 * holding nothing; it is not gone, and it now has a second consequence: the
 * `findUniqueOrThrow` below then runs unlocked too, and can throw P2025 if
 * the row is deleted out from under it before that second statement runs.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking `Class`
 * inserts — it looks like a free optimisation but isn't. `FOR UPDATE` is what
 * makes a concurrent insert for this template impossible, because an insert's
 * FK check takes `FOR KEY SHARE` on this row, which `FOR UPDATE` conflicts with
 * and `FOR NO KEY UPDATE` does not. Measured on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateInstancesForTemplate` no longer has a P2002 branch to be broken.
 * Its `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort
 * nothing, with or without this lock. The lock still earns its place by
 * keeping the values this claim returns authoritative (#102).
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and a first-pass eligibility filter;
 * the Prisma read below is what makes both the VALUES and the eligibility
 * VERDICT authoritative, for the reason above — and it is safe precisely
 * because the lock is still held when it runs. Two statements rather than one
 * `SELECT *` because `roomCost`, `minRate` and `targetRate` are
 * `DECIMAL(10,2)` and a raw row does not hand back Prisma's `Decimal`.
 */
export async function claimTemplateForGeneration(
  tx: TransactionClientOnly,
  templateId: string,
): Promise<TemplateWithTimezone | null> {
  // `LOCK_TIMEOUT_SQL` (`@/lib/db-locks`) — shared with `lockClassRow`, which
  // takes the `Class` row lock this one deadlocks against, so the two waits
  // are the same length by construction rather than by coincidence. Its
  // docblock carries the reason `$executeRawUnsafe` is safe for it.
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT ct."id" FROM "ClassTemplate" ct
      JOIN "ScheduleRule" sr ON sr."id" = ct."scheduleRuleId"
    WHERE ct."id" = ${templateId}
      AND sr."isActive" = true
      AND sr."isArchived" = false
    FOR UPDATE OF ct`;
  // Silent on purpose: this row's own `WHERE` did not match, which for the
  // sweep's caller is the ordinary "not selected" case — the pre-filter
  // `findMany` runs unlocked and is routinely minutes stale by the time this
  // statement executes. Logging every one of those would be noise, not
  // signal. The re-check below is the branch this comment's sibling exists
  // to distinguish from this one.
  if (rows.length !== 1) return null;

  // Under the lock taken above, so nothing can change `ct` itself before we
  // commit. `OrThrow` because the child row provably exists — the FOR UPDATE
  // just matched it, and nothing in `src/` deletes a `ClassTemplate` — so an
  // impossible `| null` would force every caller to pretend to handle it.
  const fresh = await tx.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });

  // The authoritative eligibility check — see this function's docblock for
  // why the raw statement's own `WHERE` cannot be trusted alone when it had
  // to wait. This read is a fresh statement taken under the lock, so it sees
  // whatever the row that made us wait actually committed.
  if (!fresh.scheduleRule.isActive || fresh.scheduleRule.isArchived) {
    // The signal the sweep's own `if (!fresh) return 0` cannot give: THIS
    // null is the measured `EvalPlanQual` race actually landing — the raw
    // statement above matched and waited, and what it waited on committed a
    // change the wait made it miss. `pauseOrResumeRule` (`rule-lifecycle.ts`)
    // reaches this function through `CLASS_FAMILY.claim` and treats a null as
    // impossible, throwing right after; logging here first costs it nothing
    // and gives the sweep's silent `return 0` the trace it does not otherwise
    // get.
    log.warn({ templateId }, 'class generation claim matched but found the row ineligible on re-check');
    return null;
  }

  return fresh;
}

/**
 * Cron / teacher-wide entry point: tops up the rolling window for all
 * active templates (or one teacher's). Each template is isolated — one
 * template whose generation throws is logged and skipped. If the throw is
 * a Postgres lock timeout (55P03), it means a concurrent writer (such as a
 * teacher resume or edit) holds the row; this is logged at warn and skipped
 * without failing the sweep (#122). Genuine failures are logged at error,
 * collected, and the first error is rethrown at the end for job-health
 * visibility.
 */
export async function generateClassInstances(
  db: PrismaClient,
  from?: Date,
  teacherId?: string,
): Promise<number> {
  const startDate = from ?? new Date();

  // `isArchived` is defense in depth, for ONE reason rather than two: the
  // routes keep archived templates inactive, but if that pairing ever slips,
  // the generator must not materialize classes for something the teacher
  // shelved. That half comes from the shared constant so
  // `services/room-archive.ts` cannot block on a different set than this query
  // selects.
  //
  // The selection reads only the template's OWN flags — `scheduleRule`'s
  // `isActive`/`isArchived` — and never `teacherRoom.isArchived`. That used to
  // be a known gap, measured on #116's branch (four classes generated into a
  // just-archived room), and is closed structurally: `ClassTemplate` mirrors
  // the rule's liveness and the room's archive onto its own row, kept equal by
  // foreign keys, and `ClassTemplate_live_needs_open_room` refuses every write
  // that would leave a live template on an archived room (issue 272). No row
  // this query selects can therefore point into an archived room.
  //
  // That guarantee holds while `ScheduleRule.live` and `ACTIVE_TEMPLATE_WHERE`
  // stay the same predicate, which is asserted at all four corners in
  // `template-room-constraint.test.ts` rather than left to this sentence — a
  // claim about another module cannot be owned here. The ROOM half needs no
  // filter in this query at all: a writer that sets the rule's flag directly
  // does not reach around the constraint either, because the cascade
  // recomputes `ruleLive` and the CHECK refuses the write.
  // See `lib/template-selection.ts`.
  const templates = await db.classTemplate.findMany({
    where: {
      scheduleRule: { ...ACTIVE_TEMPLATE_WHERE.scheduleRule, ...(teacherId ? { teacherId } : {}) },
    },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });

  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created, or the archive it is protecting
      // against can commit in between. The `findMany` above is only a
      // pre-filter — by the time the loop reaches this template its row may
      // be minutes stale: #95 closed that for `isActive`/`isArchived`, #102
      // for every other value the generator reads.
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;
          // `fresh`, not `template`: the loop variable is the pre-filter's
          // stale snapshot.
          const result = await generateInstancesForTemplate(tx, fresh, startDate);
          return result.created;
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      // Per-template isolation. A lock timeout (55P03) against a concurrent
      // writer means someone else has the template right now, not that
      // generation failed (#122) — so it is logged at warn and skipped without
      // failing the job health check.
      if (isLockTimeout(err)) {
        log.warn(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'class generation skipped template due to lock contention',
        );
      } else {
        log.error(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'class generation failed for template',
        );
        errors.push(err);
      }
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}



