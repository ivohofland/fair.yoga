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
