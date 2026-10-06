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

/**
 * `at` is the confirmation time: the response's `Date` header, so it compares
 * with the page's server-side `renderedAt`, or the device clock when the
 * response has no readable `Date` header.
 */
export type Settlement =
  | { kind: 'confirmed'; at: number }
  | { kind: 'refused'; message: string }
  | { kind: 'dropped' };

const KEY = 'fy-outbox-v1';
/** Where clears are recorded for other tabs: `Clears`. */
const CLEARS_KEY = 'fy-outbox-clears-v1';
const LOCK = 'fy-outbox';
const CONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;
const REFUSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A confirmation stamped further ahead than this would mask the server's status for as long as it stays ahead. */
const CONFIRMED_FUTURE_SLACK_MS = 5 * 60 * 1000;

/** Tethered to the schema: a status added there fails to compile here until it is listed. */
const QUEUED = { attended: true, no_show: true, late_cancel: true } satisfies Record<QueuedStatus, true>;
const QUEUED_KEYS: ReadonlySet<string> = new Set(Object.keys(QUEUED));

export const EMPTY_OUTBOX: OutboxState = Object.freeze({ pending: {}, confirmed: {}, refused: {} });

/** One registration's entries, one per map. */
interface Slot {
  pending: PendingEntry | undefined;
  confirmed: ConfirmedEntry | undefined;
  refused: RefusedEntry | undefined;
}
/** A registration whose entries in this tab storage does not hold: `mine` is this tab's, `held` what storage held when the write was refused or held back. */
interface Override {
  mine: Slot;
  held: Slot;
}
/**
 * The registrations of this tab's outbox that storage does not hold, since it
 * refused the write (a full quota, a private window, blocked storage) or a
 * read that threw held the write back: what a reload would lose. Null while
 * storage holds all of it.
 */
let overlay: ReadonlyMap<string, Override> | null = null;
/** Storage refused even a removal, so its copy may contradict this tab's: none of it is read until a write succeeds. */
let detached = false;
/**
 * The clears every tab has made, as tokens a clear replaces: `all` for one of
 * the whole outbox, `owners` for one of an account's entries. A tab that finds
 * a token changed since it last read them drops what it holds in memory for
 * that clear, rather than write it back.
 */
interface Clears {
  all: string;
  owners: Readonly<Record<string, string>>;
}
const NO_CLEARS: Clears = Object.freeze({ all: '', owners: Object.freeze({}) });
/** The clears as this tab last read or wrote them; null before the first read. */
let seenClears: Clears | null = null;
/** What storage holds, as of `cachedRaw`. */
let stored: OutboxState = EMPTY_OUTBOX;
/** The stored text `stored` was parsed from or written as. */
let cachedRaw: string | null = null;
/** This tab's outbox, as `view` builds it. */
let cached: OutboxState | null = null;
let readFailureLogged = false;
/** Whether the last read of storage threw. */
let lastReadFailed = false;
/** The last stored text whose discarded entries were reported, so one document warns once. */
let warnedRaw: string | null = null;
const listeners = new Set<() => void>();

export function isRecord(v: unknown): v is Record<string, unknown> {
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

function errorName(err: unknown): string {
  // A `DOMException` from another realm fails `instanceof Error`, so the name is read off the object.
  return isRecord(err) && typeof err.name === 'string' ? err.name : typeof err;
}
/** Answers whether storage took the removal. */
function removeStored(): boolean {
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
/** The stored text; when storage cannot be read, the text this tab last read or wrote, so a failed read changes nothing. */
function readRaw(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    lastReadFailed = false;
    return raw;
  } catch (err) {
    lastReadFailed = true;
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.warn('[attendance-outbox] storage could not be read; this tab keeps what it last read', {
        error: errorName(err),
      });
    }
    return cachedRaw;
  }
}

/** The recorded clears; null when storage cannot be read. A missing or malformed record reads as no clears. */
function readClears(): Clears | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CLEARS_KEY);
  } catch {
    return null;
  }
  if (raw === null) return NO_CLEARS;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return NO_CLEARS;
  }
  if (!isRecord(doc) || typeof doc.all !== 'string' || !isRecord(doc.owners)) return NO_CLEARS;
  const owners: Record<string, string> = Object.create(null);
  for (const [ownerId, token] of Object.entries(doc.owners)) {
    if (typeof token === 'string') owners[ownerId] = token;
  }
  return { all: doc.all, owners };
}
/**
 * Records `clears` for other tabs. Called after the clear itself, so a removal
 * has made room for it; logged when storage refuses it even so.
 */
