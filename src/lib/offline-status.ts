import { useSyncExternalStore } from 'react';

export interface ConnectionStatus {
  offline: boolean;
  /** The server's clock at the last successful ping, epoch ms. */
  serverNow: number | null;
}

const PING_TIMEOUT_MS = 5_000;
/** While a subscriber sees `offline`, how long until the ping is tried again. */
const RETRY_MS = 15_000;
const SERVER_SNAPSHOT: ConnectionStatus = { offline: false, serverNow: null };

let pingFailed = false;
let serverNow: number | null = null;
let snapshot: ConnectionStatus = SERVER_SNAPSHOT;
/** Numbers each ping; an answer is kept only from the latest one sent. */
let latestPing = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** A new object only when a value changed: React requires a stable snapshot. */
function refreshSnapshot(): void {
  const offline = pingFailed || browserOffline();
  if (snapshot.offline !== offline || snapshot.serverNow !== serverNow) {
    snapshot = { offline, serverNow };
  }
}

function scheduleRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = listeners.size > 0 && snapshot.offline ? setTimeout(() => void checkConnection(), RETRY_MS) : null;
}

function publish(): void {
  refreshSnapshot();
  scheduleRetry();
  listeners.forEach((listener) => listener());
}

function isServerNow(value: unknown): value is { now: number } {
  return typeof value === 'object' && value !== null && 'now' in value && typeof value.now === 'number';
}

/** One reachability check against `/api/ping`. Never throws. */
export async function checkConnection(): Promise<void> {
  const ping = ++latestPing;
  let failed = true;
  let now: number | null = null;
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const body: unknown = res.ok ? await res.json() : null;
    if (isServerNow(body)) {
      failed = false;
      now = body.now;
    }
  } catch {
    // A failed ping is the answer this function exists to find, not an error.
  }
  if (ping !== latestPing) return;
  pingFailed = failed;
  if (now !== null) serverNow = now;
  publish();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void checkConnection();
}

function onOnline(): void {
  void checkConnection();
}

function detach(): void {
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', publish);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  // With no subscriber nothing keeps this answer current, and isOfflineNow
  // would go on reporting it.
  pingFailed = false;
  refreshSnapshot();
}

export function subscribeConnectionStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', publish);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Seen by React's post-subscribe snapshot check, so a page opened with
    // the browser already offline disables its controls before the ping.
    refreshSnapshot();
    void checkConnection();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) detach();
  };
}

export function getConnectionStatus(): ConnectionStatus {
  return snapshot;
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus, () => SERVER_SNAPSHOT);
}

/** For a caller deciding at fire time, without subscribing. */
export function isOfflineNow(): boolean {
  return pingFailed || browserOffline();
}

/** Test-only. */
export function resetConnectionStatus(): void {
  detach();
  pingFailed = false;
  serverNow = null;
  latestPing = 0;
  snapshot = SERVER_SNAPSHOT;
  listeners.clear();
}
