import { readError, logRequestFailure } from './client-errors';

/**
 * Attendance marks queued on the device and replayed to
 * `PUT /api/registrations/[id]` (#726). One `localStorage` key per
 * registration, owned by an account; the design and the outcome per response
 * are in docs/superpowers/specs/2026-10-04-offline-checkin-design.md (D2, D5,
 * D6, D7).
 */

export type AttendanceTarget = 'attended' | 'no_show' | 'late_cancel';

export interface OutboxEntry {
  registrationId: string;
  classId: string;
  classLabel: string;
  studentName: string;
  /** The absolute status to write — never a toggle, so a replay cannot flip it back. */
  target: AttendanceTarget;
  /** Replaced on every tap; a flush deletes an entry only if this is unchanged. */
  nonce: string;
  /** Epoch ms; display and ordering only — the server reads no timestamp. */
  recordedAt: number;
  attempts: number;
  /** Whether the page it was tapped on showed the class completed. */
  knownCompleted: boolean;
}

export interface RefusedEntry extends OutboxEntry {
  message: string;
  refusedAt: number;
}

export interface CompletionNote {
  classId: string;
  classLabel: string;
}

export interface OutboxSnapshot {
  queued: readonly OutboxEntry[];
  refused: readonly RefusedEntry[];
  notes: readonly CompletionNote[];
  needsSignIn: boolean;
  /** Statuses a flush confirmed during this page's lifetime, by registration id. */
  confirmed: Readonly<Record<string, AttendanceTarget>>;
}

const QUEUED_PREFIX = 'fy-outbox:';
const REFUSED_PREFIX = 'fy-outbox-refused:';
const NOTE_PREFIX = 'fy-outbox-note:';
const PREFIXES = [QUEUED_PREFIX, REFUSED_PREFIX, NOTE_PREFIX] as const;
const VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_NAME = 'fy-outbox';
/** Far above one pass; a holder that keeps the lock longer is treated as gone, and this flush ends. */
const LOCK_WAIT_MS = 60_000;
/** Set while `removeKeys` runs, so another tab does not read its removals as flushed entries. */
const CLEARING_KEY = 'fy-outbox-clearing';
const REFUSED_FALLBACK = "This change couldn't be saved.";
const TARGETS: ReadonlySet<string> = new Set<AttendanceTarget>(['attended', 'no_show', 'late_cancel']);

export const EMPTY_OUTBOX: OutboxSnapshot = Object.freeze({
  queued: Object.freeze([]),
  refused: Object.freeze([]),
  notes: Object.freeze([]),
  needsSignIn: false,
  confirmed: Object.freeze({}),
});

const listeners = new Set<() => void>();
/** Per owner. Each change replaces the record, never mutates it: a cached snapshot holds it. */
const confirmedByOwner = new Map<string, Readonly<Record<string, AttendanceTarget>>>();
const needsSignInByOwner = new Set<string>();
/** The last snapshot handed out per owner, and its content, so an unchanged read returns the same object. */
const snapshotCache = new Map<string, { content: string; snapshot: OutboxSnapshot }>();
const EMPTY_CONTENT = JSON.stringify(EMPTY_OUTBOX);

/** Nonces queued by this document: an applied write of one is a tap whose row already shows it, not a replay. */
const enqueuedHere = new Set<string>();

/** Whether another tab is clearing, as its `CLEARING_KEY` events say. */
let otherTabClearing = false;

/** What a flush reports: writes the server applied, and how many of those were not queued by this document. */
export interface FlushResult {
  applied: number;
  replayed: number;
}

let running: Promise<FlushResult> | null = null;
/** Owners whose flush was asked for while one was running: each gets one more pass. */
const rerun = new Set<string>();

// ---------------------------------------------------------------------------
// Storage. Every access may throw (private mode, quota, blocked site data).

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function keyFor(prefix: string, owner: string, id: string): string {
  return `${prefix}${owner}:${id}`;
}

