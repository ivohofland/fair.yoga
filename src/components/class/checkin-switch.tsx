'use client';

import { useEffect, useState, type ReactNode } from 'react';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export type CheckinView = 'before' | 'checkin';

/**
 * Shows `before` or `checkin` for an `open` class page, opening check-in on
 * the device clock when the page was rendered before `checkinAt` — a stored
 * page shown offline cannot ask the server again.
 *
 * The first render is `initial`, the server's choice, so hydration matches.
 * After mount it checks `Date.now()` against `checkinAt` at once, on a timer to
 * that instant (not armed past what `setTimeout` can wait) and on returning to
 * the tab. Once it shows `checkin` it never goes back: a list holding queued
 * marks must not disappear. The clock only picks what is displayed; the server
 * judges every write.
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
  const [view, setView] = useState<CheckinView>(initial);

  useEffect(() => {
    if (view === 'checkin') return;
    const at = Date.parse(checkinAt);
    if (Number.isNaN(at)) return;

    const check = () => {
      if (Date.now() >= at) setView('checkin');
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };

    check();
    const delay = at - Date.now();
    const timer = delay > 0 && delay <= MAX_TIMEOUT_MS ? setTimeout(check, delay) : undefined;
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [view, checkinAt]);

  return <>{view === 'checkin' ? checkin : before}</>;
}
