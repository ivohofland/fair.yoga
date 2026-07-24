/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
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
 * Generates the rolling 4-week window for ONE template, idempotently
 * (`@@unique([templateId, date])` + P2002-skip). Accepts a transaction
 * client so a route can create the template and its window atomically.
 */
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();
  let created = 0;

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

  for (const date of dates) {
    const existing = await db.class.findFirst({ where: { templateId: template.id, date } });
    if (existing) continue;

    try {
      await db.class.create({
        data: {
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
          status: 'open',
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
      totalCreated += await generateInstancesForTemplate(db, template, startDate);
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
