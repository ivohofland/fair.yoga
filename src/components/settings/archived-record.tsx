import { formatDayHeader } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';

interface ArchivedRecordProps {
  archivedAt: Date | null;
  withdrawnCount: number | null;
  timeZone: string;
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
 * `archivedAt` is a true instant (written as `now` at click time), not a
 * `@db.Date` calendar date — so it is converted to the teacher's calendar day
 * with `startOfLocalDay` before `formatDayHeader` ever sees it. `formatDayHeader`
 * reads with UTC accessors specifically because it expects a value already
 * pinned to local midnight; feeding it the raw instant would let the teacher's
 * UTC offset shift the displayed date, same as `startOfLocalDay`'s own doc
 * warns against.
 *
 * `remaining` is deliberately not here. It is returned once, by the archive
 * PATCH response, and shown only in the transient confirmation message right
 * after the click — never persisted, never recomputed on page load. Freezing
 * it here would go stale the moment a teacher cancels one of the survivors.
 */
export function ArchivedRecord({ archivedAt, withdrawnCount, timeZone }: ArchivedRecordProps) {
  if (!archivedAt) return null;

  const withdrawn =
    withdrawnCount !== null && withdrawnCount > 0
      ? ` · ${withdrawnCount} ${withdrawnCount === 1 ? 'class' : 'classes'} withdrawn`
      : '';

  return (
    <p className="type-caption">
      {`Archived ${formatDayHeader(startOfLocalDay(archivedAt, timeZone))}${withdrawn}`}
    </p>
  );
}
