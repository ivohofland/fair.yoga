import { formatClassContext, formatDateShort, paymentStateText } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';

interface NotChargedPaymentRowProps {
  paymentId: string;
  studentName: string;
  classType: string;
  classDate: Date;
  startTime: Date;
  /**
   * The raw instant, deliberately not pre-formatted — `startOfLocalDay` runs
   * here so the conversion sits inside the tested unit.
   */
  notChargedAt: Date | null;
  timeZone: string;
  amount: number;
}

/**
 * One Not charged row on the payments overview.
 *
 * `MarkUnpaidButton` is the reversal: not charged means no longer owed, and
 * undoing it means owed again.
 */
export function NotChargedPaymentRow({
  paymentId,
  studentName,
  classType,
  classDate,
  startTime,
  notChargedAt,
  timeZone,
  amount,
}: NotChargedPaymentRowProps) {
  const classContext = formatClassContext(classType, classDate, startTime);
  const stateText = paymentStateText('not_charged');
  return (
    <div className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-ink">{studentName}</p>
        <p className="type-caption">
          {classContext}
          {notChargedAt && <> · {formatDateShort(startOfLocalDay(notChargedAt, timeZone))}</>}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`type-caption ${stateText.className}`}>{stateText.label}</span>
        <span className="type-number">€{amount.toFixed(2)}</span>
        <MarkUnpaidButton
          paymentId={paymentId}
          studentName={studentName}
          classContext={classContext}
        />
      </div>
    </div>
  );
}
