'use client';

import { useState } from 'react';
import { timeAgo } from '@/lib/format';
import { readErrorMessage } from '@/lib/client-errors';

interface SendReminderButtonProps {
  paymentId: string;
  studentName: string;
  reminderSentAt: Date | null;
  context?: string;
}

/**
 * The manual nudge for an unpaid payment (teacher-screens 7.2, IA Flow
 * 4). No cooldown is enforced: the visible "Reminded ..." history is
 * the calm pressure against nagging, and the stamp already spaces the
 * automatic dunning sweep server-side. Local state only — the row
 * doesn't move sections, so no router.refresh.
 */
export function SendReminderButton({
  paymentId,
  studentName,
  reminderSentAt,
  context,
}: SendReminderButtonProps) {
  const [remindedAt, setRemindedAt] = useState<Date | null>(reminderSentAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSend() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/remind`, { method: 'POST' });
      if (res.ok) {
        const json = (await res.json()) as { data: { reminderSentAt: string | null } };
        setRemindedAt(json.data.reminderSentAt ? new Date(json.data.reminderSentAt) : new Date());
      } else {
        setError(await readErrorMessage(res, 'Could not send. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {remindedAt && <span className="type-caption">Reminded {timeAgo(remindedAt)}</span>}
      <button
        type="button"
        onClick={handleSend}
        disabled={busy}
        aria-label={`Send reminder to ${studentName}${context ? ` for ${context}` : ''}`}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        {busy ? 'Sending...' : 'Send reminder'}
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
