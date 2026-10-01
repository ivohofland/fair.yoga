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

function rejectingPromptEvent(err: Error) {
  // userChoice is never read: `promptInstall` catches the `prompt()`
  // rejection first, so it only needs to exist for `isBeforeInstallPrompt`.
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn().mockRejectedValue(err),
    userChoice: Promise.resolve({ outcome: 'dismissed' as const, platform: 'web' }),
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

  it('ignores an event without a prompt method, warning about it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    expect(store.getSnapshot()).toBe('unsupported');
    expect(warnSpy).toHaveBeenCalledWith('[install-store] beforeinstallprompt without prompt()/userChoice');
    warnSpy.mockRestore();
  });

  it('answers manual after a dismissed prompt, so a visible surface stays', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(promptEvent('dismissed'));
    const listener = vi.fn();
    store.subscribe(listener);

    expect(await store.promptInstall()).toBe('dismissed');
    expect(store.getSnapshot()).toBe('manual');
    expect(listener).toHaveBeenCalled();
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
    const listener = vi.fn();
    store.subscribe(listener);

    win.dispatchEvent(new Event('appinstalled'));

    expect(store.getSnapshot()).toBe('installed');
    expect(listener).toHaveBeenCalled();
  });

  it('answers unavailable when nothing is held', async () => {
    const store = createInstallStore(fakeWindow());
    expect(await store.promptInstall()).toBe('unavailable');
  });

  it('answers unavailable when prompt() rejects, logging the failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const win = fakeWindow();
    const store = createInstallStore(win);
    const err = new Error('x');
    win.dispatchEvent(rejectingPromptEvent(err));

    expect(await store.promptInstall()).toBe('unavailable');
    expect(store.getSnapshot()).toBe('manual');
    expect(errorSpy).toHaveBeenCalledWith('[install-store] prompt failed', err);

    errorSpy.mockRestore();
  });

  it('keeps a prompt that arrives while another is being shown', async () => {
    const win = fakeWindow();
    const store = createInstallStore(win);
    win.dispatchEvent(promptEvent('accepted'));

    const first = store.promptInstall();
    win.dispatchEvent(promptEvent('accepted'));
    await first;

    expect(store.getSnapshot()).toBe('prompt');
  });
});
