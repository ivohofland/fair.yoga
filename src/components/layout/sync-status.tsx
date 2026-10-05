'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import {
  EMPTY_OUTBOX,
  dismissNote,
  dismissRefused,
  getOutboxSnapshot,
  subscribeOutbox,
} from '@/lib/attendance-outbox';

function changes(n: number): string {
  return n === 1 ? '1 change' : `${n} changes`;
}

/** What a mark saved after its class finished, on a page that showed it unfinished, tells the teacher. */
export function savedAfterFinishCopy(classLabel: string): string {
  return `Saved after ${classLabel} finished — the payment requests already sent stay as they are.`;
}

const DISMISS_CLASSES = 'type-caption text-teal shrink-0 min-h-[44px] px-1 focus-visible:shadow-focus';

/**
 * What the attendance outbox holds that the teacher should know about (#726,
 * docs/superpowers/specs/2026-10-04-offline-checkin-design.md §3): marks
 * waiting to sync, marks refused, a session that needs signing in again, and
 * writes that landed after their class finished. Visible online and offline.
 * Everything it says sits in one polite live region, mounted empty on the
 * server and whenever there is nothing to say, so each line is announced when
 * it arrives. Its Dismiss controls carry `data-offline-writable`.
 */
export function SyncStatus({ owner }: { owner: string }) {
  const getSnapshot = useCallback(() => getOutboxSnapshot(owner), [owner]);
  const { queued, refused, notes, needsSignIn } = useSyncExternalStore(
    subscribeOutbox,
    getSnapshot,
    () => EMPTY_OUTBOX,
  );
  const pathname = usePathname();

  const signIn = needsSignIn && queued.length > 0;
  const empty = queued.length === 0 && refused.length === 0 && notes.length === 0;

  return (
    <div role="status">
      {!empty && (
        <div data-sync-status className="mb-4 flex flex-col gap-2">
          {queued.length > 0 && (
            <p className="type-label text-gold-deep bg-gold-tint rounded-card px-4 py-3">
              {signIn ? (
                <a href={`/login?redirect=${encodeURIComponent(pathname)}`} className="underline text-gold-deep">
                  Sign in again to sync {changes(queued.length)}
                </a>
              ) : (
                `${changes(queued.length)} waiting to sync`
              )}
            </p>
          )}

          {refused.length > 0 && (
            <div className="bg-sand-soft border border-border rounded-card px-4 py-3">
              <p className="type-label text-danger">{changes(refused.length)} couldn&apos;t be saved</p>
              <ul className="mt-1">
                {refused.map((entry) => (
                  <li key={entry.registrationId} className="flex items-center justify-between gap-3">
                    <span className="type-caption">
                      {entry.studentName} · {entry.classLabel} — <span className="text-danger">{entry.message}</span>
                    </span>
                    <button
                      type="button"
                      data-offline-writable
                      aria-label={`Dismiss: ${entry.studentName}, ${entry.classLabel}`}
                      onClick={() => dismissRefused(owner, entry.registrationId)}
                      className={DISMISS_CLASSES}
                    >
                      Dismiss
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notes.map((note) => (
            <div
              key={note.classId}
              className="flex items-center justify-between gap-3 bg-gold-tint rounded-card px-4 py-1"
            >
              <p className="type-caption text-gold-deep py-2">
                {savedAfterFinishCopy(note.classLabel)}
              </p>
              <button
                type="button"
                data-offline-writable
                aria-label={`Dismiss: ${note.classLabel}`}
                onClick={() => dismissNote(owner, note.classId)}
                className={DISMISS_CLASSES}
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
