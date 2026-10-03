import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyPushDevice, disablePush, enablePush, recordPushDeviceForSignIn, subscriptionUsesKey, syncPushSubscription, type PushDeviceEnv } from './push-client';

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
    [{ hasNotification: false }, 'unsupported'],
    [{ permission: 'denied' }, 'blocked'],
    [{ permission: 'granted', subscribed: true }, 'on'],
    [{ permission: 'granted', subscribed: false }, 'off'],
    [{ permission: 'default', subscribed: false }, 'off'],
    [{ permission: 'default', subscribed: true }, 'off'], // subscribed, but this origin may not show notifications
  ])('%o → %s', (overrides, expected) => {
    expect(classifyPushDevice({ ...capable, ...overrides })).toBe(expected);
  });
});

describe('enablePush', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  /** A registration whose push manager holds `existing` and subscribes to `created`. */
  function stubRegistration(options: {
    existing: PushSubscription | null;
    created?: PushSubscription;
    ready?: Promise<unknown>;
  }) {
    const subscribe = vi.fn(async () => options.created ?? fakeSubscription(null, 'https://push.example/created'));
    const register = vi.fn(async () => ({
      pushManager: { getSubscription: vi.fn(async () => options.existing), subscribe },
    }));
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('navigator', { serviceWorker: { register, ready: options.ready ?? Promise.resolve() } });
    return { register, subscribe };
  }

  it('resolves failed, not a rejection, when registration itself rejects', async () => {
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') });
    vi.stubGlobal('navigator', {
      serviceWorker: { register: vi.fn(async () => { throw new Error('registration refused'); }) },
    });

    await expect(enablePush('KEY')).resolves.toBe('failed');
  });

  it('resolves blocked, registering nothing, when permission is denied', async () => {
    const register = vi.fn();
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'denied') });
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    await expect(enablePush('KEY')).resolves.toBe('blocked');
    expect(register).not.toHaveBeenCalled();
  });

  it('resolves failed, registering nothing, when the prompt is dismissed', async () => {
    const register = vi.fn();
    vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'default') });
    vi.stubGlobal('navigator', { serviceWorker: { register } });

    await expect(enablePush('KEY')).resolves.toBe('failed');
    expect(register).not.toHaveBeenCalled();
  });

  it('resolves failed, logging it, when the service worker is not ready within 10s', async () => {
    vi.useFakeTimers();
    const { subscribe } = stubRegistration({ existing: null, ready: new Promise(() => {}) });
    vi.stubGlobal('fetch', vi.fn());

    const pending = enablePush(keyOf(4));
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('failed');
    expect(subscribe).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'ready' }));
  });

  it('POSTs an existing subscription made with this key, subscribing to nothing new', async () => {
    const existing = fakeSubscription(new Uint8Array(65).fill(4).buffer, 'https://push.example/existing');
    const { subscribe } = stubRegistration({ existing });
    const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush(keyOf(4))).resolves.toBe('on');
    expect(subscribe).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).endpoint).toBe('https://push.example/existing');
  });

  it('replaces an existing subscription made with another key', async () => {
    const existing = fakeSubscription(new Uint8Array(65).fill(5).buffer, 'https://push.example/stale');
    const fresh = fakeSubscription(new Uint8Array(65).fill(4).buffer, 'https://push.example/fresh');
    const { subscribe } = stubRegistration({ existing, created: fresh });
    const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush(keyOf(4))).resolves.toBe('on');
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(vi.mocked(existing.unsubscribe).mock.invocationCallOrder[0]).toBeLessThan(subscribe.mock.invocationCallOrder[0]!);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).endpoint).toBe('https://push.example/fresh');
  });

  it('leaves a subscription that already existed in place when the server refuses it', async () => {
    const existing = fakeSubscription(new Uint8Array(65).fill(4).buffer, 'https://push.example/existing');
    stubRegistration({ existing });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    await expect(enablePush(keyOf(4))).resolves.toBe('failed');
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribes and POSTs for an existing subscription whose key comparison is unknown, resolving on', async () => {
    const existing = fakeSubscription(null, 'https://push.example/existing');
    const sameEndpoint = fakeSubscription(null, 'https://push.example/existing');
    const { subscribe } = stubRegistration({ existing, created: sameEndpoint });
    const fetchMock = vi.fn<(url: string, init: { body: string }) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enablePush(keyOf(4))).resolves.toBe('on');
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).endpoint).toBe('https://push.example/existing');
  });

  it('does not unsubscribe when a key comparison of unknown leads subscribe back to the pre-existing endpoint and the server refuses it', async () => {
    const existing = fakeSubscription(null, 'https://push.example/existing');
    const sameEndpoint = fakeSubscription(null, 'https://push.example/existing');
    stubRegistration({ existing, created: sameEndpoint });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    await expect(enablePush(keyOf(4))).resolves.toBe('failed');
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(sameEndpoint.unsubscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes a subscription it made when the server never recorded it', async () => {
    const created = fakeSubscription(null, 'https://push.example/abc');
    stubRegistration({ existing: null, created });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    await expect(enablePush('KEY')).resolves.toBe('failed');
    expect(created.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('POSTs exactly { endpoint, keys: { p256dh, auth } } and resolves on, on success', async () => {
    stubRegistration({ existing: null, created: fakeSubscription(null, 'https://push.example/abc') });
    const fetchMock = vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(
      async () => ({ ok: true }),
    );
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

describe('disablePush', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  /** `navigator.serviceWorker.getRegistration` answering a registration that holds `subscription`. */
  function stubCurrent(subscription: PushSubscription | null) {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => subscription) } })),
      },
    });
  }

  it('DELETEs { endpoint } and then unsubscribes the browser, resolving off', async () => {
    const subscription = fakeSubscription(null, 'https://push.example/abc');
    stubCurrent(subscription);
    const fetchMock = vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(
      async () => ({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(disablePush()).resolves.toBe('off');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/push/subscriptions');
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://push.example/abc' });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(subscription.unsubscribe).mock.invocationCallOrder[0]!);
  });

  it('still unsubscribes the browser when the DELETE rejects', async () => {
    const subscription = fakeSubscription(null);
    stubCurrent(subscription);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));

    await expect(disablePush()).resolves.toBe('off');
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'delete' }));
  });

  it('logs a DELETE the server refused, and still unsubscribes', async () => {
    const subscription = fakeSubscription(null);
    stubCurrent(subscription);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));

    await expect(disablePush()).resolves.toBe('off');
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'delete', status: 503 }));
  });

  it('resolves failed when unsubscribe throws', async () => {
    const subscription = fakeSubscription(null);
    vi.mocked(subscription.unsubscribe).mockRejectedValue(new Error('unsubscribe refused'));
    stubCurrent(subscription);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await expect(disablePush()).resolves.toBe('failed');
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'unsubscribe' }));
  });

  it('resolves failed when unsubscribe resolves false', async () => {
    const subscription = fakeSubscription(null);
    vi.mocked(subscription.unsubscribe).mockResolvedValue(false);
    stubCurrent(subscription);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await expect(disablePush()).resolves.toBe('failed');
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'unsubscribe' }));
  });

  it('makes no request and resolves off when there is no subscription', async () => {
    stubCurrent(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(disablePush()).resolves.toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves failed, not a rejection, when getRegistration rejects', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => { throw new Error('no registration'); }) },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(disablePush()).resolves.toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'read' }));
  });
});

