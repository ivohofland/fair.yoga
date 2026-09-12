import { describe, expect, it, vi } from 'vitest';
import {
  findMigrationViolations,
  parseMigrationDiff,
  resolveBaseRef,
} from './migration-policy';

describe('parseMigrationDiff', () => {
  it('returns an empty list for empty diff output', () => {
    expect(parseMigrationDiff('')).toEqual([]);
    expect(parseMigrationDiff('\n  \n')).toEqual([]);
  });

  it('ignores added migrations (status A)', () => {
    const diff = [
      'A\tprisma/migrations/20260912120000_new_feature/migration.sql',
      'A\tprisma/migrations/20260912120000_new_feature/README.md',
    ].join('\n');

    expect(parseMigrationDiff(diff)).toEqual([]);
  });

  it('detects modified migrations (status M)', () => {
    const diff = 'M\tprisma/migrations/20260403092044_init/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'modified',
        status: 'M',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
    ]);
  });

  it('detects deleted migrations (status D)', () => {
    const diff = 'D\tprisma/migrations/20260403092044_init/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'deleted',
        status: 'D',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
    ]);
  });

  it('detects renamed migrations (status R with similarity score)', () => {
    const diff =
      'R100\tprisma/migrations/20260403092044_init/migration.sql\tprisma/migrations/20260403092044_init_renamed/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'renamed',
        status: 'R100',
        oldPath: 'prisma/migrations/20260403092044_init/migration.sql',
        path: 'prisma/migrations/20260403092044_init_renamed/migration.sql',
      },
    ]);
  });

  it('detects type changes (status T)', () => {
    const diff = 'T\tprisma/migrations/20260403092044_init/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'type-changed',
        status: 'T',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
    ]);
  });

  it('filters added files while capturing all violations in a mixed diff', () => {
    const diff = [
      'A\tprisma/migrations/20260912120000_new_feature/migration.sql',
      'M\tprisma/migrations/20260821120000_cross_family_slot_guard/migration.sql',
      'R095\tprisma/migrations/old/migration.sql\tprisma/migrations/new/migration.sql',
      'D\tprisma/migrations/deleted/migration.sql',
    ].join('\n');

    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'modified',
        status: 'M',
        path: 'prisma/migrations/20260821120000_cross_family_slot_guard/migration.sql',
      },
      {
        type: 'renamed',
        status: 'R095',
        oldPath: 'prisma/migrations/old/migration.sql',
        path: 'prisma/migrations/new/migration.sql',
      },
      {
        type: 'deleted',
        status: 'D',
        path: 'prisma/migrations/deleted/migration.sql',
      },
    ]);
  });
});

describe('resolveBaseRef', () => {
  it('resolves PR base ref via merge-base against origin/<baseBranch>', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        return 'abc123mergebase\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef({ GITHUB_BASE_REF: 'main' }, execGit);
    expect(ref).toBe('abc123mergebase');
    expect(execGit).toHaveBeenCalledWith('git merge-base origin/main HEAD');
  });

  it('falls back to local base branch when origin/<baseBranch> fails in PR', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        throw new Error('Not a valid object name origin/main');
      }
      if (cmd === 'git merge-base main HEAD') {
        return 'fallback_merge_base\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef({ GITHUB_BASE_REF: 'main' }, execGit);
    expect(ref).toBe('fallback_merge_base');
  });

  it('resolves push event before SHA if valid commit SHA', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --verify commit_before^{commit}') {
        return 'commit_before_resolved\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_BEFORE: 'commit_before',
      },
      execGit,
    );
    expect(ref).toBe('commit_before_resolved');
  });

  it('skips all-zero GITHUB_BEFORE on initial push and falls back', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        return 'main_merge_base\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef(
      {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_BEFORE: '0000000000000000000000000000000000000000',
      },
      execGit,
    );
    expect(ref).toBe('main_merge_base');
  });

  it('resolves local development merge-base against origin/main or main', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        return 'local_origin_main_base\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef({}, execGit);
    expect(ref).toBe('local_origin_main_base');
  });

  it('falls back to HEAD when no candidates resolve', () => {
    const execGit = vi.fn().mockImplementation(() => {
      throw new Error('Not found');
    });

    const ref = resolveBaseRef({}, execGit);
    expect(ref).toBe('HEAD');
  });
});

describe('findMigrationViolations', () => {
  it('invokes git diff with --diff-filter=a and parses violations', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.startsWith('git diff --name-status --diff-filter=a base123 --')) {
        return 'M\tprisma/migrations/20260403092044_init/migration.sql\n';
      }
      return '';
    });

    const violations = findMigrationViolations({
      baseRef: 'base123',
      execGit,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      type: 'modified',
      status: 'M',
      path: 'prisma/migrations/20260403092044_init/migration.sql',
    });
  });
});
