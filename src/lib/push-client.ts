import type { InstallSupport } from './install-support';
import { logRequestFailure } from './client-errors';

export type PushDeviceState = 'unsupported' | 'needs-install' | 'off' | 'on' | 'blocked' | 'unavailable';

export interface PushDeviceEnv {
  vapidConfigured: boolean;
  install: InstallSupport;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: NotificationPermission | null;
  subscribed: boolean;
}

export function classifyPushDevice(env: PushDeviceEnv): PushDeviceState {
  if (!env.vapidConfigured) return 'unavailable';
  // Push is an installed-app feature on every platform (spec §2.9), not only
  // where iOS forces it. `unknown` (server render, first client render) also
  // lands here, since it is not `'installed'` either.
  if (env.install !== 'installed') return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'blocked';
  return env.permission === 'granted' && env.subscribed ? 'on' : 'off';
}

const SW_URL = '/sw.js';

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  return registration ? registration.pushManager.getSubscription() : null;
}

/**
 * `new Uint8Array(length)`, not `Uint8Array.from`: the latter's return type
 * backs onto `ArrayBufferLike`, which `PushSubscriptionOptionsInit.applicationServerKey`
 * (typed `BufferSource`, i.e. an `ArrayBuffer`-backed view) refuses — allocating
 * the buffer here keeps the concrete `ArrayBuffer` backing intact.
 */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Whether `subscription` was made with `vapidPublicKey`, compared as bytes.
 * `unknown` when the browser reports no `applicationServerKey`: nothing can
 * then be proven either way, so it is never grounds for dropping one.
 */
export function subscriptionUsesKey(subscription: PushSubscription, vapidPublicKey: string): 'match' | 'mismatch' | 'unknown' {
  const used = subscription.options?.applicationServerKey;
  if (!used) return 'unknown';
  const usedBytes = new Uint8Array(used);
  const expected = keyBytes(vapidPublicKey);
  const same = usedBytes.length === expected.length && usedBytes.every((byte, i) => byte === expected[i]);
  return same ? 'match' : 'mismatch';
}

export type SyncResult = { ok: true } | { ok: false; status: number | null };

/**
 * POSTs `subscription` for the account signed in now. `status` is null when
 * the request itself failed. Never throws.
 */
export async function syncPushSubscription(subscription: PushSubscription): Promise<SyncResult> {
  try {
    const json = subscription.toJSON();
    const res = await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } }),
    });
    if (res.ok) return { ok: true };
    logRequestFailure('push-client', { step: 'sync', status: res.status }, new Error(`push subscription POST answered ${res.status}`));
    return { ok: false, status: res.status };
  } catch (err) {
    logRequestFailure('push-client', { step: 'sync' }, err);
    return { ok: false, status: null };
  }
}

/**
 * Re-records this device for the account that has just signed in, so a phone
 * the previous account left subscribed stops delivering that account's
 * notifications. Acts only on a subscription the browser already holds under
 * a granted permission: it never asks for permission, never subscribes, and
 * makes no request unless both hold. Best effort: a failure is logged and
 * leaves the device recorded for whichever account held it until the next
 * re-record, so a caller must not depend on the outcome. Never throws.
 */
export async function recordPushDeviceForSignIn(): Promise<void> {
  let subscription: PushSubscription | null;
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    subscription = await currentPushSubscription();
  } catch (err) {
    logRequestFailure('push-client', { step: 'read' }, err);
    return;
  }
  if (subscription) await syncPushSubscription(subscription);
}

/** How long a caller about to unload the page waits on the re-record. */
export const RECORD_BEFORE_NAVIGATION_MS = 3000;

/**
 * For a caller whose next step is a full page load, which aborts a request
 * still in flight: waits for `recordPushDeviceForSignIn`, but no longer than
 * `RECORD_BEFORE_NAVIGATION_MS`, so a stalled request cannot hold a signed-in
 * reader on the screen. Never throws.
 */
export async function recordPushDeviceBeforeNavigation(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RECORD_BEFORE_NAVIGATION_MS);
  });
  try {
    await Promise.race([recordPushDeviceForSignIn(), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

/** Resolves true once the service worker is active, false if that takes longer than the timeout. */
async function serviceWorkerReady(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SERVICE_WORKER_READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** Call only from a click handler: the permission prompt needs the gesture. Never throws. */
export async function enablePush(vapidPublicKey: string): Promise<'on' | 'blocked' | 'failed'> {
  let created: PushSubscription | null = null;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'denied') return 'blocked';
    if (permission !== 'granted') return 'failed';
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
    if (!(await serviceWorkerReady())) {
      logRequestFailure('push-client', { step: 'ready' }, new Error('service worker not ready within 10s'));
      return 'failed';
    }
    const existing = await registration.pushManager.getSubscription();
    const match = existing ? subscriptionUsesKey(existing, vapidPublicKey) : null;
    let subscription: PushSubscription;
    if (existing && match === 'match') {
      subscription = existing;
    } else {
      if (existing && match === 'mismatch') await existing.unsubscribe();
      // For `unknown`, `subscribe` itself decides: it hands back the existing
      // subscription when that was made with this key, and refuses otherwise.
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) });
      if (!existing || match === 'mismatch' || subscription.endpoint !== existing.endpoint) created = subscription;
    }
    if ((await syncPushSubscription(subscription)).ok) return 'on';
  } catch (err) {
    logRequestFailure('push-client', { step: 'enable' }, err);
  }
  // A subscription this call made, which the server never recorded, would
  // receive nothing. One that already existed is left alone: the server may
  // hold it for this phone.
  await created?.unsubscribe().catch((err: unknown) => logRequestFailure('push-client', { step: 'enable-cleanup' }, err));
  return 'failed';
}

/**
 * Server row first (it needs the session), then the browser half, which is
 * the one that stops delivery. `off` when there was no subscription or the
 * browser confirmed the unsubscribe; `failed` otherwise. Never throws.
 */
export async function disablePush(): Promise<'off' | 'failed'> {
  let subscription: PushSubscription | null = null;
  try {
    subscription = await currentPushSubscription();
  } catch (err) {
    logRequestFailure('push-client', { step: 'read' }, err);
    return 'failed';
  }
  if (!subscription) return 'off';
  try {
    const res = await fetch('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (!res.ok) {
      logRequestFailure('push-client', { step: 'delete', status: res.status }, new Error(`push subscription DELETE answered ${res.status}`));
    }
  } catch (err) {
    logRequestFailure('push-client', { step: 'delete' }, err);
  }
  try {
    if (await subscription.unsubscribe()) return 'off';
    logRequestFailure('push-client', { step: 'unsubscribe' }, new Error('unsubscribe() resolved false'));
  } catch (err) {
    logRequestFailure('push-client', { step: 'unsubscribe' }, err);
  }
  return 'failed';
}
