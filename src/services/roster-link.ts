import type { Prisma } from '@prisma/client';

/**
 * What a `linkTeacherStudent` call did to the roster.
 *
 * Two names rather than a `boolean`, for the reason `PaymentStatus` and
 * `InvitationStatus` are unions: `resolveInvitationOnLink`
 * (`services/link-consent.ts`) takes this value as a parameter and decides a
 * security property on it (#418), and a `boolean` parameter accepts every
 * other boolean in scope — a wrong `true` there reopens the confirmation
 * oracle that rule closed. A `LinkOutcome` makes passing the wrong thing a
 * compile error.
 *
 * What it does NOT express is that the value came from the caller's own
 * transaction. No type here can; that half is stated at
 * `resolveInvitationOnLink`'s parameter and has to be read.
 */
export type LinkOutcome = 'created' | 'already-linked';

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
 * Returns which of the two things this call did, not a fact about the pair's
 * history: `'created'` when this call inserted the row, `'already-linked'`
 * when it found one standing. An unlink deletes the row, so a re-link after
 * one reports `'created'` again — the value is about this call, never about a
 * first link ever. It comes straight off the single `ON CONFLICT DO NOTHING`
 * statement above — `createMany`'s own `count` is 1 on insert, 0 on conflict
 * — so it is race-free the same way the write is: no caller has to re-read
 * the table to learn which outcome its own statement got.
 *
 * `resolveInvitationOnLink` (`services/link-consent.ts`) is written against
 * that distinction: not a caller of this function, but a consumer a caller
 * hands the value to, so it can tell an act that created the `TeacherStudent`
 * link apart from one that found it already there. What each outcome MEANS
 * for an invitation standing on that pair is `docs/data-model.md`
 * (Invitation, "What a student's own act resolves"), which owns that rule for
 * both files.
 */
export async function linkTeacherStudent(
  tx: Prisma.TransactionClient,
  pair: Prisma.TeacherStudentTeacherIdStudentIdCompoundUniqueInput,
): Promise<LinkOutcome> {
  const { count } = await tx.teacherStudent.createMany({ data: [pair], skipDuplicates: true });
  return count === 1 ? 'created' : 'already-linked';
}
