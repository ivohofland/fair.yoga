'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

interface MarkSentControlProps {
  paymentId: string;
  /** The standing claim's sentence, formatted server-side in the teacher's zone; null when the student has not marked it sent. */
  claimedLine: string | null;
}

/**
 * The student's "I've sent it" on an outstanding Level 1 payment, and its
 * Undo. Success and refusal alike refresh the page, so a payment the teacher
 * has meanwhile settled re-renders as such; a refusal's message shows until
 * that refresh lands.
 */
export function MarkSentControl({ paymentId, claimedLine }: MarkSentControlProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function send(method: 'POST' | 'DELETE') {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/sent`, { method });
      if (!res.ok) {
        setMessage(await readErrorMessage(res, 'Could not save that. Try again.'));
      }
      router.refresh();
    } catch (err) {
      logRequestFailure('mark-sent-control', { paymentId, method }, err);
      setMessage('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6">
      {claimedLine === null ? (
        <Button variant="secondary" onClick={() => send('POST')} disabled={busy}>
          I&apos;ve sent it
        </Button>
      ) : (
        <p className="type-body">
          {claimedLine}{' '}
          <button type="button" onClick={() => send('DELETE')} disabled={busy} className="type-label text-teal">
            Undo
          </button>
        </p>
      )}
      <p role="status" className="type-caption text-danger mt-1">
        {message}
      </p>
    </div>
  );
}
