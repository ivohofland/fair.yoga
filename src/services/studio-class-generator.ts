/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import type { GenerationResult } from '@/lib/generation';
import { generateEntriesForRule, type GeneratorFamily } from './entry-generation';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { log } from '@/lib/log';

/**
 * The studio mirror of `class-generator.ts`'s `TemplateWithTimezone`. The
 * teacher's zone is not decoration: `generateStudioInstancesForTemplate`
 * needs it to decide whether today's class has already started, and
 * `StudioClassTemplate` carries no zone of its own.
 */
type StudioTemplateWithTimezone = Prisma.StudioClassTemplateGetPayload<{
  include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
}>;

/**
 * Claims a studio template for generation, or reports it is no longer
 * eligible. The studio mirror of `claimTemplateForGeneration` in
 * `class-generator.ts` — see that function for why the lock, and not a
 * re-read, is what closes the race (#95).
 *
 * Deliberately a second copy rather than one helper generic over a Prisma
 * delegate: the two families are kept parallel-but-separate throughout, and a
 * generic version would have to interpolate the table name into raw SQL.
 *
 * Must be called with a transaction client, never a bare `PrismaClient` — see
 * `claimTemplateForGeneration` for what that would silently break: `SET
 * LOCAL` becomes a no-op with nothing to scope to, and the row lock releases
 * the instant the `SELECT` completes. That used to mean the claim returned
 * `true` while holding nothing; it is not gone, and it now has a second
 * consequence: the `findUniqueOrThrow` below then runs unlocked too, and can
 * throw P2025 if the row is deleted out from under it before that second
 * statement runs.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking
 * `StudioClass` inserts — it looks like a free optimisation but isn't.
 * `FOR UPDATE` is what makes a concurrent insert for this template
 * impossible, because an insert's FK check takes `FOR KEY SHARE` on this row,
 * which `FOR UPDATE` conflicts with and `FOR NO KEY UPDATE` does not. Measured
 * on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateStudioInstancesForTemplate` no longer has a P2002 branch to be
 * broken — the per-template generator below, not the sweep, which never had
 * one because it issues no insert of its own.
 * Its `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort
 * nothing, with or without this lock. The lock still earns its place by
 * keeping the values this claim returns authoritative (#102).
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and a first-pass eligibility filter;
 * the Prisma read below is what makes both the VALUES and the eligibility
 * VERDICT authoritative — `claimTemplateForGeneration`'s docblock carries the
 * measurement for why the raw statement's own `WHERE` cannot be trusted alone
 * once it had to wait on the child lock — and it is safe precisely because
 * the lock is still held when it runs. Two statements rather than one
 * `SELECT *` because `hourlyRate` is `DECIMAL(10,2)` and a raw row does not
 * hand back Prisma's `Decimal`.
 */
