'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { peekUnsubscribeKind, type UnsubscribeKind } from '@/lib/unsubscribe-kind';

type State = 'ready' | 'sending' | 'done' | 'invalid' | 'limited' | 'failed';

const STUDENT_SETTINGS = '/account/notifications';
const TEACHER_SETTINGS = '/settings/notifications';

const COPY = {
  student_notifications: {
    what: "You'll stop getting an email when a message in the app goes unread. Cancellations, waitlist spots and payment requests still come by email.",
    settings: STUDENT_SETTINGS,
  },
  teacher_bookings: {
    what: "You'll stop getting booking emails. New bookings still show in your inbox.",
    settings: TEACHER_SETTINGS,
  },
  teacher_class_completed: {
    what: "You'll stop getting an email when a class completes.",
    settings: TEACHER_SETTINGS,
  },
  teacher_invitations: {
    what: "You'll stop getting an email when someone invites you to connect.",
    settings: TEACHER_SETTINGS,
  },
  student_reminders: {
    what: 'Class reminders stop coming by email. If email was the only way you got them, reminders turn off.',
    settings: STUDENT_SETTINGS,
  },
  teacher_reminders: {
    what: 'Class reminders stop coming by email. If email was the only way you got them, reminders turn off.',
    settings: TEACHER_SETTINGS,
  },
  invitation: {
    what: "This declines the invitation, and that teacher can't add your address again.",
    settings: null,
  },
} as const satisfies Record<UnsubscribeKind, { what: string; settings: string | null }>;

/** The `t` parameter of the address's fragment, where the email puts the token. */
function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return token === null || token === '' ? null : token;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const linkClass =
  'text-teal underline decoration-[0.5px] underline-offset-[3px] rounded-field focus:outline-none focus-visible:shadow-focus';
const errorClass = 'text-[13px] leading-[1.4] text-danger';

function SettingsLink({ href }: { href: string }) {
  return (
    <Link href={href} className={linkClass}>notification settings</Link>
  );
}

/**
 * The one button that unsubscribes. The token is read from the fragment after
 * hydration and sent only when the button is pressed: a mail scanner that
 * opens the link changes nothing. Unsubscribing is idempotent, so a failed
 * attempt just offers the button again.
 */
export function UnsubscribeForm() {
  const [state, setState] = useState<State>('ready');
  // `undefined` on the server and through hydration: the fragment never
  // reaches the server.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => undefined);
  const token = hash === undefined ? null : tokenFromHash(hash);
  const kind = token === null ? null : peekUnsubscribeKind(token);
  // Dropping the fragment on success empties the hash the kind was read from.
  const [doneKind, setDoneKind] = useState<UnsubscribeKind | null>(null);
  const incomplete = hash !== undefined && (token === null || kind === null) && state !== 'done';

  async function handleUnsubscribe() {
    if (token === null) return;
    setState('sending');
    let res: Response;
    try {
      res = await fetch(`/api/unsubscribe?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        body: new URLSearchParams({ 'List-Unsubscribe': 'One-Click' }),
      });
    } catch (err) {
      logRequestFailure('unsubscribe', {}, err);
      setState('failed');
      return;
    }
    if (res.ok) {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (err) {
        // The opt-out committed; only dropping the spent token from the address failed.
        logRequestFailure('unsubscribe', { step: 'replace-state' }, err);
      }
      setDoneKind(kind);
      setState('done');
      return;
    }
    if (res.status === 429) {
      setState('limited');
      return;
    }
    // An empty fallback marks a body the app did not write.
    const { code } = await readError(res, '');
    if (code === 'UNSUBSCRIBE_LINK_INVALID') {
      setState('invalid');
      return;
    }
    logRequestFailure('unsubscribe', { status: res.status, code }, new Error('unsubscribe refused'));
    setState('failed');
  }

  if (state === 'invalid' || incomplete) {
    return (
      <div role="alert" className="flex flex-col gap-3">
        <p className="type-body">
          {state === 'invalid'
            ? 'This link no longer works. You can change what you get by email after signing in.'
            : 'This link is incomplete. Open it again from the email, or copy the whole address.'}
        </p>
        <p className="type-body">
          To choose what you get by email, <Link href="/login" className={linkClass}>sign in</Link> and open
          your notification settings.
        </p>
      </div>
    );
  }

  const shownKind = state === 'done' ? doneKind : kind;
  const copy = shownKind === null ? null : COPY[shownKind];

  if (state === 'done') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="type-subtitle">You&rsquo;re unsubscribed</p>
        <p className="type-body">
          {copy?.settings ? (
            <>
              You can change this any time in your <SettingsLink href={copy.settings} />.
            </>
          ) : (
            <>You&rsquo;ve declined the invitation. That teacher can&rsquo;t add your address again.</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {copy !== null && (
        <p className="type-body" data-testid="unsubscribe-what">{copy.what}</p>
      )}
      <Button
        type="button"
        onClick={handleUnsubscribe}
        disabled={token === null || state === 'sending'}
        className="w-full"
      >
        Unsubscribe
      </Button>
      {copy?.settings && (
        <p className="type-body">
          Or choose exactly what you get in your <SettingsLink href={copy.settings} />.
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className={errorClass}>
          Nothing changed. Please try again.
        </p>
      )}
      {state === 'limited' && (
        <p role="alert" className={errorClass}>
          Too many attempts from here. Wait a few minutes and try again.
        </p>
      )}
    </div>
  );
}
