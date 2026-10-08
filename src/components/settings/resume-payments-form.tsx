'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';

type State = { kind: 'ready' } | { kind: 'resuming' } | { kind: 'resumed' } | { kind: 'refused'; message: string };

const linkClass =
  'text-teal underline decoration-[0.5px] underline-offset-[3px] rounded-field focus:outline-none focus-visible:shadow-focus';

/**
 * The resume button. Sends back the fingerprint of the details the page
 * showed, so a change made since is refused; on that refusal the page reloads
 * with the details as they now stand.
 */
export function ResumePaymentsForm({ teacherId, fingerprint }: { teacherId: string; fingerprint: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'ready' });

  async function handleResume() {
    setState({ kind: 'resuming' });
    try {
      const res = await fetch(`/api/teachers/${encodeURIComponent(teacherId)}/payments-resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint }),
      });
      if (res.ok) {
        setState({ kind: 'resumed' });
        return;
      }
      const { code, message } = await readError(res, 'Something went wrong, and payments are still paused. Please try again.');
      if (code === 'PAYOUT_DETAILS_CHANGED') router.refresh();
      setState({ kind: 'refused', message });
    } catch (err) {
      logRequestFailure('resume-payments', {}, err);
      setState({ kind: 'refused', message: 'Something went wrong, and payments are still paused. Please try again.' });
    }
  }

  if (state.kind === 'resumed') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="type-subtitle">Payments are running again</p>
        <p className="type-body">
          Students with an outstanding payment have been told they can pay.{' '}
          <Link href="/schedule" className={linkClass}>Back to your schedule</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button type="button" onClick={handleResume} disabled={state.kind === 'resuming'} className="w-full">
        Resume payments
      </Button>
      {state.kind === 'refused' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
