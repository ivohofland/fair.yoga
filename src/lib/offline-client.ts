import { logRequestFailure } from './client-errors';
import { SW_SCOPE, SW_URL } from './service-worker';

/** The worker's page cache; a test ties this to the name declared in `public/sw.js`. */
export const OFFLINE_PAGES_CACHE = 'fy-pages-v1';

const READY_TIMEOUT_MS = 10_000;

/** Registers the worker where the browser supports one. Never throws. */
export async function registerOfflineWorker(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  } catch (err) {
    logRequestFailure('offline-client', { step: 'register' }, err);
  }
}

/** Asks the worker to store `paths`, once it is active (waiting at most `READY_TIMEOUT_MS`). Never throws. */
export async function warmOfflinePages(paths: readonly string[]): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), READY_TIMEOUT_MS);
    });
    const registration = await Promise.race([navigator.serviceWorker.ready, timedOut]);
    registration?.active?.postMessage({ type: 'warm', paths: [...paths] });
  } catch (err) {
    logRequestFailure('offline-client', { step: 'warm' }, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Empties the stored pages. Reads the registration instead of waiting on
 * `ready`, so a worker still installing never holds a sign-out. Never throws.
 */
export async function clearOfflinePages(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
      registration?.active?.postMessage({ type: 'clear' });
    }
  } catch (err) {
    logRequestFailure('offline-client', { step: 'clear' }, err);
  }
  try {
    if (typeof caches !== 'undefined') await caches.delete(OFFLINE_PAGES_CACHE);
  } catch (err) {
    logRequestFailure('offline-client', { step: 'clear-cache' }, err);
  }
}
