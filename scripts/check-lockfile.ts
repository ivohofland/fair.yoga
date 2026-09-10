// scripts/check-lockfile.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findLockfileViolations, parsePackageResolutions } from '../src/lib/lockfile-policy';

const lockfilePath = path.resolve(process.cwd(), 'pnpm-lock.yaml');
const text = readFileSync(lockfilePath, 'utf8');
const entries = parsePackageResolutions(text);

// A raw, parser-independent count. If pnpm ever changes the packages:
// section's format in a way parsePackageResolutions no longer reads, entries
// silently shrinks (or empties) while this line count does not — checked
// before the violations count below can report a vacuous "0 violations" pass.
const rawResolutionLines = text.split('\n').filter((line) => line.includes('resolution:')).length;
if (entries.length < rawResolutionLines) {
  console.error(
    `pnpm-lock.yaml parsed ${entries.length} entries but the file holds ${rawResolutionLines} "resolution:" lines — the parser has stopped reading this file's current format. Fix src/lib/lockfile-policy.ts's parser before trusting this check again.`,
  );
  process.exit(1);
}

const violations = findLockfileViolations(entries);

if (violations.length > 0) {
  console.error(`pnpm-lock.yaml fails supply-chain policy — ${violations.length} of ${entries.length} entries:`);
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.reason}`);
  }
  process.exit(1);
}

console.log(`✓ pnpm-lock.yaml passes supply-chain policy (${entries.length} entries checked)`);
