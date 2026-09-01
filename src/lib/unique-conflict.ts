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
 * One such pair EXISTS TODAY by design: `Account.email` and `Teacher.email`
 * (both report `['email']`) are handled together by `POST /api/teachers`
 * (#161). This is safe because the caller (`teachers/route.ts:71-72`)
 * deliberately does NOT need to distinguish which model collided — both mean
 * "email already in use" to the caller, and the Account profile column is a
 * denormalized copy set at link time with no email-change flow (see the model
 * header comment). This is the correct pattern when a matcher's caller has no
 * use for distinguishing models on the same columns.
 *
 * Two historical examples were resolved by consolidation, not by this pattern:
 * `(teacherId, date, startTime)` used to name both `Class_teacher_slot_unique`
 * and `StudioClass_teacher_slot_unique`; #327 replaced both with one `EXCLUDE
 * USING gist` on `CalendarEntry`, which raises `23P01` and carries no
 * `meta.target` at all — see `exclusion-conflict.ts`, which this function
 * cannot substitute for. `(teacherId, dayOfWeek, startTime)` went the same way
 * one layer up, in #298. The caution below still binds the next pair someone
 * introduces: if a future pair's caller DOES need to know which model collided,
 * consolidation (not this matcher) is the right answer.
 *
 * The rule above still binds the next pair someone introduces.
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
