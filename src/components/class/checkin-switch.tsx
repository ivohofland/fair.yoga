'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type CheckinView = 'before' | 'checkin';

/**
 * Shows `before` or `checkin` for a live class page, opening check-in on the
 * device clock when the page was rendered before `checkinAt` — a stored page
 * shown offline cannot ask the server again.
 *
 * The first render is `initial`, the server's choice, so hydration matches.
 * A later render whose `initial` is `checkin` shows check-in too, in the same
 * element, so the server's re-render at the edge keeps what is mounted under
 * it. After mount it checks `Date.now()` against `checkinAt` at once, on a
 * timer to that instant (waiting again if it fires short, never armed past
 * what `setTimeout` can wait) and on returning to the tab. Once it shows
 * `checkin` it never goes back: a list holding queued marks must not
 * disappear. The clock only picks what is displayed; the server judges every
 * write.
 */
export function CheckinSwitch({
  checkinAt,
  initial,
  before,
  checkin,
}: {
  checkinAt: string;
  initial: CheckinView;
  before: ReactNode;
  checkin: ReactNode;
}) {
  const [switched, setSwitched] = useState(false);
  const showCheckin = switched || initial === 'checkin';

  useEffect(() => {
    if (showCheckin) return;
    const at = Date.parse(checkinAt);
    if (Number.isNaN(at)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      const delay = at - Date.now();
      timer = delay > 0 && delay <= MAX_TIMEOUT_MS ? setTimeout(check, delay) : undefined;
    };
    function check() {
      if (Date.now() >= at) setSwitched(true);
      else arm();
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };

    check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [showCheckin, checkinAt]);

  return <>{showCheckin ? checkin : before}</>;
}
