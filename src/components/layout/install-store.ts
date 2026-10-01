import { useSyncExternalStore } from 'react';
import { classifyInstall, type InstallSupport } from '@/lib/install-support';

/** The slice of `Window` the store reads; `window` satisfies it, and a test
 *  can hand in an `EventTarget` carrying the rest. */
export interface InstallWindow {
  addEventListener(type: string, listener: (event: Event) => void): void;
  navigator: { userAgent: string; maxTouchPoints: number; standalone?: boolean };
  matchMedia?: (query: string) => { matches: boolean };
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function isBeforeInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function' && 'userChoice' in event;
}

export interface InstallStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Exclude<InstallSupport, 'unknown'>;
  promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

function matches(win: InstallWindow, query: string): boolean {
  return win.matchMedia ? win.matchMedia(query).matches : false;
}

export function createInstallStore(win: InstallWindow): InstallStore {
  let deferred: BeforeInstallPromptEvent | null = null;
  let promptUsed = false;
  let prompting = false;
  let appInstalled = false;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((listener) => listener());

  win.addEventListener('beforeinstallprompt', (event) => {
    if (!isBeforeInstallPrompt(event)) {
      console.warn('[install-store] beforeinstallprompt without prompt()/userChoice');
      return;
    }
    // Suppresses Chromium's own mini-infobar, so the app decides when to
    // prompt.
    event.preventDefault();
    deferred = event;
    emit();
  });
  win.addEventListener('appinstalled', () => {
    deferred = null;
    appInstalled = true;
    emit();
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return classifyInstall({
        userAgent: win.navigator.userAgent,
        maxTouchPoints: win.navigator.maxTouchPoints,
        displayModeStandalone: matches(win, '(display-mode: standalone)'),
        navigatorStandalone: win.navigator.standalone === true,
        promptHeld: deferred !== null,
        promptUsed,
        appInstalled,
      });
    },
    async promptInstall() {
      if (deferred === null || prompting) return 'unavailable';
      const event = deferred;
      prompting = true;
      try {
        await event.prompt();
        const { outcome } = await event.userChoice;
        return outcome;
      } catch (err) {
        console.error('[install-store] prompt failed', err);
        return 'unavailable';
      } finally {
        if (deferred === event) deferred = null;
        promptUsed = true;
        prompting = false;
        emit();
      }
    },
  };
}

/** Created when this module first loads in a browser, not in an effect:
 *  `beforeinstallprompt` can fire before any component has mounted. */
export const installStore: InstallStore | null =
  typeof window === 'undefined' ? null : createInstallStore(window);

const noSubscription = (): (() => void) => () => {};

export function useInstallSupport(): InstallSupport {
  return useSyncExternalStore<InstallSupport>(
    installStore ? installStore.subscribe : noSubscription,
    () => (installStore ? installStore.getSnapshot() : 'unknown'),
    () => 'unknown',
  );
}

function subscribeCoarse(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(pointer: coarse)');
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** A phone or tablet. `false` on the server and the first client render. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false),
    () => false,
  );
}
