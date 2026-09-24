import type { Notification } from '@prisma/client';

export const NOTIFICATION_PAGE_SIZE = 50;
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

const MAX_CURSOR_ID_LENGTH = 64;

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

export function encodeNotificationCursor(row: NotificationCursor): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

export function decodeNotificationCursor(raw: string): NotificationCursor | null {
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const epochMs = raw.slice(0, dot);
  const id = raw.slice(dot + 1);
  if (!/^\d{1,15}$/.test(epochMs)) return null;
  if (id.length === 0 || id.length > MAX_CURSOR_ID_LENGTH) return null;
  const createdAt = new Date(Number(epochMs));
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

export function mergeNotifications(
  fresh: readonly Notification[],
  older: readonly Notification[],
): Notification[] {
  const byId = new Map<string, Notification>();
  for (const n of older) byId.set(n.id, n);
  for (const n of fresh) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => {
    const byTime = b.createdAt.getTime() - a.createdAt.getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}
