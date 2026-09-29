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
import {
  createContentionStreaks,
  recordSweepContention,
  type ContendedTemplate,
  type ContentionStreaks,
} from './generation-contention';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { log } from '@/lib/log';
import { readInPages } from '@/lib/read-in-pages';

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
 * One page of `generateStudioClassInstances`'s candidate set: live studio
 * templates, after `afterId` in id order. Paged because the `scheduleRule`
 * relation load grows with the parent set — see
 * `docs/technical-architecture.md` ("Relation loads over platform-wide
 * sets").
 *
 * isArchived is defence in depth, matching class-generator.ts: the PATCH
 * route keeps archived templates inactive, but if that invariant ever slips
 * the generator must not materialise classes for something the teacher
 * shelved.
 *
 * Narrowed to `id` and `scheduleRule.teacherId`: `id` is what the sweep's
 * loop re-claims the row by and names it by in logs, and `teacherId` is for
 * logs only. Everything else about the template is re-read fresh under
 * `claimStudioTemplateForGeneration`, inside its own transaction.
 */
function readStudioTemplateCandidatePage(
  db: PrismaClient,
  afterId: string | undefined,
  take: number,
) {
  return db.studioClassTemplate.findMany({
    where: {
      scheduleRule: { isActive: true, isArchived: false },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    select: { id: true, scheduleRule: { select: { teacherId: true } } },
  });
}

type StudioGenerationCandidate = Awaited<ReturnType<typeof readStudioTemplateCandidatePage>>[number];

/**
 * Reads every live studio template `generateStudioClassInstances` will
 * generate for, `SWEEP_PAGE_SIZE` at a time via `readInPages`
 * (`@/lib/read-in-pages`). Extracted so a ceiling test can exercise the read
 * directly without generating classes for a platform-wide template set.
 */
export function readStudioGenerationCandidates(
  db: PrismaClient,
): Promise<StudioGenerationCandidate[]> {
  return readInPages<StudioGenerationCandidate>((after, take) =>
    readStudioTemplateCandidatePage(db, after?.id, take),
  );
}

export interface StudioGenerationSweepOptions {
  /** Required, never defaulted — see `generateStudioClassInstances`' docblock. */
  streaks: ContentionStreaks;
  from?: Date;
}

/**
 * Cron entry point: tops up the rolling window for every active, unarchived
 * studio template, platform-wide — no `teacherId` scoping, unlike
 * `generateClassInstances`. That absence is what puts this function out of
 * reach of a single PATCH: see `pauseOrResumeStudioTemplate`
 * (`studio-class-template-lifecycle.ts`), which reaches for
 * `generateStudioInstancesForTemplate` instead, and says so.
 *
 * Each template is isolated: one template whose generation throws is logged
 * and skipped. If the throw is a Postgres lock timeout (55P03), a concurrent
 * writer (such as a teacher resume or edit) holds the row. One such skip is
 * logged at warn and does not fail the sweep (#122). A template skipped that
 * way on `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive sweeps of the same
 * `opts.streaks` fails it with `GenerationContendedError` (#354), because a row
 * that stays locked looks identical to a routine skip inside any one sweep —
 * see `recordSweepContention` (`generation-contention.ts`). Genuine failures
 * are logged at error, collected, and the first is rethrown at the end for
 * job-health visibility — ahead of a contention error from the same sweep,
 * since it is the more specific signal.
 *
 * So, unless the candidate read itself failed, a throw to either caller
 * (`api/cron/generate-classes/route.ts` and `lib/scheduler.ts`'s
 * `isolatedSweeps`) means the sweep ran to completion and either at least one
 * template failed along the way or at least one stayed contended across the
 * tracker's consecutive sweeps. It does not mean some templates never got a
 * turn.
 *
 * `opts` is required and must never get a default: `SchedulerSweeps` types
 * each sweep as `(db) => Promise<unknown>`, and a required second parameter is
 * what makes this function unassignable to that slot, so the scheduler can
 * only be wired to `runStudioClassGenerationTick`, whose tracker persists
 * across sweeps. A default would let a tracker-less sweep fit the slot and
 * never escalate.
 */
export async function generateStudioClassInstances(
  db: PrismaClient,
  opts: StudioGenerationSweepOptions,
): Promise<number> {
  const startDate = opts.from ?? new Date();

  const templates = await readStudioGenerationCandidates(db);

  let totalCreated = 0;
  const errors: unknown[] = [];
  const skipped: ContendedTemplate[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created (#95). The snapshot read above
      // (`readStudioGenerationCandidates`) is only a pre-filter — this
      // template's row may be minutes stale by now.
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
      // logged at warn and skipped, and counts toward the template's
      // contention streak rather than failing this sweep on its own.
      if (isLockTimeout(err)) {
        log.warn(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation skipped template due to lock contention',
        );
        skipped.push({ templateId: template.id, teacherId: template.scheduleRule.teacherId });
      } else {
        log.error(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'studio class generation failed for template',
        );
        errors.push(err);
      }
    }
  }

  const contended = recordSweepContention(opts.streaks, skipped, STUDIO_GENERATOR.logNoun);
  if (errors.length > 0) throw errors[0];
  if (contended) throw contended;
  return totalCreated;
}

/**
 * The scheduler's entry point: the one caller that persists across sweeps, so
 * the one whose tracker can see a template stay contended. Module-level
 * because `scheduler.ts` imports services dynamically and has nowhere else to
 * keep it.
 */
const productionStreaks = createContentionStreaks();

export function runStudioClassGenerationTick(db: PrismaClient): Promise<number> {
  return generateStudioClassInstances(db, { streaks: productionStreaks });
}


