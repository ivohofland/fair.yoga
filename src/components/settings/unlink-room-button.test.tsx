import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UnlinkRoomButton } from './unlink-room-button';
import { routerPush } from '../../../tests/setup/components';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('UnlinkRoomButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function confirmUnlink(): void {
    render(<UnlinkRoomButton teacherRoomId="tr-1" roomName="Sunrise Studio" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
  }

  it('asks before unlinking, and asks nothing of the server yet', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<UnlinkRoomButton teacherRoomId="tr-1" roomName="Sunrise Studio" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink room' }));

    expect(
      screen.getByText(
        'Unlink Sunrise Studio? This removes it from your rooms. Only possible while no classes use it.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes the link and returns to the rooms list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { deleted: true } }));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/rooms'));
    expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1', { method: 'DELETE' });
  });

  // A double-click, or a retry after a lost response: the link is gone, which
  // is what this unlink asked for.
  it('treats a link that is already gone as unlinked', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'This room is no longer in your rooms.' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/rooms'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the refusal for a room that classes still use, and stays', async () => {
    const message = "This room is used by your classes, so it can't be unlinked. Archive it instead.";
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'ROOM_IN_USE', message } }));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(routerPush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink' })).not.toBeDisabled());
  });

  it('reports a network failure rather than falling silent', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
