import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Notification } from '@prisma/client';
import { routerPush, routerRefresh } from '../../../tests/setup/components';
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

function olderResponse(notifications: Notification[], nextCursor: string | null, hrefById: Record<string, string | null> = {}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        notifications: notifications.map((n) => ({
          ...n,
          createdAt: n.createdAt.toISOString(),
          updatedAt: n.updatedAt.toISOString(),
        })),
        hrefById,
        nextCursor,
      },
    }),
  };
}
const rowIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[id^="notification-row-"]')).map((el) => el.id.replace('notification-row-', ''));
const at = (mins: number) => new Date(Date.UTC(2026, 8, 15, 10, 0) - mins * 60_000);

describe('NotificationList — show older (#663)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers no button without paging, or when the cursor is null', () => {
    const { rerender } = render(<NotificationList notifications={[notification({ id: 'a' })]} />);
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
    rerender(<NotificationList notifications={[notification({ id: 'a' })]} paging={{ audience: 'teacher', nextCursor: null }} />);
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
  });

  it('fetches the next page for its audience, appends it below, and drops the button at the end', async () => {
    const fetchMock = vi.fn().mockResolvedValue(olderResponse([notification({ id: 'b', createdAt: at(5) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <NotificationList
        notifications={[notification({ id: 'a', createdAt: at(1) })]}
        paging={{ audience: 'teacher', nextCursor: 'cursor-1' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://x');
    expect(url.pathname).toBe('/api/notifications');
    expect(url.searchParams.get('recipientType')).toBe('teacher');
    expect(url.searchParams.get('before')).toBe('cursor-1');
    expect(screen.queryByRole('button', { name: 'Show older messages' })).toBeNull();
  });

  it('keeps the button and resumes from the new cursor while more remain', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(olderResponse([notification({ id: 'b', createdAt: at(5) })], 'cursor-2'))
      .mockResolvedValueOnce(olderResponse([notification({ id: 'c', createdAt: at(9) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(
      <NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'cursor-1' }} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    fireEvent.click(await screen.findByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b', 'c']));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), 'http://x').searchParams.get('before')).toBe('cursor-2');
  });

  it('marks a later-loaded row read through the same path, and shows an already-read one as read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(olderResponse([
        notification({ id: 'b', title: 'Old unread', isRead: false, createdAt: at(5) }),
        notification({ id: 'c', title: 'Old read', isRead: true, createdAt: at(6) }),
      ], null))
      .mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    const markUnread = await screen.findByRole('button', { name: 'Mark "Old unread" read' });
    expect(screen.getByRole('button', { name: 'Mark "Old read" read' })).toHaveClass('invisible');
    expect(markUnread).not.toHaveClass('invisible');

    fireEvent.click(markUnread);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/notifications/b/read', { method: 'POST' }));
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Mark "Old unread" read' })).toHaveClass('invisible');
  });

  it('opens a later-loaded row on the href the API sent for it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse(
      [notification({ id: 'b', title: 'Old invite', type: 'teacher_invitation', createdAt: at(5) })], null, { b: '/account/privacy' },
    )).mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} hrefById={{ a: null }} paging={{ audience: 'student', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Old invite/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/account/privacy'));
  });

  it('shows every row once when the page refreshes between clicks', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse([
      notification({ id: 'n3', createdAt: at(3) }),
      notification({ id: 'n2', createdAt: at(4) }),
    ], 'c2')));
    const first = [notification({ id: 'n5', createdAt: at(1) }), notification({ id: 'n4', createdAt: at(2) })];
    const { container, rerender } = render(<NotificationList notifications={first} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['n5', 'n4', 'n3', 'n2']));

    // A new row arrives; the server re-renders the first page with n4 slid out.
    rerender(
      <NotificationList
        notifications={[notification({ id: 'n6', createdAt: at(0) }), notification({ id: 'n5', createdAt: at(1) })]}
        paging={{ audience: 'teacher', nextCursor: 'c-after-refresh' }}
      />,
    );

    expect(rowIds(container)).toEqual(['n6', 'n5', 'n4', 'n3', 'n2']);
    expect(screen.getByRole('button', { name: 'Show older messages' })).toBeInTheDocument();
  });

  it('says so on a failed fetch, keeps the cursor, and succeeds on retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(olderResponse([notification({ id: 'b', createdAt: at(5) })], null));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load older messages.");

    fireEvent.click(await screen.findByRole('button', { name: 'Show older messages' }));
    await vi.waitFor(() => expect(rowIds(container)).toEqual(['a', 'b']));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), 'http://x').searchParams.get('before')).toBe('c1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fetches once when clicked twice while a fetch is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<NotificationList notifications={[notification({ id: 'a' })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    const button = screen.getByRole('button', { name: 'Show older messages' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(olderResponse([], null));
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: /older messages|Loading/ })).toBeNull());
  });

  it('moves focus to the first loaded row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(olderResponse([notification({ id: 'b', title: 'Loaded', createdAt: at(5) })], null)));
    render(<NotificationList notifications={[notification({ id: 'a', createdAt: at(1) })]} paging={{ audience: 'teacher', nextCursor: 'c1' }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Show older messages' }));

    await vi.waitFor(() => expect(screen.getByRole('button', { name: /^Loaded/ })).toHaveFocus());
  });
});
