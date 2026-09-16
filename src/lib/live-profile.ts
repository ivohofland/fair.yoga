/**
 * The one live profile of a kind on an account, or null.
 *
 * Callers pass a list already filtered to the live rows and take back the
 * single element that filter is expected to leave. The throw is what keeps
 * "expected" honest: taking `[0]` directly would pick an arbitrary row
 * silently whenever that expectation broke, and a soft-deleted row is among
 * what it could pick.
 */
export function liveProfile<T>(rows: readonly T[]): T | null {
  if (rows.length > 1) {
    throw new Error(`account holds ${rows.length} live profiles of one kind`);
  }
  return rows[0] ?? null;
}
