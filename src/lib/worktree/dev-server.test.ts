import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import * as fs from 'fs';
import { buildDevServerLogPath, spawnDevServer } from './dev-server';

vi.mock('fs');

describe('buildDevServerLogPath', () => {
  it('places the log at the worktree root', () => {
    expect(buildDevServerLogPath('/worktree')).toBe(path.join('/worktree', 'worktree-dev.log'));
  });
});

describe('spawnDevServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns next dev on the given port, detached, and returns its pid', () => {
    vi.mocked(fs.openSync).mockReturnValue(42 as never);
    vi.mocked(fs.closeSync).mockReturnValue(undefined);

    const unref = vi.fn();
    const fakeChild = { pid: 4242, unref };
    const spawnFn = vi.fn().mockReturnValue(fakeChild);

    const pid = spawnDevServer('/worktree', 3100, spawnFn as never);

    expect(pid).toBe(4242);
    expect(unref).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith(
      'npx',
      ['next', 'dev', '-p', '3100'],
      expect.objectContaining({ cwd: '/worktree', detached: true }),
    );
    expect(vi.mocked(fs.openSync)).toHaveBeenCalledWith(
      path.join('/worktree', 'worktree-dev.log'),
      'a',
    );
    expect(vi.mocked(fs.closeSync)).toHaveBeenCalledWith(42);
  });

  it('throws if the spawned process has no pid', () => {
    vi.mocked(fs.openSync).mockReturnValue(42 as never);
    vi.mocked(fs.closeSync).mockReturnValue(undefined);

    const spawnFn = vi.fn().mockReturnValue({ pid: undefined, unref: vi.fn() });
    expect(() => spawnDevServer('/worktree', 3100, spawnFn as never)).toThrow();
  });
});
