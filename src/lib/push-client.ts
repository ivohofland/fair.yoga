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
  // lands here; the control renders nothing actionable until it resolves.
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

/** Call only from a click handler: the permission prompt needs the gesture. Never throws. */
export async function enablePush(vapidPublicKey: string): Promise<'on' | 'blocked' | 'failed'> {
  let subscription: PushSubscription | null = null;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'failed';
    const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
    await navigator.serviceWorker.ready;
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) }));
    const json = subscription.toJSON();
    const res = await fetch('/api/push/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } }),
    });
    if (res.ok) return 'on';
  } catch (err) {
    logRequestFailure('push-client', {}, err);
  }
  // A browser subscription the server never recorded would receive nothing.
  await subscription?.unsubscribe().catch(() => false);
  return 'failed';
}

/** Server row first (it needs the session), then the browser half, which is the one that stops delivery. Never throws. */
export async function disablePush(): Promise<void> {
  let subscription: PushSubscription | null = null;
  try {
    subscription = await currentPushSubscription();
  } catch (err) {
    logRequestFailure('push-client', {}, err);
    return;
  }
  if (!subscription) return;
  try {
    await fetch('/api/push/subscriptions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch (err) {
    logRequestFailure('push-client', {}, err);
  }
  try {
    await subscription.unsubscribe();
  } catch (err) {
    logRequestFailure('push-client', {}, err);
  }
}
