'use client';

import { installStore } from './install-store';

/**
 * Renders nothing. Importing the store loads its module — and with it the
 * `beforeinstallprompt` listener — wherever this component is mounted.
 */
export function InstallListener(): null {
  void installStore;
  return null;
}
