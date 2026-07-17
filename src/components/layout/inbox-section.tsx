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
    return <p className="fy-lede">No notifications.</p>;
  }

  return (
    <div>
      {notifications.map((notification) => (
        <div
          key={notification.id}
          className="flex items-start justify-between gap-4 py-4 border-b border-border last:border-b-0"
        >
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span
              className={`text-[15px] text-dark leading-[1.4] ${notification.isRead ? '' : 'font-semibold'}`}
            >
              {notification.title}
            </span>
            <span className="text-[12px] text-brown fy-oldstyle">
              {truncate(notification.body, 60)}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[13px] text-brown fy-oldstyle">
              {timeAgo(notification.createdAt)}
            </span>
            {!notification.isRead && (
              <span
                className="inline-block w-2 h-2 rounded-full bg-brown"
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