/** A stand-in browser subscription; only the members these helpers read. */
function fakeSubscription(
  applicationServerKey: ArrayBuffer | null,
  endpoint = 'https://push.example/abc',
): PushSubscription & { unsubscribe: ReturnType<typeof vi.fn<() => Promise<boolean>>> } {
  return {
    endpoint,
    options: { applicationServerKey, userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription & { unsubscribe: ReturnType<typeof vi.fn<() => Promise<boolean>>> };
}

/** A 65-byte key filled with `fill`, as base64url — the form the server hands the control. */
function keyOf(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(65).fill(fill))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('syncPushSubscription', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it('POSTs the same body enablePush sends and resolves ok when the server accepts it', async () => {
    const fetchMock = vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(
      async () => ({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(syncPushSubscription(fakeSubscription(null))).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/push/subscriptions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('resolves not ok with no status, not a rejection, when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(syncPushSubscription(fakeSubscription(null))).resolves.toEqual({ ok: false, status: null });
  });

  it('resolves not ok with the status, and logs it, for a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(syncPushSubscription(fakeSubscription(null))).resolves.toEqual({ ok: false, status: 500 });
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'sync', status: 500 }));
  });
});

describe('subscriptionUsesKey', () => {
  const key = keyOf(4);

  it('is a match when the subscription was made with this key', () => {
    expect(subscriptionUsesKey(fakeSubscription(new Uint8Array(65).fill(4).buffer), key)).toBe('match');
  });

  it('is a mismatch for a subscription made with another key', () => {
    expect(subscriptionUsesKey(fakeSubscription(new Uint8Array(65).fill(5).buffer), key)).toBe('mismatch');
  });

  it('is unknown for a subscription that reports no key', () => {
    expect(subscriptionUsesKey(fakeSubscription(null), key)).toBe('unknown');
  });
});

describe('recordPushDeviceForSignIn', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  /** A browser with push: `permission` is what `Notification` reports, `subscription` what the registration holds. */
  function stubBrowser(permission: NotificationPermission, subscription: PushSubscription | null) {
    const getRegistration = vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => subscription) } }));
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration } });
    vi.stubGlobal('Notification', { permission });
    return getRegistration;
  }

  it('POSTs the existing subscription for the account that just signed in', async () => {
    stubBrowser('granted', fakeSubscription(null, 'https://push.example/abc'));
    const fetchMock = vi.fn<(url: string, init: { method: string; body: string }) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await recordPushDeviceForSignIn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/push/subscriptions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it.each<NotificationPermission>(['default', 'denied'])('makes no request and reads no registration when permission is %s', async (permission) => {
    const getRegistration = stubBrowser(permission, fakeSubscription(null));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await recordPushDeviceForSignIn();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it('makes no request when permission is granted but there is no subscription', async () => {
    stubBrowser('granted', null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await recordPushDeviceForSignIn();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no request, and does not throw, in a browser without Notification', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn() } });
    vi.stubGlobal('Notification', undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(recordPushDeviceForSignIn()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never prompts for permission and never subscribes', async () => {
    const subscribe = vi.fn();
    const requestPermission = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => null), subscribe } })) },
    });
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission });
    vi.stubGlobal('fetch', vi.fn());

    await recordPushDeviceForSignIn();

    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('resolves, logging it, when reading the registration throws', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: vi.fn(async () => { throw new Error('no registration'); }) } });
    vi.stubGlobal('Notification', { permission: 'granted' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(recordPushDeviceForSignIn()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('[push-client] request failed', expect.objectContaining({ step: 'read' }));
  });

  it('resolves when the server refuses the subscription', async () => {
    stubBrowser('granted', fakeSubscription(null));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })));

    await expect(recordPushDeviceForSignIn()).resolves.toBeUndefined();
  });
});
