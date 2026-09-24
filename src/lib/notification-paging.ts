import type { Notification } from '@prisma/client';

export const NOTIFICATION_PAGE_SIZE = 50;
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

// The last millisecond of year 9999: a later instant serialises as `+010000-…`,
// which the database client refuses.
const MAX_CURSOR_EPOCH_MS = 253_402_300_799_999;
// The id is passed to Postgres, which rejects a NUL, so it is held to a safe character set.
const CURSOR_ID = /^[0-9A-Za-z._-]{1,64}$/;

/** Reads a `limit` query value: a non-numeric one falls back to the default, a numeric one is clamped. */
export function parseLimit(raw: string | null): number {
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) return NOTIFICATION_PAGE_SIZE;
  return Math.min(NOTIFICATION_MAX_PAGE_SIZE, Math.max(1, parsed));
}

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
  if (!CURSOR_ID.test(id)) return null;
  const epoch = Number(epochMs);
  if (epoch > MAX_CURSOR_EPOCH_MS) return null;
  return { createdAt: new Date(epoch), id };
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
