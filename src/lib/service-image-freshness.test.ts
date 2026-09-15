import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkServiceImageFreshness,
  countImageKeyLines,
  extractImageReferences,
  parseImagePin,
} from './service-image-freshness';

const root = process.cwd();

describe('extractImageReferences', () => {
  it('pulls the reference after each image: key', () => {
    const yaml = [
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    ports:',
      '      - 5432:5432',
    ].join('\n');
    expect(extractImageReferences(yaml)).toEqual(['postgres:16-alpine']);
  });

  it('finds every image: line, in document order', () => {
    const yaml = 'image: a:1\nsomething: else\nimage: b:2@sha256:' + 'a'.repeat(64);
    expect(extractImageReferences(yaml)).toEqual(['a:1', `b:2@sha256:${'a'.repeat(64)}`]);
  });

  it('returns an empty array when no image: key is present', () => {
    expect(extractImageReferences('name: CI\non: push\n')).toEqual([]);
  });

  it('ignores a key that merely ends in "image:" (e.g. "base_image:")', () => {
    expect(extractImageReferences('base_image: postgres:16-alpine\n')).toEqual([]);
  });

  it('strips a trailing YAML comment from the reference', () => {
    const yaml = '        image: postgres:16-alpine  # TODO pin\n';
    expect(extractImageReferences(yaml)).toEqual(['postgres:16-alpine']);
  });

  it('strips a trailing comment from a digest-pinned reference', () => {
    const digest = 'a'.repeat(64);
    const yaml = `        image: postgres:16-alpine@sha256:${digest}  # bumped\n`;
    expect(extractImageReferences(yaml)).toEqual([`postgres:16-alpine@sha256:${digest}`]);
  });

  it('strips surrounding quotes from a quoted reference', () => {
    const digest = 'a'.repeat(64);
    const yaml = `        image: "postgres:16-alpine@sha256:${digest}"\n`;
    expect(extractImageReferences(yaml)).toEqual([`postgres:16-alpine@sha256:${digest}`]);
  });

  it('strips surrounding single quotes from a quoted reference', () => {
    const digest = 'a'.repeat(64);
    const yaml = `        image: 'postgres:16-alpine@sha256:${digest}'\n`;
    expect(extractImageReferences(yaml)).toEqual([`postgres:16-alpine@sha256:${digest}`]);
  });
});

describe('countImageKeyLines', () => {
  it('counts each image: key line', () => {
    const yaml = 'image: a:1\nsomething: else\nimage: b:2\n';
    expect(countImageKeyLines(yaml)).toBe(2);
  });

  it('ignores a key that merely ends in "image:" (e.g. "base_image:")', () => {
    expect(countImageKeyLines('base_image: postgres:16-alpine\n')).toBe(0);
  });

  it('counts an image: key even when its value is on an indented continuation line', () => {
    const yaml = 'image:\n  postgres:16-alpine@sha256:' + 'a'.repeat(64) + '\n';
    expect(countImageKeyLines(yaml)).toBe(1);
  });
});

describe('parseImagePin', () => {
  it('parses an image, tag and digest out of a pinned reference', () => {
    const digest = 'cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685';
    expect(parseImagePin(`postgres:16-alpine@sha256:${digest}`)).toEqual({
      image: 'postgres',
      tag: '16-alpine',
      digest: `sha256:${digest}`,
    });
  });

  it('trims surrounding whitespace', () => {
    const digest = 'a'.repeat(64);
    expect(parseImagePin(` postgres:16-alpine@sha256:${digest} `)).toEqual({
      image: 'postgres',
      tag: '16-alpine',
      digest: `sha256:${digest}`,
    });
  });

  it('returns null for a floating tag with no digest', () => {
    expect(parseImagePin('postgres:16-alpine')).toBeNull();
  });

  it('returns null when the digest is not exactly 64 hex characters', () => {
    expect(parseImagePin('postgres:16-alpine@sha256:abc123')).toBeNull();
  });

  it('returns null for a reference with no tag', () => {
    expect(parseImagePin(`postgres@sha256:${'a'.repeat(64)}`)).toBeNull();
  });

  it('parses a namespaced image reference', () => {
    const digest = 'a'.repeat(64);
    expect(parseImagePin(`bitnami/postgres:16-alpine@sha256:${digest}`)).toEqual({
      image: 'bitnami/postgres',
      tag: '16-alpine',
      digest: `sha256:${digest}`,
    });
  });

  // Tethered to the real artifacts, the way parsePackageManagerPin's test
  // reads package.json directly — if #603's digest pins are ever hand-edited
  // back to a floating tag, this fails immediately instead of the check
  // going quietly inert. Ties the workflow pins to docker-compose.yml's own
  // pin rather than a hardcoded literal, so a legitimate digest bump moves
  // both together and docs/supply-chain.md's "same digest the compose files
  // already carry" claim is something this test actually verifies.
  it('parses every image: reference this repo currently ships under .github/workflows, all matching docker-compose.yml\'s pinned digest', () => {
    const dir = path.join(root, '.github/workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const allPins = files.flatMap((file) =>
      extractImageReferences(readFileSync(path.join(dir, file), 'utf8')).map(parseImagePin),
    );
    expect(allPins.length).toBeGreaterThanOrEqual(4);
    for (const pin of allPins) {
      expect(pin).not.toBeNull();
    }

    const composeContent = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const composePin = extractImageReferences(composeContent).map(parseImagePin).find((pin) => pin !== null);
    expect(composePin).not.toBeNull();

    for (const pin of allPins) {
      expect(pin?.digest).toBe(composePin?.digest);
    }
  });
});

describe('checkServiceImageFreshness', () => {
  it('reports fresh when the pinned digest matches the registry latest', () => {
    expect(checkServiceImageFreshness('sha256:abc', 'sha256:abc')).toEqual({
      fresh: true,
      pinned: 'sha256:abc',
      latest: 'sha256:abc',
    });
  });

  it('reports stale when the pinned digest differs from the registry latest', () => {
    expect(checkServiceImageFreshness('sha256:abc', 'sha256:def')).toEqual({
      fresh: false,
      pinned: 'sha256:abc',
      latest: 'sha256:def',
    });
  });
});
