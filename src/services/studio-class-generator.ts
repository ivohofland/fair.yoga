/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
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
 * the instant the `SELECT` completes, so the claim returns `true` while
 * holding nothing.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` — see
 * `claimTemplateForGeneration` for why that is not a free optimisation: it is
 * what makes a concurrent insert for this template impossible while the claim
 * holds it, which is what makes the P2002 branch below unreachable whenever
 * it runs after a successful claim.
 */
export async function claimStudioTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<boolean> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  return rows.length === 1;
}

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
          if (!(await claimStudioTemplateForGeneration(tx, template.id))) return 0;

          let created = 0;
          const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS);

          for (const date of dates) {
            const existing = await tx.studioClass.findFirst({
              where: { templateId: template.id, date },
            });
            if (existing) continue;

            // @@unique([templateId, date]) makes concurrent runs collide on
            // P2002 instead of creating duplicate instances.
            try {
              await tx.studioClass.create({
                data: {
                  teacherId: template.teacherId,
                  templateId: template.id,
                  classType: template.classType,
                  date,
                  startTime: template.startTime,
                  durationMinutes: template.durationMinutes,
                  location: template.location,
                  hourlyRate: template.hourlyRate,
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                continue; // a concurrent run created this instance first
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
