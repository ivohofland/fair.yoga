'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { listRowClass } from '@/components/ui/list-row';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { EXCLUSION_COPY, MOLLIE_METHODS, exclusionReason } from '@/lib/processor-methods';
import type { MollieReturn } from '@/lib/mollie-return';
import type { ConnectionView } from '@/services/processor-connection';

interface MollieConnectionSectionProps {
  teacherId: string;
  /** Whether Mollie is configured on this server; the section renders nothing when it is not. */
  configured: boolean;
  view: ConnectionView;
  /** What the OAuth callback reported, from the page's `mollie` query parameter. */
  status: MollieReturn | null;
}

const RETURN_COPY = {
  connected: 'Mollie is connected.',
  choose: 'Choose which Mollie profile students’ payments go to.',
  expired: 'That Mollie sign-in link expired. Connect again.',
  cancelled: 'Connecting Mollie was cancelled.',
  unavailable: 'Mollie couldn’t be reached. Try connecting again in a moment.',
} as const satisfies Record<MollieReturn, string>;

const NETWORK_ERROR = 'Network error. Please try again.';

/**
 * The Mollie block on the profile settings: connect, choose the profile whose
 * balance payments go to, see what students are offered, and disconnect.
 */
export function MollieConnectionSection({ teacherId, configured, view, status }: MollieConnectionSectionProps) {
  if (!configured) return null;
  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 className="type-subtitle">Mollie</h2>
      {status !== null && <p role="status" className="type-caption text-teal">{RETURN_COPY[status]}</p>}
      <ViewBody teacherId={teacherId} view={view} />
    </section>
  );
}

function ViewBody({ teacherId, view }: { teacherId: string; view: ConnectionView }) {
  switch (view.kind) {
    case 'none':
      return (
        <>
          <p className="type-body">
            Let students pay you by iDEAL, card and more through your own Mollie account. Money goes straight to you; Mollie
            charges you its fees.
          </p>
          <ConnectButton teacherId={teacherId} label="Connect Mollie" />
        </>
      );
    case 'choose_profile':
      return (
        <>
          {view.profiles.length === 0 ? (
            <p className="type-body">Create a website profile in Mollie first, then connect again.</p>
          ) : (
            <ProfilePicker teacherId={teacherId} profiles={view.profiles} current={null} />
          )}
          <DisconnectControl teacherId={teacherId} />
        </>
      );
    case 'connected':
      return <ConnectedBody teacherId={teacherId} view={view} />;
    case 'unavailable':
      return (
        <>
          <p className="type-body">Mollie can’t be reached right now.</p>
          <DisconnectControl teacherId={teacherId} />
        </>
      );
    default: {
      const unhandled: never = view;
      throw new Error(`unhandled connection view: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
}

function ConnectedBody({ teacherId, view }: { teacherId: string; view: Extract<ConnectionView, { kind: 'connected' }> }) {
  const [changing, setChanging] = useState(false);
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="type-body">Mollie connected — {view.organizationName} · {view.profileName}</p>
        {view.testmode && <p className="type-caption">Test mode</p>}
      </div>
      {view.missingScopes.length > 0 ? (
        <>
          <p className="type-body">Reconnect Mollie to enable payments.</p>
          <ConnectButton teacherId={teacherId} label="Reconnect Mollie" />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <h3 className="type-label">Students can pay by</h3>
            {view.offered.length === 0 ? (
              <p className="type-caption">No method you have enabled in Mollie is one fair.yoga offers.</p>
            ) : (
              <ul className="flex flex-col">
                {view.offered.map((id) => (
                  <li key={id} className={listRowClass({ className: 'flex items-center' })}>
                    <span className="type-body">{MOLLIE_METHODS[id].label}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {view.excluded.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="type-label">Not shown to students</h3>
              <ul className="flex flex-col">
                {view.excluded.map((id) => (
                  <li key={id} className={listRowClass({ className: 'flex flex-col justify-center' })}>
                    <span className="type-body">{id}</span>
                    <span className="type-caption">{EXCLUSION_COPY[exclusionReason(id)]}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.offered.includes('wero') && <p className="type-caption">Wero payments can be disputed for up to 120 days.</p>}
          <p className="type-caption">Mollie deducts its fees from each payment; you see the net amount in Mollie.</p>
        </>
      )}
      {view.profiles.length > 1 &&
        (changing ? (
          <div className="flex flex-col gap-2">
            <p className="type-caption">Payments then go to that profile’s Mollie balance.</p>
            <ProfilePicker teacherId={teacherId} profiles={view.profiles} current={view.profileId} />
          </div>
        ) : (
          <Button type="button" variant="secondary" onClick={() => setChanging(true)}>Change profile</Button>
        ))}
      <DisconnectControl teacherId={teacherId} />
    </>
  );
}

/** POSTs the connect and sends the browser to the Mollie consent screen it answers. */
function ConnectButton({ teacherId, label }: { teacherId: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/teachers/${teacherId}/processor/connect`, { method: 'POST' });
      if (!res.ok) {
        setError((await readError(res, 'Couldn’t start connecting Mollie.')).message);
        setBusy(false);
        return;
      }
      const json = (await res.json()) as { data: { authorizeUrl: string } };
      // Left busy: the page is about to be replaced by Mollie's.
      window.location.assign(json.data.authorizeUrl);
    } catch (err) {
      logRequestFailure('mollie-connection-section', { teacherId }, err);
      setError(NETWORK_ERROR);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void start()}>
        {busy ? 'Opening Mollie...' : label}
      </Button>
      {error && <p role="alert" className="type-caption text-danger">{error}</p>}
    </div>
  );
}

