import { prisma } from '@/lib/db';

/**
 * The VAT % a teacher's new-class and new-template forms start from: their
 * profile default. A class or template carries its own copy once saved.
 */
export async function teacherDefaultVatPercent(teacherId: string): Promise<number> {
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { defaultVatPercent: true },
  });
  return teacher.defaultVatPercent.toNumber();
}
