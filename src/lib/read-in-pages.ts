/**
 * The page size a sweep reads a platform-wide set in. A composite relation
 * load binds one parameter per key column per parent in a single statement,
 * and a statement carries a bounded number of parameters — why sweeps page
 * at all is in `docs/technical-architecture.md` ("Relation loads over
 * platform-wide sets").
 */
export const SWEEP_PAGE_SIZE = 500;

/**
 * Reads every row `fetchPage` can reach, `SWEEP_PAGE_SIZE` at a time, and
 * returns them concatenated in the order the pages came back.
 *
 * `fetchPage` receives the last row of the previous page (`undefined` on the
 * first call) and the page size, and must return at most `take` rows. The
 * caller owns the keyset and the `orderBy`: only the caller knows which
 * columns order its query totally, and a cursor over a non-total order skips
 * or repeats rows at page boundaries. A page shorter than `take` ends the
 * read; one longer than `take` is a caller bug and throws, since it would
 * leave both the cursor and the stop condition wrong.
 */
export async function readInPages<T>(
  fetchPage: (after: T | undefined, take: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: T | undefined;
  for (;;) {
    const page = await fetchPage(after, SWEEP_PAGE_SIZE);
    if (page.length > SWEEP_PAGE_SIZE) {
      throw new Error(`readInPages: fetchPage returned ${page.length} rows for take ${SWEEP_PAGE_SIZE}`);
    }
    rows.push(...page);
    if (page.length < SWEEP_PAGE_SIZE) return rows;
    after = page[page.length - 1];
  }
}

/**
 * Calls `fetchSlice` once per consecutive slice of `keys`, at most
 * `SWEEP_PAGE_SIZE` keys each, and returns the answers concatenated in slice
 * order. For a statement keyed on a list of ids, such as an `in:` filter,
 * whose list would otherwise grow with the set: which statements Prisma sends
 * whole, and its parameter limit for them, are in
 * `docs/technical-architecture.md` ("Relation loads over platform-wide sets").
 */
export async function readInSlices<K, T>(
  keys: readonly K[],
  fetchSlice: (slice: readonly K[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < keys.length; start += SWEEP_PAGE_SIZE) {
    rows.push(...(await fetchSlice(keys.slice(start, start + SWEEP_PAGE_SIZE))));
  }
  return rows;
}
