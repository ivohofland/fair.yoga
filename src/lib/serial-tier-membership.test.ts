/**
 * The serial-tier lists and the files they name must agree.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It does not decide which files
 * belong on `LOCK_CONTENTION_TESTS` — nothing mechanical can, and issue #447 is
 * the demonstration: a census keyed on assertion text and a census keyed on
 * lock machinery each produce false positives *and* false negatives, because
 * the property is semantic. `roster-link.test.ts` is on the list and is found
 * by neither.
 *
 * Deciding is a judgement a person makes. This stops that judgement, once made,
 * from silently rotting. Three ways it can, and each fails here by name:
 *
 *   - a listed file loses its marker;
 *   - a file under `src/**` carries a marker nobody added to the list;
 *   - a listed file is renamed or deleted.
 *
 * The middle one is only as wide as the search below, which mirrors the `unit`
 * project's own `src/**` include. A marker placed under `tests/`, or in a
 * `.test.tsx`, reaches no tier and is not seen here either.
 *
 * It tethers the marker, not the sentence after it: the reason each file gives
 * is prose, and prose that is copied between files can still rot unnoticed.
 *
 * The marker lives in each file's OWN header, next to the code it describes,
 * which is what `CLAUDE.md`'s *Comment Discipline* asks for where membership
 * matters. The arrays in `vitest.tiers.ts` are the other half; this is what
 * makes the two unable to disagree.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_CONTENTION_TESTS, SERIAL_TESTS } from '../../vitest.tiers';

/**
 * Assembled rather than written out, so this file does not match its own
 * search and report itself as an unlisted member. Inlining it as one literal
 * is what breaks that, and the failure says so: this file turns up under
 * `markedButNotListed`.
 */
const MARKER = ['@serial-tier', 'lock-contention'].join(' ');

const root = process.cwd();

/**
 * Every `src/**` test matching the `unit` project's INCLUDE glob, repo-relative
 * — deliberately before its `SERIAL_TESTS` exclude, which removes exactly the
 * marked files. Filtering by what `unit` finally collects would empty `marked`
 * and leave the `markedButNotListed` direction unable to fail.
 */
function markerSearchScope(): string[] {
  return readdirSync(path.join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .map((p) => `src/${p.split(path.sep).join('/')}`)
    .filter((p) => p.endsWith('.test.ts'))
    .sort();
}

describe('the serial-tier lists agree with the files they name', () => {
  it('runs from the directory holding vitest.config.ts', () => {
    // First, so a wrong root is named once here rather than inferred from the
    // two failures below — both of which would also go red, so this guard
    // labels a loud failure rather than preventing a silent one.
    expect(existsSync(path.join(root, 'vitest.config.ts'))).toBe(true);
  });

  it('names only files that exist', () => {
    // SERIAL_TESTS, not LOCK_CONTENTION_TESTS: `SWEEP_TESTS` carries no marker
    // and so has no other tether, and a stale path there is the more dangerous
    // of the two. It matches nothing in `unit-sweeps`'s `include` AND nothing
    // in `unit`'s `exclude`, so a renamed sweep rejoins the parallel tier — a
    // database-wide sweep with an injected clock, which is what
    // `tests/setup/unit-db.ts` exists to keep away from its neighbours.
    const absent = SERIAL_TESTS.filter((f) => !existsSync(path.join(root, f)));
    expect(absent).toEqual([]);
  });

  it('names exactly the files carrying the marker', () => {
    const marked = markerSearchScope().filter((f) =>
      readFileSync(path.join(root, f), 'utf8').includes(MARKER),
    );
    // Widened deliberately: the array is `as const`, so its element type is a
    // union of its own literals and `includes` would reject any path not
    // already in it — which is exactly the comparison being made here.
    const listed: string[] = [...LOCK_CONTENTION_TESTS].sort();

    // Both directions in one assertion, so a failure names which way it broke
    // rather than reporting two sorted arrays and leaving the reader to diff.
    expect({
      listedButNotMarked: listed.filter((f) => !marked.includes(f)),
      markedButNotListed: marked.filter((f) => !listed.includes(f)),
    }).toEqual({ listedButNotMarked: [], markedButNotListed: [] });
  });
});
