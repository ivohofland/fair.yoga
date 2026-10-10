'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useInstallSupport } from '@/components/layout/install-store';
import { canOfferInstall } from '@/lib/install-support';
import { disablePush, enablePush } from '@/lib/push-client';
import { usePushDevice } from './use-push-device';

/** The settings row that turns push on or off for this phone. Shows a
 *  placeholder until `usePushDevice` resolves the device's actual state. */
export function PushDeviceControl({
  vapidPublicKey,
  installHref,
}: {
  vapidPublicKey: string | null;
  /** Where the install steps are, for the caller's role. */
  installHref: '/account' | '/settings';
}) {
  const install = useInstallSupport();
  const { state, notice, setState, setNotice } = usePushDevice(vapidPublicKey, { resync: true });
  const [busy, setBusy] = useState(false);

  async function handleEnable(): Promise<void> {
    if (!vapidPublicKey || busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await enablePush(vapidPublicKey);
    setBusy(false);
    if (outcome === 'failed') {
      setNotice('enable-failed');
      setState('off');
      return;
    }
    setState(outcome);
  }

  async function handleDisable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await disablePush();
    setBusy(false);
    if (outcome === 'failed') {
      setNotice('disable-failed');
      return;
    }
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
          {notice === 'unconfirmed' && (
            <p className="type-caption">
              Couldn&apos;t reach fair.yoga to confirm this phone. It will try again next time.
            </p>
          )}
          {notice === 'disable-failed' && (
            <p role="alert" className="type-caption text-danger">
              Couldn&apos;t turn off notifications. Try again.
            </p>
          )}
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
          {notice === 'enable-failed' && (
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
