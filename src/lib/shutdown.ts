/**
 * Process-wide shutdown signal. `installShutdownSignal` turns SIGTERM and
 * SIGINT into `beginShutdown`; anything holding work open (the notification
 * streams, the scheduler) reads `isShuttingDown` or subscribes with
 * `onShutdown`. Why it exists and what Next keeps owning:
 * `docs/technical-architecture.md` (Shutdown).
 */

import { log } from '@/lib/log';

interface ShutdownState {
  shuttingDown: boolean;
  subscribers: Set<() => void>;
  signalInstalled: boolean;
}

declare global {
  // Global so every bundle context shares one state (mirrors the SSE-counts
  // registry in the stream route). Deleting it resets everything, guard
  // included; the next access re-creates it.
  var __fairYogaShutdown: ShutdownState | undefined;
}

function state(): ShutdownState {
  return (globalThis.__fairYogaShutdown ??= {
    shuttingDown: false,
    subscribers: new Set(),
    signalInstalled: false,
  });
}

export function isShuttingDown(): boolean {
  return state().shuttingDown;
}

/** Runs `fn` at once when shutdown has already begun. Returns the unsubscribe. */
export function onShutdown(fn: () => void): () => void {
  const s = state();
  if (s.shuttingDown) {
    runSubscriber(fn);
    return () => {};
  }
  s.subscribers.add(fn);
  return () => {
    s.subscribers.delete(fn);
  };
}

export function beginShutdown(): void {
  const s = state();
  if (s.shuttingDown) return;
  s.shuttingDown = true;
  for (const fn of [...s.subscribers]) runSubscriber(fn);
}

function runSubscriber(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error({ err }, 'shutdown subscriber failed');
  }
}

interface SignalTarget {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

/** Installs once per process; a second call installs nothing. */
export function installShutdownSignal(target: SignalTarget = process): void {
  const s = state();
  if (s.signalInstalled) return;
  s.signalInstalled = true;
  target.once('SIGTERM', beginShutdown);
  target.once('SIGINT', beginShutdown);
}
