/**
 * `LOCK_CONTENTION_TESTS` and the files it names must agree.
 *
 * WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It does not decide which files
 * belong on that list — nothing mechanical can, and issue #447 is the
 * demonstration: a census keyed on assertion text and a census keyed on lock
 * machinery each produce false positives *and* false negatives, because the
 * property is semantic. `gdpr.test.ts:2903` stages a lock race through a
 * `$transaction` and a promise gate with no `FOR UPDATE` anywhere in it, and
 * no regex over either axis finds it.
 *
 * Deciding is a judgement a person makes. This test stops that judgement, once
 * made, from silently rotting: a listed file that loses its marker, a marked
 * file nobody added to the list, and a listed file that was renamed or deleted
 * all fail here, by name.
 *
 * The marker lives in each file's OWN header, next to the code it describes,
 * which is what `CLAUDE.md`'s *Comment Discipline* asks for where membership
 * matters. The config's array is the other half; this test is what makes the
 * two unable to disagree.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_CONTENTION_TESTS } from '../../vitest.tiers';

/**
 * Assembled rather than written out, so this file does not match its own
 * search and report itself as an unlisted member. Inlining it as one literal
 * is what breaks that, and the failure says so: this file turns up under
 * `markedButNotListed`.
 */
const MARKER = ['@serial-tier', 'lock-contention'].join(' ');

const root = process.cwd();

describe('LOCK_CONTENTION_TESTS agrees with the files it names', () => {
  it('runs from the directory holding vitest.config.ts', () => {
    // Everything below resolves against `root`, so a wrong root would make the
    // whole file pass while comparing nothing.
    expect(existsSync(path.join(root, 'vitest.config.ts'))).toBe(true);
  });

  it('names only files that exist', () => {
    const absent = LOCK_CONTENTION_TESTS.filter((f) => !existsSync(path.join(root, f)));
    expect(absent).toEqual([]);
  });

  it('names exactly the files carrying the marker', () => {
    const marked = globSync('src/**/*.test.ts', { cwd: root })
      .filter((f) => readFileSync(path.join(root, f), 'utf8').includes(MARKER))
      .sort();
    const listed = [...LOCK_CONTENTION_TESTS].sort();

    // Both directions in one assertion, so a failure names which way it broke
    // rather than reporting two sorted arrays and leaving the reader to diff.
    expect({
      listedButNotMarked: listed.filter((f) => !marked.includes(f)),
      markedButNotListed: marked.filter((f) => !listed.includes(f)),
    }).toEqual({ listedButNotMarked: [], markedButNotListed: [] });
  });
});
