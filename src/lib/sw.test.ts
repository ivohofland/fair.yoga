import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildPushPayload, type PushPayload } from './push-policy';

interface FakeWindow {
  url: string;
  focus: () => Promise<FakeWindow>;
  navigate: (u: string) => Promise<unknown>;
}

type Stored = Map<string, Response>;

/** An in-memory CacheStorage: enough of the API for public/sw.js. */
function fakeCaches() {
  const stores = new Map<string, Stored>();
  const urlOf = (r: string | { url: string }) => (typeof r === 'string' ? r : r.url);
  function cache(store: Stored) {
    return {
      // Lookups are exact: the worker keys every entry by pathname alone.
      match: async (r: string | { url: string }) => {
        const hit = store.get(urlOf(r));
        return hit ? hit.clone() : undefined;
      },
      // Real Cache.put rejects a body that was already read; so does this.
      put: async (r: string | { url: string }, res: Response) => {
        if (res.bodyUsed) throw new TypeError('body used');
        store.set(urlOf(r), res.clone());
      },
      delete: async (r: string | { url: string }) => store.delete(urlOf(r)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    };
  }
  return {
    stores,
    api: {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return cache(stores.get(name)!);
      },
      has: async (name: string) => stores.has(name),
      delete: async (name: string) => stores.delete(name),
      keys: async () => [...stores.keys()],
      match: async () => undefined,
    },
  };
}

type FetchFn = (input: string | { url: string }, init?: RequestInit) => Promise<Response>;

function offlineFetch() {
  return vi.fn<FetchFn>(async () => {
    throw new TypeError('Failed to fetch');
  });
}

function loadWorker(
  clientsList: FakeWindow[],
  { fetch = offlineFetch(), caches = fakeCaches() }: { fetch?: ReturnType<typeof offlineFetch>; caches?: ReturnType<typeof fakeCaches> } = {},
) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    registration: { showNotification: vi.fn<(title: string, options: unknown) => Promise<void>>(async () => {}) },
    clients: {
      matchAll: vi.fn<(options: unknown) => Promise<FakeWindow[]>>(async () => clientsList),
      openWindow: vi.fn(async () => null),
      claim: vi.fn<() => Promise<void>>(async () => {}),
    },
    skipWaiting: vi.fn(async () => {}),
    location: { origin: 'https://fair.yoga' },
  };
  const source = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  // caches and fetch are parameters so the script resolves them before Node's globals.
  new Function('self', 'caches', 'fetch', source)(self, caches.api, fetch);
  return { self, listeners, caches, fetch };
}

const ORIGIN = 'https://fair.yoga';
const OWNER = '3f6c2a7e-0b1d-4c8e-9a5f-1e2d3c4b5a69';
const OTHER_OWNER = '9b1e7d52-6a34-4f0c-8d21-5c7e9a3b1f48';
const PAGES = 'fy-pages-v1';
const STATIC = 'fy-static-v1';
const META = 'fy-meta-v1';
const DAY = 24 * 60 * 60 * 1000;

