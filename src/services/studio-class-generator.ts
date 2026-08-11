/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { getNextOccurrences } from './class-generator';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { classStartInstant } from '@/lib/timezone';
import { log } from '@/lib/log';

const DEFAULT_WEEKS = 4;

/**
 * The studio mirror of `class-generator.ts`'s `TemplateWithTimezone`. The
 * teacher's zone is not decoration: `generateStudioInstancesForTemplate`
 * needs it to decide whether today's class has already started, and
 * `StudioClassTemplate` carries no zone of its own.
 */
type StudioTemplateWithTimezone = Prisma.StudioClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
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
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` — see
 * `claimTemplateForGeneration` for why that is not a free optimisation: it is
 * what makes a concurrent insert for this template impossible while the claim
 * holds it, which is what makes the P2002 branch below unreachable, full
 * stop. `generateInstancesForTemplate` (`class-generator.ts`) has three
 * callers in production that never take that claim — its own tests call it
 * directly too — but the hedge is only genuinely load-bearing for one of
 * them:
 *   - `api/class-templates/route.ts` creates a brand-new template row inside
 *     its own transaction — nothing else can reference that id yet, so
 *     nothing can race the insert. Its hedge is dead, not load-bearing.
 *   - `pauseOrResumeTemplate` (`class-template-lifecycle.ts`) is reachable —
 *     its own `update` only flips `isActive`, a non-key column, so Postgres
 *     grants it `FOR NO KEY UPDATE`, which does not conflict with the `FOR
 *     KEY SHARE` a concurrent `Class` insert takes on the same template row
 *     for FK integrity — but the hedge is broken there by the very 25P02
 *     mechanism this docstring warns about above: its `catch` runs inside an
 *     interactive transaction, so a genuine P2002 still leaves Postgres with
 *     an aborted transaction that fails the next query with 25P02 instead of
 *     a clean skip.
 *   - `syncTemplateInstances`'s refill (`template-sync.ts`) calls through a
 *     bare `PrismaClient`, not a transaction client, so each insert
 *     autocommits on its own; a genuine collision there is a clean P2002 with
 *     nothing left to poison. This is the one caller the hedge actually
 *     protects.
 * The P2002 branch in the loop below — not the loop itself, which runs on
 * every claimed generation — is unreachable for any caller that takes this
 * claim first, whatever that caller is: the invariant lives in the lock, not
 * in a roster of who currently holds it. `generateStudioClassInstances`'s
 * sweep and `pauseOrResumeStudioTemplate`'s resume (`studio-class-template-
 * lifecycle.ts`, #94) both do. `api/studio-class-templates/route.ts`'s POST
 * (#120) does not, and does not reopen the branch either: it generates from a
 * row it created inside its own transaction, whose uuid nothing else can
 * reference yet, so there is no concurrent insert to collide with — the same
 * exemption the class family's POST has above. A caller that skips the claim
 * against an *existing* row would reopen it.
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and the eligibility re-check; the
 * Prisma read below is what makes the values authoritative, and it is safe
 * precisely because the lock is still held when it runs. Two statements
 * rather than one `SELECT *` because `hourlyRate` is `DECIMAL(10,2)` and a
 * raw row does not hand back Prisma's `Decimal`.
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
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  return tx.studioClassTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}

/**
 * Generates the rolling 4-week window for ONE studio template, reporting each
 * candidate date it could not fill and why (`GenerationResult`). The studio
 * twin of `generateInstancesForTemplate` (`class-generator.ts`) — same client
 * union, same optional `from`, same result shape — so the two families can be
 * read against each other.
 *
 * Same two mechanisms as the class family:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped,
 *     which is what lets the teacher be told something true and an operator
 *     grep for it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` compiles to a BARE
 *     `ON CONFLICT DO NOTHING` — no conflict target, so it covers every unique
 *     constraint on the table, including the partial index #196 adds. That is
 *     what makes a clash cost only its own date.
 *
 * This function's P2002 hedge used to document the same 25P02 trap the class
 * family's did (#164): a caught `P2002` inside an interactive transaction
 * aborts it, and the next statement fails with `25P02`. It is gone for the
 * same reason — the hedge could not work, only quietly poison. Do not
 * reintroduce a `catch` here.
 *
 * Takes `PrismaClient | Prisma.TransactionClient` so a caller can compose it
 * into a transaction it already owns. That is the whole reason this function
 * exists: before #94 the loop was inlined in the sweep, so
 * `pauseOrResumeStudioTemplate` had nothing to call but the platform-wide
 * sweep, and left a resumed template empty until the next cron run.
 */
export async function generateStudioInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. Ported from
  // the class family in #94 — the studio side had no such filter, so the hourly
  // sweep could materialise a class that had already started.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) > startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // One query for the whole window. Scoped to this teacher: #196's studio index
  // is `(teacherId, date, startTime) WHERE "cancelledAt" IS NULL`.
  const occupants = await db.studioClass.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, cancelledAt: true },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // `@@unique([templateId, date])` ignores cancellation, so a cancelled own
      // row makes the date permanently unfillable rather than already filled.
      // This is the live path #192 was filed about: it runs on every sweep and,
      // before this change, said nothing.
      skipped.push({
        date,
        reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors #196's studio index predicate exactly (`WHERE "cancelledAt" IS NULL`).
    if (onDate.some((c) => c.startTime === template.startTime && c.cancelledAt === null)) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    free.push(date);
  }

  const inserted =
    free.length === 0
      ? []
      : await db.studioClass.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            templateId: template.id,
            classType: template.classType,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            location: template.location,
            hourlyRate: template.hourlyRate,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedStudioSlots(template.id, template.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/** Studio twin of `logSkippedSlots` (`class-generator.ts`) — see it for the noise rule. */
function logSkippedStudioSlots(
  templateId: string,
  teacherId: string,
  skipped: SkippedSlot[],
): void {
  const blocking = skipped.filter((s) => s.reason !== 'already_generated');
  if (blocking.length === 0) return;

  log.warn(
    {
      templateId,
      teacherId,
      skipped: blocking.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        reason: s.reason,
      })),
    },
    'studio class generation could not fill every date in the window',
  );
}

/**
 * Cron entry point: tops up the rolling window for every active, unarchived
 * studio template, platform-wide — no `teacherId` scoping, unlike
 * `generateClassInstances`. That absence is what puts this function out of
 * reach of a single PATCH: see `pauseOrResumeStudioTemplate`
 * (`studio-class-template-lifecycle.ts`), which reaches for
 * `generateStudioInstancesForTemplate` instead, and says so.
 * Each template is isolated: one template whose generation throws — now
 * including a claim's lock timeout, a new way to fail this sweep did not
 * previously have — is logged and skipped, the rest still generate, and the
 * first error is rethrown at the end for job-health visibility.
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
    where: { isActive: true, isArchived: false },
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
      // Per-template isolation, matching `generateClassInstances`. The class
      // family already had this; the studio sweep did not, and the claim's
      // lock timeout above is a new way for one template to throw — without
      // this, one contended template would stop every other teacher's studio
      // classes from generating.
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'studio class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}
