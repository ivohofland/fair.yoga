import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkGroups } from './service-image-check';
import { fetchLatestDigest, RegistryUnreachableError } from './service-image-registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('skips a group whose fetch rejects with a RegistryUnreachableError, without throwing, and counts it as skipped', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi.fn().mockRejectedValue(RegistryUnreachableError.of('registry unreachable'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await checkGroups(byImageTag, fetchDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 1 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('::warning::'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('registry unreachable'));
    logSpy.mockRestore();
  });

  it('propagates a rejection that is not a RegistryUnreachableError, rather than treating it as skippable', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const unexpected = new SyntaxError('Unexpected token < in JSON at position 0');
    const fetchDigest = vi.fn().mockRejectedValue(unexpected);

    await expect(checkGroups(byImageTag, fetchDigest)).rejects.toBe(unexpected);
  });

  it('stops processing further groups once an unexpected error propagates, rather than continuing past it', async () => {
    const failingGroup = [pin('alpine', 'latest', 'sha256:aaa', 'a.yml')];
    const neverGroup = [pin('redis', '7', 'sha256:same', 'b.yml')];
    const byImageTag = new Map([
      ['alpine:latest', failingGroup],
      ['redis:7', neverGroup],
    ]);
    const unexpected = new SyntaxError('Unexpected token < in JSON at position 0');
    const fetchDigest = vi.fn((image: string) => {
      if (image === 'alpine') return Promise.reject(unexpected);
      return Promise.resolve('sha256:same');
    });

    await expect(checkGroups(byImageTag, fetchDigest)).rejects.toBe(unexpected);
    expect(fetchDigest).not.toHaveBeenCalledWith('redis', '7');
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
      return Promise.reject(RegistryUnreachableError.of('unreachable'));
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
      if (image === 'alpine') return Promise.reject(RegistryUnreachableError.of('unreachable'));
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

  it('includes the cause in the warning log line when the RegistryUnreachableError carries one', async () => {
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);
    const fetchDigest = vi
      .fn()
      .mockRejectedValue(RegistryUnreachableError.wrap(new TypeError('fetch failed', { cause: new Error('ECONNRESET') })));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await checkGroups(byImageTag, fetchDigest);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
    logSpy.mockRestore();
  });

  it('composes with the real fetchLatestDigest: a stubbed non-OK auth response is skipped, not thrown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false, status: 401 } as Response)),
    );
    const group = [pin('postgres', '16-alpine', 'sha256:aaa', 'a.yml')];
    const byImageTag = new Map([['postgres:16-alpine', group]]);

    const result = await checkGroups(byImageTag, fetchLatestDigest);

    expect(result).toEqual({ anyStale: false, skippedGroups: 1 });
  });
});
