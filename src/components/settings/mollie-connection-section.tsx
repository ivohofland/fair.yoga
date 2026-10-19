'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { listRowClass } from '@/components/ui/list-row';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { EXCLUSION_COPY, MOLLIE_METHODS, exclusionReason } from '@/lib/processor-methods';
import type { MollieReturn } from '@/lib/mollie-return';
import type { ConnectionView, ProfileOption } from '@/services/processor-connection';
import { RemoveControl } from './remove-control';

interface MollieConnectionSectionProps {
  teacherId: string;
  view: ConnectionView;
  /** What the OAuth callback reported, from the page's `mollie` query parameter. */
  status: MollieReturn | null;
}

const SETTINGS_PATH = '/settings/profile';

/** Each return's line, and whether it reports success (teal) or not (brown). */
const RETURN_COPY = {
  connected: { text: 'Mollie is connected.', tone: 'text-teal' },
  choose: { text: 'Choose which Mollie profile students’ payments go to.', tone: 'text-teal' },
  expired: { text: 'That Mollie sign-in link expired. Connect again.', tone: 'text-brown' },
  cancelled: { text: 'Connecting Mollie was cancelled.', tone: 'text-brown' },
  unavailable: { text: 'Mollie couldn’t be reached. Try connecting again in a moment.', tone: 'text-brown' },
} as const satisfies Record<MollieReturn, { text: string; tone: 'text-teal' | 'text-brown' }>;

const NETWORK_ERROR = 'Network error. Please try again.';

/** Whether `value` is a string holding an absolute https URL. */
function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';
}

/**
 * The Mollie block on the profile settings: connect, choose the profile whose
 * balance payments go to, see what students are offered, and disconnect. A
 * change made here re-renders the page without its `mollie` parameter, so a
 * return status never outlives the state it described.
 */
export function MollieConnectionSection({ teacherId, view, status }: MollieConnectionSectionProps) {
  const router = useRouter();
  const headingRef = useRef<HTMLHeadingElement>(null);

  function changed() {
    // The control that had focus is gone; the section's heading is where the outcome shows.
    headingRef.current?.focus();
    router.replace(SETTINGS_PATH);
  }

  // The choose line invites a choice the picker below cannot offer when nothing is choosable.
  const nothingToChoose = view.kind === 'choose_profile' && view.profiles.length > 0 && view.profiles.every((p) => !p.choosable);
  const showStatus = status !== null && !(status === 'choose' && nothingToChoose);

  return (
    <section className="mt-10 pt-6 border-t border-border flex flex-col gap-4">
      <h2 ref={headingRef} tabIndex={-1} className="type-subtitle focus:outline-none">Mollie</h2>
      {showStatus && status !== null && <p role="status" className={`type-caption ${RETURN_COPY[status].tone}`}>{RETURN_COPY[status].text}</p>}
      <ViewBody teacherId={teacherId} view={view} onChanged={changed} />
    </section>
  );
}

