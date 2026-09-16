/**
 * The one live profile of a kind on an account, or null.
 *
 * The helper filters for liveness itself — `T`'s bound requires `deletedAt`,
 * so a caller cannot satisfy the type without selecting the column this
 * filter reads. The throw is for two LIVE rows, a state the partial unique
 * indexes (`Teacher_account_live_unique`, `Student_account_live_unique`)
 * make unreachable; the caller's own `where: { deletedAt: null }` is not what
 * this function depends on for correctness — it is a fetch bound, narrowing
 * what comes back over the wire for an account with many tombstones.
 */
export function liveProfile<T extends { id: string; deletedAt: Date | null }>(
  rows: readonly T[],
): T | null {
  const live = rows.filter((r) => r.deletedAt === null);
  if (live.length > 1) {
    throw new Error(
      `account holds more than one live profile of a kind: ${live.map((r) => r.id).join(', ')}`,
    );
  }
  return live[0] ?? null;
}
