// scripts/check-service-image-freshness.ts
import { groupByImageTag } from '../src/lib/service-image-freshness';
import { fetchLatestDigest } from '../src/lib/service-image-registry';
import { checkGroups } from '../src/lib/service-image-check';
import { WORKFLOWS_DIR, scanWorkflows } from '../src/lib/service-image-scan';

async function main(): Promise<void> {
  const root = process.cwd();
  const { pins, unparsed, coverageGaps } = scanWorkflows(root);

  if (coverageGaps.length > 0) {
    for (const gap of coverageGaps) {
      console.error(
        `${gap.file}: found ${gap.imageKeyLines} "image:" key line(s) but extracted only ${gap.referencesFound} reference(s) — a shape extractImageReferences doesn't handle (e.g. an indented continuation line) may have hidden one. See docs/supply-chain.md ("The database image").`,
      );
    }
    process.exitCode = 1;
  }

  if (unparsed.length > 0) {
    // Present but unparseable is a real complaint, not "nothing to check" —
    // a floating tag reappearing in a services: block (or any shape this
    // pattern doesn't recognise) must not silently disable the check.
    for (const u of unparsed) {
      console.error(
        `${u.file}: "image: ${u.reference}" is not digest-pinned (expected "<image>:<tag>@sha256:<digest>"). ` +
          'See docs/supply-chain.md ("The database image") for why every service image reference here must be.',
      );
    }
    process.exitCode = 1;
  }

  if (pins.length === 0) {
    if (unparsed.length === 0) {
      console.log(`No service image references found under ${WORKFLOWS_DIR} — nothing to check.`);
    }
    return;
  }

  const byImageTag = groupByImageTag(pins);

  const { anyStale, skippedGroups } = await checkGroups(byImageTag, fetchLatestDigest);

  if (skippedGroups === byImageTag.size) {
    console.log(`::warning::All ${skippedGroups} image group(s) were unreachable — this run verified nothing.`);
  }

  if (anyStale) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`::error::Service image freshness check failed unexpectedly: ${String(err)}`);
  console.error(err);
  process.exit(1);
});
