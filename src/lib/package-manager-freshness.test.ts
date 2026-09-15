import { describe, expect, it } from 'vitest';
import { checkPackageManagerFreshness, parsePackageManagerPin } from './package-manager-freshness';

describe('parsePackageManagerPin', () => {
  it('parses name and version out of a corepack-shaped pin with an integrity hash', () => {
    expect(parsePackageManagerPin('pnpm@12.3.4+sha512.961aa41fb077da3a04a441d9f8e15ebc0c96')).toEqual(
      { name: 'pnpm', version: '12.3.4' },
    );
  });

  it('parses a pin with no integrity hash', () => {
    expect(parsePackageManagerPin('pnpm@12.3.4')).toEqual({ name: 'pnpm', version: '12.3.4' });
  });

  it('returns null for an undefined pin', () => {
    expect(parsePackageManagerPin(undefined)).toBeNull();
  });

  it('returns null for a pin with no @ separator', () => {
    expect(parsePackageManagerPin('pnpm')).toBeNull();
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
