'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { isRefusal, logRequestFailure, readError, readErrorMessage } from '@/lib/client-errors';

interface WaitlistEntryActionsProps {
  entryId: string;
  classId: string;
  /**
   * The class and when it runs, e.g. "Yin, Friday, 17 Oct 18:00", read aloud after each
   * button's visible text so a screen reader can tell one row's buttons from
   * the next.
   */
  classLabel: string;
  /** True during the first-come-first-claimed window with a free seat. */
  canClaim: boolean;
}

/**
 * Claim an open spot (final hour before class — first claim wins) or leave
 * the waitlist. Leaving asks first: a place given up is not given back, and
 * rejoining goes to the back of the queue. The confirmation takes focus when
 * it opens, and the trigger gets it back when the student stays.
 */
export function WaitlistEntryActions({ entryId, classId, classLabel, canClaim }: WaitlistEntryActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<'claim' | 'leave' | null>(null);
  const [error, setError] = useState('');
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const questionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set by "Stay on the waitlist", so focus returns to the trigger once it is back.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirmingLeave) {
      if (busy === null) confirmRef.current?.focus();
      return;
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [confirmingLeave, busy]);

  function stay() {
    returnFocus.current = true;
    setConfirmingLeave(false);
  }

  async function handleClaim() {
    setBusy('claim');
    setError('');
    try {
      const res = await fetch('/api/waitlist/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not claim the spot. Try again.'));
      // A refusal means this page was out of date — the spot was taken, the
      // window moved on. Read it again so the row stops offering the claim;
      // the message stays.
      if (isRefusal(res)) router.refresh();
    } catch (err) {
      logRequestFailure('waitlist-entry-actions-claim', { classId, entryId }, err);
      setError('Network error. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function handleLeave() {
    setBusy('leave');
    setError('');
    try {
      const res = await fetch(`/api/waitlist/${entryId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const { code, message } = await readError(res, 'Could not leave the waitlist. Try again.');
      // A waitlist spot that no longer exists is as left as this button can make it.
      if (code === 'NOT_FOUND') {
        router.refresh();
        return;
      }
      setError(message);
      // As for a refused claim: the row on screen is out of date.
      if (isRefusal(res)) router.refresh();
    } catch (err) {
      logRequestFailure('waitlist-entry-actions-leave', { entryId }, err);
      setError('Network error. Try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {canClaim && (
        <div>
          <p className="type-caption text-teal mb-2">
            A spot opened up — the first to claim it gets it.
          </p>
          {/* Every claim lands past the cancel deadline — #236's free-cancel
              grace is for an auto-promotion, never for the student's own
              claim — so this is said before the button, not after a tap. */}
          <p className="type-caption mb-2">
            Claiming books you in, and you&apos;ll pay your share even if you can&apos;t make it.
          </p>
          <Button onClick={handleClaim} disabled={busy !== null}>
            {busy === 'claim' ? 'Claiming...' : (
              <>Claim the spot{' '}<span className="sr-only">for {classLabel}</span></>
            )}
          </Button>
        </div>
      )}
      {confirmingLeave ? (
        <div className="flex flex-col gap-2">
          <p id={questionId} className="text-sm text-brown">
            Leave the waitlist? You&apos;ll lose your place in the queue.
          </p>
          <div className="flex gap-3">
            <Button
              ref={confirmRef}
              type="button"
              variant="destructive"
              aria-describedby={questionId}
              onClick={handleLeave}
              disabled={busy !== null}
            >
              {busy === 'leave' ? 'Leaving...' : (
                <>Leave{' '}<span className="sr-only">the waitlist for {classLabel}</span></>
              )}
            </Button>
            <Button type="button" variant="secondary" onClick={stay} disabled={busy !== null}>
              Stay on the waitlist
            </Button>
          </div>
        </div>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setConfirmingLeave(true)}
          disabled={busy !== null}
          className="type-label text-danger self-start disabled:opacity-50"
        >
          Leave waitlist{' '}<span className="sr-only">for {classLabel}</span>
        </button>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