function writeClears(clears: Clears): void {
  seenClears = clears;
  try {
    localStorage.setItem(CLEARS_KEY, JSON.stringify(clears));
  } catch (err) {
    console.warn('[attendance-outbox] storage refused the record of a clear; another tab may write back what it held', {
      error: errorName(err),
    });
  }
}
/**
 * Drops from `overlay` what a clear made in another tab since this tab last
 * read the record covers: everything for a clear of the whole outbox, the
 * registrations whose entries here are that account's for a clear of one.
 * Answers whether it dropped anything.
 */
function noticeClears(): boolean {
  const current = readClears();
  if (current === null) return false;
  const seen = seenClears;
  seenClears = current;
  if (seen === null || overlay === null) return false;
  if (current.all !== seen.all) {
    overlay = null;
    return true;
  }
  const cleared = new Set(Object.keys(current.owners).filter((ownerId) => current.owners[ownerId] !== own(seen.owners, ownerId)));
  if (cleared.size === 0) return false;
  const ownedBy = (e: PendingEntry | undefined): boolean => e !== undefined && cleared.has(e.ownerId);
  const kept = new Map([...overlay].filter(([, { mine }]) => !ownedBy(mine.pending) && !ownedBy(mine.refused)));
  if (kept.size === overlay.size) return false;
  overlay = kept.size === 0 ? null : kept;
  return true;
}

/** Compares every field either entry has, whatever order they were written in. */
function sameEntry(a: object | undefined, b: object): boolean {
  return a !== undefined && JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());
}
function sameOrAbsent(a: object | undefined, b: object | undefined): boolean {
  return b === undefined ? a === undefined : sameEntry(a, b);
}
/** An own entry only: a map built by spreading has `Object.prototype`, so a `__proto__` key must not reach it. */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}
function slotOf(state: OutboxState, registrationId: string): Slot {
  return {
    pending: own(state.pending, registrationId),
    confirmed: own(state.confirmed, registrationId),
    refused: own(state.refused, registrationId),
  };
}
function sameSlot(a: Slot, b: Slot): boolean {
  return sameOrAbsent(a.pending, b.pending) && sameOrAbsent(a.confirmed, b.confirmed) && sameOrAbsent(a.refused, b.refused);
}
function confirmedFresh(e: ConfirmedEntry, now: number): boolean {
  return now - e.confirmedAt <= CONFIRMED_TTL_MS && e.confirmedAt - now <= CONFIRMED_FUTURE_SLACK_MS;
}
function refusedFresh(e: RefusedEntry, now: number): boolean {
  return now - e.refusedAt <= REFUSED_TTL_MS;
}
/** `slot` as a read at `now` would find it: expired entries gone. */
function freshSlot(slot: Slot, now: number): Slot {
  const { pending, confirmed, refused } = slot;
  return {
    pending,
    confirmed: confirmed !== undefined && confirmedFresh(confirmed, now) ? confirmed : undefined,
    refused: refused !== undefined && refusedFresh(refused, now) ? refused : undefined,
  };
}
/** Each registration whose entries in `next` differ from `held`'s, with both. Null when none does. */
function overridesOf(next: OutboxState, held: OutboxState): ReadonlyMap<string, Override> | null {
  const ids = new Set<string>();
  for (const state of [next, held]) {
    for (const map of [state.pending, state.confirmed, state.refused]) Object.keys(map).forEach((id) => ids.add(id));
  }
  const out = new Map<string, Override>();
  for (const id of ids) {
    const mine = slotOf(next, id);
    const was = slotOf(held, id);
    if (!sameSlot(mine, was)) out.set(id, { mine, held: was });
  }
  return out.size === 0 ? null : out;
}
/** The entries of `next` that `held` holds identically. */
function agreed<T extends object>(next: Readonly<Record<string, T>>, held: Readonly<Record<string, T>>): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const [key, entry] of Object.entries(next)) {
    if (sameEntry(own(held, key), entry)) out[key] = entry;
  }
  return out;
}
function entryCount(state: OutboxState): number {
  return Object.keys(state.pending).length + Object.keys(state.confirmed).length + Object.keys(state.refused).length;
}
/**
 * Writes `next`, this tab's whole outbox. When storage refuses it, storage
 * keeps only the entries it already held that `next` holds identically, so
 * its copy is no larger than one that fit, and may lag behind this tab's but
 * never contradicts it: a mark corrected or settled here cannot come back on
 * a reload. This tab's entries for every registration that differs stay in
 * `overlay`. If storage refuses that too, its copy is removed; if it refuses
 * even the removal, this tab stops reading it.
 */
