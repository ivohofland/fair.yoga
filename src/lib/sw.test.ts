import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadWorker(clientsList: Array<{ url: string; focus: () => Promise<unknown>; navigate: (u: string) => Promise<unknown> }>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { listeners[type] = fn; },
    registration: { showNotification: vi.fn(async () => {}) },
    clients: { matchAll: vi.fn(async () => clientsList), openWindow: vi.fn(async () => null), claim: vi.fn(async () => {}) },
    location: { origin: 'https://fair.yoga' },
  };
  const source = readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8');
  new Function('self', source)(self);
  return { self, listeners };
}

function extendable() {
  let pending: Promise<unknown> = Promise.resolve();
  return { waitUntil: (p: Promise<unknown>) => { pending = p; }, done: () => pending };
}

describe('public/sw.js', () => {
  it('registers no fetch listener', () => {
    expect(loadWorker([]).listeners.fetch).toBeUndefined();
  });

  it('shows the pushed title and body, tagged by notification id, and never sets a badge', async () => {
    const { self, listeners } = loadWorker([]);
    const e = { ...extendable(), data: { json: () => ({ id: 'n1', title: 'A spot opened up', body: 'Vinyasa', url: '/updates?n=n1' }) } };
    listeners.push!(e);
    await e.done();
    expect(self.registration.showNotification).toHaveBeenCalledWith('A spot opened up', expect.objectContaining({ body: 'Vinyasa', tag: 'n1', data: { url: '/updates?n=n1' } }));
    expect(readFileSync(path.join(process.cwd(), 'public/sw.js'), 'utf8')).not.toMatch(/AppBadge/);
  });

  it('navigates an open window on tap, else opens one', async () => {
    const focus = vi.fn(async () => {});
    const navigate = vi.fn(async () => {});
    const open = loadWorker([{ url: 'https://fair.yoga/schedule', focus, navigate }]);
    const e1 = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n2' } } };
    open.listeners.notificationclick!(e1);
    await e1.done();
    expect(navigate).toHaveBeenCalledWith('/inbox?n=n2');
    expect(focus).toHaveBeenCalled();

    const none = loadWorker([]);
    const e2 = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n3' } } };
    none.listeners.notificationclick!(e2);
    await e2.done();
    expect(none.self.clients.openWindow).toHaveBeenCalledWith('/inbox?n=n3');
  });

  it('opens a window at the url when the open window refuses to navigate', async () => {
    const focus = vi.fn(async () => {});
    const navigate = vi.fn(async () => {
      throw new TypeError('This service worker is not the client\'s active service worker.');
    });
    const { self, listeners } = loadWorker([{ url: 'https://fair.yoga/schedule', focus, navigate }]);
    const e = { ...extendable(), notification: { close: vi.fn(), data: { url: '/inbox?n=n5' } } };
    listeners.notificationclick!(e);
    await e.done();
    expect(navigate).toHaveBeenCalledWith('/inbox?n=n5');
    expect(self.clients.openWindow).toHaveBeenCalledWith('/inbox?n=n5');
    expect(focus).not.toHaveBeenCalled();
  });

  it('takes control of open windows when it activates', async () => {
    const { self, listeners } = loadWorker([]);
    const e = extendable();
    listeners.activate!(e);
    await e.done();
    expect(self.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('redacts a cross-origin push url to the site root before showing the notification', async () => {
    const { self, listeners } = loadWorker([]);
    const e = { ...extendable(), data: { json: () => ({ id: 'n4', title: 'Title', body: 'Body', url: 'https://evil.example/' }) } };
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
