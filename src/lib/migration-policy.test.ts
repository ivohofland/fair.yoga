import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('surfaces unrecognized statuses as unknown violations', () => {
    const diff = 'U\tprisma/migrations/20260403092044_init/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'unknown',
        status: 'U',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
    ]);
  });

  it('treats a rename line missing its destination path as unknown', () => {
    const diff = 'R100\tprisma/migrations/20260403092044_init/migration.sql';
    expect(parseMigrationDiff(diff)).toEqual([
      {
        type: 'unknown',
        status: 'R100',
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

  it('resolves GITHUB_BEFORE on push events when it is a valid commit SHA', () => {
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

  it('resolves base commit from GITHUB_EVENT_PATH on push events when GITHUB_BEFORE is not explicitly set', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'event-test-'));
    const eventFile = join(tmpDir, 'event.json');
    writeFileSync(eventFile, JSON.stringify({ before: 'payload_before_sha' }));

    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git rev-parse --verify payload_before_sha^{commit}') {
        return 'payload_before_resolved\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    try {
      const ref = resolveBaseRef(
        {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_EVENT_PATH: eventFile,
        },
        execGit,
      );
      expect(ref).toBe('payload_before_resolved');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('treats an all-zero GITHUB_BEFORE on an initial push as unresolvable', () => {
    // rev-parse resolves to a value, so if the /^0+$/ guard is ever removed
    // the zeros SHA is "successfully" resolved and the assertion below fails.
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.startsWith('git rev-parse')) {
        return 'zero_before_resolved\n';
      }
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
    expect(ref).toBe('HEAD');
    expect(execGit).not.toHaveBeenCalledWith(expect.stringContaining('rev-parse'));
    expect(execGit).not.toHaveBeenCalledWith(expect.stringContaining('merge-base'));
  });

  it('returns HEAD and skips merge-base when GITHUB_BEFORE cannot resolve on a push', () => {
    // After a push origin/main points at HEAD itself, so a merge-base fallback
    // would silently compare HEAD to HEAD; the push branch must never consult it.
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.startsWith('git rev-parse')) {
        throw new Error('unreachable commit');
      }
      if (cmd === 'git merge-base origin/main HEAD') {
        return 'HEAD_sha\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef(
      { GITHUB_EVENT_NAME: 'push', GITHUB_BEFORE: 'abc123def' },
      execGit,
    );
    expect(ref).toBe('HEAD');
    expect(execGit).not.toHaveBeenCalledWith(expect.stringContaining('merge-base'));
  });

  it('resolves local development merge-base against origin/main', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        return 'local_origin_main_base\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const ref = resolveBaseRef({}, execGit);
    expect(ref).toBe('local_origin_main_base');
  });

  it('falls back to the local main branch when origin/main is missing locally', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git merge-base origin/main HEAD') {
        throw new Error('Not a valid object name origin/main');
      }
      if (cmd === 'git merge-base main HEAD') {
        return 'local_main_base\n';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    expect(resolveBaseRef({}, execGit)).toBe('local_main_base');
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
  it('invokes git diff scoped to prisma/migrations and parses violations', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git diff --name-status base123 -- prisma/migrations/') {
        return 'M\tprisma/migrations/20260403092044_init/migration.sql\n';
      }
      return '';
    });

    const violations = findMigrationViolations({ env: {}, baseRef: 'base123', execGit });

    expect(execGit).toHaveBeenCalledWith(
      'git diff --name-status base123 -- prisma/migrations/',
    );
    expect(violations).toEqual([
      {
        type: 'modified',
        status: 'M',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
    ]);
  });

  it('ignores changes to non-migration files under prisma/migrations', () => {
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd === 'git diff --name-status base123 -- prisma/migrations/') {
        return [
          'M\tprisma/migrations/migration_lock.toml',
          'M\tprisma/migrations/20260403092044_init/README.md',
          'M\tprisma/migrations/20260403092044_init/migration.sql',
          'D\tprisma/migrations/20260403092044_init/migration.sql',
          'R100\tprisma/migrations/old/README.md\tprisma/migrations/new/README.md',
          'R100\tprisma/migrations/20260403092044_init/migration.sql\tprisma/migrations/20260403092044_init/schema.txt',
        ].join('\n');
      }
      return '';
    });

    expect(findMigrationViolations({ env: {}, baseRef: 'base123', execGit })).toEqual([
      {
        type: 'modified',
        status: 'M',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
      {
        type: 'deleted',
        status: 'D',
        path: 'prisma/migrations/20260403092044_init/migration.sql',
      },
      {
        type: 'renamed',
        status: 'R100',
        oldPath: 'prisma/migrations/20260403092044_init/migration.sql',
        path: 'prisma/migrations/20260403092044_init/schema.txt',
      },
    ]);
  });

  it('fails closed when base resolution degrades to HEAD under CI env vars', () => {
    const execGit = vi.fn().mockImplementation(() => {
      throw new Error('no refs available');
    });

    expect(() =>
      findMigrationViolations({
        env: { GITHUB_BASE_REF: 'main', GITHUB_EVENT_NAME: 'pull_request' },
        execGit,
      }),
    ).toThrow(/refusing to pass/);
  });

  it('fails closed on a push event whose GITHUB_BEFORE cannot be resolved', () => {
    // Push events resolve a base only from GITHUB_BEFORE. This test pins the
    // fail-closed path for a degraded push resolution (no GITHUB_BASE_REF).
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge-base') || cmd.startsWith('git rev-parse')) {
        throw new Error('unreachable before');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    expect(() =>
      findMigrationViolations({ env: { GITHUB_EVENT_NAME: 'push' }, execGit }),
    ).toThrow(/refusing to pass/);
  });

  it('compares against HEAD when no base resolves outside CI', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const execGit = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.startsWith('git merge-base') || cmd.startsWith('git rev-parse')) {
        throw new Error('missing refs');
      }
      if (cmd === 'git diff --name-status HEAD -- prisma/migrations/') {
        return '';
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    try {
      const violations = findMigrationViolations({ env: {}, execGit });

      expect(execGit).toHaveBeenCalledWith(
        'git diff --name-status HEAD -- prisma/migrations/',
      );
      expect(warn).toHaveBeenCalled();
      expect(violations).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
