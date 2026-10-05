import { readError, logRequestFailure } from './client-errors';

/**
 * Attendance marks queued on the device and replayed to
 * `PUT /api/registrations/[id]` (#726). One `localStorage` key per item,
 * owned by an account. The key scheme and how it behaves — the outcome per
 * response, confirmations and the cross-tab rules included — is in
 * docs/technical-architecture.md (Offline (service worker) → The attendance outbox).
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

/**
 * Who said no: `verdict` is the app's own answer to the write, and the server
 * holds whatever it held before; `retries-exhausted` is this module giving up
 * after `MAX_ATTEMPTS`, and the server may never have seen the mark.
 */
export type RefusalKind = 'verdict' | 'retries-exhausted';

const REFUSAL_KINDS = { verdict: true, 'retries-exhausted': true } satisfies Record<RefusalKind, true>;

function isRefusalKind(value: unknown): value is RefusalKind {
  return typeof value === 'string' && Object.hasOwn(REFUSAL_KINDS, value);
}

export interface RefusedEntry extends OutboxEntry {
  message: string;
  refusedAt: number;
  kind: RefusalKind;
}

export interface CompletionNote {
  classId: string;
  classLabel: string;
}

/** A status the server answered for a mark, kept so a page rendered before the answer can still show it. */
export interface Confirmation {
  target: AttendanceTarget;
  /** Epoch ms of the server's answer, from its `Date` header (second resolution); the device clock without one. */
  confirmedAt: number;
}

export interface OutboxSnapshot {
  queued: readonly OutboxEntry[];
  refused: readonly RefusedEntry[];
  notes: readonly CompletionNote[];
  needsSignIn: boolean;
  /** Statuses a flush in any tab or document confirmed in the last day, by registration id. */
  confirmed: Readonly<Record<string, Confirmation>>;
}

const QUEUED_PREFIX = 'fy-outbox:';
const REFUSED_PREFIX = 'fy-outbox-refused:';
const NOTE_PREFIX = 'fy-outbox-note:';
const CONFIRMED_PREFIX = 'fy-outbox-confirmed:';
const PREFIXES = [QUEUED_PREFIX, REFUSED_PREFIX, NOTE_PREFIX, CONFIRMED_PREFIX] as const;
const VERSION = 1;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The stored pages' retention (docs/superpowers/specs/2026-10-04-offline-schedule-design.md, D7). */
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_NAME = 'fy-outbox';
/** Far above one pass; a holder that keeps the lock longer is treated as gone, and this pass ends with its entries queued. */
const LOCK_WAIT_MS = 60_000;
const REFUSED_FALLBACK = "This change couldn't be saved.";
/** A refusal after `MAX_ATTEMPTS`: the server's own words there ask for a refresh, which does nothing for a queued mark. */
const RETRIES_EXHAUSTED = "This change couldn't be saved after several tries.";
const TARGETS: ReadonlySet<string> = new Set<AttendanceTarget>(['attended', 'no_show', 'late_cancel']);

export const EMPTY_OUTBOX: OutboxSnapshot = Object.freeze({
  queued: Object.freeze([]),
  refused: Object.freeze([]),
  notes: Object.freeze([]),
  needsSignIn: false,
  confirmed: Object.freeze({}),
});

const listeners = new Set<() => void>();
const needsSignInByOwner = new Set<string>();
/** The last snapshot handed out per owner, and its content, so an unchanged read returns the same object. */
const snapshotCache = new Map<string, { content: string; snapshot: OutboxSnapshot }>();
const EMPTY_CONTENT = JSON.stringify(EMPTY_OUTBOX);

/** Nonces queued by this document: an applied write of one is a tap whose row already shows it, not a replay. */
const enqueuedHere = new Set<string>();

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

type WriteResult = { ok: true } | { ok: false; err: unknown };

