// fair.yoga service worker — push only. Deliberately no `fetch` listener:
// this worker never sits between the page and the network.

function safePath(url) {
  if (typeof url !== 'string') return '/';
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

// Take control of windows already open, so a tap can navigate them.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload.title !== 'string') return;
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: payload.id,
      icon: '/icons/icon-192.png',
      data: { url: safePath(payload.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((w) => w.url.startsWith(self.location.origin));
      // `navigate` rejects for a window this worker does not control (one
      // opened before it activated); a new window opens at `url` instead.
      if (existing) return existing.navigate(url).then(() => existing.focus(), () => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    }),
  );
});