function persist(next: OutboxState): void {
  const value = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, value);
    stored = next;
    cachedRaw = value;
    overlay = null;
    detached = false;
    return;
  } catch (err) {
    if (overlay === null) {
      console.warn('[attendance-outbox] storage refused a write; what it could not hold is in memory for this tab', {
        error: errorName(err),
      });
    }
  }
  const held = detached ? EMPTY_OUTBOX : stored;
  const kept: OutboxState = {
    pending: agreed(next.pending, held.pending),
    confirmed: agreed(next.confirmed, held.confirmed),
    refused: agreed(next.refused, held.refused),
  };
  try {
    if (entryCount(kept) === 0) {
      localStorage.removeItem(KEY);
      cachedRaw = null;
    } else if (detached || entryCount(kept) !== entryCount(held)) {
      cachedRaw = JSON.stringify(kept);
      localStorage.setItem(KEY, cachedRaw);
    }
    stored = kept;
    overlay = overridesOf(next, kept);
    detached = false;
  } catch (err) {
    console.warn('[attendance-outbox] storage refused even what it held; the stored copy is removed', {
      error: errorName(err),
    });
    detached = !removeStored();
    stored = EMPTY_OUTBOX;
    cachedRaw = null;
    overlay = overridesOf(next, EMPTY_OUTBOX);
  }
}
/**
 * Drops for good each registration in `overlay` whose stored entries are no
 * longer what storage held when this tab's write was refused or held back:
 * only another tab writes storage meanwhile, so that write is taken as the
 * newer. Run on every read of storage; an entry expiring is not a change.
 */
function reconcile(now: number): void {
  if (overlay === null || detached) return;
  const kept = new Map([...overlay].filter(([id, o]) => sameSlot(slotOf(stored, id), freshSlot(o.held, now))));
  overlay = kept.size === 0 ? null : kept;
}
/** This tab's outbox: `stored`, with each registration in `overlay` replaced by this tab's entries for it. */
function view(): OutboxState {
  if (overlay === null) return stored;
  const base = detached ? EMPTY_OUTBOX : stored;
  const copy = <T>(map: Readonly<Record<string, T>>): Record<string, T> => Object.assign(Object.create(null), map);
  const out = { pending: copy(base.pending), confirmed: copy(base.confirmed), refused: copy(base.refused) };
  const put = <T>(map: Record<string, T>, id: string, entry: T | undefined): void => {
    if (entry === undefined) delete map[id];
    else map[id] = entry;
  };
  for (const [id, { mine }] of overlay) {
    put(out.pending, id, mine.pending);
    put(out.confirmed, id, mine.confirmed);
    put(out.refused, id, mine.refused);
  }
  return out;
}

/**
 * Keeps the entries of `source` that `guard` accepts, `valid` approves and
 * `fresh` has not expired, into a null-prototype map, so a stored `__proto__`
 * key is an own entry rather than the map's prototype. Counts the entries that
 * failed `guard` or `valid` into `discarded`; expired ones are not counted.
 */
function pick<T>(
  source: unknown,
  guard: (v: unknown) => T | null,
  valid: (entry: T, key: string) => boolean,
  fresh: (entry: T) => boolean,
  discarded: { count: number },
): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  if (!isRecord(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    const entry = guard(value);
    if (entry === null || !valid(entry, key)) discarded.count++;
    else if (fresh(entry)) out[key] = entry;
  }
  return out;
}

function warnDiscarded(raw: string, detail: { dropped: number } | { unreadable: true }): void {
  if (raw === warnedRaw) return;
  warnedRaw = raw;
  console.warn('[attendance-outbox] stored entries discarded', detail);
}

