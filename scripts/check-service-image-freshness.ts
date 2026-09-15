// scripts/check-service-image-freshness.ts
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  checkServiceImageFreshness,
  countImageKeyLines,
  extractImageReferences,
  groupByImageTag,
  parseImagePin,
  type ImagePin,
} from '../src/lib/service-image-freshness';

const WORKFLOWS_DIR = '.github/workflows';

interface LocatedPin extends ImagePin {
  readonly file: string;
}

interface LocatedUnparsed {
  readonly file: string;
  readonly reference: string;
}

interface CoverageGap {
  readonly file: string;
  readonly imageKeyLines: number;
  readonly referencesFound: number;
}

function scanWorkflows(
  root: string,
): { pins: LocatedPin[]; unparsed: LocatedUnparsed[]; coverageGaps: CoverageGap[] } {
  const dir = path.join(root, WORKFLOWS_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const pins: LocatedPin[] = [];
  const unparsed: LocatedUnparsed[] = [];
  const coverageGaps: CoverageGap[] = [];
  for (const file of files) {
    const contents = readFileSync(path.join(dir, file), 'utf8');
    const references = extractImageReferences(contents);
    const imageKeyLines = countImageKeyLines(contents);
    if (imageKeyLines !== references.length) {
      coverageGaps.push({ file, imageKeyLines, referencesFound: references.length });
    }
    for (const reference of references) {
      const pin = parseImagePin(reference);
      if (pin) {
        pins.push({ ...pin, file });
      } else {
        unparsed.push({ file, reference });
      }
    }
  }
  return { pins, unparsed, coverageGaps };
}

async function fetchLatestDigest(image: string, tag: string): Promise<string> {
  const repository = image.includes('/') ? image : `library/${image}`;
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!tokenRes.ok) throw new Error(`auth token request responded ${tokenRes.status}`);
  const tokenData: unknown = await tokenRes.json();
  const token = (tokenData as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error(`auth response had no "token" field: ${JSON.stringify(tokenData)}`);
  }

  const manifestRes = await fetch(`https://registry-1.docker.io/v2/${repository}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.index.v1+json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!manifestRes.ok) throw new Error(`manifest request responded ${manifestRes.status}`);
  const digest = manifestRes.headers.get('docker-content-digest');
  if (!digest) throw new Error('manifest response had no docker-content-digest header');
  return digest;
}

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

  let anyStale = false;
  let skippedGroups = 0;
  for (const [key, group] of byImageTag) {
    const { image, tag } = group[0]!;
    let latest: string;
    try {
      latest = await fetchLatestDigest(image, tag);
    } catch (err) {
      const cause = err instanceof Error && err.cause ? ` — ${String(err.cause)}` : '';
      skippedGroups++;
      console.log(
        `::warning::Could not reach the registry to check ${key}'s latest digest (${err instanceof Error ? err.message : String(err)}${cause}) — skipping.`,
      );
      continue;
    }

    for (const pin of group) {
      const result = checkServiceImageFreshness(pin.digest, latest);
      if (result.fresh) {
        console.log(`✓ ${pin.file}: ${key}@${pin.digest} matches the registry's latest.`);
      } else {
        anyStale = true;
        console.error(
          `${pin.file}: ${key} is pinned at ${result.pinned}; the registry's latest is ${result.latest}. ` +
            `Review whether to bump the digest (see docs/supply-chain.md, "The database image").`,
        );
      }
    }
  }

  if (skippedGroups === byImageTag.size) {
    console.log(`::warning::All ${skippedGroups} image group(s) were unreachable — this run verified nothing.`);
  }

  if (anyStale) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
