// scripts/check-lockfile.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIN_EXPECTED_LOCKFILE_ENTRIES,
  checkParserCoverage,
  findLockfileViolations,
  parsePackageResolutions,
} from '../src/lib/lockfile-policy';

const lockfilePath = path.resolve(process.cwd(), 'pnpm-lock.yaml');

let text: string;
try {
  text = readFileSync(lockfilePath, 'utf8');
} catch (err) {
  console.error(
    `Could not read pnpm-lock.yaml at ${lockfilePath}: ${err instanceof Error ? err.message : String(err)}. Run this from the repo root after a successful \`pnpm install\`.`,
  );
  process.exit(1);
}

const entries = parsePackageResolutions(text);

// A raw, parser-independent tripwire. If pnpm ever changes the packages:
// section's format in a way parsePackageResolutions no longer reads, entries
// silently shrinks (or empties) while the raw count does not — and if the
// lockfile itself is empty, truncated, or missing its packages: section,
// entries and the raw count could otherwise agree at zero and report a
// vacuous pass. Both are checked here, before the violations count below can
// report "0 violations".
const coverage = checkParserCoverage(text, entries);
if (!coverage.ok) {
  if (coverage.parsedEntries < coverage.rawResolutionLines) {
    console.error(
      `pnpm-lock.yaml parsed ${coverage.parsedEntries} entries but the file holds ${coverage.rawResolutionLines} "resolution:" lines — the parser has stopped reading this file's current format. Fix src/lib/lockfile-policy.ts's parser before trusting this check again.`,
    );
  } else {
    console.error(
      `pnpm-lock.yaml parsed only ${coverage.parsedEntries} package entries, below the expected minimum of ${MIN_EXPECTED_LOCKFILE_ENTRIES}. This repo's dependency tree never legitimately resolves to that few packages — treat this as a checker/lockfile failure (empty file, wrong path, or no "packages:" section), not a clean install. Refusing to report a pass.`,
    );
  }
  process.exit(1);
}

const violations = findLockfileViolations(entries);

if (violations.length > 0) {
  console.error(
    `pnpm-lock.yaml fails supply-chain policy — ${violations.length} of ${entries.length} entries:`,
  );
  for (const violation of violations) {
    console.error(`  ${violation.key}: ${violation.reason}`);
  }
  console.error(
    'See docs/supply-chain.md for what this policy checks and how to remediate a violation.',
  );
  process.exit(1);
}

console.log(`✓ pnpm-lock.yaml passes supply-chain policy (${entries.length} entries checked)`);
