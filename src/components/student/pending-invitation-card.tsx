'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SettledNotice } from '@/components/ui/settled-notice';
import { readErrorMessage } from '@/lib/client-errors';

interface PendingInvitationCardProps {
  invitationId: string;
  teacherName: string;
}

/**
 * The student's side of #166: the only place a pending `Invitation` can be
 * answered. Accept creates the `TeacherStudent` link server-side; decline
 * is final from this screen (`declineInvitation`,
 * services/invitations.ts) — the way back is booking one of the teacher's
 * classes, or joining a waitlist for one, either of which
 * `resolveInvitationOnLink` turns into acceptance.
 * `router.refresh()` on either outcome is what moves the answered
 * invitation out of this list and, for an accept, the teacher into the
 * privacy list below.
 */
export function PendingInvitationCard({ invitationId, teacherName }: PendingInvitationCardProps) {
  const router = useRouter();
  const [confirmingDecline, setConfirmingDecline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<'accept' | 'decline' | null>(null);

  async function respond(response: 'accept' | 'decline') {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/invitations/${invitationId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      if (res.ok) {
        // #40, superseding review F7. F7 was right that a `finally` reset is
        // wrong here — the answer has committed, so a second click earns a 409
        // (`ALREADY_ANSWERED`) in red over an action that worked. Its remedy
        // was to leave `submitting` true, which froze all four controls when
        // the refresh never committed: a student could give neither answer.
        // Settling blocks the second POST the same way and still leaves them
        // somewhere they can act.
        setDone(response);
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not respond. Try again.'));
      setSubmitting(false);
    } catch {
      setError('Network error. Try again.');
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <section className="bg-sand-soft border border-border rounded-card p-5">
        <h3 className="type-label text-ink font-semibold mb-2">{teacherName}</h3>
        <SettledNotice
          label={done === 'accept' ? 'Accepted' : 'Declined'}
          actionLabel="Refresh"
          onAction={() => router.refresh()}
        />
      </section>
    );
  }

  return (
    <section className="bg-sand-soft border border-border rounded-card p-5">
      {/* h3: subordinate to the page's "Pending invitations" h2 (review F8) */}
      <h3 className="type-label text-ink font-semibold mb-2">{teacherName}</h3>

      {confirmingDecline ? (
        <div className="flex flex-col gap-3">
          <p className="type-body">
            Declining can&apos;t be undone here — the way back is booking one of{' '}
            {teacherName}&apos;s classes.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="destructive" onClick={() => respond('decline')} disabled={submitting}>
              {submitting ? 'Declining...' : 'Decline invitation'}
            </Button>
            {/*
              #40. Not disabled by `submitting`: a pure client-side reset, and
              the only way out of this confirm if the POST hangs rather than
              resolving — a case the settled state cannot reach.
            */}
            <Button variant="secondary" onClick={() => setConfirmingDecline(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="type-body">
            Accepting lets {teacherName} add you to their classes. You choose what they can see
            next — no contact details are shared until you say so.
          </p>
          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={() => respond('accept')} disabled={submitting}>
              {submitting ? 'Accepting...' : 'Accept'}
            </Button>
            <button
              type="button"
              onClick={() => setConfirmingDecline(true)}
              disabled={submitting}
              className="type-label text-danger disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {error && <p className="type-caption text-danger mt-2">{error}</p>}
    </section>
  );
}
