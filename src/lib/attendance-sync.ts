import { useSyncExternalStore } from 'react';
import {
  isRecord,
  readOutbox,
  settleEntry,
  withLock,
  type PendingEntry,
  type Settlement,
} from '@/lib/attendance-outbox';
import type { AttendanceBody } from '@/lib/api-types';
import { isApiErrorCode, type ApiErrorCode } from '@/lib/api-error-codes';
import { logRequestFailure } from '@/lib/client-errors';
import { getConnectionStatus, subscribeConnectionStatus } from '@/lib/offline-status';

export type ReplayOutcome = Settlement | { kind: 'retry' } | { kind: 'signed_out' };

export interface SyncState {
  needsSignIn: boolean;
}

const FLUSH_LOCK = 'fy-outbox-flush';
const REQUEST_TIMEOUT_MS = 10_000;
/** The last delay repeats for as long as retryable entries remain. */
const BACKOFF_MS = [5_000, 15_000, 60_000] as const;
const SERVER_SYNC_STATE: SyncState = { needsSignIn: false };

let syncState: SyncState = SERVER_SYNC_STATE;
const syncListeners = new Set<() => void>();

/** The flush running in this tab, if any. */
let running: Promise<void> | null = null;
/** Scope a trigger asked for while a flush ran; `undefined` when none did. */
let rerunScope: string | null | undefined;
let backoffStep = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
/** Started syncs not yet stopped; the backoff arms only while one is running, so a stop holds against a flush still in flight. */
let activeSyncs = 0;
/** Bumped by `resetSyncForTests`, so a flush still in flight from before it changes nothing after it. */
let generation = 0;

function setNeedsSignIn(needsSignIn: boolean): void {
  if (syncState.needsSignIn === needsSignIn) return;
  syncState = { needsSignIn };
  syncListeners.forEach((listener) => listener());
}

function subscribeSyncState(listener: () => void): () => void {
  syncListeners.add(listener);
  return () => {
    syncListeners.delete(listener);
  };
}

function getSyncState(): SyncState {
  return syncState;
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(subscribeSyncState, getSyncState, () => SERVER_SYNC_STATE);
}

function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('attendance write timed out', 'TimeoutError')),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** The server's clock from the `Date` header, or this device's when the header is missing or unreadable. */
function serverTime(res: Response): number {
  const header = res.headers.get('date');
  const parsed = header === null ? Number.NaN : Date.parse(header);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Tethered to the PUT's answer type: a key added to or renamed in `AttendanceBody` fails to compile here until it is listed. */
const ANSWER_KEYS = { id: true, status: true } satisfies Record<keyof AttendanceBody, true>;

/** True when `data` is the PUT's answer to exactly the write `entry` sent, compared on every `ANSWER_KEYS` key. */
function answersEntry(data: unknown, entry: PendingEntry): boolean {
  if (!isRecord(data)) return false;
  const sent: AttendanceBody = { id: entry.registrationId, status: entry.status };
  const expected: Readonly<Record<string, unknown>> = sent;
  return Object.keys(ANSWER_KEYS).every((key) => data[key] === expected[key]);
}

/** The app's own error answer, `{ error: { message, code? } }`; null for any other body, an empty one included. */
async function appError(res: Response): Promise<{ code?: ApiErrorCode; message: string } | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error) || typeof error.message !== 'string') return null;
  return {
    code: isApiErrorCode(error.code) ? error.code : undefined,
    message: error.message === '' ? 'Could not record attendance.' : error.message,
  };
}

async function classify(res: Response, entry: PendingEntry): Promise<ReplayOutcome> {
  if (res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { kind: 'retry' };
    }
    if (answersEntry(isRecord(body) ? body.data : undefined, entry)) {
      return { kind: 'confirmed', at: serverTime(res) };
    }
    return { kind: 'retry' };
  }
  if (res.status === 401) return { kind: 'signed_out' };
  if (res.status === 408 || res.status === 429 || res.status >= 500) return { kind: 'retry' };
  const answer = await appError(res);
  if (answer === null) {
    // A proxy, portal or filter answered, not the app: the write never reached it.
    logRequestFailure(
      'attendance-sync',
      {
        registrationId: entry.registrationId,
        status: entry.status,
        httpStatus: res.status,
        contentType: res.headers.get('content-type'),
      },
      new Error('the answer is not the app\'s error body'),
    );
    return { kind: 'retry' };
  }
  if (res.status === 403) {
    console.warn('[attendance-sync] write dropped: the server refused it to this account', {
      registrationId: entry.registrationId,
      status: entry.status,
    });
    return { kind: 'dropped' };
  }
  if (answer.code === 'CONCURRENT_MODIFICATION') return { kind: 'retry' };
  return { kind: 'refused', message: answer.message };
}

/**
 * One replay; whether the server answered it with a 2xx; and whether no answer
 * arrived at all (the request threw or timed out). Never throws.
 */
