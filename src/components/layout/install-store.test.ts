import { describe, it, expect, vi } from 'vitest';
import { createInstallStore, type InstallWindow } from './install-store';

function fakeWindow(userAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'): InstallWindow & EventTarget {
  return Object.assign(new EventTarget(), {
    navigator: { userAgent, maxTouchPoints: 5 },
    matchMedia: (): { matches: boolean } => ({ matches: false }),
  });
}

function promptEvent(outcome: 'accepted' | 'dismissed') {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn().mockResolvedValue(undefined),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
}

describe('createInstallStore', () => {
  it('holds a beforeinstallprompt, cancels its default and notifies', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    const listener = vi.fn();
    store.subscribe(listener);

    const event = promptEvent('accepted');
    win.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(store.getSnapshot()).toBe('prompt');
    expect(listener).toHaveBeenCalled();
  });

  it('ignores an event without a prompt method', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(store.getSnapshot()).toBe('unsupported');
  });

  it('answers manual after a dismissed prompt, so a visible surface stays', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(promptEvent('dismissed'));

    expect(await store.promptInstall()).toBe('dismissed');
    expect(store.getSnapshot()).toBe('manual');
  });

  it('calls prompt() once when tapped twice while the dialog is open', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    const event = promptEvent('accepted');
    win.dispatchEvent(event);

    const first = store.promptInstall();
    const second = store.promptInstall();

    expect(await second).toBe('unavailable');
    expect(await first).toBe('accepted');
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('answers installed once appinstalled fires', () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(new Event('appinstalled'));
    expect(store.getSnapshot()).toBe('installed');
  });

  it('answers unavailable when nothing is held', async () => {
    const store = createInstallStore(fakeWindow());
    expect(await store.promptInstall()).toBe('unavailable');
  });
});
