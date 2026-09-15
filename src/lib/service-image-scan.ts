/**
 * Scans `.github/workflows/` (`.yml`/`.yaml` files) for image: references and
 * classifies each into a digest-pinned pin, an unparseable reference, or a
 * coverage gap (an `image:` key line that yielded no reference at all — e.g.
 * an indented continuation line the parser can't see). Does real file I/O.
 * Throws if `<root>/.github/workflows` doesn't exist — callers that want a
 * softer failure must catch it themselves.
 * See docs/supply-chain.md ("The database image").
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  countImageKeyLines,
  extractImageReferences,
  parseImagePin,
  type ImagePin,
} from './service-image-freshness';

export const WORKFLOWS_DIR = '.github/workflows';

export interface LocatedPin extends ImagePin {
  readonly file: string;
}

export interface LocatedUnparsed {
  readonly file: string;
  readonly reference: string;
}

export interface CoverageGap {
  readonly file: string;
  readonly imageKeyLines: number;
  readonly referencesFound: number;
}

export function scanWorkflows(root: string): {
  pins: LocatedPin[];
  unparsed: LocatedUnparsed[];
  coverageGaps: CoverageGap[];
} {
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
