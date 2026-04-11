import type { Notification } from '@prisma/client';

interface InboxSectionProps {
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

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '...';
}

export function InboxSection({ notifications }: InboxSectionProps) {
  if (notifications.length === 0) {
    return <p className="text-brown text-sm">No notifications.</p>;
  }

  return (
    <div>
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="flex items-start justify-between py-3 border-b border-border"
        >
          <div className="flex flex-col gap-1 min-w-0">
            <span
              className={`text-sm ${notification.isRead ? 'text-dark' : 'text-dark font-medium'}`}
            >
              {notification.title}
            </span>
            <span className="text-brown text-xs">
              {truncate(notification.body, 60)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2 pt-0.5">
            <span className="text-brown text-xs">
              {timeAgo(notification.createdAt)}
            </span>
            {!notification.isRead && (
              <span
                className="inline-block w-2 h-2 rounded-full bg-teal"
                role="img"
                aria-label="Unread"
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