function ViewBody({ teacherId, view, onChanged }: { teacherId: string; view: ConnectionView; onChanged: () => void }) {
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
            <>
              <p className="type-body">Create a website profile in Mollie first, then connect again.</p>
              <ConnectButton teacherId={teacherId} label="Connect again" />
            </>
          ) : (
            <>
              {view.profiles.every((p) => !p.choosable) && (
                <p className="type-body">Mollie hasn’t verified any of your profiles yet. Once it has, come back here to choose one.</p>
              )}
              <ProfilePicker teacherId={teacherId} profiles={view.profiles} current={null} onChosen={onChanged} />
            </>
          )}
          <DisconnectControl teacherId={teacherId} onDisconnected={onChanged} />
        </>
      );
    case 'connected':
      return <ConnectedBody teacherId={teacherId} view={view} onChanged={onChanged} />;
    case 'unavailable':
      return (
        <>
          <p className="type-body">Mollie can’t be reached right now.</p>
          <ConnectButton teacherId={teacherId} label="Reconnect" />
          <DisconnectControl teacherId={teacherId} onDisconnected={onChanged} />
        </>
      );
    default: {
      const unhandled: never = view;
      throw new Error(`unhandled connection view: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
}

function ConnectedBody({
  teacherId, view, onChanged,
}: { teacherId: string; view: Extract<ConnectionView, { kind: 'connected' }>; onChanged: () => void }) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="type-body">Mollie connected — {view.organizationName} · {view.profileName}</p>
        {view.testmode && <p className="type-caption">Test mode</p>}
      </div>
      {!view.takesPayments ? (
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
              <h3 className="type-label">Not offered</h3>
              <ul className="flex flex-col">
                {view.excluded.map(({ id, description }) => (
                  <li key={id} className={listRowClass({ className: 'flex flex-col justify-center' })}>
                    <span className="type-body">{description ?? id}</span>
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
      {view.profiles.length > 1 && (
        <ChangeProfileControl teacherId={teacherId} profiles={view.profiles} current={view.profileId} onChosen={onChanged} />
      )}
      <DisconnectControl teacherId={teacherId} onDisconnected={onChanged} />
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
      const authorizeUrl = ((await res.json()) as { data?: { authorizeUrl?: unknown } }).data?.authorizeUrl;
      if (!isHttpsUrl(authorizeUrl)) {
        setError(RETURN_COPY.unavailable.text);
        setBusy(false);
        return;
      }
      // Left busy: the page is about to be replaced by Mollie's.
      window.location.assign(authorizeUrl);
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

/**
 * The Change profile trigger, then the picker in its place. Opening focuses
 * the current profile's radio, or the first choosable one when the current is
 * not choosable; Cancel hands focus back to the trigger.
 */
function ChangeProfileControl({
  teacherId, profiles, current, onChosen,
}: { teacherId: string; profiles: ProfileOption[]; current: string; onChosen: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!open && returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return (
      <Button ref={triggerRef} type="button" variant="secondary" onClick={() => setOpen(true)}>Change profile</Button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="type-caption">Payments then go to that profile’s Mollie balance.</p>
      <ProfilePicker
        teacherId={teacherId}
        profiles={profiles}
        current={current}
        autoFocus
        onChosen={onChosen}
        onCancel={() => { returnFocus.current = true; setOpen(false); }}
      />
    </div>
  );
}

/** A radio list of the organization's profiles and the button that PUTs the choice. */
function ProfilePicker({
  teacherId, profiles, current, autoFocus = false, onChosen, onCancel,
}: {
  teacherId: string;
  profiles: ProfileOption[];
  current: string | null;
  autoFocus?: boolean;
  onChosen: () => void;
  onCancel?: () => void;
}) {
  const name = useId();
  const [chosen, setChosen] = useState<string | null>(current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const target = fieldsetRef.current?.querySelector<HTMLInputElement>('input:checked:not(:disabled)') ?? fieldsetRef.current?.querySelector<HTMLInputElement>('input:not(:disabled)');
    target?.focus();
  }, [autoFocus]);

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
      onChosen();
    } catch (err) {
      logRequestFailure('mollie-connection-section', { teacherId }, err);
      setError(NETWORK_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <fieldset ref={fieldsetRef}>
        <legend className="type-label">Which profile should students’ payments go to?</legend>
        {profiles.map((profile) => (
          <label key={profile.id} className="flex items-center gap-3 min-h-12">
            <input
              type="radio"
              name={name}
              value={profile.id}
              checked={chosen === profile.id}
              disabled={!profile.choosable}
              aria-labelledby={`${name}-${profile.id}-name`}
              aria-describedby={[
                profile.website !== null ? `${name}-${profile.id}-website` : null,
                profile.choosable ? null : `${name}-${profile.id}-unverified`,
              ].filter((id) => id !== null).join(' ') || undefined}
              onChange={() => setChosen(profile.id)}
              className="w-5 h-5 accent-teal"
            />
            <span className="flex flex-col">
              <span id={`${name}-${profile.id}-name`} className="type-body">{profile.name}</span>
              {profile.website !== null && <span id={`${name}-${profile.id}-website`} className="type-caption">{profile.website}</span>}
              {!profile.choosable && (
                <span id={`${name}-${profile.id}-unverified`} className="type-caption">Mollie hasn’t verified this profile yet.</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      {profiles.some((p) => !p.choosable) && (
        <p className="type-caption">
          Mollie checks each profile by hand before it can take payments. Teaching in person without a website? In Mollie, choose the option for businesses without a website, describe your classes, and link your fair.yoga page or your social media.{' '}
          <a href="https://help.mollie.com/hc/en-us/articles/211745545" target="_blank" rel="noopener noreferrer" className="underline">What Mollie checks</a>
        </p>
      )}
      {error && <p role="alert" className="type-caption text-danger">{error}</p>}
      <div className="flex gap-3">
        <Button type="submit" variant="secondary" disabled={saving || chosen === null || chosen === current}>
          {saving ? 'Saving...' : 'Use this profile'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
        )}
      </div>
    </form>
  );
}

/** Disconnect through `RemoveControl`: a text trigger, then an inline confirmation. */
function DisconnectControl({ teacherId, onDisconnected }: { teacherId: string; onDisconnected: () => void }) {
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
      onDisconnected();
    } catch (err) {
      logRequestFailure('mollie-connection-section', { teacherId }, err);
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <RemoveControl
      label="Mollie"
      verb="Disconnect"
      busyVerb="Disconnecting..."
      question="Disconnect Mollie? Students will see your other payment options. Payments already started can still finish."
      confirming={confirming}
      removing={busy}
      disabled={busy}
      error={error}
      onAsk={() => { setError(''); setConfirming(true); }}
      onCancel={() => setConfirming(false)}
      onConfirm={() => void confirm()}
    />
  );
}
