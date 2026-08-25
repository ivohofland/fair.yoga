import { Prisma } from '@prisma/client';

/**
 * True when `err` is a P2002 raised by the unique key covering exactly
 * `columns`.
 *
 * Branching on columns rather than on the index name is not a preference: an
 * index Prisma cannot see (every partial index this project hand-authors) still
 * reports `meta.target` as the column-name array, identically to a declared
 * `@unique`. Measured on `StudioClass_teacher_slot_unique`:
 * `{"modelName":"StudioClass","target":["teacherId","date","startTime"]}`.
 *
 * Compared as a set. Two unique keys over the same columns in a different
 * order cannot meaningfully coexist, and an order-sensitive check would turn a
 * harmless index rewrite into a silently unreachable branch.
 *
 * Deliberately ignores `err.meta?.modelName`. The invariant that actually
 * holds is narrower than "one model per caller": no single `try` block may
 * raise P2002 from two models that share a column-name set — if one ever
 * did, this matcher could not tell which model's row collided. `(teacherId,
 * date, startTime)` names both `Class_teacher_slot_unique` and
 * `StudioClass_teacher_slot_unique`; a route whose transaction can raise
 * P2002 from both under one `try` would need `modelName` added to
 * disambiguate them. Tracked as #210, which is not fixed here.
 *
 * `(teacherId, dayOfWeek, startTime)` is not this kind of pair any more:
 * issue 298 replaced the two partial indexes that column set used to name
 * (`ClassTemplate_teacher_slot_unique`, `StudioClassTemplate_teacher_slot_
 * unique`) with `ScheduleRule_teacher_slot_excl`, a single exclusion
 * constraint raising `23P01`, not P2002 — so no caller matches this function
 * against those columns any more.
 */
export function isUniqueConflictOn(err: unknown, columns: readonly string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  if (target.length !== columns.length) return false;
  const got = [...(target as string[])].sort();
  const want = [...columns].sort();
  return got.every((c, i) => c === want[i]);
}
