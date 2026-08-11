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
 * Deliberately ignores `err.meta?.modelName`, so this is safe only as long as
 * a single `try` block can raise P2002 from just one model. That holds for
 * every caller today, but not by any guarantee: `(teacherId, date,
 * startTime)` names both `Class_teacher_slot_unique` and
 * `StudioClass_teacher_slot_unique`, and `(teacherId, dayOfWeek, startTime)`
 * names both `ClassTemplate_teacher_slot_unique` and
 * `StudioClassTemplate_teacher_slot_unique`. A route whose transaction can
 * raise P2002 from two models sharing a column-name set — e.g. a
 * `ClassTemplate` create that also generates `Class` rows, if `dayOfWeek` and
 * `date` ever converged — would need `modelName` added to disambiguate them.
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
