import type { PrismaClient, StudentPrivacy } from '@prisma/client';
import type { z } from 'zod';
import { lockLiveStudent, StudentErasedError } from '@/lib/db-locks';
import type { updatePrivacySchema } from '@/lib/schemas';

/** The per-teacher share/mute flags `PUT /api/students/[id]/privacy` writes. */
export type StudentPrivacyFields = Omit<z.infer<typeof updatePrivacySchema>, 'teacherId'>;

/**
 * Writes a student's per-teacher privacy settings.
 *
 * Gated by the Student erasure lock (#183, #626): this transaction's first
 * lock, before the upsert below. A write racing this student's erasure
 * serialises here, and one that waited reads the erasure's committed
 * `deletedAt` and refuses before writing anything. Modes and order:
 * `docs/lock-order.md`, "The `Student` row is the erasure's gate".
 *
 * Authorization (does the caller own this profile, is this teacher linked to
 * it) is the route's job, not this function's — it writes whatever
 * `(studentId, teacherId)` pair it is given.
 */
export async function updateStudentPrivacy(
  db: PrismaClient,
  input: { studentId: string; teacherId: string; fields: StudentPrivacyFields },
): Promise<{ ok: true; value: StudentPrivacy } | { ok: false; reason: 'STUDENT_ERASED' }> {
  return db.$transaction(async (tx) => {
    await lockLiveStudent(tx, input.studentId);
    const value = await tx.studentPrivacy.upsert({
      where: {
        studentId_teacherId: { studentId: input.studentId, teacherId: input.teacherId },
      },
      update: input.fields,
      create: {
        studentId: input.studentId,
        teacherId: input.teacherId,
        shareFullName: input.fields.shareFullName ?? false,
        shareEmail: input.fields.shareEmail ?? false,
        sharePhone: input.fields.sharePhone ?? false,
        shareBirthday: input.fields.shareBirthday ?? false,
        shareAddress: input.fields.shareAddress ?? false,
        receiveComms: input.fields.receiveComms ?? true,
      },
    });
    return { ok: true, value } as const;
  }).catch((err: unknown) => {
    if (err instanceof StudentErasedError) return { ok: false, reason: 'STUDENT_ERASED' } as const;
    throw err;
  });
}
