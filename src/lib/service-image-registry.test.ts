import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchLatestDigest, RegistryUnreachableError } from './service-image-registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(handler));
}

describe('fetchLatestDigest', () => {
  it('rejects when the auth token request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      throw new Error('manifest should not be fetched when the token request fails');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'auth token request responded 401',
    );
  });

  it('rejects when the auth response has no usable "token" field', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ nope: 'nope' }) });
      }
      throw new Error('manifest should not be fetched when no token is returned');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'auth response had no "token" field',
    );
  });

  it('rejects when the auth response has an empty-string "token" field', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: '' }) });
      }
      throw new Error('manifest should not be fetched when the token is empty');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'auth response had no "token" field',
    );
  });

  it('rejects when the manifest request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'manifest request responded 404',
    );
  });

  it('rejects when the manifest response has no docker-content-digest header', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      return Promise.resolve({ ok: true, headers: new Headers() });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toThrow(
      'manifest response had no docker-content-digest header',
    );
  });

  it("resolves with the digest, namespacing an unnamespaced image under library/ and sending the token as a bearer header", async () => {
    stubFetch((url, init) => {
      if (url.includes('auth.docker.io')) {
        expect(url).toBe(
          'https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/postgres:pull',
        );
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      expect(url).toBe('https://registry-1.docker.io/v2/library/postgres/manifests/16-alpine');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
      expect(init?.method).toBe('HEAD');
      expect((init?.headers as Record<string, string>).Accept).toContain(
        'application/vnd.docker.distribution.manifest.list.v2+json',
      );
      return Promise.resolve({ ok: true, headers: new Headers({ 'docker-content-digest': 'sha256:latest' }) });
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).resolves.toBe('sha256:latest');
  });

  it('uses a namespaced image string verbatim as the repository (no library/ prefix)', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        expect(url).toContain('repository:bitnami/postgres:pull');
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
      }
      expect(url).toBe('https://registry-1.docker.io/v2/bitnami/postgres/manifests/16-alpine');
      return Promise.resolve({ ok: true, headers: new Headers({ 'docker-content-digest': 'sha256:latest' }) });
    });
    await expect(fetchLatestDigest('bitnami/postgres', '16-alpine')).resolves.toBe('sha256:latest');
  });

  it('rejects with a RegistryUnreachableError when the auth token request responds non-OK', async () => {
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: false, status: 401 });
      }
      throw new Error('manifest should not be fetched when the token request fails');
    });
    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toBeInstanceOf(
      RegistryUnreachableError,
    );
  });

  it('wraps a raw fetch() rejection (e.g. a DNS failure) as a RegistryUnreachableError, preserving message and cause', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND auth.docker.io');
    stubFetch(() => Promise.reject(new TypeError('fetch failed', { cause })));

    const promise = fetchLatestDigest('postgres', '16-alpine');

    await expect(promise).rejects.toBeInstanceOf(RegistryUnreachableError);
    await expect(promise).rejects.toThrow('fetch failed');
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it('propagates a SyntaxError from a malformed auth response body unwrapped, not as a RegistryUnreachableError', async () => {
    const parseError = new SyntaxError('Unexpected token < in JSON at position 0');
    stubFetch((url) => {
      if (url.includes('auth.docker.io')) {
        return Promise.resolve({ ok: true, json: () => Promise.reject(parseError) });
      }
      throw new Error('manifest should not be fetched when the auth body fails to parse');
    });

    await expect(fetchLatestDigest('postgres', '16-alpine')).rejects.toBe(parseError);
  });
});
