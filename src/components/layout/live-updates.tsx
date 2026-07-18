'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Layer 1 of the communication model: subscribes to the notification
 * stream and re-renders the server components when something arrives —
 * the inbox, the tab-bar unread dot, and any open list stay current
 * without polling.
 *
 * EventSource auto-reconnects on transient drops, but a non-2xx response
 * (expired session → 401) closes it permanently and silently. The onerror
 * below rebuilds the connection with backoff so the stream recovers once
 * the user signs back in; the page itself keeps working either way.
 */
export function LiveUpdates() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/notifications/stream');

      source.onopen = () => {
        attempts = 0;
      };

      source.onmessage = () => {
        // Debounce bursts (bulk notifications) into one refresh.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), 500);
      };

      source.onerror = () => {
        // CONNECTING means the browser is already retrying on its own.
        if (source?.readyState !== EventSource.CLOSED) return;
        source.close();
        source = null;
        attempts += 1;
        const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempts, 5));
        reconnect = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (timer.current) clearTimeout(timer.current);
      if (reconnect) clearTimeout(reconnect);
      source?.close();
    };
  }, [router]);

  return null;
}
