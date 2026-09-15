import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkServiceImageFreshness, extractImageReferences, parseImagePin } from './service-image-freshness';

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

  // Tethered to the real artifacts, the way parsePackageManagerPin's test
  // reads package.json directly — if #603's digest pins are ever hand-edited
  // back to a floating tag, this fails immediately instead of the check
  // going quietly inert.
  it('parses every image: reference this repo currently ships under .github/workflows', () => {
    const dir = path.join(root, '.github/workflows');
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    const allPins = files.flatMap((file) =>
      extractImageReferences(readFileSync(path.join(dir, file), 'utf8')).map(parseImagePin),
    );
    expect(allPins.length).toBeGreaterThanOrEqual(4);
    for (const pin of allPins) {
      expect(pin).not.toBeNull();
      expect(pin?.image).toBe('postgres');
      expect(pin?.tag).toBe('16-alpine');
      expect(pin?.digest).toBe('sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685');
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
