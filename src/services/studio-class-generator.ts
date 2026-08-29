/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import type { GenerationResult } from '@/lib/generation';
import {
  claimRuleForGeneration,
  generateEntriesForRule,
  type GeneratorFamily,
} from './entry-generation';
import type { TransactionClientOnly } from '@/lib/db-locks';
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
 * The studio family's half of the shared claim and generator
 * (`claimRuleForGeneration` and `generateEntriesForRule`,
 * `entry-generation.ts`), and — spread into `STUDIO_FAMILY`
 * (`studio-class-template-lifecycle.ts`) — of the shared lifecycle verbs above
 * it.
 *
 * A dispatch table, not a runtime discriminator — `GeneratorFamily`'s own
 * docblock carries the stop condition and the reason no field is optional.
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
 * `claimStudioTemplateForGeneration` below hands back, and
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
 * Claims a studio template for generation, or reports it is no longer eligible
 * — `claimRuleForGeneration` (`entry-generation.ts`) parameterised with this
 * family's descriptor. That function carries the lock, the re-check under it,
 * and why neither may be weakened — including why `FOR UPDATE` may not be
 * relaxed to `FOR NO KEY UPDATE` to stop blocking this family's inserts.
 *
 * Kept as its own exported name and its own return type because both are
 * named from outside this file: `StudioTemplateWithTimezone` is what
 * `generateStudioInstancesForTemplate` above takes, and several call sites and
 * comments name this function — `db-locks.test.ts` among them, where the
 * branded parameter is pinned to refuse a bare client.
 */
export const claimStudioTemplateForGeneration = (
  tx: TransactionClientOnly,
  templateId: string,
): Promise<StudioTemplateWithTimezone | null> =>
  claimRuleForGeneration(tx, STUDIO_GENERATOR, templateId);

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



