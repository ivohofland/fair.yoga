export interface PackageManagerPin {
  name: string;
  version: string;
}

export interface PackageManagerFreshness {
  fresh: boolean;
  pinned: string;
  latest: string;
}

// corepack's own shape: "<name>@<version>" or "<name>@<version>+<hash-scheme>.<hash>".
const PIN_PATTERN = /^([^@]+)@([^+]+)/;

export function parsePackageManagerPin(packageManager: string | undefined): PackageManagerPin | null {
  if (!packageManager) return null;
  const match = PIN_PATTERN.exec(packageManager);
  if (!match) return null;
  return { name: match[1] ?? '', version: match[2] ?? '' };
}

// The registry's `latest` dist-tag never points at an older release than
// what's already pinned, so equality is enough — no semver ordering needed.
export function checkPackageManagerFreshness(pinned: string, latest: string): PackageManagerFreshness {
  return { fresh: pinned === latest, pinned, latest };
}
