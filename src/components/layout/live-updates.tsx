'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Layer 1 of the communication model: subscribes to the notification
 * stream and re-renders the server components when something arrives —
 * the inbox, the tab-bar unread dot, and any open list stay current
 * without polling. EventSource reconnects on its own.
 */
export function LiveUpdates() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/notifications/stream');

    source.onmessage = () => {
      // Debounce bursts (bulk notifications) into one refresh.
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 500);
    };

    return () => {
      if (timer.current) clearTimeout(timer.current);
      source.close();
    };
  }, [router]);

  return null;
}
