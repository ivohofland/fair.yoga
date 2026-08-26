import { Prisma } from '@prisma/client';

/**
 * True when `err` is a P2002 raised by the unique key covering exactly
 * `columns`.
 *
 * Branching on columns rather than on the index name is not a preference: an
 * index Prisma cannot see (every partial index this project hand-authors) still
 * reports `meta.target` as the column-name array, identically to a declared
 * `@unique`. Measured on `Room_private_identity_unique`, a partial index #196
 * hand-authored — `SELECT indexname FROM pg_indexes WHERE schemaname='public'
 * AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE%'` lists every
 * partial unique index live today, rather than trusting a number here:
 * `{"modelName":"Room","target":["createdById","address","floor","roomName"]}`.
 *
 * Compared as a set. Two unique keys over the same columns in a different
 * order cannot meaningfully coexist, and an order-sensitive check would turn a
 * harmless index rewrite into a silently unreachable branch.
 *
 * Deliberately ignores `err.meta?.modelName`. The invariant that actually
 * holds is narrower than "one model per caller": no single `try` block may
 * raise P2002 from two models that share a column-name set — if one ever did,
 * this matcher could not tell which model's row collided.
 *
 * NO SUCH PAIR EXISTS TODAY, and #210 — filed for the one that did — is moot
 * rather than fixed. `(teacherId, date, startTime)` used to name both
 * `Class_teacher_slot_unique` and `StudioClass_teacher_slot_unique`; #327
 * replaced both with one `EXCLUDE USING gist` on `CalendarEntry`, which raises
 * `23P01` and carries no `meta.target` at all — see `exclusion-conflict.ts`,
 * which this function cannot substitute for. The rule above still binds the
 * next pair someone introduces.
 *
 * `(teacherId, dayOfWeek, startTime)` went the same way one layer up, in #298.
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
