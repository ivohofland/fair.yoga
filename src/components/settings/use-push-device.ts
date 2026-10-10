'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { useInstallSupport } from '@/components/layout/install-store';
import { logRequestFailure } from '@/lib/client-errors';
import {
  classifyPushDevice,
  currentPushSubscription,
  disablePush,
  subscriptionUsesKey,
  syncPushSubscription,
  type PushDeviceEnv,
  type PushDeviceState,
} from '@/lib/push-client';

/** A line under a push control, set by the last thing that did not go as asked. */
export type PushNotice = null | 'enable-failed' | 'disable-failed' | 'unconfirmed';

export interface PushDevice {
  /** null until the effect below has resolved the device. */
  state: PushDeviceState | null;
  /** The permission read while resolving; null without `Notification` or before resolving. */
  permission: NotificationPermission | null;
  notice: PushNotice;
  setState: Dispatch<SetStateAction<PushDeviceState | null>>;
  setNotice: Dispatch<SetStateAction<PushNotice>>;
}

/**
 * This device's push state, resolved once per mount and again when the
 * install state or key changes. `resync` re-records a subscription that is
 * already on for the account signed in now; without it, resolving an `on`
 * device makes no request.
 */
export function usePushDevice(vapidPublicKey: string | null, { resync }: { resync: boolean }): PushDevice {
  const install = useInstallSupport();
  const [state, setState] = useState<PushDeviceState | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [notice, setNotice] = useState<PushNotice>(null);

  useEffect(() => {
    let cancelled = false;
    async function resolve(): Promise<void> {
      const hasServiceWorker = 'serviceWorker' in navigator;
      const hasPushManager = 'PushManager' in window;
      const hasNotification = 'Notification' in window;
      let subscription: PushSubscription | null = null;
      if (hasServiceWorker && hasPushManager) {
        try {
          subscription = await currentPushSubscription();
        } catch (err) {
          logRequestFailure('push-device-control', { step: 'read' }, err);
          subscription = null;
        }
      }
      if (cancelled) return;
      const readPermission = hasNotification ? Notification.permission : null;
      const env: PushDeviceEnv = {
        vapidConfigured: vapidPublicKey !== null,
        install,
        hasServiceWorker,
        hasPushManager,
        hasNotification,
        permission: readPermission,
        subscribed: subscription !== null,
      };
      let resolved = classifyPushDevice(env);
      let resolvedNotice: PushNotice = null;
      // The browser's subscription says nothing about which account the
      // server delivers it to, or whether the server still holds it — the
      // previous account on a shared phone, or a row deleted since — so a
      // caller that asks to resync has a subscription that may still be
      // good re-recorded for the account signed in now.
      if (resolved === 'on' && subscription && vapidPublicKey) {
        if (subscriptionUsesKey(subscription, vapidPublicKey) === 'mismatch') {
          // Made with a key the server no longer signs with: it can receive
          // nothing, and a new one needs the user's tap.
          logRequestFailure('push-device-control', { step: 'stale-key' }, new Error('subscription made with another VAPID key'));
          await disablePush();
          resolved = 'off';
        } else if (resync && !(await syncPushSubscription(subscription)).ok) {
          // Still subscribed in the browser, and possibly still held by the
          // server; the next visit re-records it.
          resolvedNotice = 'unconfirmed';
        }
        if (cancelled) return;
      }
      setNotice(resolvedNotice);
      setPermission(readPermission);
      setState(resolved);
    }
    resolve().catch((err: unknown) => {
      logRequestFailure('push-device-control', { step: 'resolve' }, err);
      if (!cancelled) setState('unsupported');
    });
    return () => {
      cancelled = true;
    };
  }, [install, vapidPublicKey, resync]);

  return { state, permission, notice, setState, setNotice };
}
