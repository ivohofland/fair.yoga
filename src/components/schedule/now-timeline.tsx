'use client';

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { clockInZone, describeNextStart, placeNow, type NowPlacement, type TimelineItem } from '@/lib/now-line';

/**
 * The device clock, read once when the page mounts and again whenever the
 * teacher returns to it — never on a timer. The time printed on the line is
 * therefore the moment the line was placed, which is what lets a teacher see
 * that a page left open is out of date.
 */
function createNowStore(): { subscribe: (onChange: () => void) => () => void; read: () => number } {
  let now = Date.now();
  return {
    subscribe(onChange) {
      const refresh = (): void => {
        if (document.visibilityState === 'hidden') return;
        now = Date.now();
        onChange();
      };
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('pageshow', refresh);
      window.addEventListener('focus', refresh);
      return () => {
        document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('pageshow', refresh);
        window.removeEventListener('focus', refresh);
      };
    },
    read: () => now,
  };
}

interface NowState {
  placement: NowPlacement;
  now: number;
  timeZone: string;
  byId: ReadonlyMap<string, TimelineItem>;
}

const NowContext = createContext<NowState | null>(null);

/**
 * Places the "now" line and the next/running labels over a schedule list.
 * `serverNow` is the server's render instant, so the first paint matches the
 * server's HTML; the device clock takes over after hydration.
 */
export function NowTimeline({
  items,
  timeZone,
  serverNow,
  children,
}: {
  items: TimelineItem[];
  timeZone: string;
  serverNow: number;
  children: ReactNode;
}) {
  const [store] = useState(createNowStore);
  const now = useSyncExternalStore(store.subscribe, store.read, () => serverNow);
  const state: NowState = {
    placement: placeNow(items, now),
    now,
    timeZone,
    byId: new Map(items.map((i) => [i.id, i])),
  };
  return <NowContext.Provider value={state}>{children}</NowContext.Provider>;
}

function NowLine({ now, timeZone }: { now: number; timeZone: string }) {
  return (
    <div role="note" className="flex items-center gap-2">
      <span aria-hidden="true" className="h-px flex-1 bg-gold" />
      <span className="type-caption text-gold-deep">Now · {clockInZone(now, timeZone)}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-gold" />
    </div>
  );
}

/** One card's place on the timeline: the line before or after it, and its label. */
export function NowSlot({ id, children }: { id: string; children: ReactNode }) {
  const state = useContext(NowContext);
  if (state === null) return <>{children}</>;
  const { placement, now, timeZone, byId } = state;
  const item = byId.get(id);

  let label: string | null = null;
  if (item && placement.runningId === id) {
    label = `On now · until ${clockInZone(item.end, timeZone)}`;
  } else if (item && placement.nextId === id) {
    label = `Next · ${describeNextStart(item.start, now, timeZone)}`;
  }

  return (
    <>
      {placement.lineBeforeId === id && <NowLine now={now} timeZone={timeZone} />}
      <div>
        {label !== null && <p className="type-caption text-teal font-semibold mb-1">{label}</p>}
        {children}
      </div>
      {placement.lineAfterId === id && <NowLine now={now} timeZone={timeZone} />}
    </>
  );
}