function tryWrite(key: string, value: object): WriteResult {
  const store = storage();
  if (store === null) return { ok: false, err: new Error('storage is unavailable') };
  try {
    store.setItem(key, JSON.stringify({ v: VERSION, ...value }));
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function write(key: string, value: object): boolean {
  return tryWrite(key, value).ok;
}

/** A flush write that failed: the entry stays as it was, and is sent again on every flush. */
function logWriteFailure(entry: OutboxEntry, what: 'refused' | 'attempts', err: unknown): void {
  logRequestFailure('attendance-outbox', { stage: 'store', registrationId: entry.registrationId, write: what }, err);
}

function remove(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // Nothing to do: the key stays, and the next read sees it.
  }
}

/** A stored value: gone, unreadable (the read threw), not JSON, or parsed. */
type StoredValue = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'invalid' } | { kind: 'parsed'; value: unknown };

function readJson(store: Storage, key: string): StoredValue {
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return { kind: 'unreadable' };
  }
  if (raw === null) return { kind: 'missing' };
  try {
    return { kind: 'parsed', value: JSON.parse(raw) as unknown };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Written by a later version of this module, which may still want it. */
function isNewerFormat(value: unknown): boolean {
  return isRecord(value) && typeof value.v === 'number' && value.v > VERSION;
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
  const { message, refusedAt, kind } = value;
  if (typeof message !== 'string' || typeof refusedAt !== 'number' || !isRefusalKind(kind)) return null;
  return { ...entry, message, refusedAt, kind };
}

function asConfirmation(
  value: unknown,
  id: string,
): { registrationId: string; confirmation: Confirmation } | null {
  if (!isRecord(value) || value.v !== VERSION) return null;
  const { target, confirmedAt } = value;
  if (typeof target !== 'string' || !TARGETS.has(target) || typeof confirmedAt !== 'number') return null;
  return { registrationId: id, confirmation: { target: target as AttendanceTarget, confirmedAt } };
}

function asNote(value: unknown, id: string): CompletionNote | null {
  if (!isRecord(value) || value.v !== VERSION) return null;
  const { classId, classLabel } = value;
  if (classId !== id || typeof classLabel !== 'string') return null;
  return { classId: id, classLabel };
}

/**
 * The owner's valid values under `prefix`. A value that is not JSON, or has the
 * wrong shape, is deleted; one in a newer format, or one whose read threw, is
 * skipped and kept.
 */
function readAll<T>(owner: string, prefix: string, parse: (value: unknown, id: string) => T | null): T[] {
  const store = storage();
  if (store === null) return [];
  const values: T[] = [];
  try {
    for (const { key, owner: keyOwner, id } of keysUnder(store, prefix)) {
      if (keyOwner !== owner) continue;
      const stored = readJson(store, key);
      if (stored.kind === 'missing' || stored.kind === 'unreadable') continue;
      if (stored.kind === 'parsed' && isNewerFormat(stored.value)) continue;
      const parsed = stored.kind === 'parsed' ? parse(stored.value, id) : null;
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
  const stored = readJson(store, keyFor(QUEUED_PREFIX, owner, registrationId));
  return stored.kind === 'parsed' ? asEntry(stored.value, registrationId) : null;
}

// ---------------------------------------------------------------------------
// The store.

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Another tab changed storage. Everything it did is in storage, so a read is
 * all this tab needs. A `null` key is a `clear()` of the whole store.
 */
function onStorage(event: StorageEvent): void {
  const { key } = event;
  if (key !== null && !PREFIXES.some((prefix) => key.startsWith(prefix))) return;
  notify();
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
  const confirmed: Record<string, Confirmation> = {};
  for (const { registrationId, confirmation } of readAll(owner, CONFIRMED_PREFIX, asConfirmation).sort((a, b) =>
    a.registrationId.localeCompare(b.registrationId),
  )) {
    if (now - confirmation.confirmedAt <= CONFIRMED_TTL_MS) confirmed[registrationId] = confirmation;
    else remove(keyFor(CONFIRMED_PREFIX, owner, registrationId));
  }
  const next: OutboxSnapshot = {
    queued: readQueued(owner),
    refused: refused.sort((a, b) => a.refusedAt - b.refusedAt || a.registrationId.localeCompare(b.registrationId)),
    notes: readAll(owner, NOTE_PREFIX, asNote).sort((a, b) => a.classId.localeCompare(b.classId)),
    needsSignIn: needsSignInByOwner.has(owner),
    confirmed: Object.keys(confirmed).length === 0 ? EMPTY_OUTBOX.confirmed : confirmed,
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
 * directly instead of queueing silently, and the row's older queued mark and
 * confirmation are dropped: either would show in its place, and a queued one
 * would later overwrite it.
 */
export function enqueueAttendance(
  owner: string,
  entry: Omit<OutboxEntry, 'nonce' | 'recordedAt' | 'attempts'>,
): 'queued' | 'unavailable' {
  const queuedKey = keyFor(QUEUED_PREFIX, owner, entry.registrationId);
  const unavailable = (): 'unavailable' => {
    remove(queuedKey);
    remove(keyFor(CONFIRMED_PREFIX, owner, entry.registrationId));
    notify();
    return 'unavailable';
  };
  let nonce: string;
  try {
    nonce = crypto.randomUUID();
  } catch {
    return unavailable();
  }
  const full: OutboxEntry = { ...entry, nonce, recordedAt: Date.now(), attempts: 0 };
  if (!write(queuedKey, full)) return unavailable();
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
    for (const prefix of PREFIXES) {
      for (const { key, owner } of keysUnder(store, prefix)) if (!keep(owner)) remove(key);
    }
  } catch {
    // A store that throws on enumeration holds nothing this module can reach.
  }
}

/** Every outbox key of any other account goes; the owner's stay. */
export function purgeOtherOwners(owner: string): void {
  removeKeys((keyOwner) => keyOwner === owner);
  for (const other of needsSignInByOwner) if (other !== owner) needsSignInByOwner.delete(other);
  notify();
}

/** Every outbox key, whatever its owner — for sign-out and account deletion. */
export function clearAllOutboxes(): void {
  removeKeys(() => false);
  needsSignInByOwner.clear();
  notify();
}

function setNeedsSignIn(owner: string, value: boolean): void {
  if (needsSignInByOwner.has(owner) === value) return;
  if (value) needsSignInByOwner.add(owner);
  else needsSignInByOwner.delete(owner);
  notify();
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

function refuse(owner: string, entry: OutboxEntry, kind: RefusalKind, message: string, attempts: number): boolean {
  return ifUnchanged(owner, entry, () => {
    const refused: RefusedEntry = { ...entry, attempts, message, refusedAt: Date.now(), kind };
    const written = tryWrite(keyFor(REFUSED_PREFIX, owner, entry.registrationId), refused);
    // Unwritten, the refusal would be lost with the queued key, so that stays.
    if (written.ok) remove(keyFor(QUEUED_PREFIX, owner, entry.registrationId));
    else logWriteFailure(entry, 'refused', written.err);
  });
}

/** A signal that aborts after `ms`; built by hand where the browser has no `AbortSignal.timeout`. */
function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('The request timed out.', 'TimeoutError')), ms);
  return controller.signal;
}

/** The URL an attendance mark is written to. */
export function attendanceUrl(registrationId: string): string {
  return `/api/registrations/${encodeURIComponent(registrationId)}`;
}

/**
 * The request that writes an attendance mark, queued or direct: no redirect
 * followed (a portal's answer is not the app's), nothing cached, 10 s timeout.
 */
export function attendanceRequest(target: AttendanceTarget): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: target }),
    redirect: 'error',
    cache: 'no-store',
    signal: timeoutSignal(REQUEST_TIMEOUT_MS),
  };
}