export async function claimStudioTemplateForGeneration(
  tx: TransactionClientOnly,
  templateId: string,
): Promise<StudioTemplateWithTimezone | null> {
  // `LOCK_TIMEOUT_SQL` (`@/lib/db-locks`) — shared with `lockClassRow`, which
  // takes the `Class` row lock this one deadlocks against, so the two waits
  // are the same length by construction rather than by coincidence. Its
  // docblock carries the reason `$executeRawUnsafe` is safe for it.
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT sct."id" FROM "StudioClassTemplate" sct
      JOIN "ScheduleRule" sr ON sr."id" = sct."scheduleRuleId"
    WHERE sct."id" = ${templateId}
      AND sr."isActive" = true
      AND sr."isArchived" = false
    FOR UPDATE OF sct`;
  // Silent on purpose: this row's own `WHERE` did not match, which for the
  // sweep's caller is the ordinary "not selected" case — see
  // `claimTemplateForGeneration`'s twin (`class-generator.ts`) for why that
  // is routine and not worth logging, and for the branch below this one that
  // is.
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  const fresh = await tx.studioClassTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });

  // The authoritative eligibility check — see `claimTemplateForGeneration`'s
  // docblock (class-generator.ts) for why the raw statement's own `WHERE`
  // cannot be trusted alone when it had to wait. This read is a fresh
  // statement taken under the lock, so it sees whatever the row that made us
  // wait actually committed.
  if (!fresh.scheduleRule.isActive || fresh.scheduleRule.isArchived) {
    // Mirrors `claimTemplateForGeneration`'s own log at this branch
    // (class-generator.ts): this null is the measured `EvalPlanQual` race
    // actually landing, not the ordinary "not selected" case above.
    // `pauseOrResumeRule`'s call site (`rule-lifecycle.ts`, reached for this
    // family by `pauseOrResumeStudioTemplate`) treats reaching this as
    // impossible and throws right after; logging here first costs it
    // nothing and gives the sweep's silent `return 0` the trace it does not
    // otherwise get.
    log.warn({ templateId }, 'studio class generation claim matched but found the row ineligible on re-check');
    return null;
  }

  return fresh;
}

/**
 * The studio family's half of the shared generator (`generateEntriesForRule`,
 * `entry-generation.ts`).
 *
 * A dispatch table, not a runtime discriminator — `GeneratorFamily`'s own
 * docblock carries the stop condition and the reason no field is optional.
 * `readChildOrThrow` has no caller yet: it is the `findUniqueOrThrow`
 * `claimStudioTemplateForGeneration` above already runs, lifted here so the
 * descriptor is written once rather than grown a field at a time.
 */
export const STUDIO_GENERATOR: GeneratorFamily<StudioClassTemplate, 'studio'> = {
  kind: 'studio',
  logNoun: 'studio class',
  childTable: 'StudioClassTemplate',
  readChildOrThrow: (tx, templateId) =>
    tx.studioClassTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  createChildren: async (db, template, entries) => {
    await db.studioClass.createMany({
      data: entries.map((entry) => ({
        calendarEntryId: entry.id,
        kind: 'studio' as const,
        location: template.location,
        hourlyRate: template.hourlyRate,
      })),
    });
  },
};

/**
 * Generates the rolling 4-week window for ONE studio template — see
 * `generateEntriesForRule` (`entry-generation.ts`), which carries every
 * argument for the shape, the week key and the absent `catch`.
 *
 * Kept as its own exported name and its own parameter type because both are
 * named from outside this file: `StudioTemplateWithTimezone` is what
 * `claimStudioTemplateForGeneration` above hands back, and
 * `pauseOrResumeStudioTemplate` reaches for this function by name — which is
 * the whole reason a per-template entry point exists, since before #94 the
 * loop was inlined in the sweep and a resumed template stayed empty until the
 * next cron run.
 */
export const generateStudioInstancesForTemplate = (
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> => generateEntriesForRule(db, STUDIO_GENERATOR, template, from);

/**
 * Cron entry point: tops up the rolling window for every active, unarchived
 * studio template, platform-wide — no `teacherId` scoping, unlike
 * `generateClassInstances`. That absence is what puts this function out of
 * reach of a single PATCH: see `pauseOrResumeStudioTemplate`
 * (`studio-class-template-lifecycle.ts`), which reaches for
 * `generateStudioInstancesForTemplate` instead, and says so.
 * Each template is isolated: one template whose generation throws is logged
 * and skipped. If the throw is a Postgres lock timeout (55P03), it means
 * a concurrent writer (such as a teacher resume or edit) holds the row;
 * this is logged at warn and skipped without failing the sweep (#122).
 * Genuine failures are logged at error, collected, and the first error is
 * rethrown at the end for job-health visibility.
 *
 * This changes what a throw means to both callers
 * (`api/cron/generate-classes/route.ts` and `lib/scheduler.ts`'s
 * `isolatedSweeps`): it used to mean the sweep aborted partway through and
 * some templates never got a turn; it now means the sweep ran to completion
 * and at least one template failed along the way. Both callers already
 * tolerate either shape, but do not assume "threw" still implies "incomplete"
 * when reading this signature.
 */
export async function generateStudioClassInstances(
  db: PrismaClient,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();

  // isArchived is defence in depth, matching class-generator.ts: the PATCH
  // route keeps archived templates inactive, but if that invariant ever slips
  // the generator must not materialise classes for something the teacher
  // shelved. It slipped once — the studio route had neither guard until #53's
  // coverage pass found it.
  const templates = await db.studioClassTemplate.findMany({
    where: { scheduleRule: { isActive: true, isArchived: false } },
    include: { scheduleRule: true },
  });

  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created (#95). The `findMany` above is
      // only a pre-filter — this template's row may be minutes stale by now.
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimStudioTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;

          // `fresh`, not `template`: the loop variable is the pre-filter's
          // snapshot and may be minutes old. #102.
          const result = await generateStudioInstancesForTemplate(tx, fresh, startDate);
          return result.created;
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      // Per-template isolation, matching `generateClassInstances`. A lock
      // timeout (55P03) against a concurrent writer means someone else has
      // the template right now, not that generation failed (#122) — so it is
      // logged at warn and skipped without failing the job health check.
      if (isLockTimeout(err)) {
        log.warn(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation skipped template due to lock contention',
        );
      } else {
        log.error(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation failed for template',
        );
        errors.push(err);
      }
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}



