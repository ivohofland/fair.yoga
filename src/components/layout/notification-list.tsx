'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Notification, RecipientType } from '@prisma/client';
import { EmptyState } from '@/components/ui/empty-state';
import { RetentionNote } from './retention-note';
import { timeAgo } from '@/lib/format';
import { teacherNotificationHref } from '@/lib/notification-links';
import { NOTIFICATION_PAGE_SIZE, mergeNotifications } from '@/lib/notification-paging';

interface NotificationListProps {
  notifications: Notification[];
  /** Per-row link overrides. Without it, rows take the teacher targets
   * (`teacherNotificationHref`); student pages must pass their own. */
  hrefById?: Record<string, string | null>;
  /** Present when older rows may exist: which recipient hat to read, and where to resume. */
  paging?: { audience: RecipientType; nextCursor: string | null };
}

type Serialized<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] };

interface OlderPageBody {
  notifications: Serialized<Notification>[];
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
}

interface Loaded {
  rows: Notification[];
  hrefById: Record<string, string | null>;
  nextCursor: string | null;
}

function reviveNotification(n: Serialized<Notification>): Notification {
  return { ...n, createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt) };
}

const rowButtonId = (id: string) => `notification-row-${id}`;

export function NotificationList({ notifications, hrefById, paging }: NotificationListProps) {
  const router = useRouter();
  const [readState, setReadState] = useState<Record<string, boolean>>(
    Object.fromEntries(notifications.map((n) => [n.id, n.isRead])),
  );
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle');
  const inFlight = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  const rows = loaded ? mergeNotifications(notifications, loaded.rows) : notifications;
  const hrefs = hrefById ? { ...loaded?.hrefById, ...hrefById } : undefined;
  const nextCursor = loaded ? loaded.nextCursor : (paging?.nextCursor ?? null);

  useEffect(() => {
    if (pendingFocus.current === null) return;
    document.getElementById(rowButtonId(pendingFocus.current))?.focus();
    pendingFocus.current = null;
  }, [loaded]);

  async function showOlder() {
    if (inFlight.current || nextCursor === null || !paging) return;
    inFlight.current = true;
    setStatus('loading');
    try {
      const params = new URLSearchParams({
        recipientType: paging.audience,
        before: nextCursor,
        limit: String(NOTIFICATION_PAGE_SIZE),
      });
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: OlderPageBody };
      const older = body.data.notifications.map(reviveNotification);
      pendingFocus.current = older[0]?.id ?? null;
      setLoaded({
        rows: mergeNotifications(rows, older),
        hrefById: { ...hrefs, ...body.data.hrefById },
        nextCursor: body.data.nextCursor,
      });
      setStatus('idle');
    } catch {
      setStatus('failed');
    } finally {
      inFlight.current = false;
    }
  }

  async function markRead(id: string) {
    if (readState[id]) return;
    setReadState((prev) => ({ ...prev, [id]: true }));
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    // Re-runs the layout server component so the tab bar's unread dot updates.
    router.refresh();
  }

  function resolveHref(notification: Notification): string | null {
    if (hrefs) return hrefs[notification.id] ?? null;
    return teacherNotificationHref(notification);
  }

  function handleNavigate(notification: Notification) {
    markRead(notification.id);
    const href = resolveHref(notification);
    if (href) {
      router.push(href);
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No notifications."
        body="News about your classes appears here."
        note={<RetentionNote />}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {rows.map((notification) => {
        const isRead = readState[notification.id] ?? notification.isRead;
        const href = resolveHref(notification);

        return (
          <div
            key={notification.id}
            // One row shape for both states: identical geometry, constant
            // separator. Read/unread differ only in tint, title weight, dot,
            // and Mark-read visibility — nothing moves on state change.
            className={`flex items-start justify-between gap-2 min-h-14 py-3 -mx-3 px-3 border-b border-border ${
              isRead ? '' : 'bg-sand-soft'
            }`}
          >
            <button
              id={rowButtonId(notification.id)}
              type="button"
              onClick={() => handleNavigate(notification)}
              className="flex items-start min-w-0 text-left flex-1"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className={`text-[15px] text-ink ${isRead ? '' : 'font-medium'}`}>
                  {notification.title}
                  {href && <span className="text-brown-light"> &rarr;</span>}
                </span>
                <span className="type-caption">
                  {notification.body}
                </span>
              </div>
            </button>
            <div className="flex items-center gap-2 shrink-0 ml-2 pt-0.5">
              <span className="type-caption">
                {timeAgo(notification.createdAt)}
              </span>
              {/* Rendered invisible (not removed) when read so its 44px tap
                  target keeps holding the row height and the timestamp
                  doesn't shift when the state changes. */}
              <button
                type="button"
                onClick={() => markRead(notification.id)}
                aria-label={`Mark "${notification.title}" read`}
                className={`type-caption text-teal min-h-[44px] px-1 ${isRead ? 'invisible' : ''}`}
              >
                Mark read
              </button>
              <span className={`inline-block w-2 h-2 shrink-0 rounded-full ${isRead ? '' : 'bg-gold'}`} />
            </div>
          </div>
        );
      })}
      {nextCursor !== null && (
        <div className="pt-2">
          {status === 'failed' && (
            <p role="alert" className="type-caption text-danger">
              Couldn&apos;t load older messages.
            </p>
          )}
          <button
            type="button"
            onClick={showOlder}
            aria-disabled={status === 'loading'}
            className="type-label text-teal min-h-[44px]"
          >
            {status === 'loading' ? 'Loading…' : 'Show older messages'}
          </button>
        </div>
      )}
      <div className="pt-4">
        <RetentionNote />
      </div>
    </div>
  );
}
