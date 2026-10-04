'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isOfflineNow, useConnectionStatus } from '@/lib/offline-status';
import { warmOfflinePages } from '@/lib/offline-client';
import type { OfflineSnapshotStamp } from '@/lib/offline-snapshot-props';
import { SyncStatus } from './sync-status';

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
 * Disables every control inside it while offline, through the native
 * `<fieldset disabled>`. `data-offline-fieldset` is the stylesheet's hook for
 * the dimmed look.
 */
export function OfflineFieldset({ children }: { children: ReactNode }) {
  const { offline } = useConnectionStatus();
  return (
    <fieldset data-offline-fieldset disabled={offline} className="m-0 min-w-0 border-0 p-0">
      {children}
    </fieldset>
  );
}

/**
 * Wraps a page the service worker may store. Offline, it says when the page
 * was loaded and disables every control inside it through an
 * `OfflineFieldset`. Above both sits the attendance outbox's sync block,
 * outside any fieldset. `segmented` drops the wrapping fieldset: the page
 * places its own `OfflineFieldset`s and leaves between them what must work
 * offline. The `data-offline-owner` attribute is the owner marker the worker
 * requires; see docs/technical-architecture.md (Offline (service worker)).
 */
export function OfflineSnapshot({
  ownerId,
  renderedAt,
  loadedAtClock,
  loadedAtDayClock,
  loadedOn,
  timeZone,
  warmPaths = [],
  segmented = false,
  children,
}: OfflineSnapshotStamp & { warmPaths?: readonly string[]; segmented?: boolean; children: ReactNode }) {
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
      <SyncStatus owner={ownerId} />
      <p role="status" className={offline ? 'type-label text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4' : 'sr-only'}>
        {offline && `Offline — showing what was loaded ${loaded}`}
      </p>
      {segmented ? children : <OfflineFieldset>{children}</OfflineFieldset>}
    </div>
  );
}
