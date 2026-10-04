import { useSyncExternalStore } from 'react';
import type { z } from 'zod';
import type { updateRegistrationSchema } from '@/lib/schemas';
import type { AttendanceStatus } from '@/lib/registration-status';

export type QueuedStatus = z.infer<typeof updateRegistrationSchema>['status'];

export interface PendingEntry {
  id: string;
  ownerId: string;
  registrationId: string;
  classId: string;
  studentName: string;
  status: QueuedStatus;
  recordedAt: number;
}
export interface ConfirmedEntry {
  status: QueuedStatus;
  confirmedAt: number;
}
export interface RefusedEntry extends PendingEntry {
  message: string;
  refusedAt: number;
}
export interface OutboxState {
  /** Keyed by registrationId. */
  pending: Readonly<Record<string, PendingEntry>>;
  /** Keyed by registrationId. */
  confirmed: Readonly<Record<string, ConfirmedEntry>>;
  /** Keyed by registrationId. */
  refused: Readonly<Record<string, RefusedEntry>>;
}

/** `at` is the server's clock (the response's `Date` header), so it compares with the page's server-side `renderedAt`. */
export type Settlement =
  | { kind: 'confirmed'; at: number }
  | { kind: 'refused'; message: string }
  | { kind: 'dropped' };

const KEY = 'fy-outbox-v1';
const LOCK = 'fy-outbox';
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;
const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tethered to the schema: a status added there fails to compile here until it is listed. */
const QUEUED = { attended: true, no_show: true, late_cancel: true } satisfies Record<QueuedStatus, true>;
const QUEUED_KEYS: ReadonlySet<string> = new Set(Object.keys(QUEUED));

export const EMPTY_OUTBOX: OutboxState = Object.freeze({ pending: {}, confirmed: {}, refused: {} });

/** Used when `localStorage` throws (private window, blocked storage): this tab only. */
let memory: string | null = null;
let useMemory = false;
let cached: OutboxState | null = null;
/** The stored text `cached` was parsed from or written as. */
let cachedRaw: string | null = null;
const listeners = new Set<() => void>();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isQueued(v: unknown): v is QueuedStatus {
  return typeof v === 'string' && QUEUED_KEYS.has(v);
}
function asPending(v: unknown): PendingEntry | null {
  if (!isRecord(v)) return null;
  const { id, ownerId, registrationId, classId, studentName, status, recordedAt } = v;
  if (
    typeof id !== 'string' ||
    typeof ownerId !== 'string' ||
    typeof registrationId !== 'string' ||
    typeof classId !== 'string' ||
    typeof studentName !== 'string' ||
    !isQueued(status) ||
    typeof recordedAt !== 'number'
  ) {
    return null;
  }
  return { id, ownerId, registrationId, classId, studentName, status, recordedAt };
}
function asConfirmed(v: unknown): ConfirmedEntry | null {
  if (!isRecord(v)) return null;
  const { status, confirmedAt } = v;
  if (!isQueued(status) || typeof confirmedAt !== 'number') return null;
  return { status, confirmedAt };
}
function asRefused(v: unknown): RefusedEntry | null {
  const base = asPending(v);
  if (base === null || !isRecord(v)) return null;
  const { message, refusedAt } = v;
  if (typeof message !== 'string' || typeof refusedAt !== 'number') return null;
  return { ...base, message, refusedAt };
}

function readRaw(): string | null {
  if (useMemory) return memory;
  try {
    return localStorage.getItem(KEY);
  } catch {
    useMemory = true;
    return memory;
  }
}
function writeRaw(value: string | null): void {
  if (!useMemory) {
    try {
      if (value === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
      return;
    } catch {
      useMemory = true;
    }
  }
  memory = value;
}

/** Keeps the entries of `source` that `guard` accepts and `keep` approves. */
function pick<T>(
  source: unknown,
  guard: (v: unknown) => T | null,
  keep: (entry: T, key: string) => boolean,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    const entry = guard(value);
    if (entry !== null && keep(entry, key)) out[key] = entry;
  }
  return out;
}