/** A radio list of the organization's profiles and the button that PUTs the choice. */
function ProfilePicker({ teacherId, profiles, current }: { teacherId: string; profiles: { id: string; name: string }[]; current: string | null }) {
  const router = useRouter();
  const name = useId();
  const [chosen, setChosen] = useState<string | null>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (chosen === null) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/teachers/${teacherId}/processor/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId: chosen }),
      });
      if (!res.ok) {
        setError((await readError(res, 'Couldn’t save the profile.')).message);
        return;
      }
      router.refresh();
    } catch (err) {
      logRequestFailure('mollie-connection-section', { teacherId }, err);
      setError(NETWORK_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <fieldset>
        <legend className="type-label">Which profile should students’ payments go to?</legend>
        {profiles.map((profile) => (
          <label key={profile.id} className="flex items-center gap-3 min-h-12">
            <input
              type="radio"
              name={name}
              value={profile.id}
              checked={chosen === profile.id}
              onChange={() => setChosen(profile.id)}
              className="w-5 h-5 accent-teal"
            />
            <span className="type-body">{profile.name}</span>
          </label>
        ))}
      </fieldset>
      {error && <p role="alert" className="type-caption text-danger">{error}</p>}
      <Button type="submit" variant="secondary" disabled={saving || chosen === null || chosen === current}>
        {saving ? 'Saving...' : 'Use this profile'}
      </Button>
    </form>
  );
}

/** A text trigger, then an inline confirmation: nothing is sent on the first tap. */
function DisconnectControl({ teacherId }: { teacherId: string }) {
  const router = useRouter();
  const questionId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/teachers/${teacherId}/processor`, { method: 'DELETE' });
      if (!res.ok) {
        setError((await readError(res, 'Couldn’t disconnect Mollie.')).message);
        return;
      }
      setConfirming(false);
      router.refresh();
    } catch (err) {
      logRequestFailure('mollie-connection-section', { teacherId }, err);
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p id={questionId} className="text-sm text-brown">
            Disconnect Mollie? Students will see your other payment options. Payments already started can still finish.
          </p>
          <div className="flex gap-3">
            <Button type="button" variant="destructive" aria-describedby={questionId} disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Disconnecting...' : 'Disconnect Mollie'}
            </Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="type-label text-danger self-start">
          Disconnect
        </button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
