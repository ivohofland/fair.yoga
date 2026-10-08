'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SignOutButton } from '@/components/account/sign-out-button';
import { HandoffCodeEntry } from '@/components/auth/handoff-code-entry';
import { RECENT_AUTH_WINDOW_MS } from '@/lib/auth/recent-auth';
import { logRequestFailure, readError } from '@/lib/client-errors';

type LinkState = 'needed' | 'sending' | 'sent' | 'error';

type State =
  | { kind: 'ready' }
  | { kind: 'resuming' }
  | { kind: 'resumed' }
  | { kind: 'already' }
  | { kind: 'signed_out' }
  | { kind: 'refused'; message: string; signOut: boolean }
  | { kind: 'step_up'; link: LinkState };

/** Where this form lives; a sign-in from here comes back to it. */
export const RESUME_PATH = '/settings/resume-payments';

/** The sign-in page, returning to the resume screen afterwards. */
export const RESUME_SIGN_IN_PATH = `/login?redirect=${encodeURIComponent(RESUME_PATH)}` as const;

const RETRY_COPY = 'Something went wrong, and payments are still paused. Please try again.';
const RELOAD_COPY = 'This page is out of date, and payments are still paused. Reload this page, then resume.';

const linkClass =
  'text-teal underline decoration-[0.5px] underline-offset-[3px] rounded-field focus:outline-none focus-visible:shadow-focus';

/**
 * A stale session's way through when the pause requires a passkey, shown in
 * place of the server's copy; why the server's does not fit here:
 * `docs/technical-architecture.md`, "Recent authentication".
 */
export const PASSKEY_RECENT_AUTH_COPY =
  `For your security, sign out and sign in again with your passkey, then resume within ${RECENT_AUTH_WINDOW_MS / 60_000} minutes.`;

/** Whether a 200 is the route's unchanged answer: payments were not paused. */
async function isUnchanged(res: Response): Promise<boolean> {
  try {
    const json: unknown = await res.json();
    return typeof json === 'object' && json !== null && (json as { outcome?: unknown }).outcome === 'unchanged';
  } catch (err) {
    logRequestFailure('resume-payments', { step: 'read-outcome' }, err);
    return false;
  }
}

/**
 * The resume button. Sends back the fingerprint of the details the page
 * showed, so a change made since is refused; on that refusal the page reloads
 * with the details as they now stand. `passkeyRequired` is the review's: false
 * once the pause's fallback has opened. A stale session gets its way back in
 * here: an emailed sign-in link without a passkey requirement, a sign-out
 * toward the passkey with one, each returning to this page.
 */
export function ResumePaymentsForm({
  teacherId,
  fingerprint,
  passkeyRequired,
  accountId,
  email,
}: {
  teacherId: string;
  fingerprint: string;
  passkeyRequired: boolean;
  accountId: string;
  email: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'ready' });

  async function handleResume() {
    setState({ kind: 'resuming' });
    let res: Response;
    try {
      res = await fetch(`/api/teachers/${encodeURIComponent(teacherId)}/payments-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      });
    } catch (err) {
      logRequestFailure('resume-payments', {}, err);
      setState({ kind: 'refused', message: RETRY_COPY, signOut: false });
      return;
    }
    if (res.ok) {
      setState({ kind: (await isUnchanged(res)) ? 'already' : 'resumed' });
      router.refresh();
      return;
    }
    const { code, message } = await readError(res, RETRY_COPY);
    if (code === 'PAYOUT_DETAILS_CHANGED') {
      router.refresh();
      setState({ kind: 'refused', message, signOut: false });
      return;
    }
    if (code === 'RECENT_AUTH_REQUIRED') {
      setState(passkeyRequired
        ? { kind: 'refused', message: PASSKEY_RECENT_AUTH_COPY, signOut: true }
        : { kind: 'step_up', link: 'needed' });
      return;
    }
    if (code === 'PASSKEY_REQUIRED') {
      setState({ kind: 'refused', message, signOut: true });
      return;
    }
    logRequestFailure('resume-payments', { status: res.status, code }, new Error('resume refused'));
    if (res.status === 401) {
      setState({ kind: 'signed_out' });
      return;
    }
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      setState({ kind: 'refused', message: RELOAD_COPY, signOut: false });
      return;
    }
    setState({ kind: 'refused', message: res.status === 429 ? message : RETRY_COPY, signOut: false });
  }

  async function handleSendLink() {
    setState({ kind: 'step_up', link: 'sending' });
    try {
      const res = await fetch('/api/auth/magic-link/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirect: RESUME_PATH }),
      });
      if (!res.ok) {
        const { code } = await readError(res, 'send-link');
        logRequestFailure('resume-payments', { step: 'send-link', status: res.status, code }, new Error('send refused'));
        setState({ kind: 'step_up', link: 'error' });
        return;
      }
      setState({ kind: 'step_up', link: 'sent' });
    } catch (err) {
      logRequestFailure('resume-payments', { step: 'send-link' }, err);
      setState({ kind: 'step_up', link: 'error' });
    }
  }

  if (state.kind === 'resumed' || state.kind === 'already') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="type-subtitle">{state.kind === 'resumed' ? 'Payments are running again' : 'Payments are already running'}</p>
        <p className="type-body">
          {state.kind === 'resumed'
            ? 'Students with an outstanding payment have been told they can pay.'
            : 'They were resumed before this, perhaps from another tab or device.'}{' '}
          <Link href="/schedule" className={linkClass}>Back to your schedule</Link>
        </p>
      </div>
    );
  }

  if (state.kind === 'signed_out') {
    return (
      <p role="alert" className="type-body">
        You&rsquo;ve been signed out, and payments are still paused.{' '}
        <Link href={RESUME_SIGN_IN_PATH} className={linkClass}>Sign in again</Link> to resume.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button type="button" onClick={handleResume} disabled={state.kind === 'resuming'} className="w-full">
        Resume payments
      </Button>
      {state.kind === 'refused' && (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            {state.message}
          </p>
          {state.signOut && <SignOutButton accountId={accountId} redirectTo={RESUME_SIGN_IN_PATH} />}
        </div>
      )}
      {state.kind === 'step_up' && (
        <div className="flex flex-col items-start gap-2 rounded-card border border-border bg-sand-soft p-4">
          {state.link === 'sent' ? (
            <>
              <p className="type-body">Check {email} for a sign-in link. It brings you back here to resume.</p>
              <HandoffCodeEntry />
            </>
          ) : (
            <>
              <p className="type-body">
                For your security, sign in again before resuming. The link we email brings you back here.
              </p>
              <Button variant="secondary" onClick={handleSendLink} disabled={state.link === 'sending'}>
                {state.link === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </Button>
            </>
          )}
          {state.link === 'error' && (
            <p role="alert" className="text-[13px] text-danger">Could not send the sign-in link. Please try again.</p>
          )}
        </div>
      )}
    </div>
  );
}
