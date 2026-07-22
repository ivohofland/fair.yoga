'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Notification } from '@prisma/client';
import { EmptyState } from '@/components/ui/empty-state';
import { timeAgo } from '@/lib/format';

interface NotificationListProps {
  notifications: Notification[];
  /** Per-row link overrides. Without it, rows link to the teacher class
   *  detail — student pages must pass their own targets. */
  hrefById?: Record<string, string | null>;
}

function notificationHref(notification: Notification): string | null {
  if (notification.relatedClassId) {
    return `/class/${notification.relatedClassId}`;
  }
  return null;
}

export function NotificationList({ notifications, hrefById }: NotificationListProps) {
  const router = useRouter();
  const [readState, setReadState] = useState<Record<string, boolean>>(
    Object.fromEntries(notifications.map((n) => [n.id, n.isRead])),
  );

  async function markRead(id: string) {
    if (readState[id]) return;
    setReadState((prev) => ({ ...prev, [id]: true }));
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
    // Re-runs the layout server component so the tab bar's unread dot updates.
    router.refresh();
  }

  function resolveHref(notification: Notification): string | null {
    if (hrefById) return hrefById[notification.id] ?? null;
    return notificationHref(notification);
  }

  function handleNavigate(notification: Notification) {
    markRead(notification.id);
    const href = resolveHref(notification);
    if (href) {
      router.push(href);
    }
  }

  if (notifications.length === 0) {
    return <EmptyState title="No notifications." body="News about your classes appears here." />;
  }

  return (
    <div className="flex flex-col">
      {notifications.map((notification) => {
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
    </div>
  );
}
