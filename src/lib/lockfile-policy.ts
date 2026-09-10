/**
 * Pure functions over pnpm-lock.yaml text — no I/O. Enforces #534's two
 * remaining assertions: every package resolves from the plain registry (no
 * git/tarball/local source), and every resolution carries an integrity hash.
 * Rationale, the lockfile's two-document shape, and the measured entry
 * counts: docs/supply-chain.md.
 */

export interface LockfilePackageEntry {
  readonly key: string;
  readonly resolution: string | null;
}

export type LockfileViolationReason =
  'missing-integrity' | 'non-registry-source' | 'unparseable-entry';

export interface LockfileViolation {
  readonly key: string;
  readonly reason: LockfileViolationReason;
}

const PACKAGES_HEADER = /^packages:\s*$/;
const TOP_LEVEL_KEY = /^[^\s]/;
const PACKAGE_KEY_LINE = /^ {2}('.*'|[^\s'][^\s]*?):$/;
const RESOLUTION_LINE = /^ {4}resolution: \{(.*)\}$/;

/** The shapes pnpm is known to use for a non-registry resolution —
 *  git-hosted, a plain tarball URL, or a local workspace/`file:` link. The
 *  exact field names are the array below, not restated here, so this
 *  comment can't drift from what the code actually checks. A plain
 *  registry entry's resolution holds only `integrity` (`cpu`/`os`/`libc`
 *  for platform-specific optionals are sibling keys of `resolution`, not
 *  inside it, and never appear here). Measured shape for a git dependency,
 *  and the rationale for banning every marker below: docs/supply-chain.md.
 */
export const NON_REGISTRY_MARKERS = [
  'tarball:',
  'gitHosted:',
  'repo:',
  'commit:',
  'type:',
  'directory:',
];

/**
 * Floor for parsePackageResolutions' entry count, used by
 * checkParserCoverage below. Chosen well under today's real count (697,
 * docs/supply-chain.md) but far above zero, so an empty, truncated, or
 * packages:-less lockfile can't slip past the coverage check by chance —
 * see checkParserCoverage's docblock.
 */
export const MIN_EXPECTED_LOCKFILE_ENTRIES = 100;

/**
 * Extracts every `packages:` entry's key and inlined `resolution: {...}`
 * content. pnpm 12's lockfile is two concatenated YAML documents (one for
 * packageManagerDependencies, one for the real app graph) — this scans line
 * by line rather than parsing YAML, so it reads both without treating `---`
 * specially: it enters a `packages:` block on that exact top-level line and
 * leaves it on the next top-level (column-0) line, in either document.
 *
 * A key with no `resolution:` line before the next key (or the end of the
 * block) comes back with `resolution: null` rather than being dropped — a
 * parser that silently skips what it can't read would make this policy
 * check quietly stop checking anything if pnpm ever changes this format.
 */
export function parsePackageResolutions(lockfileText: string): LockfilePackageEntry[] {
  const entries: LockfilePackageEntry[] = [];
  let inPackages = false;
  let pendingKey: string | null = null;

  const flushPending = (): void => {
    if (pendingKey !== null) {
      entries.push({ key: pendingKey, resolution: null });
      pendingKey = null;
    }
  };

  for (const rawLine of lockfileText.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (PACKAGES_HEADER.test(line)) {
      flushPending();
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (TOP_LEVEL_KEY.test(line)) {
      flushPending();
      inPackages = false;
      continue;
    }

    const keyMatch = PACKAGE_KEY_LINE.exec(line);
    if (keyMatch) {
      flushPending();
      pendingKey = (keyMatch[1] ?? '').replace(/^'|'$/g, '');
      continue;
    }

    const resolutionMatch = RESOLUTION_LINE.exec(line);
    if (resolutionMatch && pendingKey !== null) {
      entries.push({ key: pendingKey, resolution: resolutionMatch[1] ?? '' });
      pendingKey = null;
    }
  }
  flushPending();

  return entries;
}

function isNonRegistrySource(resolution: string): boolean {
  return NON_REGISTRY_MARKERS.some((marker) => resolution.includes(marker));
}

function hasIntegrity(resolution: string): boolean {
  return /(^|,\s*)integrity:/.test(resolution);
}

/**
 * One violation per bad entry. `unparseable-entry` (a null resolution) is
 * checked first, ahead of both other reasons; when both of the remaining
 * reasons would apply, `non-registry-source` is prioritised over
 * `missing-integrity` — the source is the more specific diagnosis, and a
 * caller only needs one reason to fail the build and name the package.
 */
export function findLockfileViolations(
  entries: readonly LockfilePackageEntry[],
): LockfileViolation[] {
  const violations: LockfileViolation[] = [];
  for (const entry of entries) {
    if (entry.resolution === null) {
      violations.push({ key: entry.key, reason: 'unparseable-entry' });
      continue;
    }
    if (isNonRegistrySource(entry.resolution)) {
      violations.push({ key: entry.key, reason: 'non-registry-source' });
      continue;
    }
    if (!hasIntegrity(entry.resolution)) {
      violations.push({ key: entry.key, reason: 'missing-integrity' });
    }
  }
  return violations;
}

export interface ParserCoverageCheck {
  readonly ok: boolean;
  readonly parsedEntries: number;
  readonly rawResolutionLines: number;
}

/**
 * A second, independent tripwire beside findLockfileViolations: counts
 * `resolution:` occurrences in the raw text and compares against how many
 * entries the parser actually recognized, then floors that count at
 * MIN_EXPECTED_LOCKFILE_ENTRIES. If pnpm ever changes the `packages:`
 * section's format in a way parsePackageResolutions stops recognizing, this
 * catches the resulting silent under-count — including the
 * all-the-way-to-zero case (an empty, truncated, or `packages:`-less
 * lockfile), where entries.length and a naive raw count would otherwise
 * agree at zero and hide a real failure. scripts/check-lockfile.ts calls
 * this and fails the build when `ok` is false.
 */
export function checkParserCoverage(
  lockfileText: string,
  entries: readonly LockfilePackageEntry[],
): ParserCoverageCheck {
  const rawResolutionLines = lockfileText
    .split('\n')
    .filter((line) => line.includes('resolution:')).length;
  const ok =
    entries.length >= MIN_EXPECTED_LOCKFILE_ENTRIES && entries.length >= rawResolutionLines;
  return { ok, parsedEntries: entries.length, rawResolutionLines };
}
