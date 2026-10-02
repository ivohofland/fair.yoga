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
});
