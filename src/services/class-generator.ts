/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { classStartInstant } from '@/lib/timezone';
import { log } from '@/lib/log';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WEEKS = 4;

// ---------------------------------------------------------------------------
// getNextOccurrences
// ---------------------------------------------------------------------------

/**
 * Returns the next `weeks` occurrences of a given day-of-week starting
 * from (and including) `from`.
 *
 * @param dayOfWeek Schema convention: 0=Monday, 1=Tuesday, ..., 6=Sunday
 * @param from      Start date (time portion is ignored)
 * @param weeks     Number of occurrences to generate
 * @returns Array of Date objects with time set to 00:00:00.000 UTC
 */
export function getNextOccurrences(
  dayOfWeek: number,
  from: Date,
  weeks: number,
): Date[] {
  // Schema convention: 0=Mon, 1=Tue, ..., 6=Sun
  // JS getUTCDay():    0=Sun, 1=Mon, ..., 6=Sat
  // Convert schema day to JS day: jsDayOfWeek = (dayOfWeek + 1) % 7
  const jsDayOfWeek = (dayOfWeek + 1) % 7;

  // Start from midnight UTC of `from`
  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );

  // Find the first occurrence on or after `start`
  const currentJsDay = start.getUTCDay();
  const daysUntilTarget = (jsDayOfWeek - currentJsDay + 7) % 7;
  // daysUntilTarget === 0 means `from` is already the target day — include it

  const firstOccurrence = new Date(start);
  firstOccurrence.setUTCDate(firstOccurrence.getUTCDate() + daysUntilTarget);

  const dates: Date[] = [];
  for (let i = 0; i < weeks; i++) {
    const date = new Date(firstOccurrence);
    date.setUTCDate(date.getUTCDate() + i * 7);
    dates.push(date);
  }

  return dates;
}

// ---------------------------------------------------------------------------
// generateClassInstances
// ---------------------------------------------------------------------------

type TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
}>;

