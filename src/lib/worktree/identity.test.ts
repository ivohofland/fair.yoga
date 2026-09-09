import { describe, it, expect } from 'vitest';
import { sanitizeSlug, dbNamesForSlug, resolveIdentity, isTestDatabaseName } from './identity';

describe('sanitizeSlug', () => {
  it('lowercases and replaces hyphens with underscores', () => {
    expect(sanitizeSlug('fix-512-Handoff-Timeout')).toBe('fix_512_handoff_timeout');
  });

  it('collapses runs of unsafe characters and trims leading/trailing underscores', () => {
    expect(sanitizeSlug('--weird..name!!')).toBe('weird_name');
  });

  it('truncates to a length that leaves room for the database prefix', () => {
    const long = 'a'.repeat(80);
    const result = sanitizeSlug(long);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it('throws when nothing safe is left', () => {
    expect(() => sanitizeSlug('!!!')).toThrow();
  });
});

describe('dbNamesForSlug', () => {
  it('prefixes the slug for both database families', () => {
    expect(dbNamesForSlug('fix_517')).toEqual({
      test: 'ethical_yoga_test_fix_517',
      dev: 'ethical_yoga_dev_fix_517',
    });
  });
});

describe('isTestDatabaseName', () => {
  it('accepts the shared convention', () => {
    expect(isTestDatabaseName('ethical_yoga_test')).toBe(true);
  });

  it('accepts the per-worktree convention', () => {
    expect(isTestDatabaseName('ethical_yoga_test_verify_517')).toBe(true);
  });

  it('rejects the plain dev database', () => {
    expect(isTestDatabaseName('ethical_yoga')).toBe(false);
  });

  it('rejects a name that merely contains test as a substring', () => {
    expect(isTestDatabaseName('ethical_yoga_testing')).toBe(false);
  });

  it('rejects a dev database whose worktree slug happens to contain "test"', () => {
    expect(isTestDatabaseName('ethical_yoga_dev_fix_test_flake')).toBe(false);
  });

  it('rejects a dev database name ending in _test_<slug>', () => {
    expect(isTestDatabaseName('ethical_yoga_dev_my_test_worktree')).toBe(false);
  });
});

describe('resolveIdentity', () => {
  it('is the main checkout when git-dir equals git-common-dir', () => {
    const result = resolveIdentity('/repo/.git', '/repo/.git');
    expect(result).toEqual({ isMainCheckout: true, slug: null, gitCommonDir: '/repo/.git' });
  });

  it('is a linked worktree when the dirs differ, slug is the git-dir basename', () => {
    const result = resolveIdentity('/repo/.git/worktrees/fix-517', '/repo/.git');
    expect(result).toEqual({
      isMainCheckout: false,
      slug: 'fix_517',
      gitCommonDir: '/repo/.git',
    });
  });

  it('ignores a trailing slash difference', () => {
    const result = resolveIdentity('/repo/.git/', '/repo/.git');
    expect(result.isMainCheckout).toBe(true);
  });
});
