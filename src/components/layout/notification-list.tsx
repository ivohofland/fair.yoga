'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Notification } from '@prisma/client';

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
  }

  function handleNavigate(notification: Notification) {
    markRead(notification.id);
    const href = notificationHref(notification);
    if (href) {
      router.push(href);
    }
  }

  if (notifications.length === 0) {
    return <p className="text-brown text-sm">No notifications.</p>;
  }

  return (
    <div>
      {notifications.map((notification) => {
        const isRead = readState[notification.id] ?? notification.isRead;
        const href = notificationHref(notification);

        return (
          <div
            key={notification.id}
            className="flex items-start justify-between py-3 border-b border-border"
          >
            <button
              type="button"
              onClick={() => handleNavigate(notification)}
              className="flex items-start gap-2 min-w-0 text-left flex-1"
            >
              <span className={`mt-1.5 inline-block w-2 h-2 shrink-0 rounded-full ${isRead ? '' : 'bg-teal'}`} />
              <div className="flex flex-col gap-1 min-w-0">
                <span className={`text-sm ${isRead ? 'text-dark' : 'text-dark font-medium'}`}>
                  {notification.title}
                  {href && <span className="text-brown"> &rarr;</span>}
                </span>
                <span className="text-brown text-xs">
                  {notification.body}
                </span>
              </div>
            </button>
            <div className="flex items-center gap-2 shrink-0 ml-2 pt-0.5">
              <span className="text-brown text-xs">
                {timeAgo(notification.createdAt)}
              </span>
              {!isRead && (
                <button
                  type="button"
                  onClick={() => markRead(notification.id)}
                  className="text-brown text-xs opacity-60 min-h-[44px] px-1"
                  aria-label="Mark as read"
                >
                  Mark read
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
