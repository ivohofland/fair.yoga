import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyPushDevice, enablePush, type PushDeviceEnv } from './push-client';

const capable: PushDeviceEnv = {
  vapidConfigured: true, install: 'installed', hasServiceWorker: true, hasPushManager: true,
  hasNotification: true, permission: 'default', subscribed: false,
};

describe('classifyPushDevice', () => {
  it.each<[Partial<PushDeviceEnv>, string]>([
    [{ vapidConfigured: false }, 'unavailable'],
    [{ install: 'ios-safari', hasPushManager: false }, 'needs-install'],
    [{ install: 'prompt' }, 'needs-install'], // Android Chrome in a tab
    [{ install: 'manual' }, 'needs-install'], // desktop browser
    [{ install: 'unsupported' }, 'needs-install'],
    [{ install: 'unknown' }, 'needs-install'],
    [{ hasPushManager: false }, 'unsupported'],
    [{ hasServiceWorker: false }, 'unsupported'],
    [{ permission: 'denied' }, 'blocked'],
    [{ permission: 'granted', subscribed: true }, 'on'],
    [{ permission: 'granted', subscribed: false }, 'off'],
    [{ permission: 'default', subscribed: false }, 'off'],
  ])('%o → %s', (overrides, expected) => {
    expect(classifyPushDevice({ ...capable, ...overrides })).toBe(expected);
  });
});

describe('enablePush', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves failed, not a rejection, when registration itself rejects', async () => {
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('navigator', {
      serviceWorker: { register: vi.fn(async () => { throw new Error('registration refused'); }) },
    });

    await expect(enablePush('KEY')).resolves.toBe('failed');
  });

  it('unsubscribes a browser subscription the server never recorded', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe,
    };
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => null),
            subscribe: vi.fn(async () => subscription),
          },
        })),
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    await expect(enablePush('KEY')).resolves.toBe('failed');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('POSTs exactly { endpoint, keys: { p256dh, auth } } and resolves on, on success', async () => {
    const subscription = {
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(async () => true),
    };
    const fetchMock = vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(
      async () => ({ ok: true }),
    );
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => null),
            subscribe: vi.fn(async () => subscription),
          },
        })),
        ready: Promise.resolve(),
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush('KEY')).resolves.toBe('on');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/push/subscriptions');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['endpoint', 'keys']);
    expect(body).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  });
});
