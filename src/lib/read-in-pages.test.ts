import { describe, it, expect } from 'vitest';
import { readInPages, SWEEP_PAGE_SIZE } from './read-in-pages';

interface Row {
  id: string;
}

interface Call {
  after: Row | undefined;
  take: number;
  returned: Row[];
}

/** Zero-padded ids, so string order is numeric order. */
function source(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: String(i).padStart(6, '0') }));
}

/** A keyset fetch over `rows`: `id > after.id`, first `take`, every call recorded. */
function fakeFetch(rows: Row[]) {
  const calls: Call[] = [];
  const fetchPage = async (after: Row | undefined, take: number): Promise<Row[]> => {
    const page = rows.filter((r) => after === undefined || r.id > after.id).slice(0, take);
    calls.push({ after, take, returned: page });
    return page;
  };
  return { calls, fetchPage };
}

describe('readInPages', () => {
  it('returns [] from an empty source after one call with no cursor', async () => {
    const { calls, fetchPage } = fakeFetch([]);
    expect(await readInPages(fetchPage)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.after).toBeUndefined();
  });

  it('takes one call for a source one short of a page', async () => {
    const rows = source(SWEEP_PAGE_SIZE - 1);
    const { calls, fetchPage } = fakeFetch(rows);
    expect(await readInPages(fetchPage)).toEqual(rows);
    expect(calls).toHaveLength(1);
  });

  it('takes a second, empty call for a source of exactly one page', async () => {
    const rows = source(SWEEP_PAGE_SIZE);
    const { calls, fetchPage } = fakeFetch(rows);
    expect(await readInPages(fetchPage)).toEqual(rows);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.returned).toEqual([]);
  });

  it('takes three calls for two pages and one row, in source order', async () => {
    const rows = source(2 * SWEEP_PAGE_SIZE + 1);
    const { calls, fetchPage } = fakeFetch(rows);
    const result = await readInPages(fetchPage);
    expect(result).toEqual(rows);
    expect(calls).toHaveLength(3);
  });

  it('asks for SWEEP_PAGE_SIZE on every call and resumes after the previous page’s last row', async () => {
    const rows = source(2 * SWEEP_PAGE_SIZE + 1);
    const { calls, fetchPage } = fakeFetch(rows);
    await readInPages(fetchPage);
    for (const call of calls) expect(call.take).toBe(SWEEP_PAGE_SIZE);
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1]?.returned ?? [];
      expect(calls[i]?.after).toBe(previous[previous.length - 1]);
    }
  });

  it('throws when fetchPage returns more rows than it was asked for', async () => {
    const rows = source(SWEEP_PAGE_SIZE + 1);
    let calls = 0;
    const overfull = async (): Promise<Row[]> => {
      calls++;
      return rows;
    };
    await expect(readInPages(overfull)).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });
});
