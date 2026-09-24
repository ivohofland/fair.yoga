import { describe, it, expect } from 'vitest';
import type { Notification } from '@prisma/client';
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  mergeNotifications,
  parseLimit,
} from './notification-paging';

function row(id: string, iso: string, over: Partial<Notification> = {}): Notification {
  return {
    id, recipientType: 'teacher', recipientId: 't-1', type: 'announcement',
    title: id, body: 'b', relatedClassId: null, isRead: false, emailSent: false,
    createdAt: new Date(iso), updatedAt: new Date(iso), ...over,
  };
}

describe('notification cursor', () => {
  it('round-trips a row exactly, milliseconds included', () => {
    const createdAt = new Date('2026-09-15T10:00:00.123Z');
    const decoded = decodeNotificationCursor(encodeNotificationCursor({ createdAt, id: 'abc-123' }));
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it('keeps an id that itself contains a dot', () => {
    const decoded = decodeNotificationCursor(
      encodeNotificationCursor({ createdAt: new Date(1000), id: 'a.b' }),
    );
    expect(decoded?.id).toBe('a.b');
  });

  it.each(['', 'abc', '.x', '12.', 'NaN.x', '-5.x', '1e3.x', '99999999999999999.x', `1000.${'x'.repeat(65)}`,
    '253402300800000.x', '999999999999999.x', '1.\u0000', '1.a\u0000b', '1.a b'])(
    'rejects %j',
    (raw) => {
      expect(decodeNotificationCursor(raw)).toBeNull();
    },
  );
});

describe('notification cursor bounds', () => {
  it('accepts the last millisecond of year 9999', () => {
    const decoded = decodeNotificationCursor('253402300799999.x');
    expect(decoded?.createdAt.toISOString()).toBe('9999-12-31T23:59:59.999Z');
  });

  it('accepts a uuid-shaped id', () => {
    const id = '0b8f2f4e-6d1c-4f0a-9a52-1c2d3e4f5a6b';
    expect(decodeNotificationCursor(`1000.${id}`)?.id).toBe(id);
  });
});

describe('parseLimit', () => {
  it.each([
    [null, 50], ['abc', 50], ['', 50], ['0', 1], ['-3', 1], ['1000', 100], ['100', 100], ['12abc', 12],
  ] as const)('parses %j as %i', (raw, expected) => {
    expect(parseLimit(raw)).toBe(expected);
  });
});

describe('mergeNotifications', () => {
  it('returns the union by id, newest first, id descending on a tie', () => {
    const merged = mergeNotifications(
      [row('c', '2026-09-15T10:00:00Z'), row('b', '2026-09-15T09:00:00Z')],
      [row('a', '2026-09-15T09:00:00Z'), row('z', '2026-09-15T08:00:00Z')],
    );
    expect(merged.map((n) => n.id)).toEqual(['c', 'b', 'a', 'z']);
  });

  it('shows a row that is in both lists once, taking the fresh copy', () => {
    const merged = mergeNotifications(
      [row('b', '2026-09-15T09:00:00Z', { isRead: true })],
      [row('b', '2026-09-15T09:00:00Z', { isRead: false }), row('a', '2026-09-15T08:00:00Z')],
    );
    expect(merged.map((n) => n.id)).toEqual(['b', 'a']);
    expect(merged[0]?.isRead).toBe(true);
  });
});
