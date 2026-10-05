'use client';

import { useCallback, useSyncExternalStore, type ReactNode } from 'react';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Shows `attendance` once the server showed check-in or the device clock has
 * reached `checkinAt` (epoch ms), and `registered` until then. A list the
 * server showed stays shown whatever the device clock says. One shown by the
 * device clock alone hides again if that clock is set back before `checkinAt`,
 * until it reaches `checkinAt` again. The clock is read again when a timer
 * reaches `checkinAt` and on `visibilitychange`, since a suspended page's
 * timers do not fire on time.
 * The server snapshot is `false`, so the first paint is the server's and
 * hydration matches; the clock takes over after mount.
 */
export function CheckinGate({
  serverShowCheckin,
  checkinAt,
  attendance,
  registered,
}: {
  serverShowCheckin: boolean;
  checkinAt: number;
  attendance: ReactNode;
  registered: ReactNode;
}) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!Number.isFinite(checkinAt)) return () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      // A timer can fire before `checkinAt`: a delay clamped to the longest
      // timer, or a clock set back while it waited. Then it waits again.
      const arm = (): void => {
        const remaining = checkinAt - Date.now();
        timer = remaining > 0 ? setTimeout(fire, Math.min(remaining, MAX_TIMEOUT_MS)) : undefined;
      };
      const fire = (): void => {
        if (Date.now() >= checkinAt) onChange();
        else arm();
      };
      arm();
      document.addEventListener('visibilitychange', onChange);
      return () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onChange);
      };
    },
    [checkinAt],
  );
  const clockOpen = useSyncExternalStore(subscribe, () => Date.now() >= checkinAt, () => false);
  const open = serverShowCheckin || clockOpen;
  return <>{open ? attendance : registered}</>;
}
