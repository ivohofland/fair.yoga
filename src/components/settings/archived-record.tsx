import { formatDateWithYear } from '@/lib/format';
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
 * with `startOfLocalDay` before `formatDateWithYear` ever sees it. What that
 * returns is *midnight UTC of the teacher's local calendar day*, not local
 * midnight: local midnight is a different instant, and reading that one with
 * UTC accessors would produce exactly the off-by-a-day this paragraph exists
 * to prevent. `formatDateWithYear` reads with UTC accessors because midnight
 * UTC is the shape it is handed; feeding it the raw instant instead would let
 * the teacher's UTC offset shift the displayed date, as `startOfLocalDay`'s own
 * doc warns.
 *
 * `formatDateWithYear`, not `formatDayHeader`: this date has no natural
 * expiry, so it carries a year (`12 Jun 2025`) rather than omitting one the way
 * a date near enough to be unambiguous can. Not a claim about what the two
 * formatters' callers actually do — `formatDayHeader` is used for past dates
 * elsewhere; see its sibling's docblock in `@/lib/format`.
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
      {`Archived ${formatDateWithYear(startOfLocalDay(archivedAt, timeZone))}${withdrawn}`}
    </p>
  );
}
