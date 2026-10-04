// fair.yoga service worker: push, and a read-only offline copy of a
// teacher's schedule and class pages. The rules, and why each holds, are in
// docs/technical-architecture.md (Offline (service worker)); this file is
// their code.

const PAGES = 'fy-pages-v1';
const STATIC = 'fy-static-v1';
const META = 'fy-meta-v1';
const CURRENT_CACHES = [PAGES, STATIC, META];

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PATIENCE_MS = 8000;
const WARM_FRESH_MS = 10 * 60 * 1000;
const MAX_WARM_PATHS = 20;
const GATEWAY_FAILURES = new Set([502, 503, 504]);
const GENERATION_KEY = '/__fy/generation';
// The attribute that names a stored page's owner. A `"` inside any other
// text arrives escaped (`&quot;`, or `\"` in the flight payload), so page
// content cannot forge a second match.
const OWNER_PATTERN = /data-offline-owner="([A-Za-z0-9-]+)"/g;
const STATIC_PATTERN = /\/_next\/static\/[^"'\\\s)<>]+/g;
const SLOW = 'slow';
const FAILED = 'failed';

const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline · fair.yoga</title></head>
<body style="margin:0;background:#F7F4EF;color:#6B5B4E;font-family:system-ui,-apple-system,sans-serif">
<main style="max-width:640px;margin:0 auto;padding:48px 16px">
<h1 style="font-family:Georgia,serif;color:#1A5653;font-size:24px;margin:0 0 12px">You're offline</h1>
<p style="margin:0 0 24px;line-height:1.5">This page wasn't saved on this device. Your schedule and today's classes are, once you've opened the app with a connection today.</p>
<p style="margin:0"><a href="/schedule" style="color:#1A5653;font-weight:600">Open your schedule</a></p>
</main></body></html>`;

/** Paths whose network response is being stored now; a warm skips them. */
const pathsBeingStored = new Set();
/** Warms in flight, aborted by a clear. */
const warmControllers = new Set();

function key(pathname) {
  return self.location.origin + pathname;
}

function isCacheablePath(pathname) {
  return pathname === '/schedule' || /^\/(?:class|studio-class)\/(?!new$)[^/]+$/.test(pathname);
}

function isRedirect(res) {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400);
}

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}

// Copied from the network response, so a stored page is served under the
// same policy it was rendered with.
const KEPT_HEADERS = [
  'content-type',
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
];

function storedHeaders(res, owner) {
  const headers = new Headers();
  for (const name of KEPT_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('x-fy-owner', owner);
  headers.set('x-fy-stored-at', String(Date.now()));
  return headers;
}

function storedAt(res) {
  const at = Number(res.headers.get('x-fy-stored-at'));
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Written by this worker, owned, and under the retention limit. */
function isServable(res) {
  const at = storedAt(res);
  return at !== null && Boolean(res.headers.get('x-fy-owner')) && Date.now() - at < MAX_AGE_MS;
}

async function generation() {
  const res = await (await caches.open(META)).match(key(GENERATION_KEY));
  const value = res ? Number(await res.text()) : 0;
  return Number.isFinite(value) ? value : 0;
}

function staticPaths(body) {
  return new Set(Array.from(body.matchAll(STATIC_PATTERN), (m) => m[0]));
}

/**
 * Runs `task` after every earlier one has settled. Pruning and the stretch of
 * a store that writes a page and pulls its files take turns, so a prune
 * never deletes a file a page it could not yet see is about to rely on.
 */
let turn = Promise.resolve();
function exclusive(task) {
  const run = turn.then(task, task);
  turn = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Deletes every static file no stored page references. */
function pruneStatic() {
  return exclusive(pruneStaticNow);
}

async function pruneStaticNow() {
  const referenced = new Set();
  if (await caches.has(PAGES)) {
    const pages = await caches.open(PAGES);
    for (const req of await pages.keys()) {
      const res = await pages.match(req);
      if (res) for (const path of staticPaths(await res.text())) referenced.add(key(path));
    }
  }
  const files = await caches.open(STATIC);
  for (const req of await files.keys()) {
    if (!referenced.has(req.url)) await files.delete(req);
  }
}

async function pullStatic(body) {
  const files = await caches.open(STATIC);
  await Promise.all(
    [...staticPaths(body)].map(async (path) => {
      if (await files.match(key(path))) return;
      try {
        const res = await fetch(key(path));
        if (res.ok) await files.put(key(path), res);
      } catch (err) {
        // The stored page will hydrate without this file offline.
        console.warn('[sw] could not store a static file', path, err);
      }
    }),
  );
}

async function purgeExpired() {
  if (!(await caches.has(PAGES))) return;
  const pages = await caches.open(PAGES);
  let removed = false;
  for (const req of await pages.keys()) {
    const res = await pages.match(req);
    if (!res || !isServable(res)) {
      await pages.delete(req);
      removed = true;
    }
  }
  if (removed) await pruneStatic();
}

async function clearPages() {
  for (const controller of warmControllers) controller.abort();
  const next = (await generation()) + 1;
  await (await caches.open(META)).put(key(GENERATION_KEY), new Response(String(next)));
  await caches.delete(PAGES);
  await pruneStatic();
}

/**
 * Stores `res` for `pathname` when it is a page this worker may keep: a 200
 * HTML page carrying exactly one owner. `startedAt` is the generation read
 * when its request began; a clear since then means the request carried a
 * session that has ended, so nothing is kept.
 */
async function storePage(pathname, res, startedAt) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return;
  const body = await res.text();
  const owners = Array.from(body.matchAll(OWNER_PATTERN), (m) => m[1]);
  if (owners.length !== 1) return;
  const owner = owners[0];
  // Before the wipe below as well as before the put: a stale store must not
  // clear the pages of the account that replaced the one it belongs to.
  if ((await generation()) !== startedAt) return;
  let pages = await caches.open(PAGES);
  for (const req of await pages.keys()) {
    const existing = await pages.match(req);
    if (!existing || existing.headers.get('x-fy-owner') !== owner) {
      await caches.delete(PAGES);
      pages = await caches.open(PAGES);
      break;
    }
  }
  const headers = storedHeaders(res, owner);
  await exclusive(async () => {
    // clearPages bumps the generation before it deletes PAGES, so a put that
    // passes this check lands in a cache that clear then removes.
    if ((await generation()) !== startedAt) return;
    await pages.put(key(pathname), new Response(body, { status: 200, headers }));
    await pullStatic(body);
  });
}

async function storedCopy(pathname) {
  const pages = await caches.open(PAGES);
  const res = await pages.match(key(pathname));
  if (!res) return null;
  if (isServable(res)) return res;
  await pages.delete(key(pathname));
  return null;
}

/**
 * The network's answer, unless it fails, answers a gateway error, or is
 * still silent after PATIENCE_MS — then `fallback()`'s response if it has
 * one. A slow network with no fallback is still waited for.
 */
async function networkFirst(fromNetwork, fallback) {
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SLOW), PATIENCE_MS);
  });
  const first = await Promise.race([fromNetwork.catch(() => FAILED), slow]);
  clearTimeout(timer);
  if (first !== SLOW && first !== FAILED && !GATEWAY_FAILURES.has(first.status)) return first;
  const stored = await fallback().catch((err) => {
    console.warn('[sw] stored copy unreadable', err);
    return null;
  });
  if (stored) return stored;
  if (first === SLOW) return fromNetwork.catch(() => offlineResponse());
  return first === FAILED ? offlineResponse() : first;
}

function handleCacheablePage(event, pathname) {
  pathsBeingStored.add(pathname);
  // The generation is read before the request goes out, so a clear cannot
  // land between the two. An unreadable one stores nothing and still serves.
  const startedAt = generation().catch(() => -1);
  const fromNetwork = startedAt.then(() => fetch(event.request));
  const stored = fromNetwork
    .then(
      (res) => {
        if (isRedirect(res)) return clearPages();
        // Cloned before the page reads the original.
        const copy = res.clone();
        return startedAt.then((g) => storePage(pathname, copy, g));
      },
      // No response is no page to store; serving is networkFirst's job.
      () => undefined,
    )
    .catch((err) => console.warn('[sw] could not store a page', pathname, err))
    .finally(() => pathsBeingStored.delete(pathname));
  event.waitUntil(stored.then(() => purgeExpired()));
  event.respondWith(networkFirst(fromNetwork, () => storedCopy(pathname)));
}

async function scheduleRedirect() {
  return (await storedCopy('/schedule')) ? Response.redirect(key('/schedule'), 302) : null;
}

async function warm(paths) {
  const startedAt = await generation();
  const pages = await caches.open(PAGES);
  const wanted = paths.filter((p) => typeof p === 'string' && isCacheablePath(p)).slice(0, MAX_WARM_PATHS);
  await Promise.all(
    wanted.map(async (pathname) => {
      if (pathsBeingStored.has(pathname)) return;
      const existing = await pages.match(key(pathname));
      if (existing && isServable(existing) && Date.now() - storedAt(existing) < WARM_FRESH_MS) return;
      const controller = new AbortController();
      warmControllers.add(controller);
      pathsBeingStored.add(pathname);
      try {
        const res = await fetch(key(pathname), { credentials: 'same-origin', redirect: 'manual', signal: controller.signal });
        if (isRedirect(res)) await clearPages();
        else await storePage(pathname, res, startedAt);
      } catch (err) {
        if (!controller.signal.aborted) console.warn('[sw] could not warm a page', pathname, err);
      } finally {
        warmControllers.delete(controller);
        pathsBeingStored.delete(pathname);
      }
    }),
  );
  await purgeExpired();
}

function safePath(url) {
  if (typeof url !== 'string') return '/';
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

// Drops caches an older worker version wrote, then takes control of windows
// already open, so a push tap can navigate them and their next navigation is
// answered here.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n.startsWith('fy-') && !CURRENT_CACHES.includes(n)).map((n) => caches.delete(n))),
      )
      .then(() => purgeExpired())
      .catch((err) => console.error('[sw] cache cleanup on activate failed', err))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    if (isCacheablePath(url.pathname)) {
      handleCacheablePage(event, url.pathname);
    } else if (url.pathname === '/' || url.pathname === '/start') {
      event.respondWith(networkFirst(fetch(request), scheduleRedirect));
    } else {
      event.respondWith(fetch(request).catch(() => offlineResponse()));
    }
    return;
  }
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(networkFirst(fetch(request), async () => (await caches.open(STATIC)).match(request.url, { ignoreVary: true }) || null));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'clear') event.waitUntil(clearPages());
  else if (data.type === 'warm' && Array.isArray(data.paths)) event.waitUntil(warm(data.paths));
});

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  // A push that shows nothing can get the subscription revoked, so one this
  // worker cannot read still shows something.
  const shown =
    payload && typeof payload.title === 'string'
      ? self.registration.showNotification(payload.title, {
          body: typeof payload.body === 'string' ? payload.body : '',
          tag: payload.id,
          icon: '/icons/icon-192.png',
          data: { url: safePath(payload.url) },
        })
      : self.registration.showNotification('fair.yoga', { body: 'You have a new update.', data: { url: '/' } });
  event.waitUntil(shown.catch((err) => console.error('[sw] showNotification failed', err)));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windows) => {
        const existing = windows.find((w) => w.url.startsWith(self.location.origin));
        // `navigate` rejects for a window this worker does not control.
        // `clients.claim()` on activation takes every window already open,
        // so that is one loaded by a hard reload, which bypasses the worker;
        // a new window opens at `url` instead.
        if (existing) {
          return existing
            .focus()
            .then((client) => client.navigate(url))
            .catch(() => self.clients.openWindow(url));
        }
        return self.clients.openWindow(url);
      })
      .catch((err) => console.error('[sw] notificationclick failed', err)),
  );
});
