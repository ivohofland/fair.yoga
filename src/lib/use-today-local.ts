'use client';

import { useSyncExternalStore } from 'react';
import { todayLocal } from '@/lib/format';

/**
 * Never fires. `useSyncExternalStore` requires a subscribe function, and there
 * is no external store here to subscribe to — the "store" is the host clock,
 * which emits nothing. A no-op unsubscribe means the value is re-read whenever
 * React re-renders this component and at no other time, which is exactly the
 * cadence a date input's `min` wants.
 *
 * Module-level so the reference is stable: a fresh closure per render would
 * make React tear down and re-subscribe on every pass.
 */
const subscribeToNothing = () => () => {};

/** The server has no device to ask, so it renders no bound at all. */
const noServerSnapshot = () => undefined;

/**
 * Today's calendar day for a date input's `min`, or `undefined` on the server
 * (#249).
 *
 * WHY A HOOK AND NOT A CALL. `todayLocal()` reads the host's zone, and the host
 * that renders a `'use client'` component first is the SERVER. Every page that
 * shows one of these date fields sits under `(teacher)/layout.tsx`, which
 * awaits `getSession()` and a Prisma count — so it renders dynamically, per
 * request, in the container's zone. No `TZ` is set in the Dockerfile or either
 * compose file, which makes that zone UTC: not the teacher's, not the device's,
 * nobody's. React 19 then keeps the server's attribute through hydration rather
 * than replacing it with the client's, so the wrong bound is not a flash — it
 * is the final state. Measured: a server render under TZ=UTC at
 * 2026-08-19T01:00Z emits `min="2026-08-19"`, and the Los Angeles teacher
 * reading that page at 18:00 cannot pick tonight's class.
 *
 * The fix is not a better zone guess on the server. There is no value the
 * server can correctly emit, because at render time it does not know where the
 * teacher is standing. So it emits nothing: `undefined` renders no attribute at
 * all, an unbounded picker, which is what this field was before #249 and is
 * wrong only in being permissive.
 *
 * `useSyncExternalStore` RATHER THAN `useState` + `useEffect`, which was the
 * first shape of this and is the more obvious one. Three reasons, in order of
 * weight. It is the API React provides for precisely this split — a value that
 * differs between server and client — so `getServerSnapshot` states the intent
 * instead of encoding it as an initial state that an effect happens to
 * overwrite. It re-reads on every render rather than latching at mount, so a
 * form left open across midnight re-bounds to the right day the next time
 * anything re-renders it, which the effect version silently gave up. And
 * `react-hooks/set-state-in-effect` rejects the effect version outright, for
 * the cascading-render reason — worth heeding rather than suppressing, since
 * the sanctioned alternative is better here on its own merits.
 *
 * `getSnapshot` returning a fresh string each call is safe: React compares
 * snapshots with `Object.is`, and equal strings are `Object.is`-equal. It is
 * the object-returning version of this shape that loops.
 *
 * `Teacher.defaultTimezone` was the other candidate and is deliberately not
 * used. The guards read it because they run on the server and have no device to
 * ask; this control is looking at a calendar widget on a phone, where "today"
 * means the phone's today. Signup detects that zone in the browser and stores
 * it (#258), falling back to a hardcoded `Europe/Amsterdam` only when none was
 * detected — so the column is usually right and occasionally Amsterdam, while
 * the device is right by construction. Sourcing the picker from the column
 * would also miss a teacher who is travelling, whose stored zone is still their
 * home one while the phone in their hand has already moved.
 *
 * A HINT, NEVER A GUARD, and one that is absent for the first paint.
 * `updateClass` and `transitionClass` refuse a past start on their own and
 * answer 409; #247 is the standing reminder that a page-level control is not a
 * service guard, and this hook's `undefined` window is the sharpest form of
 * it — for a moment there is no control at all, and nothing is unsafe.
 *
 * Tested through its two consumers rather than on its own: a `.test.tsx` under
 * `src/lib/` would be collected by neither vitest project (`unit` globs
 * `.test.ts`, `components` globs `src/components` and `src/app`), so it would
 * silently never run. `class-edit-form.test.tsx` owns the server-render
 * assertion — the one that reddens if anyone inlines `todayLocal()` back into
 * a render — and `class/new/page.test.tsx` the client one.
 */
export function useTodayLocal(): string | undefined {
  return useSyncExternalStore(subscribeToNothing, todayLocal, noServerSnapshot);
}
