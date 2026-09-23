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

  it('shows the retention note under an empty list', () => {
    render(<NotificationList notifications={[]} />);

    expect(screen.getByText('Messages are kept for a year.')).toBeInTheDocument();
  });

  it('shows the retention note under a non-empty list', () => {
    render(<NotificationList notifications={[notification({})]} />);

    expect(screen.getByText('Messages are kept for a year.')).toBeInTheDocument();
  });
});
