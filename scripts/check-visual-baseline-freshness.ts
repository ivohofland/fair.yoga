// scripts/check-visual-baseline-freshness.ts
import { readFileSync } from 'node:fs';
import {
  ROUTE_BASELINES,
  VISUAL_SPEC_PATH,
  ATTESTATION_PATH,
  ATTEST_COMMAND,
  findCoverageGaps,
  findStaleRoutes,
} from '../src/lib/visual-baseline-freshness';

try {
  const specSource = readFileSync(VISUAL_SPEC_PATH, 'utf8');
  const gaps = findCoverageGaps(specSource);

  let failed = false;

  if (gaps.missingFromMap.length > 0) {
    console.error(
      `\n❌ ${VISUAL_SPEC_PATH} has toHaveScreenshot() call(s) with no entry in ROUTE_BASELINES ` +
        `(src/lib/visual-baseline-freshness.ts): ${gaps.missingFromMap.join(', ')}`,
    );
    failed = true;
  }

  if (gaps.missingFromSpec.length > 0) {
    console.error(
      `\n❌ ROUTE_BASELINES (src/lib/visual-baseline-freshness.ts) names route(s) with no ` +
        `matching toHaveScreenshot() call in ${VISUAL_SPEC_PATH}: ${gaps.missingFromSpec.join(', ')}`,
    );
    failed = true;
  }

  if (gaps.unparseableCallCount > 0) {
    console.error(
      `\n❌ ${VISUAL_SPEC_PATH} has ${gaps.unparseableCallCount} toHaveScreenshot() call(s) whose ` +
        `name argument isn't a simple quoted string literal — findCoverageGaps cannot verify ` +
        `these have a matching ROUTE_BASELINES entry. Use a literal '<name>.png' argument.`,
    );
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  const stale = findStaleRoutes(ROUTE_BASELINES);

  if (stale.length > 0) {
    console.error(`\n❌ ${stale.length} visual baseline(s) are stale:`);
    for (const s of stale) {
      console.error(`  [${s.name}] ${s.detail}`);
    }
    console.error(
      `\nIf a route's regenerated screenshot comes back byte-identical to its old baseline ` +
        `(a non-visual source change), there is nothing new for git to commit. Record that ` +
        `instead: '${ATTEST_COMMAND}' reruns the visual suite, refuses if any baseline byte ` +
        `moved, and writes a content-hashed attestation this check will accept. Baselines are ` +
        `macOS-only, so run it on a macOS checkout and commit ${ATTESTATION_PATH}.`,
    );
    process.exit(1);
  }

  console.log('✓ Visual baselines are up to date with the routes they cover');
} catch (err) {
  console.error(
    `Failed to verify visual baseline freshness: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
