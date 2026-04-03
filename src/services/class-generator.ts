/**
 * Class Generator — Generates class instances from active ClassTemplates.
 *
 * Runs on a rolling 4-week basis and is idempotent: re-running
 * for the same date range will not create duplicate classes.
 */

import type { PrismaClient } from '@prisma/client';

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
  let daysUntilTarget = (jsDayOfWeek - currentJsDay + 7) % 7;
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

/**
 * Generates class instances for all active templates on a rolling 4-week
 * basis from `from` (defaults to today).
 *
 * Idempotent: skips dates that already have a class for the same template.
 *
 * @returns Total number of newly created class instances
 */
export async function generateClassInstances(
  db: PrismaClient,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();

  // 1. Find all active templates
  const templates = await db.classTemplate.findMany({
    where: { isActive: true },
  });

  let totalCreated = 0;

  for (const template of templates) {
    // 2. Get the next 4 occurrences for this template's day
    const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS);

    for (const date of dates) {
      // 3. Check if a class already exists for this template + date
      const existing = await db.class.findFirst({
        where: {
          templateId: template.id,
          date,
        },
      });

      if (existing) {
        continue;
      }

      // 4. Create the class instance
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

      totalCreated++;
    }
  }

  return totalCreated;
}
