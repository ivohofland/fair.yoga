import { formatDayHeader } from '@/lib/format';

/**
 * Confirmation shown after pausing a recurring template. Resuming needs no
 * explanation, so this is only ever called on the pause direction.
 */
export function pauseMessage(lastScheduled: { date: Date; startTime: string } | null): string {
  return lastScheduled
    ? `No new classes will be added to your schedule. The last one still scheduled is ${formatDayHeader(lastScheduled.date)} · ${lastScheduled.startTime}.`
    : 'No new classes will be added to your schedule. Nothing from this template is currently scheduled.';
}

/**
 * Confirmation shown after archiving a recurring template. Un-archiving
 * deletes nothing and needs no explanation, so this is only ever called on
 * the archiving direction.
 *
 * No pronoun on the "still N classes" branches ("cancel individually", not
 * "cancel them individually") — a pronoun would have to agree with `classWord`
 * too, and already drifted out of agreement once. The verb was the second
 * slip: "There are still 1 class" repeats the same mistake with "are" instead
 * of a pronoun. Rather than add a second branch to make the verb agree too,
 * the phrasing drops the verb entirely — "1 class still on the schedule" —
 * so there is nothing left that can fall out of agreement with `classWord`.
 */
export function archiveMessage(deleted: number, remaining: number): string {
  const classWord = remaining === 1 ? 'class' : 'classes';

  if (deleted === 0 && remaining === 0) return 'Nothing from this template was scheduled.';

  if (deleted === 0) {
    return `No unbooked classes to delete. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
  }

  if (remaining === 0) {
    return 'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.';
  }

  return `Classes on the schedule without bookings are now deleted. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
}

/**
 * Confirmation shown after archiving a studio class template. Un-archiving
 * deletes nothing and needs no explanation, so this is only ever called on
 * the archiving direction — mirroring `archiveMessage`.
 *
 * `remaining` is not always 0 here: `archiveOrUnarchiveStudioTemplate`'s
 * delete deliberately spares a class dated today (`date > now` excludes it
 * once the clock passes 00:00 UTC), but the count backing `remaining` is
 * keyed from the start of today (00:00 UTC) instead, matching what the
 * teacher sees on their schedule — so archiving on a class's own day
 * legitimately leaves that one class behind. Pausing a studio template
 * reuses `pauseMessage` as-is rather than duplicating it — its wording never
 * names "recurring" or "studio", so it already fits both template families.
 */
export function archiveStudioMessage(deleted: number, remaining: number): string {
  const classWord = remaining === 1 ? 'class' : 'classes';

  if (deleted === 0 && remaining === 0) return 'Nothing from this template was scheduled.';

  if (deleted === 0) {
    return `${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
  }

  const deletedWord = deleted === 1 ? 'class' : 'classes';

  if (remaining === 0) {
    return `Deleted ${deleted} scheduled studio ${deletedWord}. Nothing from this template is scheduled any more.`;
  }

  return `Deleted ${deleted} scheduled studio ${deletedWord}. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
}
