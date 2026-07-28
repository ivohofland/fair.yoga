import { formatDayHeader } from '@/lib/format';

interface ArchivedRecordProps {
  archivedAt: Date | null;
  withdrawnCount: number | null;
}

/**
 * The durable half of what archiving reports (#97). The confirmation message
 * shown right after the click is the immediate half; this is what is still
 * here tomorrow.
 *
 * No line at all when the template was never archived — which includes every
 * template that existed before #97 shipped. An "unknown" placeholder would
 * invent a history the database does not have.
 *
 * The count is omitted when it is zero: "0 classes withdrawn" answers a
 * question nobody asked and reads like something went wrong. The date still
 * shows, because when the template was shelved is worth knowing either way.
 *
 * `remaining` is deliberately not here. It is a live query on the page that
 * uses this, and truer computed than frozen — a teacher who cancels one of the
 * survivors afterwards should see that number drop.
 */
export function ArchivedRecord({ archivedAt, withdrawnCount }: ArchivedRecordProps) {
  if (!archivedAt) return null;

  const withdrawn =
    withdrawnCount && withdrawnCount > 0
      ? ` · ${withdrawnCount} ${withdrawnCount === 1 ? 'class' : 'classes'} withdrawn`
      : '';

  return (
    <p className="type-caption">
      {`Archived ${formatDayHeader(archivedAt)}${withdrawn}`}
    </p>
  );
}
