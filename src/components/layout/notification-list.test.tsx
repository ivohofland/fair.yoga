import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Notification } from '@prisma/client';
import { routerPush } from '../../../tests/setup/components';
import { TEACHER_INVITATION_PATH } from '@/lib/notification-links';
import { NotificationList } from './notification-list';

function notification(over: Partial<Notification>): Notification {
  return {
    id: 'n-1', recipientType: 'teacher', recipientId: 't-1', type: 'announcement',
    title: 'Title', body: 'Body', relatedClassId: null, isRead: false, emailSent: false,
    createdAt: new Date('2026-09-15T10:00:00Z'), updatedAt: new Date('2026-09-15T10:00:00Z'),
    ...over,
  };
}

describe('NotificationList — where a teacher row goes (#172)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens the invitations page from a teacher invitation row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[
      notification({ type: 'teacher_invitation', title: 'A teacher would like to connect' }),
    ]} />);

    fireEvent.click(screen.getByRole('button', { name: /^A teacher would like to connect/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(TEACHER_INVITATION_PATH));
  });

  it('still opens a class row on its class', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[
      notification({ type: 'booking_confirmed', title: 'Anna booked', relatedClassId: 'class-9' }),
    ]} />);

    fireEvent.click(screen.getByRole('button', { name: /^Anna booked/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/class/class-9'));
  });
});

describe('NotificationList — retention note (#223)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('places the retention note inside the empty state, as its last line', () => {
    render(<NotificationList notifications={[]} />);

    const note = screen.getByText('Messages are kept for a year.');
    const emptyState = screen.getByText('No notifications.').parentElement;
    expect(emptyState?.lastElementChild?.contains(note)).toBe(true);
    // Not in the action slot: nothing in the empty state is interactive.
    expect(emptyState?.querySelector('button, a')).toBeNull();
  });

  it('places the retention note after the rows, outside every row', () => {
    render(<NotificationList notifications={[
      notification({ id: 'n-1', title: 'First' }),
      notification({ id: 'n-2', title: 'Second' }),
    ]} />);

    const note = screen.getByText('Messages are kept for a year.');
    const lastRow = screen.getByRole('button', { name: /^Second/ }).parentElement;
    expect(lastRow?.contains(note)).toBe(false);
    expect(lastRow?.compareDocumentPosition(note)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.queryByText('No notifications.')).toBeNull();
  });
});
