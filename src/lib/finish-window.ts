import type { ClassStatus } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import { log } from '@/lib/log';

/**
 * How long before its end a teacher may finish a class, and how long after its
 * end the sweep finishes it for them. One number for both edges: the window is
 * symmetric around the end, except that the teacher's edge never precedes the
 * start (see `finishOpensAt`). See
 * `docs/superpowers/specs/2026-09-24-attendance-finish-window-design.md`.
 */
export const FINISH_GRACE_MINUTES = 15;

const GRACE_MS = FINISH_GRACE_MINUTES * 60_000;

/** The instant a class ends: its start plus its duration, in real minutes. */
export function classEndInstant(
  entry: { date: Date; startTime: Date; durationMinutes: number },
  timeZone: string,
): Date {
  const start = classStartInstant(entry, timeZone);
  return new Date(start.getTime() + entry.durationMinutes * 60_000);
}

/**
 * The earliest instant a teacher may finish the class: `FINISH_GRACE_MINUTES`
 * before its end, but never before its start. A class no longer than the grace
 * would otherwise be finishable, and so billable, before it begins.
 */
export function finishOpensAt({ start, end }: { start: Date; end: Date }): Date {
  return new Date(Math.max(start.getTime(), end.getTime() - GRACE_MS));
}

/** The instant the sweep finishes the class if the teacher has not. */
export function autoFinishAt(end: Date): Date {
  return new Date(end.getTime() + GRACE_MS);
}

/**
 * `HH:MM` in `timeZone`. An unreadable zone formats in UTC, says so, and logs
 * at `error` (#145). An unreadable instant is checked before the `try`, because
 * it throws in every zone, UTC included, and would escape the fallback.
 */
export function formatClockInZone(instant: Date, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) {
    log.error({ timeZone }, 'unreadable instant, cannot format it in a timezone');
    return 'Invalid Date';
  }
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).format(instant);
  try {
    return format(timeZone);
  } catch {
    log.error({ timeZone }, 'invalid timezone, falling back to UTC formatting');
    return `${format('UTC')} (UTC)`;
  }
}

/**
 * How long before its start an `open` class shows the check-in list. Its own
 * rule, not the finish grace: the two happen to share a length.
 */
export const CHECKIN_OPENS_MINUTES = 15;

/** How long a render that finds the class past `autoFinishAt` waits to ask again. */
const SWEEP_RETRY_MS = 60_000;

export interface ClassPageClock {
  /** Not cancelled, and `open` or `in_progress`. */
  live: boolean;
  /** The attendance list: `in_progress`, or `open` from `CHECKIN_OPENS_MINUTES` before the start. */
  showCheckin: boolean;
  /** Live, and at or past `finishOpensAt`. */
  canFinish: boolean;
  /** Live, and at or past `autoFinishAt`. */
  autoFinishing: boolean;
  /** `autoFinishAt` of this class. */
  autoAt: Date;
  /**
   * The instants at which what this function answers can change: the check-in
   * edge (`open` only), `finishOpensAt` and `autoFinishAt` — some possibly
   * already past — and, once `autoFinishing`, a retry `SWEEP_RETRY_MS` after
   * `now`. Empty unless `live`. An unreadable edge is left out: its
   * `toISOString()` throws.
   */
  refreshInstants: Date[];
}

/**
 * What the class page shows at `now`, and when that can next change. Pure:
 * the page passes its own render time.
 */
export function classPageClock({
  now,
  start,
  end,
  status,
  cancelled,
}: {
  now: Date;
  start: Date;
  end: Date;
  status: ClassStatus;
  cancelled: boolean;
}): ClassPageClock {
  const t = now.getTime();
  const checkinAt = new Date(start.getTime() - CHECKIN_OPENS_MINUTES * 60_000);
  const opensAt = finishOpensAt({ start, end });
  const autoAt = autoFinishAt(end);

  const open = !cancelled && status === 'open';
  const live = open || (!cancelled && status === 'in_progress');
  const showCheckin = live && (status === 'in_progress' || t >= checkinAt.getTime());
  const canFinish = live && t >= opensAt.getTime();
  const autoFinishing = live && t >= autoAt.getTime();

  const refreshInstants = live
    ? [
        ...(open ? [checkinAt] : []),
        opensAt,
        autoAt,
        ...(autoFinishing ? [new Date(t + SWEEP_RETRY_MS)] : []),
      ].filter((d) => !Number.isNaN(d.getTime()))
    : [];

  return { live, showCheckin, canFinish, autoFinishing, autoAt, refreshInstants };
}
