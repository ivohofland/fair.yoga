/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import { Prisma } from '@prisma/client';
import type { ClassTemplate, PrismaClient } from '@prisma/client';
import type { GenerationResult } from '@/lib/generation';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { isLockTimeout } from '@/lib/api-errors';
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';
import { log } from '@/lib/log';

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
import { readInPages } from '@/lib/read-in-pages';

// ---------------------------------------------------------------------------
// generateClassInstances
// ---------------------------------------------------------------------------

type TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{
  include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } };
}>;

/**
 * The class family's half of the shared claim and generator
 * (`claimRuleForGeneration` and `generateEntriesForRule`,
 * `entry-generation.ts`), and — spread into `CLASS_FAMILY`
 * (`class-template-lifecycle.ts`) — of the shared lifecycle verbs above it.
 *
 * A dispatch table, not a runtime discriminator — `GeneratorFamily`'s own
 * docblock carries the stop condition and the reason no field is optional.
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
        // The template's own mirror, not a fresh read. Accurate by the lock
        // this path already holds: `claimTemplateForGeneration` keeps this
        // row `FOR UPDATE` across this insert, and archiving the room
        // cascades into it — so the archive cannot commit in between.
        roomArchived: template.roomArchived,
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
 * Claims a class template for generation, or reports it is no longer eligible
 * — `claimRuleForGeneration` (`entry-generation.ts`) parameterised with this
 * family's descriptor. That function carries the lock, the re-check under it,
 * and why neither may be weakened.
 *
 * Kept as its own exported name and its own return type because both are
 * named from outside this file: `TemplateWithTimezone` is what
 * `generateInstancesForTemplate` above takes, and several call sites and
 * comments name this function — `db-locks.test.ts` among them, where the
 * branded parameter is pinned to refuse a bare client.
 */
export const claimTemplateForGeneration = (
  tx: TransactionClientOnly,
  templateId: string,
): Promise<TemplateWithTimezone | null> =>
  claimRuleForGeneration(tx, CLASS_GENERATOR, templateId);

/**
 * One page of `generateClassInstances`'s candidate set: live class templates
 * (or one teacher's), after `afterId` in id order. Paged because the
 * `scheduleRule` relation load grows with the parent set — see
 * `docs/technical-architecture.md` ("Relation loads over platform-wide
 * sets").
 *
 * `isArchived` is defense in depth, for ONE reason rather than two: the
 * routes keep archived templates inactive, but if that pairing ever slips,
 * the generator must not materialize classes for something the teacher
 * shelved. That half comes from the shared constant so
 * `services/room-archive.ts` cannot block on a different set than this query
 * selects.
 *
 * The selection reads only the template's OWN flags — `scheduleRule`'s
 * `isActive`/`isArchived` — and never `teacherRoom.isArchived`; that gap is
 * closed structurally instead: `ClassTemplate` mirrors the rule's liveness
 * and the room's archive onto its own row, kept equal by foreign keys, and
 * `ClassTemplate_live_needs_open_room` refuses every write that would leave a
 * live template on an archived room. No row this query selects can therefore
 * point into an archived room.
 *
 * That guarantee holds while `ScheduleRule.live` and `ACTIVE_TEMPLATE_WHERE`
 * stay the same predicate, which is asserted at all four corners in
 * `template-room-constraint.test.ts` rather than left to this sentence — a
 * claim about another module cannot be owned here. The ROOM half needs no
 * filter in this query at all: a writer that sets the rule's flag directly
 * does not reach around the constraint either, because the cascade
 * recomputes `ruleLive` and the CHECK refuses the write.
 * See `lib/template-selection.ts`.
 *
 * Narrowed to `id` and `scheduleRule.teacherId`: `id` is what the sweep's
 * loop re-claims the row by and names it by in logs, and `teacherId` is for
 * logs only. The loop never uses the teacher-timezone hop, so the selection
 * excludes it. Everything else about the template is re-read fresh under
 * `claimTemplateForGeneration`, inside its own transaction.
 */
