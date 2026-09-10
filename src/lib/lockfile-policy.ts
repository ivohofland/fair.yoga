/**
 * Pure functions over pnpm-lock.yaml text — no I/O. Enforces #534's two
 * remaining assertions: every package resolves from the plain registry (no
 * git/tarball/local source), and every resolution carries an integrity hash.
 * Rationale, the lockfile's two-document shape, and the measured entry
 * counts: docs/supply-chain.md.
 */

export interface LockfilePackageEntry {
  key: string;
  resolution: string | null;
}

export type LockfileViolationReason = 'missing-integrity' | 'non-registry-source' | 'unparseable-entry';

export interface LockfileViolation {
  key: string;
  reason: LockfileViolationReason;
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
const NON_REGISTRY_MARKERS = ['tarball:', 'gitHosted:', 'repo:', 'commit:', 'type:', 'directory:'];

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

  for (const line of lockfileText.split('\n')) {
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
 * One violation per bad entry, prioritising `non-registry-source` over
 * `missing-integrity` when both would apply — the source is the more
 * specific diagnosis, and a caller only needs one reason to fail the build
 * and name the package.
 */
export function findLockfileViolations(entries: LockfilePackageEntry[]): LockfileViolation[] {
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
