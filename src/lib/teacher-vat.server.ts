import { prisma } from '@/lib/db';

/**
 * The teacher's profile default VAT %, the starting value for a form that
 * creates a class or template. A saved class or template carries its own copy.
 */
export async function teacherDefaultVatPercent(teacherId: string): Promise<number> {
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { defaultVatPercent: true },
  });
  return teacher.defaultVatPercent.toNumber();
}
