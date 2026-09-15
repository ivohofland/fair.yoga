import { formatDayHeader, formatCents } from '@/lib/format';
import type { PaymentBreakdownLines } from '@/lib/payment-breakdown';

interface PaymentBreakdownProps {
  lines: PaymentBreakdownLines;
  classType: string;
  date: Date;
}

/**
 * Where a student's payment for a completed class went. Renders
 * unconditionally; the caller decides whether a row shows it.
 */
export function PaymentBreakdown({ lines, classType, date }: PaymentBreakdownProps) {
  const rows: ReadonlyArray<{ label: string; value: string; emphasis: boolean }> = [
    { label: 'Room', value: formatCents(lines.roomCents), emphasis: false },
    { label: 'Teacher', value: formatCents(lines.teacherCents), emphasis: false },
    { label: 'Class total', value: formatCents(lines.totalCents), emphasis: false },
    { label: 'Students', value: String(lines.students), emphasis: false },
    { label: 'Your share', value: formatCents(lines.shareCents), emphasis: true },
  ];

  return (
    <details className="mt-2">
      <summary
        className="type-label text-teal cursor-pointer"
        aria-label={`Where your payment goes — ${classType}, ${formatDayHeader(date)}`}
      >
        Where your payment goes
      </summary>
      <dl className="mt-2 bg-sand-soft border border-border rounded-field p-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 py-1">
            <dt className="type-body">{row.label}</dt>
            <dd className={row.emphasis ? 'type-number' : 'tabular-nums text-ink'}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
