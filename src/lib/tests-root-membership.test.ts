/**
 * Every test file sitting directly in `tests/` must be collected by some vitest
 * project.
 *
 * WHY THIS NEEDS A GUARD. The `unit` project's `include` is `src/**` plus each
 * shared-helper test at `tests/` root named ONE BY ONE. A `tests/**` glob would
 * be shorter and wrong: it would also collect the integration tier, which needs
 * the running app and fails without it. Naming them individually is therefore
 * deliberate — and the cost of a deliberate list is that someone adds the file
 * and forgets the entry. That failure is silent in the worst way: the file is
 * collected by nothing, runs never, and so never reports anything wrong. A
 * helper whose test never runs is indistinguishable from one whose test passes.
 *
 * ROOT LEVEL ONLY. `tests/integration/**` and `tests/e2e/**` are separate tiers
 * with their own runners and their own preconditions; sweeping them in here
 * would demand they appear in a project that cannot run them.
 *
 * It asks the RESOLVED config what each project collects, and matches with real
 * glob semantics, rather than checking that the array literally contains a
 * string. So the invariant it holds is "this file is collected by something",
 * not "the array has these entries" — replacing the named entries with a
 * different pattern that still collects them keeps this green, and only a file
 * that genuinely runs nowhere turns it red.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import config from '../../vitest.config';

const root = process.cwd();

/** Repo-relative paths of the test files sitting directly in `tests/`. */
function testsRootFiles(): string[] {
  return readdirSync(path.join(root, 'tests'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => `tests/${entry.name}`)
    .sort();
}

/**
 * Every `include` pattern from every project of the resolved config.
 *
 * Read through `unknown` and narrowed by hand: `projects` is a union that
 * admits bare path strings as well as inline definitions, and a cast would let
 * a config reshaped into one of the other arms return nothing here — which
 * would report every file below as uncollected instead of saying the shape
 * moved.
 */
function includePatterns(): string[] {
  const resolved = config({ mode: 'test', command: 'serve' });
  const projects: unknown = resolved.test?.projects;
  if (!Array.isArray(projects)) return [];

  const patterns: string[] = [];
  for (const project of projects) {
    if (typeof project !== 'object' || project === null || !('test' in project)) continue;
    const include: unknown = (project as { test?: { include?: unknown } }).test?.include;
    if (!Array.isArray(include)) continue;
    patterns.push(...include.filter((p): p is string => typeof p === 'string'));
  }
  return patterns;
}

/** A pattern naming one file rather than a set — the shape a rename strands. */
function isLiteralPath(pattern: string): boolean {
  return !/[*?[\]{}!]/.test(pattern);
}

describe('tests/ root files are collected by some vitest project', () => {
  it('reads the project include lists out of vitest.config.ts', () => {
    // First, so a config reshaped out from under `includePatterns` is named
    // here rather than surfacing below as "nothing is collected any more",
    // which points at the wrong file.
    expect(existsSync(path.join(root, 'vitest.config.ts'))).toBe(true);
    expect(includePatterns().length).toBeGreaterThan(0);
  });

  it('collects every test file directly under tests/', () => {
    const patterns = includePatterns();
    const uncollected = testsRootFiles().filter(
      (file) => !patterns.some((pattern) => path.matchesGlob(file, pattern)),
    );

    // Named rather than counted, so the failure says which file runs nowhere.
    expect({ uncollected }).toEqual({ uncollected: [] });
  });

  it('names no tests/ file that has been renamed away', () => {
    // The other direction: an entry left behind by a rename matches nothing and
    // silently stops carrying its file. The file itself also fails the case
    // above, but this says which entry went stale rather than which file lost
    // its home.
    const stale = includePatterns()
      .filter((pattern) => pattern.startsWith('tests/') && isLiteralPath(pattern))
      .filter((pattern) => !existsSync(path.join(root, pattern)));

    expect({ stale }).toEqual({ stale: [] });
  });
});
