/**
 * The page size a sweep reads a platform-wide set in. A relation load's
 * parent set becomes one row-value `IN` list in the SQL Prisma sends, and the
 * Postgres parser's stack grows with that list — why sweeps page at all is in
 * `docs/technical-architecture.md` ("Relation loads over platform-wide sets").
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
