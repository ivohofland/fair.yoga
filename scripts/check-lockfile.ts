// scripts/check-lockfile.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findLockfileViolations, parsePackageResolutions } from '../src/lib/lockfile-policy';

const lockfilePath = path.resolve(process.cwd(), 'pnpm-lock.yaml');
const text = readFileSync(lockfilePath, 'utf8');
const entries = parsePackageResolutions(text);
const violations = findLockfileViolations(entries);

if (violations.length > 0) {
  console.error(`pnpm-lock.yaml fails supply-chain policy — ${violations.length} of ${entries.length} entries:`);
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.reason}`);
  }
  process.exit(1);
}

console.log(`✓ pnpm-lock.yaml passes supply-chain policy (${entries.length} entries checked)`);
