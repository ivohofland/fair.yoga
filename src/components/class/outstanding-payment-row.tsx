'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { PaymentStatus } from '@prisma/client';
import { formatClassContext, paymentStateInlineText, paymentStateText, timeAgo } from '@/lib/format';
import { usePaymentActions } from '@/lib/use-payment-actions';
import { isOutstanding } from '@/lib/payment-status';
import { SendReminderButton } from '@/components/class/send-reminder-button';

interface OutstandingPaymentRowProps {
  paymentId: string;
  studentName: string;
  classId: string;
  classType: string;
  classDate: Date;
  startTime: Date;
  amount: number;
  status: PaymentStatus;
  reminderSentAt: Date | null;
}

/**
 * One Outstanding row on the payments overview. A client component because the
 * reminder button and the mark-paid action must share paid-state: once a
 * payment is marked paid the reminder button has to disappear, or a teacher
 * could dun a student they just marked as having paid. Mark-paid deliberately
 * does not refresh (the row keeps its transient Undo); a *successful* Undo
 * refreshes to reconcile the server-computed Outstanding/Received totals and
 * section split. The reminded caption is preserved by local state across that
 * refresh (which re-renders without remounting), not re-seeded from the server.
 */
export function OutstandingPaymentRow({
  paymentId,
  studentName,
  classId,
  classType,
  classDate,
  startTime,
  amount,
  status,
  reminderSentAt,
}: OutstandingPaymentRowProps) {
  const router = useRouter();
  const { paymentState, justMarked, updating, error, markPaid, markNotCharged, undo } =
    usePaymentActions({ [paymentId]: status });
  const [remindedAt, setRemindedAt] = useState<Date | null>(reminderSentAt);
  const [reminderError, setReminderError] = useState('');

  // #59, #154. Derived internally so all four consumers — visible caption,
  // reminder button context, undo aria-label, and mark-paid aria-label —
  // are guaranteed byte-identical from a single source of truth.
  const classContext = formatClassContext(classType, classDate, startTime);

  const current = paymentState[paymentId] ?? status;
  const isPaid = current === 'paid';
  const isNotCharged = current === 'not_charged';
  const outstanding = isOutstanding(current);
  const busy = updating === paymentId;

  return (
    <div className="py-2 border-b border-border last:border-b-0">
      <div className="flex items-center justify-between gap-3 min-h-14">
        <div className="min-w-0">
          <p className="text-base text-ink">{studentName}</p>
          <p className="type-caption">
            <Link href={`/class/${classId}`} className="no-underline text-brown-light">
              {classContext}
            </Link>
            {current === 'overdue' && (
              <span className={paymentStateInlineText('overdue').className}>
                {paymentStateInlineText('overdue').label}
              </span>
            )}
          </p>
          {remindedAt && <p className="type-caption">Reminded {timeAgo(remindedAt)}</p>}
          {outstanding && (
            <p className="type-caption mt-1 flex items-center gap-2">
              <SendReminderButton
                paymentId={paymentId}
                studentName={studentName}
                context={classContext}
                onSent={setRemindedAt}
                onError={setReminderError}
              />
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => markNotCharged(paymentId)}
                disabled={busy}
                className="type-caption text-teal min-h-[44px] px-1"
                // Visible text leads the accessible name for WCAG 2.5.3, matching
                // the shape Mark paid's aria-label uses below.
                aria-label={`Not charged — ${studentName}, ${classContext}`}
              >
                Not charged
              </button>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="type-number text-brown">€{amount.toFixed(2)}</span>
          {isPaid ? (
            <span className="inline-flex items-center gap-2">
              <span className={`type-caption ${paymentStateText('paid').className}`}>
                {paymentStateText('paid').label}
              </span>
              {justMarked.has(paymentId) && (
                <button
                  type="button"
                  onClick={async () => {
                    // Refresh only on success, so a failed undo keeps its error
                    // on screen instead of refreshing the row (and error) away.
                    if (await undo(paymentId)) router.refresh();
                  }}
                  disabled={busy}
                  className="type-caption text-teal min-h-[44px] px-1"
                  aria-label={`Undo marking ${studentName} as paid for ${classContext}`}
                >
                  Undo
                </button>
              )}
            </span>
          ) : isNotCharged ? (
            <span className="inline-flex items-center gap-2">
              <span className={`type-caption ${paymentStateText('not_charged').className}`}>
                {paymentStateText('not_charged').label}
              </span>
              {justMarked.has(paymentId) && (
                <button
                  type="button"
                  onClick={async () => {
                    // Refresh only on success, so a failed undo keeps its error
                    // on screen instead of refreshing the row (and error) away.
                    if (await undo(paymentId)) router.refresh();
                  }}
                  disabled={busy}
                  className="type-caption text-teal min-h-[44px] px-1"
                  aria-label={`Undo marking ${studentName} as not charged for ${classContext}`}
                >
                  Undo
                </button>
              )}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => markPaid(paymentId)}
              disabled={busy}
              className={`h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint ${busy ? 'opacity-50' : ''}`}
              // Leads with the visible label, deliberately breaking the "… for
              // {context}" shape the other two buttons share. WCAG 2.5.3
              // requires the visible text ("Mark paid") to appear contiguously
              // and in order inside the accessible name; the label this
              // replaced, "Mark {name} payment as paid", splits it and leaves
              // a speech-input user unable to activate a button they can read.
              // Leading with it goes further than the SC strictly demands —
              // "{name}, Mark paid" would also conform — because speech input
              // matches on a prefix in practice. The other two conform as
              // written, their visible text already starting their label, so
              // they were left alone rather than reshaped for symmetry.
              aria-label={`Mark paid — ${studentName}, ${classContext}`}
            >
              {busy ? 'Saving...' : 'Mark paid'}
            </button>
          )}
        </div>
      </div>
      {(error || reminderError) && (
        <p role="alert" className="type-caption text-danger mt-1">
          {error || reminderError}
        </p>
      )}
    </div>
  );
}