function readTemplateCandidatePage(
  db: PrismaClient,
  teacherId: string | undefined,
  afterId: string | undefined,
  take: number,
) {
  return db.classTemplate.findMany({
    where: {
      scheduleRule: { ...ACTIVE_TEMPLATE_WHERE.scheduleRule, ...(teacherId ? { teacherId } : {}) },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    select: { id: true, scheduleRule: { select: { teacherId: true } } },
  });
}

type GenerationCandidate = Awaited<ReturnType<typeof readTemplateCandidatePage>>[number];

/**
 * Reads every live class template `generateClassInstances` will generate for
 * (or one teacher's), `SWEEP_PAGE_SIZE` at a time via `readInPages`
 * (`@/lib/read-in-pages`). Extracted so a ceiling test can exercise the read
 * directly without generating classes for a platform-wide template set.
 */
export function readGenerationCandidates(
  db: PrismaClient,
  teacherId?: string,
): Promise<GenerationCandidate[]> {
  return readInPages<GenerationCandidate>((after, take) =>
    readTemplateCandidatePage(db, teacherId, after?.id, take),
  );
}

export interface ClassGenerationSweepOptions {
  /** Required, never defaulted — see `generateClassInstances`' docblock. */
  streaks: ContentionStreaks;
  from?: Date;
  teacherId?: string;
}

/**
 * Cron / teacher-wide entry point: tops up the rolling window for all
 * active templates (or one teacher's). Each template is isolated — one
 * template whose generation throws is logged and skipped.
 *
 * If the throw is a Postgres lock timeout (55P03), a concurrent writer (such
 * as a teacher resume or edit) holds the row. One such skip is logged at warn
 * and does not fail the sweep (#122). A template skipped that way on
 * `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive sweeps of the same
 * `opts.streaks` fails it with `GenerationContendedError` (#354), because a row
 * that stays locked looks identical to a routine skip inside any one sweep —
 * see `recordSweepContention` (`generation-contention.ts`).
 *
 * Genuine failures are logged at error, collected, and the first is rethrown
 * at the end for job-health visibility — ahead of a contention error from the
 * same sweep, since it is the more specific signal.
 *
 * `opts` is required and must never get a default: `SchedulerSweeps` types
 * each sweep as `(db) => Promise<unknown>`, and a required second parameter is
 * what makes this function unassignable to that slot. That refuses the sweep
 * itself and nothing more: a one-parameter wrapper that mints a fresh tracker
 * per call still fits the slot and never escalates, so the scheduler's wiring
 * is `runClassGenerationTick`, whose tracker persists across sweeps.
 * `ReconcileOptions` (`waitlist-reconciliation.ts`) carries the fuller account.
 */
export async function generateClassInstances(
  db: PrismaClient,
  opts: ClassGenerationSweepOptions,
): Promise<number> {
  const startDate = opts.from ?? new Date();
  const teacherId = opts.teacherId;

  const templates = await readGenerationCandidates(db, teacherId);

  let totalCreated = 0;
  const errors: unknown[] = [];
  const skipped: ContendedTemplate[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created, or the archive it is protecting
      // against can commit in between. The snapshot read above
      // (`readGenerationCandidates`) is only a pre-filter — by the time the
      // loop reaches this template its row may be minutes stale: #95 closed
      // that for `isActive`/`isArchived`, #102 for every other value the
      // generator reads.
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
      // generation failed (#122) — so it is logged at warn and skipped, and
      // counts toward the template's contention streak rather than failing
      // this sweep on its own.
      if (isLockTimeout(err)) {
        log.warn(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'recurring class generation skipped template due to lock contention',
        );
        skipped.push({ templateId: template.id, teacherId: template.scheduleRule.teacherId });
      } else {
        log.error(
          { err, templateId: template.id, teacherId: template.scheduleRule.teacherId },
          'recurring class generation failed for template',
        );
        errors.push(err);
      }
    }
  }

  const contended = recordSweepContention(opts.streaks, skipped, CLASS_GENERATOR.logNoun);
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

export function runClassGenerationTick(db: PrismaClient): Promise<number> {
  return generateClassInstances(db, { streaks: productionStreaks });
}


