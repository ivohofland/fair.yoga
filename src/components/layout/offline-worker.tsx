'use client';

import { useEffect } from 'react';
import { registerOfflineWorker } from '@/lib/offline-client';

/** Registers the service worker once the teacher area has mounted. */
export function OfflineWorker() {
  useEffect(() => {
    void registerOfflineWorker();
  }, []);
  return null;
}