/** Whether `value` is the app's answer for this write: the registration, holding the target. */
export function isAttendanceAnswer(
  value: unknown,
  registrationId: string,
  target: AttendanceTarget,
): value is { data: { id: string; status: string; classCompleted?: unknown }; outcome?: unknown } {
  if (!isRecord(value) || !isRecord(value.data)) return false;
  return value.data.id === registrationId && value.data.status === target;
}

/**
 * Ends the pass with the entry kept. Logged when the device says it is online,
 * so a stop that keeps recurring leaves a trace; offline it is the expected case.
 */
function stop(
  entry: OutboxEntry,
  reason: 'thrown' | 'non-matching-body' | 'status',
  status: number | undefined,
  err: unknown,
): 'stop' {
  if (typeof navigator !== 'undefined' && navigator.onLine === true) {
    logRequestFailure('attendance-outbox', { stage: 'send', registrationId: entry.registrationId, reason, status }, err);
  }
  return 'stop';
}

/** When the server answered, by its `Date` header; the device clock when the header is missing or unreadable. */
function answeredAt(res: Response): number {
  const header = res.headers.get('Date');
  const parsed = header === null ? Number.NaN : Date.parse(header);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

async function readJsonBody(res: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: (await res.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

async function send(owner: string, entry: OutboxEntry): Promise<SendResult> {
  // Outside the `try`: a failure to build the request is a bug, not "offline".
  const init = attendanceRequest(entry.target);
  let res: Response;
  try {
    res = await fetch(attendanceUrl(entry.registrationId), init);
  } catch (err) {
    // Offline, timed out or redirected (a portal): the entry waits for the next flush.
    return stop(entry, 'thrown', undefined, err);
  }

  if (res.status === 200) {
    const read = await readJsonBody(res);
    if (!read.ok || !isAttendanceAnswer(read.body, entry.registrationId, entry.target)) {
      return stop(entry, 'non-matching-body', res.status, new Error('200 without the matching body'));
    }
    const { body } = read;
    setNeedsSignIn(owner, false);
    const queuedKey = keyFor(QUEUED_PREFIX, owner, entry.registrationId);
    const stored = readStoredEntry(owner, entry.registrationId);
    const superseded = stored !== null && stored.nonce !== entry.nonce;
    // Nothing stored: the entry was removed meanwhile (a clear, a direct-write
    // fallback, another tab's flush), and none of those wants a confirmation
    // from this answer.
    if (stored !== null) {
      // Written before the queued key goes, so a read in any tab finds one or
      // the other; only a store too full for it even after the queued key goes
      // leaves neither. A newer queued mark still shows over it; should that
      // one be refused, this is what the server holds.
      const confirmedKey = keyFor(CONFIRMED_PREFIX, owner, entry.registrationId);
      const confirmation: Confirmation = { target: entry.target, confirmedAt: answeredAt(res) };
      const written = write(confirmedKey, confirmation);
      if (!superseded) remove(queuedKey);
      // A full store may have room once the queued key is gone.
      if (!written) write(confirmedKey, confirmation);
    }
    const applied = body.outcome === undefined;
    if (stored !== null && applied && body.data.classCompleted === true && !entry.knownCompleted) {
      write(keyFor(NOTE_PREFIX, owner, entry.classId), { classId: entry.classId, classLabel: entry.classLabel });
    }
    notify();
    return { applied, replayed: applied && !enqueuedHere.has(entry.nonce), superseded };
  }

  if (res.status === 401) {
    setNeedsSignIn(owner, true);
    return stop(entry, 'status', res.status, new Error('401'));
  }

  const clientError = res.status >= 400 && res.status < 500 && res.status !== 429;
  if (res.status !== 500 && !clientError) return stop(entry, 'status', res.status, new Error(`${res.status}`));

  // Only a JSON 4xx is the app's verdict on the entry. A 500, or a 4xx that is
  // not JSON (a proxy, a firewall), is counted as an attempt whatever its body.
  const fromApp = res.status !== 500 && (await readJsonBody(res.clone())).ok;
  const { code, message } = await readError(res, REFUSED_FALLBACK);
  if (fromApp) setNeedsSignIn(owner, false);

  let superseded: boolean;
  if (!fromApp || code === 'CONCURRENT_MODIFICATION') {
    const attempts = entry.attempts + 1;
    superseded =
      attempts >= MAX_ATTEMPTS
        ? refuse(owner, entry, 'retries-exhausted', RETRIES_EXHAUSTED, attempts)
        : ifUnchanged(owner, entry, () => {
            const written = tryWrite(keyFor(QUEUED_PREFIX, owner, entry.registrationId), { ...entry, attempts });
            if (!written.ok) logWriteFailure(entry, 'attempts', written.err);
          });
  } else {
    superseded = refuse(owner, entry, 'verdict', message, entry.attempts);
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
  needsSignInByOwner.clear();
  snapshotCache.clear();
  rerun.clear();
  enqueuedHere.clear();
  running = null;
}
