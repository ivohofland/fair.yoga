'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

interface MarkSentControlProps {
  paymentId: string;
  /** The standing claim's sentence, ready to show; null when the student has not marked it sent. */
  claimedLine: string | null;
}

interface StatusMessage {
  text: string;
  tone: 'confirm' | 'refusal';
}

const CONFIRMATION: Record<'POST' | 'DELETE', string> = {
  POST: 'Marked as sent.',
  DELETE: 'Marked as not sent.',
};

/**
 * The student's "I've sent it" on an outstanding Level 1 payment, and its
 * Undo. Success and refusal alike call `router.refresh()`; a refusal's
 * message shows until that refresh lands. A success is announced in the
 * status region, and once the refreshed `claimedLine` arrives focus moves to
 * the control that replaced the one pressed.
 */
export function MarkSentControl({ paymentId, claimedLine }: MarkSentControlProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const sentButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  /** Set on success: the claim state whose arrival moves focus to its control. */
  const awaitedClaimed = useRef<boolean | null>(null);
  const claimed = claimedLine !== null;

  useEffect(() => {
    if (busy || awaitedClaimed.current !== claimed) return;
    awaitedClaimed.current = null;
    (claimed ? undoButton.current : sentButton.current)?.focus();
  }, [claimed, busy]);

  async function send(method: 'POST' | 'DELETE') {
    setBusy(true);
    setMessage(null);
    awaitedClaimed.current = null;
    let res: Response;
    try {
      res = await fetch(`/api/payments/${paymentId}/sent`, { method });
    } catch (err) {
      logRequestFailure('mark-sent-control', { paymentId, method }, err);
      setMessage({ text: 'Network error. Try again.', tone: 'refusal' });
      setBusy(false);
      return;
    }
    if (res.ok) {
      setMessage({ text: CONFIRMATION[method], tone: 'confirm' });
      awaitedClaimed.current = method === 'POST';
    } else {
      setMessage({ text: await readErrorMessage(res, 'Could not save that. Try again.'), tone: 'refusal' });
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="mb-6">
      {claimed ? (
        <p className="type-body">
          {claimedLine}{' '}
          <button
            ref={undoButton}
            type="button"
            onClick={() => send('DELETE')}
            disabled={busy}
            className="type-label text-teal min-h-[44px] px-1"
          >
            Undo
          </button>
        </p>
      ) : (
        <Button ref={sentButton} variant="secondary" onClick={() => send('POST')} disabled={busy}>
          I&apos;ve sent it
        </Button>
      )}
      <p role="status" className={`type-caption mt-1 ${message?.tone === 'confirm' ? 'text-brown' : 'text-danger'}`}>
        {message?.text ?? ''}
      </p>
    </div>
  );
}
