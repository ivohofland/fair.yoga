import { Prisma } from '@prisma/client';

/**
 * Put this student on this teacher's roster, whether or not they already are.
 *
 * `createMany` with `skipDuplicates`, not `upsert`: it compiles to `INSERT …
 * ON CONFLICT DO NOTHING`, one statement, so there is no gap between a read
 * and a write for a concurrent writer to land in. `upsert({ where, update: {},
 * create })` has that gap — Prisma compiles an empty `update` to a `SELECT`
 * followed by an `INSERT` — and a caller that lost the race got a `P2002`,
 * which reaches the client as a 409 saying the thing it just asked for
 * already exists (#181, and `docs/lock-order.md`).
 *
 * The parameter is the generated compound-unique type rather than a hand-
 * written `{ teacherId, studentId }`. Prisma emits that type only for a
 * declared compound unique, and `skipDuplicates` sends a target-less `ON
 * CONFLICT` that relies on one existing — so dropping or renaming the key
 * fails this file to compile instead of quietly leaving an unguarded insert.
 *
 * Returns nothing on purpose: whether this call was the one that inserted is
 * not a distinction any caller has a use for. They all want the link to
 * exist afterwards, which it does either way.
 */
export async function linkTeacherStudent(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<void> {
  await tx.teacherStudent.createMany({ data: [pair], skipDuplicates: true });
}