/** Parses what is stored, keeping only well-formed, unexpired entries. Never throws. */
function parse(raw: string | null, now: number): OutboxState {
  if (raw === null) return EMPTY_OUTBOX;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return EMPTY_OUTBOX;
  }
  if (!isRecord(doc)) return EMPTY_OUTBOX;
  return {
    pending: pick(doc.pending, asPending, (e, key) => e.registrationId === key),
    confirmed: pick(doc.confirmed, asConfirmed, (e) => now - e.confirmedAt <= CONFIRMED_TTL_MS),
    refused: pick(
      doc.refused,
      asRefused,
      (e, key) => e.registrationId === key && now - e.refusedAt <= REFUSED_TTL_MS,
    ),
  };
}

export function getOutbox(): OutboxState {
  if (cached === null) {
    cachedRaw = readRaw();
    cached = parse(cachedRaw, Date.now());
  }
  return cached;
}
/**
 * Reads storage past the cache, which only this tab's writes and a subscribed
 * `storage` listener refresh. Keeps the cached object, and its identity, when
 * nothing changed; otherwise subscribers are told.
 */
export function readOutbox(): OutboxState {
  const raw = readRaw();
  if (cached !== null && raw === cachedRaw) return cached;
  const hadCache = cached !== null;
  cached = parse(raw, Date.now());
  cachedRaw = raw;
  if (hadCache) notify();
  return cached;
}
function notify(): void {
  listeners.forEach((l) => l());
}
function commit(next: OutboxState): void {
  cachedRaw = JSON.stringify(next);
  writeRaw(cachedRaw);
  cached = next;
  notify();
}
function onStorage(e: StorageEvent): void {
  if (e.key !== KEY && e.key !== null) return;
  cached = null;
  notify();
}
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}
export function useOutbox(): OutboxState {
  return useSyncExternalStore(subscribeOutbox, getOutbox, () => EMPTY_OUTBOX);
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(name, fn) : fn();
}

/** Read-modify-write against a fresh read, so another tab's write is never lost. */
async function update(change: (current: OutboxState) => OutboxState): Promise<void> {
  await withLock(LOCK, async () => {
    cached = null;
    commit(change(getOutbox()));
  });
}

export async function enqueueAttendance(
  input: Omit<PendingEntry, 'id' | 'recordedAt'>,
): Promise<PendingEntry> {
  const entry: PendingEntry = { ...input, id: crypto.randomUUID(), recordedAt: Date.now() };
  await update((s) => ({ ...s, pending: { ...s.pending, [entry.registrationId]: entry } }));
  return entry;
}

export async function settleEntry(sent: PendingEntry, settlement: Settlement): Promise<void> {
  await update((s) => {
    if (s.pending[sent.registrationId]?.id !== sent.id) return s; // a newer tap replaced it
    const pending = { ...s.pending };
    delete pending[sent.registrationId];
    switch (settlement.kind) {
      case 'confirmed':
        return {
          ...s,
          pending,
          confirmed: {
            ...s.confirmed,
            [sent.registrationId]: { status: sent.status, confirmedAt: settlement.at },
          },
        };
      case 'refused':
        return {
          ...s,
          pending,
          refused: {
            ...s.refused,
            [sent.registrationId]: { ...sent, message: settlement.message, refusedAt: Date.now() },
          },
        };
      case 'dropped':
        return { ...s, pending };
      default: {
        const unreachable: never = settlement;
        throw new Error(`unhandled settlement: ${JSON.stringify(unreachable)}`);
      }
    }
  });
}

export async function dismissRefused(registrationId: string): Promise<void> {
  await update((s) => {
    const refused = { ...s.refused };
    delete refused[registrationId];
    return { ...s, refused };
  });
}

export async function clearOutbox(): Promise<void> {
  await withLock(LOCK, async () => {
    writeRaw(null);
    cached = EMPTY_OUTBOX;
    cachedRaw = null;
    notify();
  });
}

export function shownStatus(
  outbox: OutboxState,
  registrationId: string,
  rendered: AttendanceStatus,
  renderedAt: number,
): { status: AttendanceStatus; pending: boolean } {
  const pending = outbox.pending[registrationId];
  if (pending) return { status: pending.status, pending: true };
  const confirmed = outbox.confirmed[registrationId];
  // `confirmedAt` is a `Date` header, truncated to the second, so it can read up to 999 ms early.
  if (confirmed && confirmed.confirmedAt + 1000 > renderedAt) {
    return { status: confirmed.status, pending: false };
  }
  return { status: rendered, pending: false };
}

export function resetOutboxForTests(): void {
  cached = null;
  memory = null;
  useMemory = false;
  listeners.clear();
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
}
