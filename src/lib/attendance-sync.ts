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

export type SyncState = {
  needsSignIn: boolean;
  /** The last flush in this tab ended with an entry it had tried and must try again. */
  retrying: boolean;
};

const FLUSH_LOCK = 'fy-outbox-flush';
const REQUEST_TIMEOUT_MS = 10_000;
/** The last delay repeats for as long as retryable entries remain. */
const BACKOFF_MS = [5_000, 15_000, 60_000] as const;
const SERVER_SYNC_STATE: SyncState = { needsSignIn: false, retrying: false };

let syncState: SyncState = SERVER_SYNC_STATE;
const syncListeners = new Set<() => void>();

/** The flush running in this tab, if any. */
let running: Promise<void> | null = null;
/** The owner the last trigger during a running flush asked for; `undefined` when none did. */
let rerunOwner: string | undefined;
let backoffStep = 0;
let backoffTimer: ReturnType<typeof setTimeout> | null = null;
/** Started syncs not yet stopped; the backoff arms only while one is running, so a stop holds against a flush still in flight. */
let activeSyncs = 0;
/** Bumped by `resetSyncForTests`, so a flush still in flight from before it changes nothing after it. */
let generation = 0;

function setSyncState(patch: Partial<SyncState>): void {
  const before: Readonly<Record<string, boolean>> = syncState;
  if (Object.entries(patch).every(([key, value]) => before[key] === value)) return;
  syncState = { ...syncState, ...patch };
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

/** An answer the replay keeps retrying; ids and statuses only. */
function logRetriedAnswer(entry: PendingEntry, res: Response, err: unknown): void {
  logRequestFailure(
    'attendance-sync',
    {
      registrationId: entry.registrationId,
      status: entry.status,
      httpStatus: res.status,
      contentType: res.headers.get('content-type'),
    },
    err,
  );
}

/** What an answer means for the entry, and what it says about the session. */
interface Classified {
  outcome: ReplayOutcome;
  /**
   * True only for the app's own answer to a request past the session check: a
   * 2xx that answers the write sent, or the app's JSON error body on a 4xx
   * other than 401, 408 and 429. A 5xx can come from the session check itself,
   * and a 2xx the replay cannot confirm may not be the app's.
   */
  signedIn: boolean;
}

async function classify(res: Response, entry: PendingEntry): Promise<Classified> {
  if (res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      logRetriedAnswer(entry, res, err);
      return { outcome: { kind: 'retry' }, signedIn: false };
    }
    if (answersEntry(isRecord(body) ? body.data : undefined, entry)) {
      return { outcome: { kind: 'confirmed', at: serverTime(res) }, signedIn: true };
    }
    logRetriedAnswer(entry, res, new Error('the 2xx answer does not match the write sent'));
    return { outcome: { kind: 'retry' }, signedIn: false };
  }
  if (res.status === 401) return { outcome: { kind: 'signed_out' }, signedIn: false };
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    if (navigator.onLine) logRetriedAnswer(entry, res, new Error('a status the replay retries'));
    return { outcome: { kind: 'retry' }, signedIn: false };
  }
  const answer = await appError(res);
  if (answer === null) {
    // A proxy, portal or filter answered, not the app: the write never reached it.
    logRetriedAnswer(entry, res, new Error('the answer is not the app\'s error body'));
    return { outcome: { kind: 'retry' }, signedIn: false };
  }
  if (res.status === 403) {
    console.warn('[attendance-sync] write dropped: the server refused it to this account', {
      registrationId: entry.registrationId,
      status: entry.status,
    });
    return { outcome: { kind: 'dropped' }, signedIn: true };
  }
  if (answer.code === 'CONCURRENT_MODIFICATION') return { outcome: { kind: 'retry' }, signedIn: true };
  return { outcome: { kind: 'refused', message: answer.message }, signedIn: true };
}

/**
 * One replay, classified; and whether no answer arrived at all (the request
 * threw or timed out). Never throws.
 */
