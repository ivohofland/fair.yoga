'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isOfflineNow, useConnectionStatus } from '@/lib/offline-status';
import { warmOfflinePages } from '@/lib/offline-client';
import type { OfflineSnapshotStamp } from '@/lib/offline-snapshot-props';

/** How far a page's render may trail the server's clock before a successful ping refreshes it. */
const STALE_AFTER_MS = 60_000;

function todayIn(timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (err) {
    console.error('[offline-snapshot] unreadable timezone, showing the day', { timeZone }, err);
    return null;
  }
}

/**
 * Wraps a page the service worker may store. Offline, it says when the page
 * was loaded and disables the controls in `children` and `after` through their
 * fieldsets. The `queueable` slot, rendered between them, is the one region
 * left enabled offline, for writes the page queues. The `data-offline-owner`
 * attribute is the owner marker the worker requires; see
 * docs/technical-architecture.md (Offline (service worker)).
 */
export function OfflineSnapshot({
  ownerId,
  renderedAt,
  loadedAtClock,
  loadedAtDayClock,
  loadedOn,
  timeZone,
  warmPaths = [],
  children,
  queueable,
  after,
}: OfflineSnapshotStamp & {
  warmPaths?: readonly string[];
  children: ReactNode;
  queueable?: ReactNode;
  after?: ReactNode;
}) {
  const { offline, serverNow } = useConnectionStatus();
  const router = useRouter();
  const pathname = usePathname();
  const refreshedFor = useRef<number | null>(null);
  const warmKey = [pathname, ...warmPaths].join('|');

  useEffect(() => {
    // The first run sees the server snapshot, before the browser's own state is read.
    if (offline || isOfflineNow()) return;
    void warmOfflinePages(warmKey.split('|'));
  }, [offline, warmKey]);

  useEffect(() => {
    if (offline || serverNow === null || serverNow - renderedAt <= STALE_AFTER_MS) return;
    if (refreshedFor.current === renderedAt) return;
    refreshedFor.current = renderedAt;
    router.refresh();
  }, [offline, serverNow, renderedAt, router]);

  const loaded = offline ? (loadedOn === todayIn(timeZone) ? `at ${loadedAtClock}` : loadedAtDayClock) : null;

  return (
    <div data-offline-owner={ownerId}>
      <p role="status" className={offline ? 'type-label text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4' : 'sr-only'}>
        {offline && `Offline — showing what was loaded ${loaded}`}
      </p>
      <fieldset data-offline-fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">
        {children}
      </fieldset>
      {queueable !== undefined && <div data-offline-queueable>{queueable}</div>}
      {after !== undefined && (
        <fieldset data-offline-fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">
          {after}
        </fieldset>
      )}
    </div>
  );
}
