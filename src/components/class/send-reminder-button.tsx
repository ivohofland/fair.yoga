'use client';

import { useState } from 'react';
import { readErrorMessage } from '@/lib/client-errors';

interface SendReminderButtonProps {
  paymentId: string;
  studentName: string;
  /**
   * Appended to the aria-label so two rows for the same student stay
   * tellable apart — a student can owe on more than one class. Pass `null`
   * on a surface already scoped to a single class (the class checklist),
   * where the class/date would be noise. Required, not optional: a new
   * cross-class surface that forgets it silently reintroduces the
   * duplicate-label bug this prop exists to prevent.
   */
  context: string | null;
  /** Reports the fresh stamp so the parent can render the "Reminded …" caption. */
  onSent: (remindedAt: Date) => void;
  /**
   * Reports send failures ('' clears). The parent renders them in the row's
   * text column, not the fixed action cluster, so a long message can't
   * overflow the row on a phone.
   */
  onError: (message: string) => void;
}

/**
 * The manual nudge for an outstanding payment (teacher-screens 7.2, IA
 * Flow 4). A send stamps `Payment.reminderSentAt`, which the parent renders
 * as the calm "Reminded …" caption — the only pressure against nagging,
 * since no cooldown is enforced. The stamp also defers the automatic dunning
 * sweep by `REMIND_EVERY_DAYS` (`services/payment-reminders.ts`): a send on a
 * `pending` payment stamps it too, and because `markOverduePayments` never
 * clears the stamp, that deferral carries through when the payment later flips
 * to overdue — so a manual send resets the weekly clock rather than adding to
 * it.
 *
 * A controlled trigger: the parent owns the reminded state (so it survives a
 * mark-paid → undo remount) and both the caption and any error render in the
 * row's text column, where they can't overflow the action cluster on a phone.
 */
export function SendReminderButton({
  paymentId,
  studentName,
  context,
  onSent,
  onError,
}: SendReminderButtonProps) {
  const [busy, setBusy] = useState(false);

  async function handleSend() {
    setBusy(true);
    onError('');

    let res: Response;
    try {
      res = await fetch(`/api/payments/${paymentId}/remind`, { method: 'POST' });
    } catch (err) {
      console.error('[send-reminder] request failed', { paymentId, err });
      onError('Network error. Try again.');
      setBusy(false);
      return;
    }

    if (!res.ok) {
      onError(await readErrorMessage(res, 'Could not send. Try again.'));
      setBusy(false);
      return;
    }

    // The server commits the notification + stamp before it responds, so past
    // this point the reminder HAS been sent. A malformed or field-less body
    // must not be dressed up as a failure — that would provoke a second,
    // duplicate nudge.
    try {
      const json = (await res.json()) as { data: { reminderSentAt: string } };
      if (typeof json?.data?.reminderSentAt !== 'string') {
        throw new Error('missing reminderSentAt');
      }
      onSent(new Date(json.data.reminderSentAt));
    } catch (err) {
      console.error('[send-reminder] sent, but the response was unreadable', { paymentId, err });
      onError('Reminder sent — reload to confirm before sending again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSend}
      disabled={busy}
      aria-label={`Send reminder to ${studentName}${context ? ` for ${context}` : ''}`}
      className="type-caption text-teal min-h-[44px] px-1"
    >
      {busy ? 'Sending...' : 'Send reminder'}
    </button>
  );
}
