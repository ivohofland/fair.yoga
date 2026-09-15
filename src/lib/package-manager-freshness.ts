/**
 * Pure functions over `package.json`'s `packageManager` field — no I/O.
 * Parses corepack's own pin shape and compares it against a version fetched
 * elsewhere (`scripts/check-package-manager-freshness.ts`). Rationale and
 * the measured state: docs/supply-chain.md.
 */

export interface PackageManagerPin {
  readonly name: string;
  readonly version: string;
}

export interface PackageManagerFreshness {
  readonly fresh: boolean;
  readonly pinned: string;
  readonly latest: string;
}

// corepack's own shape: "<name>@<version>" or "<name>@<version>+<hash-scheme>.<hash>".
const PIN_PATTERN = /^([^@]+)@([^+]+)/;

export function parsePackageManagerPin(packageManager: string | undefined): PackageManagerPin | null {
  if (!packageManager) return null;
  const match = PIN_PATTERN.exec(packageManager);
  if (!match) return null;
  return { name: (match[1] ?? '').trim(), version: (match[2] ?? '').trim() };
}

// Equality, not semver ordering: a registry's `latest` dist-tag is a mutable
// pointer a maintainer can move backward (to walk back a bad release), and a
// repo can deliberately pin ahead of it — either way, any difference from
// `latest` is worth a human look. Equality catches both directions; a
// `pinned < latest` ordering check would only catch one, and would need a
// semver dependency this check has no other reason to add.
export function checkPackageManagerFreshness(pinned: string, latest: string): PackageManagerFreshness {
  return { fresh: pinned === latest, pinned, latest };
}
