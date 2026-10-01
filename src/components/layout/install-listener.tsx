'use client';

import { installStore } from './install-store';

/**
 * Renders nothing. Importing the store from the root layout loads its
 * module, and with it the `beforeinstallprompt` listener, on every page —
 * before the Settings row or the Schedule card that read it may exist.
 */
export function InstallListener(): null {
  void installStore;
  return null;
}
