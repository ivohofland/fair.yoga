import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIN_EXPECTED_LOCKFILE_ENTRIES,
  NON_REGISTRY_MARKERS,
  checkParserCoverage,
  findLockfileViolations,
  parsePackageResolutions,
} from './lockfile-policy';

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
      "    engines: {node: '>=18.18'}",
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
    expect(entries[0]?.key).toBe(
      'lodash@https://codeload.github.com/lodash/lodash/tar.gz/f299b52f',
    );
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

    expect(parsePackageResolutions(text).map((e) => e.key)).toEqual([
      'pnpm@12.3.4',
      'is-number@6.0.0',
    ]);
  });

  it('records a key with no resolution line as an unparseable entry rather than dropping it', () => {
    const text = [
      'packages:',
      '',
      '  weird-entry@1.0.0:',
      '  another-entry@1.0.0:',
      '    resolution: {integrity: sha512-cccc}',
      '',
    ].join('\n');

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
    expect(entries.length).toBeGreaterThan(MIN_EXPECTED_LOCKFILE_ENTRIES);
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
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'tampered@1.0.0', reason: 'missing-integrity' },
    ]);
  });

  it('flags a tarball-sourced resolution as non-registry, even though it carries integrity', () => {
    const entries = [
      {
        key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x',
        resolution:
          'gitHosted: true, integrity: sha512-efBiOJ, tarball: https://codeload.github.com/lodash/lodash/tar.gz/x',
      },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      {
        key: 'lodash@https://codeload.github.com/lodash/lodash/tar.gz/x',
        reason: 'non-registry-source',
      },
    ]);
  });

  it('flags a null resolution as unparseable rather than silently skipping it', () => {
    const entries = [{ key: 'weird-entry@1.0.0', resolution: null }];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'weird-entry@1.0.0', reason: 'unparseable-entry' },
    ]);
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

  // The docblock claims non-registry-source is reported in preference to
  // missing-integrity when both apply. Every other non-registry fixture
  // above also carries integrity, so none of them can tell the two
  // orderings apart — this one carries no "integrity:" substring at all, so
  // it only passes under the documented priority.
  it('flags a non-registry resolution with no integrity at all as non-registry-source, not missing-integrity', () => {
    const entries = [
      {
        key: 'evil@1.0.0',
        resolution: 'gitHosted: true, tarball: https://evil.example/pkg.tgz',
      },
    ];
    expect(findLockfileViolations(entries)).toEqual([
      { key: 'evil@1.0.0', reason: 'non-registry-source' },
    ]);
  });

  // Table-driven over the real NON_REGISTRY_MARKERS export rather than a
  // hand-copied list, so a marker added or removed from that array is
  // automatically covered (or automatically drops out) here too.
  it.each(NON_REGISTRY_MARKERS)(
    'flags a resolution carrying the %s marker as non-registry-source',
    (marker) => {
      const entries = [
        { key: `pkg-with-${marker}`, resolution: `${marker} true, integrity: sha512-x` },
      ];
      expect(findLockfileViolations(entries)).toEqual([
        { key: `pkg-with-${marker}`, reason: 'non-registry-source' },
      ]);
    },
  );
});

describe('checkParserCoverage', () => {
  it('passes for the real committed lockfile', () => {
    const text = readFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
    const entries = parsePackageResolutions(text);
    const result = checkParserCoverage(text, entries);
    expect(result.ok).toBe(true);
    expect(result.parsedEntries).toBe(entries.length);
  });

  // The exact bug this function exists to close: an empty (or
  // packages:-less) lockfile parses to zero entries, and a naive raw count
  // of "resolution:" lines also lands on zero — the two would agree and a
  // comparison between them alone would report a pass.
  it('fails on an empty lockfile, where parsed entries and raw resolution lines would otherwise both be zero', () => {
    expect(checkParserCoverage('', [])).toEqual({
      ok: false,
      parsedEntries: 0,
      rawResolutionLines: 0,
    });
  });

  it('fails when entries.length is nonzero but below MIN_EXPECTED_LOCKFILE_ENTRIES', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      key: `pkg-${i}@1.0.0`,
      resolution: 'integrity: sha512-x',
    }));
    const text = entries.map(() => '    resolution: {integrity: sha512-x}').join('\n');
    const result = checkParserCoverage(text, entries);
    expect(result.ok).toBe(false);
    expect(result.parsedEntries).toBe(5);
    expect(result.rawResolutionLines).toBe(5);
  });

  // Both counts comfortably clear MIN_EXPECTED_LOCKFILE_ENTRIES here — this
  // is the original failure mode the raw-count tether exists to catch (a
  // format drift where the parser silently recognizes fewer entries than
  // the file actually holds), distinct from the floor check above.
  it('fails when parsed entries fall short of raw resolution lines, both comfortably above the floor', () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({
      key: `pkg-${i}@1.0.0`,
      resolution: 'integrity: sha512-x',
    }));
    const text = Array.from({ length: 210 }, () => '    resolution: {integrity: sha512-x}').join('\n');
    const result = checkParserCoverage(text, entries);
    expect(result.ok).toBe(false);
    expect(result.parsedEntries).toBe(200);
    expect(result.rawResolutionLines).toBe(210);
  });
});
