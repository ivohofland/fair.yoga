import type { PrismaClient } from '@prisma/client';

/** Session seeds need the account behind a profile — resolve it by id. */
export async function accountIdOfTeacher(db: PrismaClient, teacherId: string): Promise<string> {
  const t = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true },
  });
  return t.accountId;
}

export async function accountIdOfStudent(db: PrismaClient, studentId: string): Promise<string> {
  const s = await db.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { accountId: true },
  });
  if (!s.accountId) throw new Error(`student ${studentId} has no account — seed one`);
  return s.accountId;
}