async function send(
  entry: PendingEntry,
): Promise<{ outcome: ReplayOutcome; succeeded: boolean; unanswered: boolean }> {
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/registrations/${entry.registrationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: entry.status }),
      signal: timeout.signal,
    });
    return { outcome: await classify(res, entry), succeeded: res.ok, unanswered: false };
  } catch (err) {
    if (!timeout.signal.aborted) {
      logRequestFailure(
        'attendance-sync',
        { registrationId: entry.registrationId, status: entry.status },
        err,
      );
    }
    return { outcome: { kind: 'retry' }, succeeded: false, unanswered: true };
  } finally {
    timeout.clear();
  }
}

export async function sendAttendance(entry: PendingEntry): Promise<ReplayOutcome> {
  return (await send(entry)).outcome;
}

/** `null` is wider than any owner id, and two different owner ids widen to `null`. */
function widen(requested: string | null | undefined, scope: string | null): string | null {
  if (requested === undefined) return scope;
  return requested === scope ? scope : null;
}

/** One pass over the outbox; answers whether any entry is left to retry. */
async function pass(scope: string | null, gen: number): Promise<boolean> {
  return withLock(FLUSH_LOCK, async () => {
    let retried = false;
    let succeeded = false;
    // Fresh: another tab may have replaced or settled an entry since this tab last looked.
    const entries = Object.values(readOutbox().pending).sort((a, b) => a.recordedAt - b.recordedAt);
    sending: for (const entry of entries) {
      if (gen !== generation) break;
      if (scope !== null && entry.ownerId !== scope) {
        await settleEntry(entry, { kind: 'dropped' });
        continue;
      }
      const sent = await send(entry);
      if (gen !== generation) break;
      succeeded ||= sent.succeeded;
      const outcome = sent.outcome;
      switch (outcome.kind) {
        case 'retry':
          retried = true;
          // No answer at all: the next entry would wait out the same failure, holding the flush lock.
          if (sent.unanswered) break sending;
          break;
        case 'signed_out':
          setNeedsSignIn(true);
          return retried;
        case 'confirmed':
        case 'refused':
        case 'dropped':
          await settleEntry(entry, outcome);
          break;
        default: {
          const unreachable: never = outcome;
          throw new Error(`unhandled replay outcome: ${JSON.stringify(unreachable)}`);
        }
      }
    }
    if (succeeded && gen === generation) setNeedsSignIn(false);
    return retried;
  });
}

function clearBackoff(): void {
  if (backoffTimer !== null) clearTimeout(backoffTimer);
  backoffTimer = null;
}

function scheduleBackoff(retried: boolean, scope: string | null): void {
  clearBackoff();
  if (!retried) {
    backoffStep = 0;
    return;
  }
  if (activeSyncs === 0 || document.visibilityState !== 'visible') return;
  const delay = BACKOFF_MS[Math.min(backoffStep, BACKOFF_MS.length - 1)];
  backoffStep++;
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    void flushAttendance(scope);
  }, delay);
}

async function run(first: string | null, gen: number): Promise<void> {
  try {
    let scope = first;
    let retried: boolean;
    let rerun: boolean;
    do {
      rerunScope = undefined;
      try {
        retried = await pass(scope, gen);
      } catch (err) {
        logRequestFailure('attendance-sync', { scope }, err);
        // Whatever was pending is still pending; the backoff keeps trying it.
        retried = true;
      }
      if (gen !== generation) return;
      const next = rerunScope;
      rerun = next !== undefined;
      if (next !== undefined) scope = next;
    } while (rerun);
    scheduleBackoff(retried, scope);
  } finally {
    // Synchronous with the last `rerun` check, so no trigger can slip between them unseen.
    if (gen === generation) running = null;
  }
}

/** `null` sends every pending entry whoever owns it (sign-out); an owner id sends that owner's and drops the rest unsent. */
export function flushAttendance(ownerId: string | null): Promise<void> {
  if (running !== null) {
    rerunScope = widen(rerunScope, ownerId);
    return running;
  }
  running = run(ownerId, generation);
  return running;
}

export function startAttendanceSync(ownerId: string): () => void {
  const flush = (): void => {
    void flushAttendance(ownerId);
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') flush();
  };
  let wasOffline = false;
  const unsubscribe = subscribeConnectionStatus(() => {
    const { offline } = getConnectionStatus();
    if (wasOffline && !offline) flush();
    wasOffline = offline;
  });
  // Read after subscribing: the first subscribe can itself change the answer.
  wasOffline = getConnectionStatus().offline;
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', onVisibilityChange);
  activeSyncs++;
  flush();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    activeSyncs--;
    window.removeEventListener('online', flush);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    unsubscribe();
    clearBackoff();
  };
}

export function resetSyncForTests(): void {
  generation++;
  activeSyncs = 0;
  clearBackoff();
  backoffStep = 0;
  running = null;
  rerunScope = undefined;
  syncState = SERVER_SYNC_STATE;
  syncListeners.clear();
}
