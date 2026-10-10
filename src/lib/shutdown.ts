/**
 * Process-wide shutdown signal. `installShutdownSignal` turns SIGTERM and
 * SIGINT into `beginShutdown`; `isShuttingDown` reads the flag and
 * `onShutdown` subscribes to it. Why it exists and what Next keeps owning:
 * `docs/technical-architecture.md` (Shutdown).
 */

import { log } from '@/lib/log';

interface ShutdownState {
  shuttingDown: boolean;
  subscribers: Set<() => void>;
  signalInstalled: boolean;
}

declare global {
  // Global because separate bundle entries share one process; deleting it
  // resets everything, guard included, and the next access re-creates it.
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

export function beginShutdown(signal?: NodeJS.Signals): void {
  const s = state();
  if (s.shuttingDown) return;
  s.shuttingDown = true;
  log.info({ signal, subscribers: s.subscribers.size }, 'shutdown begun');
  for (const fn of [...s.subscribers]) runSubscriber(fn);
}

function runSubscriber(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error(
      { err },
      'shutdown subscriber failed; the work it holds may stay open until the orchestrator kills the process',
    );
  }
}

interface SignalTarget {
  once(event: 'SIGTERM' | 'SIGINT', listener: (signal?: NodeJS.Signals) => void): unknown;
}

/** Installs once per process; a second call installs nothing. */
export function installShutdownSignal(target: SignalTarget = process): void {
  const s = state();
  if (s.signalInstalled) return;
  s.signalInstalled = true;
  target.once('SIGTERM', beginShutdown);
  target.once('SIGINT', beginShutdown);
}
