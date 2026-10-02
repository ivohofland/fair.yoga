import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPushPayload, type PushPayload } from './push-policy';

interface FakeWindow {
  url: string;
  focus: () => Promise<FakeWindow>;
  navigate: (u: string) => Promise<unknown>;
}

function loadWorker(clientsList: FakeWindow[]) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    registration: { showNotification: vi.fn<(title: string, options: unknown) => Promise<void>>(async () => {}) },
    clients: {
      matchAll: vi.fn<(options: unknown) => Promise<FakeWindow[]>>(async () => clientsList),
      openWindow: vi.fn(async () => null),
      claim: vi.fn<() => Promise<void>>(async () => {}),
    },
    location: { origin: 'https://fair.yoga' },
  };
  const source = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  new Function('self', source)(self);
  return { self, listeners };
}

/** An event whose `waitUntil` records the promise it was handed. */
function extendable() {
  const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
  return { waitUntil, done: () => waitUntil.mock.calls[0]![0] };
}

function pushEvent(payload: PushPayload) {
  return { ...extendable(), data: { json: () => payload } };
}

/** A promise the test settles itself. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** True when `p` has not settled after every queued microtask has run. */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([p.then(() => null, () => null), new Promise((r) => setTimeout(() => r(marker), 0))]);
  return winner === marker;
}

function fakeWindow(overrides: Partial<FakeWindow> = {}): FakeWindow {
  const w: FakeWindow = {
    url: 'https://fair.yoga/schedule',
    focus: vi.fn(async () => w),
    navigate: vi.fn(async () => w),
    ...overrides,
  };
  return w;
}

describe('public/sw.js', () => {
  it('registers no fetch listener', () => {
    expect(loadWorker([]).listeners.fetch).toBeUndefined();
  });

  it('shows the pushed title and body, tagged by notification id, and never sets a badge', async () => {
    const { self, listeners } = loadWorker([]);
    const payload = buildPushPayload({ id: 'n1', recipientType: 'student', type: 'spot_available', title: 'A spot opened up', body: 'Vinyasa' });
    const e = pushEvent(payload);
    listeners.push!(e);
    await e.done();
    expect(self.registration.showNotification).toHaveBeenCalledWith('A spot opened up', expect.objectContaining({ body: 'Vinyasa', tag: 'n1', data: { url: '/updates?n=n1' } }));
    expect(readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8')).not.toMatch(/AppBadge/);
  });

  it('keeps the push event alive until showNotification settles', async () => {
    const { self, listeners } = loadWorker([]);
    const shown = deferred<void>();
    self.registration.showNotification.mockReturnValueOnce(shown.promise);
    const e = pushEvent(buildPushPayload({ id: 'n1', recipientType: 'student', type: 'spot_available', title: 'T', body: 'B' }));
    listeners.push!(e);
    expect(e.waitUntil).toHaveBeenCalledTimes(1);
    expect(await isPending(e.done())).toBe(true);
    shown.resolve();
    await expect(e.done()).resolves.toBeUndefined();
  });

  it('logs a showNotification that rejects, rather than failing the event', async () => {
    const { self, listeners } = loadWorker([]);
    const failure = new Error('notifications blocked');
    self.registration.showNotification.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const e = pushEvent(buildPushPayload({ id: 'n1', recipientType: 'student', type: 'spot_available', title: 'T', body: 'B' }));
      listeners.push!(e);
      await expect(e.done()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^\[sw\] /), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([
    ['data that does not parse', { json: () => { throw new SyntaxError('Unexpected token'); } }],
    ['no data at all', null],
    ['no string title', { json: () => ({ id: 'n1', body: 'B', url: '/updates?n=n1' }) }],
  ])('shows a generic notification for a push with %s', async (_label, data) => {
    const { self, listeners } = loadWorker([]);
    const e = { ...extendable(), data };
    listeners.push!(e);
    await e.done();
    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(self.registration.showNotification).toHaveBeenCalledWith('fair.yoga', { body: 'You have a new update.', data: { url: '/' } });
  });

  it('focuses an open window, then navigates it, on tap', async () => {
    const order: string[] = [];
    const w = fakeWindow();
    w.focus = vi.fn(async () => { order.push('focus'); return w; });
    w.navigate = vi.fn(async () => { order.push('navigate'); return w; });
    const { self, listeners } = loadWorker([w]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n2' } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(order).toEqual(['focus', 'navigate']);
    expect(w.navigate).toHaveBeenCalledWith('/inbox?n=n2');
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('opens a window on tap when none is open', async () => {
    const { self, listeners } = loadWorker([]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n3' } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/inbox?n=n3');
  });

  it('keeps the click event alive until the open window has navigated', async () => {
    const navigated = deferred<FakeWindow>();
    const w = fakeWindow({ navigate: vi.fn(() => navigated.promise) });
    const { listeners } = loadWorker([w]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n6' } } };
    listeners.notificationclick!(e);
    expect(e.waitUntil).toHaveBeenCalledTimes(1);
    expect(await isPending(e.done())).toBe(true);
    navigated.resolve(w);
    await e.done();
    expect(w.navigate).toHaveBeenCalledWith('/inbox?n=n6');
  });

  it('opens a window at the url when the open window refuses to navigate', async () => {
    const w = fakeWindow({
      navigate: vi.fn(async () => {
        throw new TypeError('This service worker is not the client\'s active service worker.');
      }),
    });
    const { self, listeners } = loadWorker([w]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n5' } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(w.navigate).toHaveBeenCalledWith('/inbox?n=n5');
    expect(self.clients.openWindow).toHaveBeenCalledWith('/inbox?n=n5');
  });

  it('opens a window at the url when the open window refuses focus', async () => {
    const w = fakeWindow({
      focus: vi.fn(async () => {
        throw new Error('Not allowed to focus a window.');
      }),
    });
    const { self, listeners } = loadWorker([w]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n7' } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(w.navigate).not.toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/inbox?n=n7');
  });

  it('logs a click chain that fails outright, rather than failing the event', async () => {
    const { self, listeners } = loadWorker([]);
    const failure = new Error('matchAll refused');
    self.clients.matchAll.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n8' } } };
      listeners.notificationclick!(e);
      await expect(e.done()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/^\[sw\] /), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('takes control of open windows when it activates, and keeps the event alive for it', async () => {
    const { self, listeners } = loadWorker([]);
    const claimed = deferred<void>();
    self.clients.claim.mockReturnValueOnce(claimed.promise);
    const e = extendable();
    listeners.activate!(e);
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
    expect(e.waitUntil).toHaveBeenCalledTimes(1);
    expect(e.done()).toBe(claimed.promise);
  });

  it('redacts a cross-origin push url to the site root before showing the notification', async () => {
    const { self, listeners } = loadWorker([]);
    const e = pushEvent({ id: 'n4', title: 'Title', body: 'Body', url: 'https://evil.example/' } satisfies PushPayload);
    listeners.push!(e);
    await e.done();
    expect(self.registration.showNotification).toHaveBeenCalledWith('Title', expect.objectContaining({ data: { url: '/' } }));
  });

  it.each([
    'https://evil.example/',
    // WHATWG URL parsing treats a leading backslash as a path separator for
    // special schemes, so this looks like a same-origin absolute path but
    // resolves to a different host.
    '/\\evil.example',
    // Protocol-relative: no scheme, but still a different host.
    '//evil.example',
  ])('refuses %s as not a same-origin path', async (maliciousUrl) => {
    const { self, listeners } = loadWorker([]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: maliciousUrl } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(self.clients.openWindow).toHaveBeenCalledWith('/');
  });
});