/**
 * Generates the rolling 4-week window for ONE template, reporting each
 * candidate date it could not fill and why (`GenerationResult`).
 *
 * Two mechanisms, each with a job the other cannot do:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped, which
 *     is what lets the teacher be told something true and an operator grep for
 *     it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` compiles to a BARE
 *     `ON CONFLICT DO NOTHING` — no conflict target, so it covers every unique
 *     constraint on the table, including `Class_teacher_slot_unique` on
 *     (teacherId, date, startTime) WHERE status <> 'cancelled' — the partial
 *     index #196 added. That is what makes a clash cost only its own date,
 *     inside a transaction that then goes on to run another statement and
 *     commit. Pinned by `src/services/class-generator.test.ts`, "names a date
 *     lost to a concurrent insert as raced, not as filled" — a holder row
 *     with `templateId: null`, so the collision is isolated to the slot key
 *     rather than riding along on `@@unique([templateId, date])` too.
 *
 * This function used to claim it was idempotent via "`@@unique([templateId,
 * date])` + P2002-skip". It was not, and the correction is the reason this
 * shape exists: Prisma does not savepoint individual queries inside an
 * interactive transaction, so a caught `P2002` leaves Postgres with an aborted
 * transaction. The next statement fails with `25P02`, and if the clash landed
 * on the *last* date there is no next statement — `COMMIT` on an aborted
 * transaction returns the `ROLLBACK` tag with no error, so `$transaction`
 * resolved successfully while every row it reported was discarded (#164).
 * Named rather than counted, because a count goes stale on the first unrelated
 * change and this one was wrong on arrival: `api/class-templates/route.ts`,
 * `generateClassInstances` below, `pauseOrResumeTemplate`
 * (`class-template-lifecycle.ts`) and `syncTemplateInstances`
 * (`template-sync.ts`) all pass a transaction client now.
 * `syncTemplateInstances` was the one that did not, passing a bare
 * `PrismaClient`, until the atomic-template-update branch (issue 83) stopped
 * it opening a transaction of its own — it now composes into whichever
 * transaction its own caller already holds instead. In production, that is:
 * this file's own tests still call this function directly with a bare
 * `prisma` (`class-generator.test.ts`), which is why the roster says
 * production rather than pretending to be exhaustive. Do not reintroduce a `catch` here; there is
 * nothing it can do that the constraint does not.
 *
 * Accepts a transaction client so a route can create the template and its
 * window atomically.
 */
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. A run
  // after today's start time must not create a class that already happened;
  // the window slides one week further instead.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) >
        startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // One query for the whole window, replacing the per-date `findFirst`. Scoped
  // to this teacher because the slot key #196 enforces is
  // `(teacherId, date, startTime)` — another teacher's class can never block
  // this one and must not be read.
  const occupants = await db.class.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, status: true },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    // At most one, by `@@unique([templateId, date])`.
    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // A cancelled own row still holds the date: that unique key does not
      // care about status, so the date is unfillable for good, not merely
      // already filled. Telling those two apart is #192.
      skipped.push({
        date,
        reason: own.status === 'cancelled' ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors the predicate `Class_teacher_slot_unique` carries (`WHERE
    // "status" <> 'cancelled'`); the index backs it since #196; this
    // pre-check is what names the reason, not what enforces it.
    // Widen or narrow one without the other and this pre-check starts
    // disagreeing with the constraint that backs it — see the spec's §4.1.
    if (onDate.some((c) => c.startTime === template.startTime && c.status !== 'cancelled')) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    free.push(date);
  }

  const inserted =
    free.length === 0
      ? []
      : await db.class.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            teacherRoomId: template.teacherRoomId,
            templateId: template.id,
            classType: template.classType,
            description: template.description,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            roomCost: template.roomCost,
            minRate: template.minRate,
            targetRate: template.targetRate,
            minStudents: template.minStudents,
            maxStudents: template.maxStudents,
            cancelDeadline: template.cancelDeadline,
            autoCancelCheck: template.autoCancelCheck,
            status: 'open' as const,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  // A free date that did not come back lost a race with a concurrent insert.
  // Before #164 this was the P2002 that poisoned the transaction; it is now an
  // ordinary skipped date, and the only one whose cause is not in `occupants`.
  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedSlots(template.id, template.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/**
 * One line per generator call, never one per date — that ratio is the answer to
 * the noise question #192 raised, where per-date logging on an hourly sweep put
 * ~48 lines/day on a 2GB VPS for a teacher with two blocked dates. Per call it
 * is 24, and each is complete rather than a fragment.
 *
 * `already_generated` is excluded deliberately: it is the correct, expected
 * outcome of every steady-state run, and logging it *is* the noise.
 */
function logSkippedSlots(templateId: string, teacherId: string, skipped: SkippedSlot[]): void {
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
    'class generation could not fill every date in the window',
  );
}

/**
 * Claims a template for generation, or reports it is no longer eligible.
 *
 * `FOR UPDATE` is the point, not the `SELECT`. It locks the same row
 * `archiveOrUnarchiveTemplate`'s compare-and-swap locks, and the two modes
 * conflict — that `updateMany` touches no key column, so Postgres grants it
 * `FOR NO KEY UPDATE`, which this blocks and which blocks this — so the sweep
 * and an archive serialise instead of interleaving:
 *
 *   - claim first  → the archive's UPDATE waits; we generate and commit; the
 *                    archive's own deleteMany then withdraws what we made —
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
 *   - archive first → we wait, then read `isArchived: true` and skip.
 *
 * A plain re-read would not do this. Under READ COMMITTED each statement takes
 * a fresh snapshot, so an archive committing between the re-read and the
 * `create` is invisible to the re-read and still lost. Do not "simplify" the
 * locking `SELECT` above into a plain `findUnique`.
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
 * statement above still does the locking and the eligibility re-check; the
 * Prisma read below is what makes the values authoritative, and it is safe
 * precisely because the lock is still held when it runs. Two statements rather
 * than one `SELECT *` because `roomCost`, `minRate` and `targetRate` are
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
    SELECT "id" FROM "ClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above, so nothing can change this row before we
  // commit. `OrThrow` because the row provably exists — the FOR UPDATE just
  // matched it — and an impossible `| null` would force every caller to
  // pretend to handle it.
  return tx.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}

/**
 * Cron / teacher-wide entry point: tops up the rolling window for all
 * active templates (or one teacher's). Each template is isolated — one
 * template whose generation throws is logged and skipped, the rest still
 * generate, and the first error is rethrown at the end for job-health
 * visibility.
 */
export async function generateClassInstances(
  db: PrismaClient,
  from?: Date,
  teacherId?: string,
): Promise<number> {
  const startDate = from ?? new Date();

  // isArchived is defense in depth: the routes keep archived templates
  // inactive, but if that invariant ever slips, the generator must not
  // materialize classes for something the teacher shelved.
  const templates = await db.classTemplate.findMany({
    where: { isActive: true, isArchived: false, ...(teacherId ? { teacherId } : {}) },
    include: { teacher: { select: { defaultTimezone: true } } },
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
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}
