import type { Currency } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The currency a teacher's rooms, templates and new-class forms are priced in.
 * A class or studio class carries its own snapshot; this is the teacher's
 * current one, for everything that has no row of its own to read it from.
 */
export async function teacherCurrency(teacherId: string): Promise<Currency> {
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { currency: true },
  });
  return teacher.currency;
}
