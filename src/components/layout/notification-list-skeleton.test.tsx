import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { Notification } from '@prisma/client';
import { listRowClass } from '@/components/ui/list-row';
import { NotificationList } from './notification-list';
import { NotificationListSkeleton } from './notification-list-skeleton';

const readNotification: Notification = {
  id: 'n-1', recipientType: 'teacher', recipientId: 't-1', type: 'announcement',
  title: 'Title', body: 'Body', relatedClassId: null, isRead: true, emailSent: false,
  pushHandledAt: null,
  createdAt: new Date('2026-09-15T10:00:00Z'), updatedAt: new Date('2026-09-15T10:00:00Z'),
};

describe('NotificationListSkeleton', () => {
  const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

  it('keeps the real row\'s class set', () => {
    const { container } = render(<NotificationList notifications={[readNotification]} />);
    expect(set(container.firstElementChild?.firstElementChild?.className)).toEqual(
      set('min-h-14 py-3 border-b border-border flex items-start justify-between gap-2 px-3 -mx-3'),
    );
  });

  it('draws its rows through the list\'s root, the row frame and the row inset, hidden and inert', () => {
    const realList = render(<NotificationList notifications={[readNotification]} />).container.firstElementChild;
    const realRow = realList?.firstElementChild;
    const { container } = render(<NotificationListSkeleton rows={3} />);
    const skel = container.firstElementChild;
    expect(skel?.getAttribute('aria-hidden')).toBe('true');
    expect(set(skel?.className)).toEqual(set(realList?.className));

    const rows = [...(skel?.children ?? [])];
    expect(rows).toHaveLength(3);
    const frame = set(listRowClass({ density: 'relaxed', divider: 'after-each' }));
    for (const token of [...frame, 'px-3', '-mx-3']) {
      expect(realRow?.classList.contains(token)).toBe(true);
      for (const row of rows) expect(row.classList.contains(token)).toBe(true);
    }
    expect(container.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
  });

  it('draws six rows by default', () => {
    const { container } = render(<NotificationListSkeleton />);
    expect(container.firstElementChild?.children).toHaveLength(6);
  });
});
