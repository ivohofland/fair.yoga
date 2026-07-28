import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ArchiveRoomButton } from './archive-room-button';
import { routerPush } from '../../../tests/setup/components';

/**
 * This button renders no confirmation on success, only a `router.push` — but
 * that push target is derived inline, the same wiring class as the `?state=`
 * derivation the toggle buttons need this layer for. Nothing asserted it until
 * this file: a button that fired the correct PATCH and then navigated to the
 * wrong page passed the whole suite (#99).
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
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/rooms'));
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
