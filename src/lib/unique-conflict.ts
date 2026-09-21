import { Prisma } from '@prisma/client';

/**
 * Extracts the underlying column identifier from a raw or PostgreSQL-decompiled
 * target expression (e.g. `lower(TRIM(BOTH FROM address))` -> `address`).
 *
 * Expression indexes (#260): `Room_public_identity_unique` and
 * `Room_private_identity_unique` use `lower(trim(...))` expression keys.
 * PostgreSQL decompiles these in `meta.target` as `lower(TRIM(BOTH FROM address))`.
 * Target expressions are unwrapped to their base column identifier so callers
 * continue to branch on standard column arrays (`['address', 'floor', 'roomName']`).
 */
function extractColumnIdentifier(targetExpr: unknown): string {
  if (typeof targetExpr !== 'string') return '';
  const stripped = targetExpr.trim().replace(/["']/g, '');
  const match = stripped.match(/([a-zA-Z0-9_]+)[\s)]*$/);
  return match ? match[1]! : stripped;
}

/**
 * True when `err` is a P2002 raised by the unique key covering exactly
 * `columns`.
 *
 * Branching on columns rather than on the index name is not a preference: an
 * index Prisma cannot see (every partial index this project hand-authors) still
 * reports `meta.target` as the column-name array, identically to a declared
 * `@unique`. Measured on `Teacher_account_live_unique`, a partial index
 * hand-authored without expression keys — `SELECT indexname FROM pg_indexes
 * WHERE schemaname='public' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE%'`
 * lists every partial unique index live today, rather than trusting a number
 * here: `{"modelName":"Teacher","target":["accountId"]}`.
 *
 * For partial indexes with expression keys (such as `Room_public_identity_unique`
 * and `Room_private_identity_unique`, #260), PostgreSQL decompiles expressions
 * into `meta.target` (e.g. `lower(TRIM(BOTH FROM address))`), which this helper
 * unwraps to base column names via `extractColumnIdentifier`.
 *
 * Compared as a set. Two unique keys over the same columns in a different
 * order cannot meaningfully coexist, and an order-insensitive check would turn a
 * harmless index rewrite into a silently unreachable branch.
 *
 * Deliberately ignores `err.meta?.modelName`. The invariant that actually
 * holds is narrower than "one model per caller": no single `try` block may
 * raise P2002 from two models that share a column-name set — if one ever did,
 * this matcher could not tell which model's row collided. That is correct
 * wherever the caller has no use for the distinction. For example, `POST
 * /api/account/teacher-profile` (#161) creates `Teacher` and, for a new
 * signup, `Account` together, and both report `['email']` on conflict; the
 * caller does not need to know which one collided — either way it means
 * "email already in use," and the Account profile column is a denormalized
 * copy set at link time with no email-change flow (see the model header
 * comment). This is the pattern to reach for whenever a matcher's caller has
 * no use for distinguishing models on the same columns — other such pairs
 * may exist elsewhere in the codebase without this comment tracking them.
 *
 * Two historical examples were resolved by consolidation, not by this pattern:
 * `(teacherId, date, startTime)` used to name both `Class_teacher_slot_unique`
 * and `StudioClass_teacher_slot_unique`; #327 replaced both with one `EXCLUDE
 * USING gist` on `CalendarEntry`, which raises `23P01` and carries no
 * `meta.target` at all — see `exclusion-conflict.ts`, which this function
 * cannot substitute for. `(teacherId, dayOfWeek, startTime)` went the same way
 * one layer up, in #298. The caution still binds the next pair someone
 * introduces: if a future pair's caller DOES need to know which model
 * collided, consolidation (not this matcher) is the right answer.
 */
export function isUniqueConflictOn(err: unknown, columns: readonly string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  if (target.length !== columns.length) return false;
  const got = [...(target as string[])].map(extractColumnIdentifier).sort();
  const want = [...columns].sort();
  return got.every((c, i) => c === want[i]);
}
