'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { dismissRefused, useOutbox } from '@/lib/attendance-outbox';
import type { QueuedStatus, RefusedEntry } from '@/lib/attendance-outbox';
import { startAttendanceSync, useSyncState } from '@/lib/attendance-sync';

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

export function AttendanceSyncStatus() {
  const ctx = useContext(SyncContext);
  const outbox = useOutbox();
  const { needsSignIn } = useSyncState();
  const inline = useSyncExternalStore(
    ctx?.registry.subscribe ?? NO_SUBSCRIBE,
    ctx?.registry.getSnapshot ?? getNoClasses,
    getNoClasses,
  );
  if (!ctx) return null;

  const pending = Object.values(outbox.pending).filter((e) => e.ownerId === ctx.ownerId).length;
  const refused = Object.values(outbox.refused).filter(
    (e) => e.ownerId === ctx.ownerId && !inline.has(e.classId),
  );
  if (pending === 0 && refused.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 py-2">
      {pending > 0 && (
        <p role="status" className="type-caption">
          {pending} attendance {pending === 1 ? 'change' : 'changes'} waiting to sync
          {needsSignIn ? ' — sign in to sync them' : ''}
        </p>
      )}
      {refused.map((entry) => (
        <div key={entry.registrationId} className="flex flex-wrap items-baseline gap-x-3">
          <p className="type-caption text-danger">{refusalLine(entry)}</p>
          <Link href={`/class/${entry.classId}`} className="type-caption underline">
            Open class
          </Link>
          <button
            type="button"
            className="type-caption underline"
            onClick={() => void dismissRefused(entry.registrationId)}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

function NO_SUBSCRIBE(): () => void {
  return () => {};
}

function getNoClasses(): ReadonlySet<string> {
  return NO_CLASSES;
}