function html(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });
}
function page(owner = OWNER, extra = '') {
  return html(`<div data-offline-owner="${owner}"><script src="/_next/static/chunks/app-abc.js"></script>${extra}</div>`, 200, {
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
}
function navigation(pathname: string) {
  return { method: 'GET', url: `${ORIGIN}${pathname}`, mode: 'navigate' };
}
/** A fetch event; `settled()` resolves once every waitUntil promise has. */
function fetchEvent(request: { method: string; url: string; mode: string }) {
  const extended: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  return {
    request,
    waitUntil: (p: Promise<unknown>) => { extended.push(p); },
    respondWith: (p: Promise<Response>) => { responded = p; },
    response: () => responded,
    settled: async () => { await Promise.all(extended); },
  };
}

function jsResponse() {
  return new Response('console.log(1)', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
}
/** Answers static files itself; everything else is `answer`'s. */
function networkFetch(answer: (url: string) => Response | Promise<Response>) {
  return vi.fn<FetchFn>(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    return new URL(url).pathname.startsWith('/_next/static/') ? jsResponse() : answer(url);
  });
}

/** Writes a stored page straight into the fake, bypassing the worker. */
function seedPage(
  c: ReturnType<typeof fakeCaches>,
  pathname: string,
  { owner = OWNER as string | null, storedAt = String(Date.now()) as string | null, body = 'STORED-PAGE' } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
  if (owner !== null) headers['x-fy-owner'] = owner;
  if (storedAt !== null) headers['x-fy-stored-at'] = storedAt;
  if (!c.stores.has(PAGES)) c.stores.set(PAGES, new Map());
  c.stores.get(PAGES)!.set(ORIGIN + pathname, new Response(body, { status: 200, headers }));
}
function seedStatic(c: ReturnType<typeof fakeCaches>, pathname: string) {
  if (!c.stores.has(STATIC)) c.stores.set(STATIC, new Map());
  c.stores.get(STATIC)!.set(ORIGIN + pathname, jsResponse());
}
const pageKeys = (c: ReturnType<typeof fakeCaches>) => [...(c.stores.get(PAGES)?.keys() ?? [])];
const staticKeys = (c: ReturnType<typeof fakeCaches>) => [...(c.stores.get(STATIC)?.keys() ?? [])];
async function generationOf(c: ReturnType<typeof fakeCaches>) {
  const res = c.stores.get(META)?.get(`${ORIGIN}/__fy/generation`);
  return res ? Number(await res.clone().text()) : 0;
}
type Listeners = Record<string, (event: unknown) => void>;
/** Runs a navigation through the worker and returns the response once settled. */
async function navigate(listeners: Listeners, pathname: string) {
  const ev = fetchEvent(navigation(pathname));
  listeners.fetch!(ev);
  const res = await ev.response()!;
  await ev.settled();
  return res;
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
  it('answers no request that is not a GET', () => {
    const { listeners } = loadWorker([]);
    const ev = fetchEvent({ method: 'POST', url: `${ORIGIN}/schedule`, mode: 'navigate' });
    listeners.fetch!(ev);
    expect(ev.response()).toBeUndefined();
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
    const e = extendable();
    listeners.activate!(e);
    expect(e.waitUntil).toHaveBeenCalledTimes(1);
    await e.done();
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
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

describe('offline', () => {
  const never = () => new Promise<Response>(() => {});

  it('passes through everything that is not a same-origin GET navigation to a cacheable page, or static file', () => {
    const { listeners } = loadWorker([]);
    const requests = [
      { method: 'POST', url: `${ORIGIN}/class/c1`, mode: 'navigate' },
      { method: 'GET', url: `${ORIGIN}/api/notifications/stream`, mode: 'cors' },
      { method: 'GET', url: `${ORIGIN}/api/classes/x`, mode: 'cors' },
      { method: 'GET', url: `${ORIGIN}/class/x?_rsc=1`, mode: 'cors' },
      { method: 'GET', url: `${ORIGIN}/api/ping`, mode: 'cors' },
      { method: 'GET', url: 'https://other.example/class/c1', mode: 'navigate' },
    ];
    for (const request of requests) {
      const ev = fetchEvent(request);
      listeners.fetch!(ev);
      expect(ev.response(), request.url).toBeUndefined();
    }
  });

  it('hands the page the network response and stores it with its owner, time, policy and static files', async () => {
    const fetch = networkFetch(() => page());
    const { listeners, caches } = loadWorker([], { fetch });
    const ev = fetchEvent(navigation('/class/c1'));
    listeners.fetch!(ev);
    const res = await ev.response()!;
    expect(await res.text()).toContain(`data-offline-owner="${OWNER}"`);
    await ev.settled();
    const stored = caches.stores.get(PAGES)!.get(`${ORIGIN}/class/c1`)!;
    expect(stored.headers.get('x-fy-owner')).toBe(OWNER);
    expect(Number.isFinite(Number(stored.headers.get('x-fy-stored-at')))).toBe(true);
    expect(stored.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(staticKeys(caches)).toEqual([`${ORIGIN}/_next/static/chunks/app-abc.js`]);
  });

  it.each([
    ['a body with no marker', () => html('<p>hi</p>')],
    ['a body with two markers', () => html(`<div data-offline-owner="${OWNER}"></div><div data-offline-owner="${OTHER_OWNER}"></div>`)],
    ['a 500', () => html(`<div data-offline-owner="${OWNER}"></div>`, 500)],
    ['a non-HTML 200', () => new Response(`<div data-offline-owner="${OWNER}"></div>`, { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['a marker value that is not an id', () => html('<div data-offline-owner="x&quot;y"></div>')],
  ])('does not store %s', async (_label, answer) => {
    const { listeners, caches } = loadWorker([], { fetch: networkFetch(answer) });
    await navigate(listeners, '/class/c1');
    expect(pageKeys(caches)).toEqual([]);
  });

  it('serves the stored copy when the network fails', async () => {
    const { listeners, caches } = loadWorker([]);
    seedPage(caches, '/class/c1');
    const res = await navigate(listeners, '/class/c1');
    expect(await res.text()).toBe('STORED-PAGE');
  });

  it('finds the stored page for a navigation that carries a query string', async () => {
    const { listeners, caches } = loadWorker([]);
    seedPage(caches, '/class/c1');
    const res = await navigate(listeners, '/class/c1?from=inbox');
    expect(await res.text()).toBe('STORED-PAGE');
  });

  it('answers an offline page, under its own policy, when nothing is stored', async () => {
    const { listeners } = loadWorker([]);
    const res = await navigate(listeners, '/class/c1');
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("You're offline");
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('serves a copy just inside 24 hours and deletes one just outside', async () => {
    const { listeners, caches } = loadWorker([]);
    seedPage(caches, '/class/fresh', { storedAt: String(Date.now() - (DAY - 60_000)) });
    seedPage(caches, '/class/stale', { storedAt: String(Date.now() - (DAY + 1)) });
    expect(await (await navigate(listeners, '/class/fresh')).text()).toBe('STORED-PAGE');
    const stale = await navigate(listeners, '/class/stale');
    expect(stale.status).toBe(503);
    expect(pageKeys(caches)).not.toContain(`${ORIGIN}/class/stale`);
  });

  it.each([
    ['unreadable stored-at', { storedAt: 'nope' }],
    ['no stored-at', { storedAt: null }],
    ['no owner', { owner: null }],
  ])('never serves an entry with %s', async (_label, seed) => {
    const { listeners, caches } = loadWorker([]);
    seedPage(caches, '/class/c1', seed);
    const res = await navigate(listeners, '/class/c1');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toBe('STORED-PAGE');
  });

  it.each([
    ['an opaque redirect', () => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' })],
    ['a 307 to the login page', () => new Response(null, { status: 307, headers: { Location: '/login' } })],
  ])('wipes every stored page on %s and bumps the generation', async (_label, answer) => {
    const { listeners, caches } = loadWorker([], { fetch: networkFetch(answer) });
    seedPage(caches, '/schedule');
    const before = await generationOf(caches);
    const res = await navigate(listeners, '/class/c2');
    expect(res).toBeDefined();
    expect(pageKeys(caches)).toEqual([]);
    expect(await generationOf(caches)).toBeGreaterThan(before);
  });

  it('keeps one owner: storing a page for another account drops the first account\'s pages', async () => {
    const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => page(OTHER_OWNER)) });
    seedPage(caches, '/class/c1');
    await navigate(listeners, '/schedule');
    expect(pageKeys(caches)).toEqual([`${ORIGIN}/schedule`]);
  });

  it('on a clear message drops the stored pages, bumps the generation and prunes unreferenced static files', async () => {
    const { listeners, caches } = loadWorker([]);
    seedPage(caches, '/schedule');
    seedStatic(caches, '/_next/static/chunks/x.js');
    const before = await generationOf(caches);
    const e = extendable();
    listeners.message!({ data: { type: 'clear' }, waitUntil: e.waitUntil });
    await e.done();
    expect(caches.stores.has(PAGES)).toBe(false);
    expect(await generationOf(caches)).toBe(before + 1);
    expect(staticKeys(caches)).toEqual([]);
  });

  // The mock fetch ignores `signal`, so the abort cannot be what keeps the
  // late page out here; the generation check is. Do not make the fake honour
  // the signal, or that half of the guard stops being exercised.
  it('does not store a warm that finishes after a clear', async () => {
    const answer = deferred<Response>();
    const fetch = networkFetch(() => answer.promise);
    const { listeners, caches } = loadWorker([], { fetch });
    const warming = extendable();
    listeners.message!({ data: { type: 'warm', paths: ['/class/c1'] }, waitUntil: warming.waitUntil });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    const signal = fetch.mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    const clearing = extendable();
    listeners.message!({ data: { type: 'clear' }, waitUntil: clearing.waitUntil });
    await clearing.done();
    expect(signal.aborted).toBe(true);
    answer.resolve(page());
    await warming.done();
    expect(pageKeys(caches)).toEqual([]);
  });

  describe('warm', () => {
    const warmMessage = (listeners: Listeners, paths: unknown[]) => {
      const e = extendable();
      listeners.message!({ data: { type: 'warm', paths }, waitUntil: e.waitUntil });
      return e.done();
    };
    const pageFetches = (fetch: ReturnType<typeof offlineFetch>, pathname: string) =>
      fetch.mock.calls.filter(([input]) => (typeof input === 'string' ? input : input.url) === ORIGIN + pathname);

    it('fetches only cacheable paths, with the session cookie and no redirect following', async () => {
      const fetch = networkFetch(() => page());
      const { listeners, caches } = loadWorker([], { fetch });
      await warmMessage(listeners, ['/class/c1', '/students/s1', '/class/new', '/class/c1/edit', 42]);
      const pageCalls = fetch.mock.calls.filter(([input]) => !String(input).includes('/_next/static/'));
      expect(pageCalls.map(([input]) => input)).toEqual([`${ORIGIN}/class/c1`]);
      expect(pageCalls[0]![1]).toMatchObject({ credentials: 'same-origin', redirect: 'manual' });
      expect(pageKeys(caches)).toEqual([`${ORIGIN}/class/c1`]);
    });

    it('skips a page stored within ten minutes and refetches after', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const fetch = networkFetch(() => page());
        const { listeners } = loadWorker([], { fetch });
        await warmMessage(listeners, ['/class/c1']);
        expect(pageFetches(fetch, '/class/c1')).toHaveLength(1);
        await warmMessage(listeners, ['/class/c1']);
        expect(pageFetches(fetch, '/class/c1')).toHaveLength(1);
        vi.advanceTimersByTime(10 * 60 * 1000 + 1);
        await warmMessage(listeners, ['/class/c1']);
        expect(pageFetches(fetch, '/class/c1')).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips a path whose navigation is still being stored', async () => {
      const fetch = networkFetch(() => never());
      const { listeners } = loadWorker([], { fetch });
      listeners.fetch!(fetchEvent(navigation('/class/c1')));
      await warmMessage(listeners, ['/class/c1']);
      expect(pageFetches(fetch, '/class/c1')).toHaveLength(1);
    });
  });

  describe('patience', () => {
    it('serves the stored copy once a silent network has kept the page waiting 8 seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => never()) });
        seedPage(caches, '/class/c1');
        const ev = fetchEvent(navigation('/class/c1'));
        listeners.fetch!(ev);
        await vi.advanceTimersByTimeAsync(8000);
        expect(await (await ev.response()!).text()).toBe('STORED-PAGE');
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps waiting for the network when there is no stored copy', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const answer = deferred<Response>();
        const { listeners } = loadWorker([], { fetch: networkFetch(() => answer.promise) });
        const ev = fetchEvent(navigation('/class/c1'));
        listeners.fetch!(ev);
        await vi.advanceTimersByTimeAsync(8000);
        answer.resolve(page());
        expect(await (await ev.response()!).text()).toContain('data-offline-owner');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('gateway errors', () => {
    it('serves the stored copy over a 503', async () => {
      const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => html('down', 503)) });
      seedPage(caches, '/class/c1');
      expect(await (await navigate(listeners, '/class/c1')).text()).toBe('STORED-PAGE');
    });

    it('answers the 503 itself when nothing is stored', async () => {
      const { listeners } = loadWorker([], { fetch: networkFetch(() => html('down', 503)) });
      const res = await navigate(listeners, '/class/c1');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('down');
    });
  });

  describe('launch urls', () => {
    it.each(['/', '/start'])('sends %s offline to the stored schedule', async (pathname) => {
      const { listeners, caches } = loadWorker([]);
      seedPage(caches, '/schedule');
      const res = await navigate(listeners, pathname);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`${ORIGIN}/schedule`);
    });

    it.each(['/', '/start'])('answers the offline page for %s when no schedule is stored', async (pathname) => {
      const { listeners } = loadWorker([]);
      const res = await navigate(listeners, pathname);
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("You're offline");
    });

    it.each(['/', '/start'])('leaves %s alone online and stores nothing', async (pathname) => {
      const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => html('landing')) });
      seedPage(caches, '/schedule');
      const res = await navigate(listeners, pathname);
      expect(await res.text()).toContain('landing');
      expect(pageKeys(caches)).toEqual([`${ORIGIN}/schedule`]);
    });
  });

  describe('other navigation', () => {
    it('answers the offline page offline', async () => {
      const { listeners } = loadWorker([]);
      const res = await navigate(listeners, '/students');
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("You're offline");
    });

    it('passes the network response through online and stores nothing', async () => {
      const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => page()) });
      const res = await navigate(listeners, '/students');
      expect(await res.text()).toContain('data-offline-owner');
      expect(caches.stores.size).toBe(0);
    });
  });

  describe('static files', () => {
    const request = { method: 'GET', url: `${ORIGIN}/_next/static/chunks/app-abc.js`, mode: 'cors' };

    it('serves the stored copy offline', async () => {
      const { listeners, caches } = loadWorker([]);
      seedStatic(caches, '/_next/static/chunks/app-abc.js');
      const ev = fetchEvent(request);
      listeners.fetch!(ev);
      expect(await (await ev.response()!).text()).toBe('console.log(1)');
    });

    it('answers with the network online', async () => {
      const fetch = vi.fn<FetchFn>(async () => new Response('fresh', { status: 200 }));
      const { listeners, caches } = loadWorker([], { fetch });
      seedStatic(caches, '/_next/static/chunks/app-abc.js');
      const ev = fetchEvent(request);
      listeners.fetch!(ev);
      expect(await (await ev.response()!).text()).toBe('fresh');
    });

    it('serves the stored copy once a silent network has kept it waiting 8 seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { listeners, caches } = loadWorker([], { fetch: vi.fn<FetchFn>(() => never()) });
        seedStatic(caches, '/_next/static/chunks/app-abc.js');
        const ev = fetchEvent(request);
        listeners.fetch!(ev);
        await vi.advanceTimersByTimeAsync(8000);
        expect(await (await ev.response()!).text()).toBe('console.log(1)');
      } finally {
        vi.useRealTimers();
      }
    });

    it('prunes files no stored page references once a page expires, and keeps the rest', async () => {
      const fetch = networkFetch(() => html('gone', 404));
      const { listeners, caches } = loadWorker([], { fetch });
      seedPage(caches, '/class/a', { body: '<script src="/_next/static/chunks/a.js"></script>' });
      seedPage(caches, '/class/b', { body: '<script src="/_next/static/chunks/b.js"></script>', storedAt: String(Date.now() - DAY - 1) });
      seedStatic(caches, '/_next/static/chunks/a.js');
      seedStatic(caches, '/_next/static/chunks/b.js');
      await navigate(listeners, '/class/zz');
      expect(staticKeys(caches)).toEqual([`${ORIGIN}/_next/static/chunks/a.js`]);
    });

    it('pulls a file named inside the flight payload, which ends at the escaping backslash', async () => {
      const flight = String.raw`<script>self.__next_f.push([1,"x:I[\"/_next/static/chunks/c.js\",[]]"])</script>`;
      const { listeners, caches } = loadWorker([], { fetch: networkFetch(() => page(OWNER, flight)) });
      await navigate(listeners, '/class/c1');
      expect(staticKeys(caches)).toContain(`${ORIGIN}/_next/static/chunks/c.js`);
    });
  });

  describe('lifecycle', () => {
    it('skips waiting on install, inside waitUntil', async () => {
      const { self, listeners } = loadWorker([]);
      const e = extendable();
      listeners.install!(e);
      expect(self.skipWaiting).toHaveBeenCalledTimes(1);
      expect(e.waitUntil).toHaveBeenCalledTimes(1);
      await e.done();
    });

    it('deletes older fy- caches on activate, keeps current and foreign ones, and still claims', async () => {
      const { self, listeners, caches } = loadWorker([]);
      for (const name of ['fy-pages-v0', 'fy-old-thing', PAGES, 'workbox-x']) caches.stores.set(name, new Map());
      const e = extendable();
      listeners.activate!(e);
      await e.done();
      expect([...caches.stores.keys()].sort()).toEqual([PAGES, 'workbox-x'].sort());
      expect(self.clients.claim).toHaveBeenCalledTimes(1);
    });

    it('still claims when deleting a cache throws', async () => {
      const { self, listeners, caches } = loadWorker([]);
      caches.stores.set('fy-pages-v0', new Map());
      caches.api.delete = async () => { throw new Error('storage unavailable'); };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const e = extendable();
        listeners.activate!(e);
        await e.done();
        expect(self.clients.claim).toHaveBeenCalledTimes(1);
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
