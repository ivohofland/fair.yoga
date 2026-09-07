import type { Prisma } from '@prisma/client';

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
 * Returns whether this call inserted the row: `true` when this was the first
 * link between the pair, `false` when it already stood. The value comes
 * straight off the single `ON CONFLICT DO NOTHING` statement above —
 * `createMany`'s own `count` is 1 on insert, 0 on conflict — so it is
 * race-free the same way the write is: no caller has to re-read the table to
 * learn which outcome its own statement got. `resolveInvitationOnLink`
 * (`services/link-consent.ts`) is written against that distinction: not a
 * caller of this function, but a consumer a caller hands the value to, so it
 * can tell an act that created the `TeacherStudent` link apart from one that
 * found it already there.
 */
export async function linkTeacherStudent(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<boolean> {
  const { count } = await tx.teacherStudent.createMany({ data: [pair], skipDuplicates: true });
  return count === 1;
}
