/**
 * Studio Class Generator — Generates studio class instances from active StudioClassTemplates.
 *
 * Same rolling 4-week pattern as class-generator.ts. Idempotent.
 */

import type { PrismaClient } from '@prisma/client';
import { getNextOccurrences } from './class-generator';

const DEFAULT_WEEKS = 4;

export async function generateStudioClassInstances(
  db: PrismaClient,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();

  const templates = await db.studioClassTemplate.findMany({
    where: { isActive: true },
  });

  let totalCreated = 0;

  for (const template of templates) {
    const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS);

    for (const date of dates) {
      const existing = await db.studioClass.findFirst({
        where: {
          templateId: template.id,
          date,
        },
      });

      if (existing) continue;

      await db.studioClass.create({
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

      totalCreated++;
    }
  }

  return totalCreated;
}
