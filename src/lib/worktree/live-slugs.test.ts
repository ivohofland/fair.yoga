import { describe, it, expect } from 'vitest';
import { computeLiveSlugs } from './live-slugs';

describe('computeLiveSlugs', () => {
  it('keeps only entries whose working directory still exists', () => {
    const result = computeLiveSlugs([
      { slug: 'fix_517', workingDirExists: true },
      { slug: 'fix_520', workingDirExists: false },
    ]);
    expect(result).toEqual(new Set(['fix_517']));
  });

  it('returns an empty set for no entries', () => {
    expect(computeLiveSlugs([])).toEqual(new Set());
  });
});