/** Parses what is stored, keeping only well-formed, unexpired entries. Never throws. */
function parse(raw: string | null, now: number): OutboxState {
  if (raw === null) return EMPTY_OUTBOX;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    doc = undefined;
  }
  if (!isRecord(doc)) {
    warnDiscarded(raw, { unreadable: true });
    return EMPTY_OUTBOX;
  }
  const discarded = { count: 0 };
  const keyed = (e: PendingEntry, key: string): boolean => e.registrationId === key;
  const state: OutboxState = {
    pending: pick(doc.pending, asPending, keyed, () => true, discarded),
    confirmed: pick(doc.confirmed, asConfirmed, () => true, (e) => confirmedFresh(e, now), discarded),
    refused: pick(doc.refused, asRefused, keyed, (e) => refusedFresh(e, now), discarded),
  };
  if (discarded.count > 0) warnDiscarded(raw, { dropped: discarded.count });
  return state;
}

export function getOutbox(): OutboxState {
  if (cached === null) {
    if (!detached) {
      const now = Date.now();
      cachedRaw = readRaw();
      stored = parse(cachedRaw, now);
      reconcile(now);
    }
    noticeClears();
    cached = view();
  }
  return cached;
}
/**
 * Reads storage past the cache, which only this tab's writes and a subscribed
 * `storage` listener refresh. Keeps the cached object, and its identity, when
 * nothing changed. Subscribers are told only when the stored text differs from
 * a cache that existed; a read that fills an empty cache tells no one.
 */
export function readOutbox(): OutboxState {
  const hadCache = cached !== null;
  if (detached) {
    if (noticeClears()) {
      cached = view();
      if (hadCache) notify();
    }
    return getOutbox();
  }
  const raw = readRaw();
  const dropped = noticeClears();
  if (cached !== null && raw === cachedRaw && !dropped) return cached;
  const now = Date.now();
  stored = parse(raw, now);
  cachedRaw = raw;
  reconcile(now);
  cached = view();
  if (hadCache) notify();
  return cached;
}
function notify(): void {
  listeners.forEach((l) => l());
}
function commit(next: OutboxState): void {
  persist(next);
  cached = next;
  notify();
}
/**
 * Keeps `next` in memory without writing, after a read that threw: a write
 * could overwrite what another tab stored since this tab last read. The next
 * change after a read that works writes it.
 */
function hold(next: OutboxState): void {
  overlay = overridesOf(next, stored);
  cached = next;
  notify();
}
/**
 * Tries the whole write again while this tab holds entries storage refused,
 * since storage may have room by now; otherwise they are written only with
 * this tab's next change. Writes nothing once a clear another tab made has
 * taken them, and nothing while `detached`: that write reads nothing first,
 * so it would erase whatever another tab stored since, and reading first
 * would drop this tab's entries against the copy storage refused to remove.
 * Best-effort: a page being unloaded may not finish it.
 */
function retryWrite(): void {
  if (overlay === null || detached) return;
  void withLock(LOCK, async () => {
    cached = null;
    const current = getOutbox();
    if (overlay === null) notify();
    else if (!detached) apply(current);
  });
}
function onStorage(e: StorageEvent): void {
  if (e.key !== KEY && e.key !== CLEARS_KEY && e.key !== null) return;
  cached = null;
  notify();
  retryWrite();
}
function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') retryWrite();
}
function listen(): void {
  window.addEventListener('storage', onStorage);
  window.addEventListener('pagehide', retryWrite);
  document.addEventListener('visibilitychange', onVisibilityChange);
}
function unlisten(): void {
  window.removeEventListener('storage', onStorage);
  window.removeEventListener('pagehide', retryWrite);
  document.removeEventListener('visibilitychange', onVisibilityChange);
}
export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) listen();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) unlisten();
  };
}
export function useOutbox(): OutboxState {
  return useSyncExternalStore(subscribeOutbox, getOutbox, () => EMPTY_OUTBOX);
}

/** Whether `ownerId` has a pending entry this tab shows that storage does not hold. */
function isOutboxVolatile(ownerId: string | null): boolean {
  const { pending } = ownedOutbox(getOutbox(), ownerId);
  const memory = overlay;
  if (memory === null) return false;
  return Object.values(pending).some((entry) => {
    const held = memory.get(entry.registrationId)?.held;
    return held !== undefined && !sameEntry(held.pending, entry);
  });
}
/**
 * True while this tab shows pending entries of `ownerId` that storage
 * refused, so a reload would lose them. The server snapshot is `false`.
 */
