/**
 * The one live profile of a kind on an account, or null.
 *
 * `Account.teachers` and `Account.students` are lists because `accountId`'s
 * uniqueness is partial — see each model's own docblock in
 * `prisma/schema.prisma` for the index that enforces it. Prisma cannot
 * express a partial unique key, so it cannot type either relation as
 * at-most-one; callers select with `where: { deletedAt: null }`, which those
 * indexes make single-valued.
 *
 * The throw is what keeps the lost compile-time guarantee loud. Without an
 * index, a caller taking `[0]` picks arbitrarily and silently, and an
 * arbitrary pick can be a soft-deleted row.
 */
export function liveProfile<T>(rows: readonly T[]): T | null {
  if (rows.length > 1) {
    throw new Error(`account holds ${rows.length} live profiles of one kind`);
  }
  return rows[0] ?? null;
}
