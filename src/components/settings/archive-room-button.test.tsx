import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveRoomButton } from './archive-room-button';

/**
 * URL only. This button renders no confirmation — success is a `router.push`
 * — so there is nothing further a component test would see that a pure
 * function could not. See the spec's scope boundary (#99).
 */
describe('ArchiveRoomButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubOk(): void {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends state=archived when the room is not archived', async () => {
    stubOk();
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1?state=archived', {
        method: 'PATCH',
      }),
    );
  });

  it('sends state=unarchived when the room is archived', async () => {
    stubOk();
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });
});