export function useOutboxVolatile(ownerId: string | null): boolean {
  return useSyncExternalStore(subscribeOutbox, () => isOutboxVolatile(ownerId), () => false);
}

export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(name, fn) : fn();
}

/** Writes `next`, built on a read just made; held in memory when that read threw. */
function apply(next: OutboxState): void {
  if (lastReadFailed && !detached) hold(next);
  else commit(next);
}
/** Read-modify-write against a fresh read, so another tab's write is never lost; held in memory when that read throws. Call under `LOCK`. */
function change(fn: (current: OutboxState) => OutboxState): void {
  cached = null;
  apply(fn(getOutbox()));
}
async function update(fn: (current: OutboxState) => OutboxState): Promise<void> {
  await withLock(LOCK, async () => change(fn));
}

/** `crypto.randomUUID` is missing outside a secure context and on older Safari; the id only has to differ from this registration's previous one. */
function newEntryId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueAttendance(
  input: Omit<PendingEntry, 'id' | 'recordedAt'>,
): Promise<PendingEntry> {
  const entry: PendingEntry = { ...input, id: newEntryId(), recordedAt: Date.now() };
  await update((s) => ({ ...s, pending: { ...s.pending, [entry.registrationId]: entry } }));
  return entry;
}

export async function settleEntry(sent: PendingEntry, settlement: Settlement): Promise<void> {
  await update((s) => {
    if (s.pending[sent.registrationId]?.id !== sent.id) return s; // a newer tap replaced it
    const pending = { ...s.pending };
    delete pending[sent.registrationId];
    switch (settlement.kind) {
      case 'confirmed': {
        // The server now holds this registration's write, so an earlier refusal no longer describes it.
        const refused = { ...s.refused };
        delete refused[sent.registrationId];
        return {
          ...s,
          pending,
          refused,
          confirmed: {
            ...s.confirmed,
            [sent.registrationId]: { status: sent.status, confirmedAt: settlement.at },
          },
        };
      }
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

/**
 * Empties this tab's outbox and the stored copy, then records the clear for
 * other tabs; if storage refuses the removal, this tab stops reading it.
 */
export async function clearOutbox(): Promise<void> {
  await withLock(LOCK, async () => {
    detached = !removeStored();
    overlay = null;
    stored = EMPTY_OUTBOX;
    cached = EMPTY_OUTBOX;
    cachedRaw = null;
    writeClears({ all: newEntryId(), owners: {} });
    notify();
  });
}

/**
 * Removes `ownerId`'s pending and refused entries, then records the clear for
 * other tabs. Every other owner's stay, and so do the confirmations, which
 * carry no owner and no name.
 */
export async function clearOwnedOutbox(ownerId: string): Promise<void> {
  await withLock(LOCK, async () => {
    change((s) => {
      const others = <T extends PendingEntry>(entries: Readonly<Record<string, T>>): Record<string, T> =>
        Object.fromEntries(Object.entries(entries).filter(([, e]) => e.ownerId !== ownerId));
      return { ...s, pending: others(s.pending), refused: others(s.refused) };
    });
    const clears = readClears() ?? seenClears ?? NO_CLEARS;
    writeClears({ all: clears.all, owners: { ...clears.owners, [ownerId]: newEntryId() } });
  });
}

/**
 * The part of `outbox` that belongs to `ownerId`: its pending and refused
 * entries. Confirmations carry no owner and are all kept. A null owner keeps
 * no pending or refused entry.
 */
export function ownedOutbox(outbox: OutboxState, ownerId: string | null): OutboxState {
  const mine = <T extends PendingEntry>(entries: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).filter(([, e]) => e.ownerId === ownerId));
  return { pending: mine(outbox.pending), confirmed: outbox.confirmed, refused: mine(outbox.refused) };
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
  cachedRaw = null;
  stored = EMPTY_OUTBOX;
  overlay = null;
  detached = false;
  seenClears = null;
  warnedRaw = null;
  readFailureLogged = false;
  lastReadFailed = false;
  listeners.clear();
  if (typeof window !== 'undefined') unlisten();
}
