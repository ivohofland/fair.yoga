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
 * too, and already drifted out of agreement once.
 */
export function archiveMessage(deleted: number, remaining: number): string {
  const classWord = remaining === 1 ? 'class' : 'classes';

  if (deleted === 0 && remaining === 0) return 'Nothing from this template was scheduled.';

  if (deleted === 0) {
    return `No unbooked classes to delete. There are still ${remaining} ${classWord} on the schedule — cancel individually if needed.`;
  }

  if (remaining === 0) {
    return 'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.';
  }

  return `Classes on the schedule without bookings are now deleted. There are still ${remaining} ${classWord} on the schedule — cancel individually if needed.`;
}

/**
 * Confirmation shown after archiving a studio class template. Un-archiving
 * deletes nothing and needs no explanation, so this is only ever called on
 * the archiving direction — mirroring `archiveMessage`.
 *
 * Takes only `deleted`, unlike `archiveMessage`: a studio template's
 * `remaining` is always 0 (`StudioClass` carries no registrations to check a
 * charged status against, so every future uncancelled instance is
 * deletable), which means the "still N classes on the schedule" branches
 * `archiveMessage` needs can never apply here. Pausing a studio template
 * reuses `pauseMessage` as-is rather than duplicating it — its wording never
 * names "recurring" or "studio", so it already fits both template families.
 */
export function archiveStudioMessage(deleted: number): string {
  if (deleted === 0) return 'Nothing from this template was scheduled.';

  return `Deleted ${deleted} scheduled studio ${deleted === 1 ? 'class' : 'classes'}. Nothing from this template is scheduled any more.`;
}
