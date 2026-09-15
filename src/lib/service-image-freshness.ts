/**
 * Pure functions over a Docker image reference — no I/O. Parses the
 * `<image>:<tag>@sha256:<digest>` shape this repo pins service-container
 * images to, and compares a pinned digest against one fetched elsewhere
 * (`scripts/check-service-image-freshness.ts`). Rationale and the measured
 * state: docs/supply-chain.md ("The database image").
 */

export interface ImagePin {
  readonly image: string;
  readonly tag: string;
  readonly digest: string;
}

export interface ServiceImageFreshness {
  readonly fresh: boolean;
  readonly pinned: string;
  readonly latest: string;
}

// Any line whose trimmed key is exactly "image" — not a suffix like
// "base_image:" — followed by the reference, up to end of line. A trailing
// YAML comment or surrounding quotes are stripped in extractImageReferences.
const IMAGE_LINE_PATTERN = /^[ \t]*image:[ \t]+(.+?)[ \t]*$/gm;

// YAML comments require preceding whitespace, and an image reference never
// contains a literal "#", so this split is unambiguous for this file's use.
const TRAILING_COMMENT_PATTERN = /\s+#.*$/;
const QUOTED_PATTERN = /^(['"])(.*)\1$/;

// "<image>:<tag>@sha256:<64 hex>" — the shape docker-compose*.yml already
// pins to, and the shape #603 asks the GitHub Actions services: blocks to
// match.
const IMAGE_PIN_PATTERN = /^([^:@\s]+):([^@\s]+)@sha256:([0-9a-f]{64})$/;

export function extractImageReferences(yamlContent: string): string[] {
  return [...yamlContent.matchAll(IMAGE_LINE_PATTERN)]
    .map((match) => stripCommentAndQuotes(match[1] ?? ''))
    .filter((ref) => ref !== '');
}

function stripCommentAndQuotes(raw: string): string {
  const withoutComment = raw.replace(TRAILING_COMMENT_PATTERN, '').trim();
  const quoted = QUOTED_PATTERN.exec(withoutComment);
  return quoted ? (quoted[2] ?? '') : withoutComment;
}

export function parseImagePin(reference: string): ImagePin | null {
  const match = IMAGE_PIN_PATTERN.exec(reference.trim());
  if (!match) return null;
  const [, image, tag, digest] = match;
  if (!image || !tag || !digest) return null;
  return { image, tag, digest: `sha256:${digest}` };
}

// Equality, not "does the tag still resolve here": a registry digest behind
// a floating tag can move either direction (a bad release walked back, or a
// deliberate pin ahead of latest), so any difference is worth a human look —
// same reasoning checkPackageManagerFreshness gives for the pnpm pin.
export function checkServiceImageFreshness(pinnedDigest: string, latestDigest: string): ServiceImageFreshness {
  return { fresh: pinnedDigest === latestDigest, pinned: pinnedDigest, latest: latestDigest };
}
