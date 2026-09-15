import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPackageManagerFreshness, parsePackageManagerPin } from './package-manager-freshness';

const root = process.cwd();

describe('parsePackageManagerPin', () => {
  it('parses name and version out of a corepack-shaped pin with an integrity hash', () => {
    expect(parsePackageManagerPin('pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96')).toEqual(
      { name: 'pnpm', version: '12.3.4' },
    );
  });

  it('parses a pin with no integrity hash', () => {
    expect(parsePackageManagerPin('pnpm@12.3.4')).toEqual({ name: 'pnpm', version: '12.3.4' });
  });

  it('trims surrounding whitespace from name and version', () => {
    expect(parsePackageManagerPin(' pnpm@12.3.4 ')).toEqual({ name: 'pnpm', version: '12.3.4' });
  });

  it('returns null for an undefined pin', () => {
    expect(parsePackageManagerPin(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parsePackageManagerPin('')).toBeNull();
  });

  it('returns null for a pin with no @ separator', () => {
    expect(parsePackageManagerPin('pnpm')).toBeNull();
  });

  it('returns null for a pin missing its version (nothing after +)', () => {
    expect(parsePackageManagerPin('pnpm@+sha512.abc')).toBeNull();
  });

  // Tethered to the real artifact, the way pnpm-policy.test.ts reads
  // pnpm-workspace.yaml directly — if corepack's field format ever changes
  // shape, this fails immediately instead of the check going quietly inert.
  it('parses this repo\'s own packageManager pin', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    const pin = parsePackageManagerPin(manifest.packageManager);
    expect(pin).not.toBeNull();
    expect(pin?.name).toBe('pnpm');
    expect(pin?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('checkPackageManagerFreshness', () => {
  it('reports fresh when the pinned version matches the registry latest', () => {
    expect(checkPackageManagerFreshness('12.3.4', '12.3.4')).toEqual({
      fresh: true,
      pinned: '12.3.4',
      latest: '12.3.4',
    });
  });

  it('reports stale when the pinned version differs from the registry latest', () => {
    expect(checkPackageManagerFreshness('12.3.4', '12.4.1')).toEqual({
      fresh: false,
      pinned: '12.3.4',
      latest: '12.4.1',
    });
  });
});
