import type { Currency } from '@/lib/prisma-client';
import { formatClassContext, formatDateShort, formatMoney } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';
import { AttemptRefund, OtherAttempts } from '@/components/payments/attempt-refund';
import { settlingAttempt, type AttemptView } from '@/lib/processor-attempt-view';
import { ListRow } from '@/components/ui/list-row';

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
  currency: Currency;
  /** The payment's Mollie attempts (`TEACHER_ATTEMPT_SELECT`). */
  processorAttempts: AttemptView[];
}

/**
 * One Received row on the payments overview.
 *
 * A plain (non-client) component: unlike `OutstandingPaymentRow` it holds no
 * state — `MarkUnpaidButton` and `AttemptRefund` own their own.
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
  currency,
  processorAttempts,
}: ReceivedPaymentRowProps) {
  const classContext = formatClassContext(classType, classDate, startTime);
  const settling = settlingAttempt(processorAttempts);
  return (
    <ListRow className="flex items-center justify-between gap-3">
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
        <OtherAttempts
          paymentId={paymentId}
          attempts={processorAttempts.filter((a) => a !== settling)}
          studentName={studentName}
          classContext={classContext}
        />
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="type-number">{formatMoney(amount, currency)}</span>
        {/*
          #128. `studentName` and `classContext` are threaded through so every
          row's button has a distinct accessible name for screen readers.
        */}
        {/* Decision 17: a payment Mollie settled leaves `paid` by a refund, not "Mark unpaid". */}
        {settling ? (
          <AttemptRefund
            paymentId={paymentId}
            attempt={settling}
            settles
            studentName={studentName}
            classContext={classContext}
          />
        ) : (
          <MarkUnpaidButton
            paymentId={paymentId}
            studentName={studentName}
            classContext={classContext}
          />
        )}
      </div>
    </ListRow>
  );
}