/** Every key under `prefix`, with the owner and id it names. Collected first: removal shifts indices. */
function keysUnder(store: Storage, prefix: string): Array<{ key: string; owner: string; id: string }> {
  const found: Array<{ key: string; owner: string; id: string }> = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const colon = rest.indexOf(':');
    if (colon < 0) found.push({ key, owner: '', id: '' });
    else found.push({ key, owner: rest.slice(0, colon), id: rest.slice(colon + 1) });
  }
  return found;
}

function write(key: string, value: object): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    store.setItem(key, JSON.stringify({ v: VERSION, ...value }));
    return true;
  } catch {
    return false;
  }
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do: the key stays, and the next read sees it.
  }
}

function readJson(store: Storage, key: string): unknown {
  try {
    const raw = store.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asEntry(value: unknown, id: string): OutboxEntry | null {
  if (!isRecord(value) || value.v !== VERSION) return null;
  const { registrationId, classId, classLabel, studentName, target, nonce, recordedAt, attempts, knownCompleted } =
    value;
  if (
    registrationId !== id ||
    typeof classId !== 'string' ||
    typeof classLabel !== 'string' ||
    typeof studentName !== 'string' ||
    typeof target !== 'string' ||
    !TARGETS.has(target) ||
    typeof nonce !== 'string' ||
    typeof recordedAt !== 'number' ||
    typeof attempts !== 'number' ||
    typeof knownCompleted !== 'boolean'
  ) {
    return null;
  }
  return {
    registrationId: id,
    classId,
    classLabel,
    studentName,
    target: target as AttendanceTarget,
    nonce,
    recordedAt,
    attempts,
    knownCompleted,
  };
}

function asRefused(value: unknown, id: string): RefusedEntry | null {
  const entry = asEntry(value, id);
  if (entry === null || !isRecord(value)) return null;
  const { message, refusedAt } = value;
  if (typeof message !== 'string' || typeof refusedAt !== 'number') return null;
  return { ...entry, message, refusedAt };
}

function asNote(value: unknown, id: string): CompletionNote | null {
  if (!isRecord(value) || value.v !== VERSION) return null;
  const { classId, classLabel } = value;
  if (classId !== id || typeof classLabel !== 'string') return null;
  return { classId: id, classLabel };
}

/** The owner's valid values under `prefix`; a wrong-shaped one is deleted. */
function readAll<T>(owner: string, prefix: string, parse: (value: unknown, id: string) => T | null): T[] {
  const store = storage();
  if (store === null) return [];
  const values: T[] = [];
  try {
    for (const { key, owner: keyOwner, id } of keysUnder(store, prefix)) {
      if (keyOwner !== owner) continue;
      const parsed = parse(readJson(store, key), id);
      if (parsed === null) remove(key);
      else values.push(parsed);
    }
  } catch {
    return values;
  }
  return values;
}

function readQueued(owner: string): OutboxEntry[] {
  return readAll(owner, QUEUED_PREFIX, asEntry).sort(
    (a, b) => a.recordedAt - b.recordedAt || a.registrationId.localeCompare(b.registrationId),
  );
}

function readStoredEntry(owner: string, registrationId: string): OutboxEntry | null {
  const store = storage();
  if (store === null) return null;
  return asEntry(readJson(store, keyFor(QUEUED_PREFIX, owner, registrationId)), registrationId);
}

// ---------------------------------------------------------------------------
// The store.

function notify(): void {
  listeners.forEach((listener) => listener());
}

function stringField(event: Event, field: 'key' | 'oldValue' | 'newValue'): string | null | undefined {
  if (!(field in event)) return undefined;
  const value: unknown = (event as unknown as Record<string, unknown>)[field];
  return typeof value === 'string' || value === null ? value : undefined;
}

/**
 * Another tab changed storage. A queued key it removed without refusing the
 * entry was flushed there, so its target is confirmed here too — otherwise the
 * row would fall back to this tab's stale server render.
 */
function onStorage(event: Event): void {
  const key = stringField(event, 'key');
  if (key === CLEARING_KEY) {
    otherTabClearing = stringField(event, 'newValue') !== null;
    return;
  }
  if (key !== null && !(typeof key === 'string' && PREFIXES.some((prefix) => key.startsWith(prefix)))) return;
  if (typeof key === 'string' && key.startsWith(QUEUED_PREFIX) && !otherTabClearing) {
    confirmRemovedElsewhere(key, stringField(event, 'oldValue'), stringField(event, 'newValue'));
  }
  notify();
}

function confirmRemovedElsewhere(
  key: string,
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
): void {
  if (newValue !== null || typeof oldValue !== 'string') return;
  const rest = key.slice(QUEUED_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return;
  const owner = rest.slice(0, colon);
  const id = rest.slice(colon + 1);
  let old: OutboxEntry | null;
  try {
    old = asEntry(JSON.parse(oldValue) as unknown, id);
  } catch {
    return;
  }
  const store = storage();
  if (old === null || store === null) return;
  if (readJson(store, keyFor(REFUSED_PREFIX, owner, id)) !== null) return;
  confirm(owner, id, old.target);
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

/**
 * Read fresh from storage on every call, so another tab's write or an expiry
 * shows without a notification; the same object comes back while the content
 * is unchanged, as `useSyncExternalStore` requires.
 */
export function getOutboxSnapshot(owner: string): OutboxSnapshot {
  const now = Date.now();
  const refused = readAll(owner, REFUSED_PREFIX, asRefused).filter((entry) => {
    if (now - entry.refusedAt <= REFUSED_TTL_MS) return true;
    remove(keyFor(REFUSED_PREFIX, owner, entry.registrationId));
    return false;
  });
  const next: OutboxSnapshot = {
    queued: readQueued(owner),
    refused: refused.sort((a, b) => a.refusedAt - b.refusedAt || a.registrationId.localeCompare(b.registrationId)),
    notes: readAll(owner, NOTE_PREFIX, asNote).sort((a, b) => a.classId.localeCompare(b.classId)),
    needsSignIn: needsSignInByOwner.has(owner),
    confirmed: confirmedByOwner.get(owner) ?? EMPTY_OUTBOX.confirmed,
  };
  const content = JSON.stringify(next);
  if (content === EMPTY_CONTENT) return EMPTY_OUTBOX;
  const cached = snapshotCache.get(owner);
  if (cached !== undefined && cached.content === content) return cached.snapshot;
  snapshotCache.set(owner, { content, snapshot: next });
  return next;
}

export function pendingCount(owner: string): number {
  const { queued, refused } = getOutboxSnapshot(owner);
  return queued.length + refused.length;
}

/**
 * Queue a mark, replacing any queued or refused one for that registration.
 * `'unavailable'` when storage cannot hold it — the caller then writes
 * directly instead of queueing silently.
 */
export function enqueueAttendance(
  owner: string,
  entry: Omit<OutboxEntry, 'nonce' | 'recordedAt' | 'attempts'>,
): 'queued' | 'unavailable' {
  let nonce: string;
  try {
    nonce = crypto.randomUUID();
  } catch {
    return 'unavailable';
  }
  const full: OutboxEntry = { ...entry, nonce, recordedAt: Date.now(), attempts: 0 };
  if (!write(keyFor(QUEUED_PREFIX, owner, entry.registrationId), full)) return 'unavailable';
  enqueuedHere.add(nonce);
  remove(keyFor(REFUSED_PREFIX, owner, entry.registrationId));
  notify();
  return 'queued';
}

export function dismissRefused(owner: string, registrationId: string): void {
  remove(keyFor(REFUSED_PREFIX, owner, registrationId));
  notify();
}

export function dismissNote(owner: string, classId: string): void {
  remove(keyFor(NOTE_PREFIX, owner, classId));
  notify();
}

function removeKeys(keep: (owner: string) => boolean): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(CLEARING_KEY, '1');
  } catch {
    // Another tab may then confirm what this one removes; the removals still happen.
  }
  try {
    for (const prefix of PREFIXES) {
      for (const { key, owner } of keysUnder(store, prefix)) if (!keep(owner)) remove(key);
    }
  } catch {
    // A store that throws on enumeration holds nothing this module can reach.
  }
  remove(CLEARING_KEY);
}

/** Every outbox key of any other account goes; the owner's stay. */
export function purgeOtherOwners(owner: string): void {
  removeKeys((keyOwner) => keyOwner === owner);
  for (const other of confirmedByOwner.keys()) if (other !== owner) confirmedByOwner.delete(other);
  for (const other of needsSignInByOwner) if (other !== owner) needsSignInByOwner.delete(other);
  notify();
}

/** Every outbox key, whatever its owner — for sign-out and account deletion. */
export function clearAllOutboxes(): void {
  removeKeys(() => false);
  confirmedByOwner.clear();
  needsSignInByOwner.clear();
  notify();
}

function setNeedsSignIn(owner: string, value: boolean): void {
  if (needsSignInByOwner.has(owner) === value) return;
  if (value) needsSignInByOwner.add(owner);
  else needsSignInByOwner.delete(owner);
  notify();
}

function confirm(owner: string, registrationId: string, target: AttendanceTarget): void {
  confirmedByOwner.set(owner, { ...confirmedByOwner.get(owner), [registrationId]: target });
}

// ---------------------------------------------------------------------------
// Flushing.

/** What one PUT did to the flush: stop it, or carry on — and whether a newer tap replaced the entry meanwhile. */
type SendResult = 'stop' | { applied: boolean; replayed: boolean; superseded: boolean };

/** Apply `change` to the stored entry only if it is still the one that was sent. Reports a newer one as superseded. */
function ifUnchanged(owner: string, sent: OutboxEntry, change: () => void): boolean {
  const stored = readStoredEntry(owner, sent.registrationId);
  if (stored === null) return false;
  if (stored.nonce !== sent.nonce) return true;
  change();
  return false;
}

function refuse(owner: string, entry: OutboxEntry, message: string, attempts: number): boolean {
  return ifUnchanged(owner, entry, () => {
    const refused: RefusedEntry = { ...entry, attempts, message, refusedAt: Date.now() };
    if (write(keyFor(REFUSED_PREFIX, owner, entry.registrationId), refused)) {
      remove(keyFor(QUEUED_PREFIX, owner, entry.registrationId));
    }
  });
}

function isAppliedBody(
  value: unknown,
  entry: OutboxEntry,
): value is { data: { id: string; status: string; classCompleted?: unknown }; outcome?: unknown } {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  return value.data.id === entry.registrationId && value.data.status === entry.target;
}

async function readJsonBody(res: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: (await res.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

async function send(owner: string, entry: OutboxEntry): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`/api/registrations/${encodeURIComponent(entry.registrationId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: entry.target }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Offline, timed out or redirected (a portal): the entry waits for the next flush.
    return 'stop';
  }

  if (res.status === 200) {
    const read = await readJsonBody(res);
    if (!read.ok || !isAppliedBody(read.body, entry)) return 'stop';
    const { body } = read;
    setNeedsSignIn(owner, false);
    const superseded = ifUnchanged(owner, entry, () => remove(keyFor(QUEUED_PREFIX, owner, entry.registrationId)));
    confirm(owner, entry.registrationId, entry.target);
    const applied = body.outcome === undefined;
    if (applied && body.data.classCompleted === true && !entry.knownCompleted) {
      write(keyFor(NOTE_PREFIX, owner, entry.classId), { classId: entry.classId, classLabel: entry.classLabel });
    }
    notify();
    return { applied, replayed: applied && !enqueuedHere.has(entry.nonce), superseded };
  }

  if (res.status === 401) {
    setNeedsSignIn(owner, true);
    return 'stop';
  }

  const retryable = res.status === 500 || res.status === 409;
  const refusable = res.status >= 400 && res.status < 500 && res.status !== 429;
  if (!retryable && !refusable) return 'stop';

  // A 4xx that is not JSON came from something other than the app (a proxy, a
  // portal) and says nothing about the entry. A 500 is counted whatever its body.
  if (res.status !== 500 && !(await readJsonBody(res.clone())).ok) return 'stop';
  const { code, message } = await readError(res, REFUSED_FALLBACK);
  if (res.status !== 500) setNeedsSignIn(owner, false);

  let superseded: boolean;
  if (res.status === 500 || code === 'CONCURRENT_MODIFICATION') {
    const attempts = entry.attempts + 1;
    superseded =
      attempts >= MAX_ATTEMPTS
        ? refuse(owner, entry, message, attempts)
        : ifUnchanged(owner, entry, () =>
            write(keyFor(QUEUED_PREFIX, owner, entry.registrationId), { ...entry, attempts }),
          );
  } else {
    superseded = refuse(owner, entry, message, entry.attempts);
  }
  notify();
  return { applied: false, replayed: false, superseded };
}

/**
 * One pass over the owner's queue, oldest first. An entry a newer tap replaced
 * while its PUT was in flight is sent again before the pass ends.
 */
async function pass(owner: string): Promise<FlushResult> {
  const counts: FlushResult = { applied: 0, replayed: 0 };
  let only: Set<string> | null = null;
  for (;;) {
    const entries = readQueued(owner).filter((entry) => only === null || only.has(entry.registrationId));
    if (entries.length === 0) {
      if (only === null) setNeedsSignIn(owner, false);
      return counts;
    }
    const superseded = new Set<string>();
    for (const entry of entries) {
      const result = await send(owner, entry);
      if (result === 'stop') return counts;
      if (result.applied) counts.applied++;
      if (result.replayed) counts.replayed++;
      if (result.superseded) superseded.add(entry.registrationId);
    }
    if (superseded.size === 0) return counts;
    only = superseded;
  }
}

/**
 * A pass under the cross-tab lock where the browser has one. Never throws. A
 * lock not granted within `LOCK_WAIT_MS` ends this pass with the entries still
 * queued, so a holder that never lets go cannot stall this tab's flushes.
 */
async function lockedPass(owner: string): Promise<FlushResult> {
  try {
    const locks: LockManager | undefined = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return await pass(owner);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('The outbox lock was not granted in time.', 'TimeoutError')),
      LOCK_WAIT_MS,
    );
    try {
      return await locks.request(LOCK_NAME, { signal: controller.signal }, () => {
        clearTimeout(timer);
        return pass(owner);
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logRequestFailure('attendance-outbox', { stage: 'flush' }, err);
    return { applied: 0, replayed: 0 };
  }
}

/**
 * Replay the owner's queue. One flush per tab at a time: a call during one
 * returns the running promise and adds one more pass to it. Never rejects.
 */
export function flushOutbox(owner: string): Promise<FlushResult> {
  if (running !== null) {
    rerun.add(owner);
    return running;
  }
  const run = (async () => {
    try {
      const total = await lockedPass(owner);
      for (let next = rerun.values().next(); !next.done; next = rerun.values().next()) {
        rerun.delete(next.value);
        const more = await lockedPass(next.value);
        total.applied += more.applied;
        total.replayed += more.replayed;
      }
      return total;
    } finally {
      running = null;
    }
  })();
  running = run;
  return run;
}

/** Test-only. */
export function resetOutboxForTests(): void {
  if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  listeners.clear();
  confirmedByOwner.clear();
  needsSignInByOwner.clear();
  snapshotCache.clear();
  rerun.clear();
  enqueuedHere.clear();
  otherTabClearing = false;
  running = null;
}
