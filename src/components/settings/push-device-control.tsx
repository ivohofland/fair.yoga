'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useInstallSupport } from '@/components/layout/install-store';
import { canOfferInstall } from '@/lib/install-support';
import { logRequestFailure } from '@/lib/client-errors';
import {
  classifyPushDevice,
  currentPushSubscription,
  disablePush,
  enablePush,
  type PushDeviceEnv,
  type PushDeviceState,
} from '@/lib/push-client';

/** The settings row that turns push on or off for this phone. Shows a
 *  placeholder until the effect below resolves the device's actual state. */
export function PushDeviceControl({
  vapidPublicKey,
  installHref,
}: {
  vapidPublicKey: string | null;
  /** Where this role's settings index offers the install steps (`InstallAppRow`, #723) — passed by the caller, which owns the role. */
  installHref: '/account' | '/settings';
}) {
  const install = useInstallSupport();
  const [state, setState] = useState<PushDeviceState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

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
          logRequestFailure('push-device-control', {}, err);
          subscription = null;
        }
      }
      if (cancelled) return;
      const env: PushDeviceEnv = {
        vapidConfigured: vapidPublicKey !== null,
        install,
        hasServiceWorker,
        hasPushManager,
        hasNotification,
        permission: hasNotification ? Notification.permission : null,
        subscribed: subscription !== null,
      };
      setState(classifyPushDevice(env));
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [install, vapidPublicKey]);

  async function handleEnable(): Promise<void> {
    if (!vapidPublicKey || busy) return;
    setBusy(true);
    setFailed(false);
    const outcome = await enablePush(vapidPublicKey);
    setBusy(false);
    if (outcome === 'failed') {
      setFailed(true);
      setState('off');
      return;
    }
    setState(outcome);
  }

  async function handleDisable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    await disablePush();
    setBusy(false);
    setFailed(false);
    setState('off');
  }

  if (state === null) {
    return <p data-testid="push-device-control-pending" className="type-caption min-h-12" />;
  }

  switch (state) {
    case 'unavailable':
      return <p className="type-body">Push notifications aren&apos;t available on this server yet.</p>;

    case 'needs-install': {
      // `install` carries the finer-grained InstallSupport value; a browser
      // with no install route at all (`unsupported`) has nowhere for this
      // link to lead, so the copy stands alone.
      const offerLink = canOfferInstall(install);
      return (
        <div className="flex flex-col gap-2">
          <p className="type-body">
            Notifications arrive in the fair.yoga app. Add it to your home screen to turn them on.
          </p>
          {offerLink && (
            <Link
              href={installHref}
              className="type-label text-teal no-underline inline-flex items-center min-h-12"
            >
              Add to Home Screen
            </Link>
          )}
        </div>
      );
    }

    case 'unsupported':
      return <p className="type-body">This browser can&apos;t receive notifications.</p>;

    case 'blocked':
      return (
        <p className="type-body">
          Notifications for fair.yoga are blocked in this phone&apos;s settings. Allow them there to turn this on.
        </p>
      );

    case 'on':
      return (
        <div className="flex flex-col gap-2">
          <p className="type-body">On for this phone</p>
          <Button variant="secondary" onClick={() => void handleDisable()} disabled={busy}>
            Turn off for this phone
          </Button>
        </div>
      );

    case 'off':
      return (
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => void handleEnable()} disabled={busy}>
            Turn on for this phone
          </Button>
          <p className="type-caption">
            You choose below which messages arrive. Email still comes as it does now.
          </p>
          {failed && (
            <p role="alert" className="type-caption text-danger">
              Notifications weren&apos;t turned on. Try again.
            </p>
          )}
        </div>
      );

    default: {
      const never: never = state;
      return never;
    }
  }
}