async function send(entry: PendingEntry): Promise<Classified & { unanswered: boolean }> {
  const timeout = timeoutSignal(REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/registrations/${entry.registrationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: entry.status }),
      signal: timeout.signal,
    });
    return { ...(await classify(res, entry)), unanswered: false };
  } catch (err) {
    // Offline, a request that runs out of time is the expected case.
    if (!timeout.signal.aborted || navigator.onLine) {
      logRequestFailure(
        'attendance-sync',
        { registrationId: entry.registrationId, status: entry.status },
        err,
      );
    }
    return { outcome: { kind: 'retry' }, signedIn: false, unanswered: true };
  } finally {
    timeout.clear();
  }
}

export async function sendAttendance(entry: PendingEntry): Promise<ReplayOutcome> {
  return (await send(entry)).outcome;
}

/**
 * One pass over `ownerId`'s pending entries; answers whether any is left to
 * retry. Another owner's entries are neither sent nor settled: under this
 * session's cookie they would only be refused.
 */
async function pass(ownerId: string, gen: number): Promise<boolean> {
  return withLock(FLUSH_LOCK, async () => {
    let retried = false;
    // Fresh: another tab may have replaced or settled an entry since this tab last looked.
    const entries = Object.values(readOutbox().pending)
      .filter((entry) => entry.ownerId === ownerId)
      .sort((a, b) => a.recordedAt - b.recordedAt);
    // Nothing of this owner's is waiting, so nothing is waiting on a sign-in either.
    let signedIn = entries.length === 0;
    sending: for (const entry of entries) {
      if (gen !== generation) break;
      const sent = await send(entry);
      if (gen !== generation) break;
      signedIn ||= sent.signedIn;
      const outcome = sent.outcome;
      switch (outcome.kind) {
        case 'retry':
          retried = true;
          // No answer at all: the next entry would wait out the same failure, holding the flush lock.
          if (sent.unanswered) break sending;
          break;
        case 'signed_out':
          setSyncState({ needsSignIn: true });
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
    if (signedIn && gen === generation) setSyncState({ needsSignIn: false });
    return retried;
  });
}

function clearBackoff(): void {
  if (backoffTimer !== null) clearTimeout(backoffTimer);
  backoffTimer = null;
}

function scheduleBackoff(retried: boolean, ownerId: string): void {
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
    void flushAttendance(ownerId);
  }, delay);
}

async function run(first: string, gen: number): Promise<void> {
  try {
    let ownerId = first;
    let retried: boolean;
    let rerun: boolean;
    do {
      rerunOwner = undefined;
      try {
        retried = await pass(ownerId, gen);
      } catch (err) {
        logRequestFailure('attendance-sync', { ownerId }, err);
        // Whatever was pending is still pending; the backoff keeps trying it.
        retried = true;
      }
      if (gen !== generation) return;
      const next = rerunOwner;
      rerun = next !== undefined;
      if (next !== undefined) ownerId = next;
    } while (rerun);
    setSyncState({ retrying: retried });
    scheduleBackoff(retried, ownerId);
  } finally {
    // Synchronous with the last `rerun` check, so no trigger can slip between them unseen.
    if (gen === generation) running = null;
  }
}

/**
 * Sends `ownerId`'s pending entries. A call while a flush runs makes it run
 * one more pass when it ends, for the owner the last such call named: a tab
 * whose account changed sends only the account it now has.
 */
export function flushAttendance(ownerId: string): Promise<void> {
  if (running !== null) {
    rerunOwner = ownerId;
    return running;
  }
  running = run(ownerId, generation);
  return running;
}

/** How long an action that leaves queued changes behind (signing out, finishing a class) waits on a flush before it asks. */
export const FLUSH_WAIT_MS = 3_000;

/**
 * Flushes `ownerId`'s entries, settling when the flush does or after
 * `FLUSH_WAIT_MS`, whichever comes first. Never rejects: a failed flush is
 * logged under `tag`.
 */
export async function flushWithinWait(ownerId: string, tag: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FLUSH_WAIT_MS);
  });
  const flushed = flushAttendance(ownerId)
    .catch((err: unknown) => logRequestFailure(tag, { step: 'flush' }, err))
    .finally(() => clearTimeout(timer));
  await Promise.race([flushed, timedOut]);
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
  rerunOwner = undefined;
  syncState = SERVER_SYNC_STATE;
  syncListeners.clear();
}
