import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLockfileViolations, parsePackageResolutions } from './lockfile-policy';

describe('parsePackageResolutions', () => {
  it('returns nothing for text with no packages: section', () => {
    expect(parsePackageResolutions('lockfileVersion: 9.0\n\nimporters:\n  .: {}\n')).toEqual([]);
  });

  it('parses a plain registry entry, unquoting a quoted key', () => {
    const text = [
      'packages:',
      '',
      "  '@prisma/client@6.19.3':",
      '    resolution: {integrity: sha512-mKq3jQFhjvko5LTJFHGilsuQs+W+T3Gm451NzuTDGQxwCzwXHYnIu2zGkRoW+Exq3Rob7yp2MfzSrdIiZVhrBg==}',
      '    engines: {node: \'>=18.18\'}',
      '',
      'snapshots:',
      '',
    ].join('\n');

    expect(parsePackageResolutions(text)).toEqual([
      {
        key: '@prisma/client@6.19.3',
        resolution:
          'integrity: sha512-mKq3jQFhjvko5LTJFHGilsuQs+W+T3Gm451NzuTDGQxwCzwXHYnIu2zGkRoW+Exq3Rob7yp2MfzSrdIiZVhrBg==',
      },
    ]);
  });

  it('parses an unquoted key with an embedded colon (a git tarball URL)', () => {
    const text = [
      'packages:',
      '',
      '  lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f:',
      '    resolution: {gitHosted: true, integrity: sha512-efBiOJ, tarball: https://codeload.github.com/lodash/lodash/tar.gz/f299b52f}',
      '',
    ].join('\n');

    const entries = parsePackageResolutions(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f');
    expect(entries[0]?.resolution).toContain('tarball:');
  });

  it('reads packages: from both documents of a two-document lockfile', () => {
    const text = [
      '---',
      'lockfileVersion: 9.0',
      '',
      'packages:',
      '',
      '  pnpm@12.3.4:',
      '    resolution: {integrity: sha512-aaaa}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      '  pnpm@12.3.4: {}',
      '---',
      'lockfileVersion: 9.0',
      '',
      'packages:',
      '',
      '  is-number@6.0.0:',
      '    resolution: {integrity: sha512-bbbb}',
      '',
      'snapshots:',
      '',
      '  is-number@6.0.0: {}',
    ].join('\n');

    expect(parsePackageResolutions(text).map((e) => e.key)).toEqual(['pnpm@12.3.4', 'is-number@6.0.0']);
  });

  it('records a key with no resolution line as an unparseable entry rather than dropping it', () => {
    const text = ['packages:', '', '  weird-entry@1.0.0:', '  another-entry@1.0.0:', '    resolution: {integrity: sha512-cccc}', ''].join(
      '\n',
    );

    expect(parsePackageResolutions(text)).toEqual([
      { key: 'weird-entry@1.0.0', resolution: null },
      { key: 'another-entry@1.0.0', resolution: 'integrity: sha512-cccc' },
    ]);
  });

  it('flushes a trailing pending key with no resolution at end of input', () => {
    const text = ['packages:', '', '  trailing@1.0.0:'].join('\n');
    expect(parsePackageResolutions(text)).toEqual([{ key: 'trailing@1.0.0', resolution: null }]);
  });

  // Every other test above is an inline fixture, so none of them would
  // notice if pnpm ever changed the real packages: section's shape. This
  // reads the real committed lockfile the same way src/lib/pnpm-policy.test.ts
  // reads the real pnpm-workspace.yaml — it covers what an inline fixture
  // cannot. A floor, not an exact count, so it doesn't rot as dependencies
  // are added or removed.
  it('parses the real committed lockfile and finds it compliant', () => {
    const text = readFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
    const entries = parsePackageResolutions(text);
    expect(entries.length).toBeGreaterThan(100);
    expect(findLockfileViolations(entries)).toEqual([]);
  });
});

describe('findLockfileViolations', () => {
  it('reports nothing for a compliant registry entry', () => {
    const entries = [{ key: 'is-number@6.0.0', resolution: 'integrity: sha512-bbbb' }];
    expect(findLockfileViolations(entries)).toEqual([]);
  });

  it('flags a resolution missing integrity', () => {
    const entries = [{ key: 'tampered@1.0.0', resolution: 'cpu: [x64]' }];
    expect(findLockfileViolations(entries)).toEqual([{ key: 'tampered@1.0.0', reason: 'missing-integrity' }]);
  });

  it('flags a tarball-sourced resolution as non-registry, even though it carries integrity', () => {
    const entries = [
      {
        key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x',
        resolution: 'gitHosted: true, integrity: sha512-efBiOJ, tarball: https://codeload.github.com/lodash/lodash/tar.gz/x',
      },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x', reason: 'non-registry-source' },
    ]);
  });

  it('flags a null resolution as unparseable rather than silently skipping it', () => {
    const entries = [{ key: 'weird-entry@1.0.0', resolution: null }];
    expect(findLockfileViolations(entries)).toEqual([{ key: 'weird-entry@1.0.0', reason: 'unparseable-entry' }]);
  });

  it('reports one violation per bad entry, not just the first', () => {
    const entries = [
      { key: 'ok@1.0.0', resolution: 'integrity: sha512-good' },
      { key: 'bad-one@1.0.0', resolution: 'cpu: [x64]' },
      { key: 'bad-two@1.0.0', resolution: null },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'bad-one@1.0.0', reason: 'missing-integrity' },
      { key: 'bad-two@1.0.0', reason: 'unparseable-entry' },
    ]);
  });
});
