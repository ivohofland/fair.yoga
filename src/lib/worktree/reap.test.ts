import { describe, it, expect, vi } from 'vitest';
import { reapOrphans } from './reap';
import type { Registry } from './registry';

describe('reapOrphans', () => {
  it('kills the pid, drops both databases, and removes the entry for each orphan', async () => {
    const registry: Registry = {
      fix_517: { port: 3100, pid: null },
      fix_520: { port: 3101, pid: 4242 },
    };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix_517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual(['fix_520']);
    expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null } });
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_fix_520');
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_fix_520');
    expect(dropDatabase).toHaveBeenCalledTimes(2);
  });

  it('does not call killPid for an orphan with no recorded pid', async () => {
    const registry: Registry = { fix_520: { port: 3101, pid: null } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    await reapOrphans(registry, new Set(), { dropDatabase, killPid });

    expect(killPid).not.toHaveBeenCalled();
  });

  it('leaves a registry with no orphans untouched', async () => {
    const registry: Registry = { fix_517: { port: 3100, pid: null } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix_517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual([]);
    expect(result.registry).toEqual(registry);
    expect(dropDatabase).not.toHaveBeenCalled();
  });

  it('does not let one orphan\'s failure prevent a later orphan in the same call from being reaped', async () => {
    const registry: Registry = {
      fix_517: { port: 3100, pid: null },
      fix_520: { port: 3101, pid: null },
    };
    const dropDatabase = vi.fn().mockImplementation((dbName: string) => {
      if (dbName.includes('fix_517')) {
        return Promise.reject(new Error('simulated drop failure'));
      }
      return Promise.resolve();
    });
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(), { dropDatabase, killPid });

    expect(result.reaped).toEqual(['fix_520']);
    expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null } });
  });
});
