'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { flushOutbox, purgeOtherOwners } from '@/lib/attendance-outbox';
import { isOfflineNow, useConnectionStatus } from '@/lib/offline-status';

/**
 * Replays the account's queued attendance marks from every teacher page
 * (#726, spec D4): on mount, on the `online` event, when the page becomes
 * visible, and when the connection store goes from offline to online. Renders
 * nothing.
 */
export function OutboxSync({ owner }: { owner: string }) {
  const router = useRouter();
  /** Read at refresh time, so the listeners below are not re-bound when the router object changes. */
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const { offline } = useConnectionStatus();
  const wasOffline = useRef(offline);
  /** The flush a refresh is already waiting on: triggers that join it add no second refresh. */
  const awaited = useRef<Promise<{ applied: number }> | null>(null);

  const sync = useCallback(() => {
    const flush = flushOutbox(owner);
    if (flush === awaited.current) return;
    awaited.current = flush;
    void flush.then(({ applied }) => {
      if (awaited.current === flush) awaited.current = null;
      // Offline, a refresh that fails becomes a hard reload of the cached page.
      if (applied > 0 && !isOfflineNow()) routerRef.current.refresh();
    });
  }, [owner]);

  useEffect(() => {
    purgeOtherOwners(owner);
    sync();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') sync();
    };
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', sync);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [owner, sync]);

  useEffect(() => {
    if (wasOffline.current && !offline) sync();
    wasOffline.current = offline;
  }, [offline, sync]);

  return null;
}
