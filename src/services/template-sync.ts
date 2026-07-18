/**
 * Template → instance propagation. Editing a recurring template used to
 * change future generations only; the up-to-four already-generated
 * instances silently kept the old time and rates.
 *
 * Rule: propagate to generated instances that are still fully mutable —
 * `draft`/`open`, `settingsLocked: false` (no registrations yet), and in
 * the future. Anything a student has touched keeps its settings.
 *
 * A day-of-week change doesn't move classes (a different day is a
 * different class): mutable instances on the wrong day are deleted and
 * the generator refills the window on the new day.
 */

import type { PrismaClient } from '@prisma/client';
import { generateClassInstances } from './class-generator';

export interface TemplateSyncResult {
  /** Instances updated in place. */
  synced: number;
  /** Wrong-day instances removed (window refilled on the new day). */
  regenerated: number;
  /** Future instances left untouched because bookings locked them. */
  kept: number;
}

export async function syncTemplateInstances(
  db: PrismaClient,
  templateId: string,
): Promise<TemplateSyncResult> {
  const template = await db.classTemplate.findUniqueOrThrow({ where: { id: templateId } });

  const result = await db.$transaction(async (tx) => {
    // Future generated instances; `gt: now` deliberately excludes today —
    // a class hours from starting should not shift under its students.
    const future = await tx.class.findMany({
      where: { templateId, date: { gt: new Date() } },
      select: { id: true, date: true, settingsLocked: true, status: true },
    });

    const mutable = future.filter(
      (c) => !c.settingsLocked && (c.status === 'draft' || c.status === 'open'),
    );
    const kept = future.length - mutable.length;

    // Schema convention 0=Monday; JS getUTCDay() 0=Sunday.
    const templateJsDay = (template.dayOfWeek + 1) % 7;
    const wrongDay = mutable.filter((c) => c.date.getUTCDay() !== templateJsDay);
    const sameDay = mutable.filter((c) => c.date.getUTCDay() === templateJsDay);

    if (wrongDay.length > 0) {
      await tx.class.deleteMany({ where: { id: { in: wrongDay.map((c) => c.id) } } });
    }

    if (sameDay.length > 0) {
      await tx.class.updateMany({
        where: { id: { in: sameDay.map((c) => c.id) } },
        data: {
          teacherRoomId: template.teacherRoomId,
          classType: template.classType,
          description: template.description,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          roomCost: template.roomCost,
          minRate: template.minRate,
          targetRate: template.targetRate,
          minStudents: template.minStudents,
          maxStudents: template.maxStudents,
          cancelDeadline: template.cancelDeadline,
          autoCancelCheck: template.autoCancelCheck,
        },
      });
    }

    return { synced: sameDay.length, regenerated: wrongDay.length, kept };
  });

  // Refill the window after a day change (idempotent — the unique
  // (templateId, date) constraint guards against racing cron runs).
  if (result.regenerated > 0 && template.isActive) {
    await generateClassInstances(db, undefined, template.teacherId);
  }

  return result;
}
