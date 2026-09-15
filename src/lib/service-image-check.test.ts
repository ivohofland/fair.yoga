import { describe, expect, it, vi } from 'vitest';
import { checkGroups } from './service-image-check';

function pin(image: string, tag: string, digest: string, file: string) {
  return { image, tag, digest, file };
}

describe('checkGroups', () => {
  it('fetches the digest exactly once for a group with multiple pins sharing the same image:tag', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml'), pin('postgres', '16-alpine', 'sha256:aaa', 'b.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:aaa');

    await checkGroups(byImageTag, fetchDigest);

    expect(fetchDigest).toHaveBeenCalledTimes(1);
    expect(fetchDigest).toHaveBeenCalledWith('postgres', '16-alpine');
  });

  it('skips a group whose fetch rejects, without throwing, and counts it as skipped', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockRejectedValue(new Error('registry unreachable'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 1 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('registry unreachable'));
    logSpy.mockRestore();
  });

  it('reports anyStale when a fetched digest differs from a pin, and does not let a skipped group affect a sibling group', async () => {
    const staleGroup = [pin('postgres', '16-alpine', 'sha256:old', 'a.yml')];
    const unreachableGroup = [pin('redis', '7', 'sha256:bbb', 'b.yml')];
    const byImageTag = new Map([
      ['postgres:16-alpine', staleGroup],
      ['redis:7', unreachableGroup],
    ]);
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'postgres') return Promise.resolve('sha256:new');
      return Promise.reject(new Error('unreachable'));
    });

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 1 });
  });

  it('reports no stale groups and no skips when every pin matches the fetched digest', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:aaa');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 0 });
  });

  it('keeps checking groups after an earlier one is skipped — does not stop at the first unreachable group', async () => {
    const failingGroup = [pin('alpine', 'latest', 'sha256:aaa', 'a.yml')];
    const staleGroup = [pin('postgres', '16-alpine', 'sha256:old', 'b.yml')];
    const freshGroup = [pin('redis', '7', 'sha256:same', 'c.yml')];
    const byImageTag = new Map([
      ['alpine:latest', failingGroup],
      ['postgres:16-alpine', staleGroup],
      ['redis:7', freshGroup],
    ]);
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'alpine') return Promise.reject(new Error('unreachable'));
      if (image === 'postgres') return Promise.resolve('sha256:new');
      return Promise.resolve('sha256:same');
    });

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(fetchDigest).toHaveBeenCalledWith('postgres', '16-alpine');
    expect(fetchDigest).toHaveBeenCalledWith('redis', '7');
    expect(result).toEqual({ anyStale: true, skippedGroups: 1 });
  });

  it('visits every pin in a group, not just the first — a fresh pin does not stop the loop before a later stale one is seen', async () => {
    const group = [
      pin('postgres', '16-alpine', 'sha256:same', 'fresh.yml'),
      pin('postgres', '16-alpine', 'sha256:old', 'stale.yml'),
    ];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockResolvedValue('sha256:same');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 0 });
  });

  it('visits every pin in a group even in the opposite order — a stale pin does not stop the loop before a later fresh one is checked', async () => {
    const group = [
      pin('postgres', '16-alpine', 'sha256:old', 'stale.yml'),
      pin('postgres', '16-alpine', 'sha256:same', 'fresh.yml'),
    ];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchDigest = vi.fn().mockResolvedValue('sha256:same');

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: true, skippedGroups: 0 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('fresh.yml'));
    logSpy.mockRestore();
  });
});
