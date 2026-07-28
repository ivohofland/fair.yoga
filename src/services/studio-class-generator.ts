/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, StudioClassTemplate } from '@prisma/client';
import { getNextOccurrences } from './class-generator';
import { log } from '@/lib/log';

const DEFAULT_WEEKS = 4;

/**
 * How long a claim waits for the template's row lock before giving up.
 * A literal, not a bound parameter: Postgres does not accept bind parameters
 * in `SET`. It is interpolated from this constant only — never from input —
 * which is why `$executeRawUnsafe` is safe here.
 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

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
 * callers that never take that claim, but the hedge is only genuinely
 * load-bearing for one of them:
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
 * The loop below has no caller other than `generateStudioClassInstances`'s
 * own claimed transaction, so there is no unclaimed path left for the branch
 * to matter on here.
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
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<StudioClassTemplate | null> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  return tx.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
}

/**
 * Cron entry point: tops up the rolling window for every active, unarchived
 * studio template, platform-wide — no `teacherId` scoping, unlike
 * `generateClassInstances` (see `pauseOrResumeStudioTemplate`'s docstring in
 * `studio-class-template-lifecycle.ts` for why nothing here is teacher-wide).
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
          let created = 0;
          const dates = getNextOccurrences(fresh.dayOfWeek, startDate, DEFAULT_WEEKS);

          for (const date of dates) {
            const existing = await tx.studioClass.findFirst({
              where: { templateId: fresh.id, date },
            });
            if (existing) continue;

            // Unreachable while the claim above holds the row lock: no other
            // insert for this templateId can land inside this transaction, so
            // nothing is left to collide with `@@unique([templateId, date])`.
            // Kept as a defensive backstop only — pre-lock, this branch was
            // the one doing real work; see `claimStudioTemplateForGeneration`
            // for why that is no longer true.
            try {
              await tx.studioClass.create({
                data: {
                  teacherId: fresh.teacherId,
                  templateId: fresh.id,
                  classType: fresh.classType,
                  date,
                  startTime: fresh.startTime,
                  durationMinutes: fresh.durationMinutes,
                  location: fresh.location,
                  hourlyRate: fresh.hourlyRate,
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                continue; // dead under the claim's lock; see the comment above
              }
              throw err;
            }

            created++;
          }

          return created;
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
