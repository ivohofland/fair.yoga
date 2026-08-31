import { formatClassContext, formatDateShort } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';

interface ReceivedPaymentRowProps {
  paymentId: string;
  studentName: string;
  classType: string;
  classDate: Date;
  startTime: Date;
  /**
   * The raw instant, deliberately not pre-formatted.
   * `startOfLocalDay` runs *here* so the conversion sits inside the tested
   * unit; formatting it in the page would leave the bug this component exists
   * to fix untestable, because the page is an async server component RTL
   * cannot render.
   *
   * This matches `ClassList` and `ArchivedRecord`, which both take raw values
   * plus a `timeZone`. See #140, #154.
   */
  paidAt: Date | null;
  timeZone: string;
  amount: number;
}

/**
 * One Received row on the payments overview.
 *
 * A plain (non-client) component: unlike `OutstandingPaymentRow` it holds no
 * state — `MarkUnpaidButton` owns its own.
 */
export function ReceivedPaymentRow({
  paymentId,
  studentName,
  classType,
  classDate,
  startTime,
  paidAt,
  timeZone,
  amount,
}: ReceivedPaymentRowProps) {
  const classContext = formatClassContext(classType, classDate, startTime);
  return (
    <div className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-ink">{studentName}</p>
        <p className="type-caption">
          {classContext}
          {/*
            #140. `paidAt` is an *instant* — the moment "Mark paid" was tapped
            — not a calendar date, so it goes through `startOfLocalDay` before a
            UTC-accessor formatter sees it. Without that, a payment marked at
            18:00 Pacific on the 12th renders as the 13th.

            `classContext`'s date is the opposite case: `CalendarEntry.date` is a
            `@db.Date` calendar value already at midnight UTC, so it must *not*
            be converted. Two kinds of date in this one caption — see
            `src/lib/timezone.ts` for the rule.
          */}
          {paidAt && <> · ✓ paid {formatDateShort(startOfLocalDay(paidAt, timeZone))}</>}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="type-number">€{amount.toFixed(2)}</span>
        {/*
          #128. `studentName` and `classContext` are threaded through so every
          row's button has a distinct accessible name for screen readers.
        */}
        <MarkUnpaidButton
          paymentId={paymentId}
          studentName={studentName}
          classContext={classContext}
        />
      </div>
    </div>
  );
}
