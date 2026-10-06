'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { EMPTY_OUTBOX, dismissRefused, getOutbox, ownedOutbox, useOutbox, useOutboxVolatile } from '@/lib/attendance-outbox';
import type { QueuedStatus, RefusedEntry } from '@/lib/attendance-outbox';
import { startAttendanceSync, useSyncState } from '@/lib/attendance-sync';
import { useConnectionStatus } from '@/lib/offline-status';

/** Class ids whose refusals a mounted attendance list shows itself. */
interface InlineRegistry {
  register: (classId: string) => () => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ReadonlySet<string>;
}

const NO_CLASSES: ReadonlySet<string> = new Set();

function createInlineRegistry(): InlineRegistry {
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlySet<string> = NO_CLASSES;

  function publish(): void {
    snapshot = new Set(counts.keys());
    listeners.forEach((listener) => listener());
  }

  return {
    register(classId) {
      counts.set(classId, (counts.get(classId) ?? 0) + 1);
      publish();
      return () => {
        const next = (counts.get(classId) ?? 0) - 1;
        if (next > 0) counts.set(classId, next);
        else counts.delete(classId);
        publish();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

interface SyncContextValue {
  ownerId: string;
  registry: InlineRegistry;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function AttendanceSyncProvider({
  ownerId,
  children,
}: {
  ownerId: string;
  children: ReactNode;
}) {
  const [registry] = useState(createInlineRegistry);
  const value = useMemo(() => ({ ownerId, registry }), [ownerId, registry]);

  useEffect(() => startAttendanceSync(ownerId), [ownerId]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/** The account whose attendance changes this tab syncs; null outside the provider. */
export function useAttendanceOwner(): string | null {
  return useContext(SyncContext)?.ownerId ?? null;
}

/** While the caller is mounted, refusals for `classId` are the caller's to show, not the status region's. */
export function useInlineRefusals(classId: string): void {
  const registry = useContext(SyncContext)?.registry;
  useEffect(() => registry?.register(classId), [registry, classId]);
}

function statusWord(status: QueuedStatus): string {
  switch (status) {
    case 'attended':
      return 'present';
    case 'no_show':
      return 'no-show';
    case 'late_cancel':
      return 'cancelled late';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export function refusalLine(entry: RefusedEntry): string {
  return `Couldn't record ${entry.studentName} as ${statusWord(entry.status)}: ${entry.message}`;
}

const NO_IDS: ReadonlySet<string> = new Set();

/** Which refusals the summary has heard of. */
interface Heard {
  /** Refusal ids it never announces. */
  quiet: ReadonlySet<string>;
  /** Refusal ids it counts now. */
  counted: ReadonlySet<string>;
}

/**
 * `prev` moved on to the refusals now stored, where `inline` holds the classes
 * whose mounted list shows its own. One a list shows goes quiet; when one the
 * summary counted leaves it, the others it counted go quiet too.
 */
function hear(prev: Heard, refused: readonly RefusedEntry[], inline: ReadonlySet<string>): Heard {
  const quiet = new Set(prev.quiet);
  for (const e of refused) if (inline.has(e.classId)) quiet.add(e.id);
  const arrived = new Set(refused.filter((e) => !quiet.has(e.id)).map((e) => e.id));
  if ([...prev.counted].some((id) => !arrived.has(id))) {
    for (const id of prev.counted) quiet.add(id);
  }
  return { quiet, counted: new Set([...arrived].filter((id) => !quiet.has(id))) };
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

function sameHeard(a: Heard, b: Heard): boolean {
  return sameIds(a.quiet, b.quiet) && sameIds(a.counted, b.counted);
}

function changes(n: number): string {
  return `${n} attendance ${n === 1 ? 'change' : 'changes'}`;
}

/** Ends `sentence` with a full stop unless it already has one. */
function stopped(sentence: string): string {
  return sentence.endsWith('.') ? sentence : `${sentence}.`;
}

/**
 * The signed-in account's pending count and the refusals no mounted list
 * shows, as a visible block with its controls. What is announced goes through
 * a separate text-only `role="status"`, always mounted, empty when there is
 * nothing to say, holding one summary:
 * - the waiting count, with "sign in to sync them" when a sign-in is needed
 *   and "This device can't keep them if the page reloads." while storage
 *   refused some of them, but only when it is more than a round trip in
 *   progress: offline, after an attempt that must be retried, or when a
 *   sign-in is needed;
 * - how many refusals it shows that arrived while it was mounted, never one
 *   stored when it mounted or one a mounted list showed first. When one of
 *   those leaves the summary the rest go quiet, so a smaller count does not
 *   announce them again.
 */
export function AttendanceSyncStatus() {
  const ctx = useContext(SyncContext);
  const outbox = useOutbox();
  const volatile = useOutboxVolatile(ctx?.ownerId ?? null);
  const { needsSignIn, retrying } = useSyncState();
  const { offline } = useConnectionStatus();
  const inline = useSyncExternalStore(
    ctx?.registry.subscribe ?? noSubscribe,
    ctx?.registry.getSnapshot ?? getNoClasses,
    getNoClasses,
  );
  const blockRef = useRef<HTMLDivElement>(null);
  const dismissRefs = useRef(new Map<string, HTMLButtonElement>());
  // Seeded on the client's first render from the live store, since `outbox`
  // is the empty server snapshot while hydrating.
  const [heard, setHeard] = useState<Heard>(() => ({
    quiet: new Set(typeof window === 'undefined' ? [] : Object.values(getOutbox().refused).map((e) => e.id)),
    counted: NO_IDS,
  }));

  const owned = ownedOutbox(ctx ? outbox : EMPTY_OUTBOX, ctx?.ownerId ?? null);
  const pending = Object.keys(owned.pending).length;
  const refused = Object.values(owned.refused).filter((e) => !inline.has(e.classId));
  const nextHeard = hear(heard, Object.values(owned.refused), inline);
  // Adjusting state during render, as React allows for state derived from a change: it settles in one more pass.
  if (!sameHeard(nextHeard, heard)) setHeard(nextHeard);
  const announced = nextHeard.counted.size;

  if (!ctx) return null;

  const waiting =
    pending === 0
      ? ''
      : `${changes(pending)} waiting to sync${needsSignIn ? ' — sign in to sync them' : ''}`;
  const unkept = pending > 0 && volatile ? "This device can't keep them if the page reloads." : '';
  const shownWaiting = unkept === '' ? waiting : `${waiting}. ${unkept}`;
  const announceWaiting = offline || retrying || needsSignIn;
  const unrecorded = announced === 0 ? '' : `${changes(announced)} couldn't be recorded.`;
  const summary = [announceWaiting ? waiting : '', announceWaiting ? unkept : '', unrecorded]
    .filter((sentence) => sentence !== '')
    .map(stopped)
    .join(' ');

  // Dismiss unmounts the focused button, so focus moves first: to the next refusal's Dismiss, else to the block.
  function dismiss(index: number): void {
    const entry = refused[index];
    if (entry === undefined) return;
    const next = refused[index + 1];
    const target = next === undefined ? undefined : dismissRefs.current.get(next.registrationId);
    (target ?? blockRef.current)?.focus();
    void dismissRefused(entry.registrationId);
  }

  return (
    <>
      <p role="status" className="sr-only">
        {summary}
      </p>
      <div
        ref={blockRef}
        role="group"
        aria-label="Attendance sync"
        tabIndex={-1}
        className="focus:outline-none"
      >
        {(pending > 0 || refused.length > 0) && (
          <div className="flex flex-col gap-2 py-2">
            {pending > 0 && <p className="type-caption">{shownWaiting}</p>}
            {refused.map((entry, index) => (
              <div key={entry.registrationId} className="flex flex-wrap items-baseline gap-x-3">
                <p className="type-caption text-danger">{refusalLine(entry)}</p>
                <Link
                  href={`/class/${entry.classId}`}
                  aria-label={`Open class for ${entry.studentName}`}
                  className="type-label text-teal no-underline inline-flex items-center min-h-11"
                >
                  Open class
                </Link>
                <button
                  ref={(el) => {
                    if (el === null) dismissRefs.current.delete(entry.registrationId);
                    else dismissRefs.current.set(entry.registrationId, el);
                  }}
                  type="button"
                  aria-label={`Dismiss: ${refusalLine(entry)}`}
                  className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
                  onClick={() => dismiss(index)}
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function noSubscribe(): () => void {
  return () => {};
}

function getNoClasses(): ReadonlySet<string> {
  return NO_CLASSES;
}
