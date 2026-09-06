/**
 * Joins a set of concurrent promises using `Promise.allSettled`, then rethrows
 * the reason of the first rejected promise (in array order), if any.
 * `undefined` arguments are allowed and settle immediately, for callers whose
 * racer may never have been assigned.
 *
 * Used in lock-order test `finally` teardowns so that:
 * 1. Every promise created in the staged race is joined, even if an earlier one
 *    rejects (preventing unjoined background writers touching shared database state).
 * 2. Any rejection from the racers or holder is still reported rather than
 *    silently swallowed.
 */
export async function joinOrThrow(...promises: (Promise<unknown> | undefined)[]): Promise<void> {
  const joined = await Promise.allSettled(promises);
  const failed = joined.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
}
