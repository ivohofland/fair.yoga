'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Notification } from '@prisma/client';
import { EmptyState } from '@/components/ui/empty-state';

interface NotificationListProps {
  notifications: Notification[];
}

function timeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - new Date(date).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function notificationHref(notification: Notification): string | null {
  if (notification.relatedClassId) {
    return `/class/${notification.relatedClassId}`;
  }
  return null;
}

export function NotificationList({ notifications }: NotificationListProps) {
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

  function handleNavigate(notification: Notification) {
    markRead(notification.id);
    const href = notificationHref(notification);
    if (href) {
      router.push(href);
    }
  }

  if (notifications.length === 0) {
    return <EmptyState title="No notifications." body="News about your classes appears here." />;
  }

  return (
    <div>
      {notifications.map((notification) => {
        const isRead = readState[notification.id] ?? notification.isRead;
        const href = notificationHref(notification);

        return (
          <div
            key={notification.id}
            // Unread rows sit on sand, read rows on cream. No hierarchy tricks.
            className={`flex items-start justify-between gap-2 min-h-14 py-3 border-b border-border ${
              isRead ? '' : 'bg-sand-soft -mx-3 px-3 rounded-field border-b-transparent'
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
              {!isRead ? (
                <button
                  type="button"
                  onClick={() => markRead(notification.id)}
                  className="type-caption text-teal min-h-[44px] px-1"
                >
                  Mark read
                </button>
              ) : null}
              <span className={`inline-block w-2 h-2 shrink-0 rounded-full ${isRead ? '' : 'bg-gold'}`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
