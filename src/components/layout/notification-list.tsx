'use client';

import { useState } from 'react';
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

export function NotificationList({ notifications }: NotificationListProps) {
  const [readState, setReadState] = useState<Record<string, boolean>>(
    Object.fromEntries(notifications.map((n) => [n.id, n.isRead])),
  );

  async function handleMarkRead(id: string) {
    if (readState[id]) return;
    setReadState((prev) => ({ ...prev, [id]: true }));
    await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
  }

  if (notifications.length === 0) {
    return <p className="text-brown text-sm">No notifications.</p>;
  }

  return (
    <div>
      {notifications.map((notification) => {
        const isRead = readState[notification.id] ?? notification.isRead;

        return (
          <button
            key={notification.id}
            type="button"
            onClick={() => handleMarkRead(notification.id)}
            className="w-full text-left flex items-start justify-between py-3 border-b border-border"
          >
            <div className="flex items-start gap-2 min-w-0">
              {!isRead && (
                <span
                  className="mt-1.5 inline-block w-2 h-2 rounded-full bg-teal shrink-0"
                  role="img"
                  aria-label="Unread"
                />
              )}
              {isRead && (
                <span className="mt-1.5 inline-block w-2 h-2 shrink-0" />
              )}
              <div className="flex flex-col gap-1 min-w-0">
                <span className={`text-sm ${isRead ? 'text-dark' : 'text-dark font-medium'}`}>
                  {notification.title}
                </span>
                <span className="text-brown text-xs">
                  {notification.body}
                </span>
              </div>
            </div>
            <span className="text-brown text-xs shrink-0 ml-2 pt-0.5">
              {timeAgo(notification.createdAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
