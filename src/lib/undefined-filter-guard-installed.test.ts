/**
 * Every vitest project that points `DATABASE_URL` at a database installs the
 * undefined-filter guard (#783) through its `setupFiles`. Removing the setup
 * file from one project leaves that tier's test-built clients plain, and
 * nothing else would notice: its tests still pass.
 *
 * The config is read through `unknown` and narrowed by hand, as in
 * `tests-root-membership.test.ts`, so a reshaped config fails here by name
 * rather than reading as "no project has a database".
 */
import { describe, it, expect } from 'vitest';
import config from '../../vitest.config';

const GUARD_SETUP = './tests/setup/undefined-filter-guard.ts';

type ProjectView = { name: string; hasDatabaseUrl: boolean; setupFiles: string[] };

function projects(): ProjectView[] {
  const resolved = config({ mode: 'test', command: 'serve' });
  const list: unknown = resolved.test?.projects;
  if (!Array.isArray(list)) return [];
  const views: ProjectView[] = [];
  for (const project of list) {
    if (typeof project !== 'object' || project === null || !('test' in project)) continue;
    const test: unknown = project.test;
    if (typeof test !== 'object' || test === null) continue;
    const name: unknown = 'name' in test ? test.name : undefined;
    const env: unknown = 'env' in test ? test.env : undefined;
    const setupFiles: unknown = 'setupFiles' in test ? test.setupFiles : undefined;
    views.push({
      name: typeof name === 'string' ? name : '',
      hasDatabaseUrl: typeof env === 'object' && env !== null && 'DATABASE_URL' in env,
      setupFiles: Array.isArray(setupFiles) ? setupFiles.filter((f): f is string => typeof f === 'string') : [],
    });
  }
  return views;
}

describe('the undefined-filter guard is installed in every database tier', () => {
  it('finds the database tiers, so the check below cannot pass over none', () => {
    const names = projects()
      .filter((p) => p.hasDatabaseUrl)
      .map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['unit', 'unit-sweeps', 'integration']));
  });

  it('lists the guard setup file in each of them', () => {
    const missing = projects()
      .filter((p) => p.hasDatabaseUrl && !p.setupFiles.includes(GUARD_SETUP))
      .map((p) => p.name);
    expect({ missing }).toEqual({ missing: [] });
  });
});
