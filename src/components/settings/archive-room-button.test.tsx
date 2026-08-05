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

  /**
   * #166 review F14. The third instance of a defect already fixed twice on
   * this branch (`ArchiveStudentButton`, `ArchiveContactButton`): `if
   * (res.ok)` with no `else` and no `catch`. The success path navigates
   * away, so a failure that says nothing looks exactly like a click that
   * never registered. These three are the tests that fail if the
   * `else`/`catch` is removed again — the two above pass either way.
   */
  it('shows the server message when the PATCH fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'This room is used by an upcoming class.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('This room is used by an upcoming class.'),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('falls back to the generic copy its sibling toggles use when the server sends none', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={true} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Failed to update. Please try again.')).toBeInTheDocument();
  });

  it('reports a thrown fetch instead of swallowing it', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    // Re-enabled, not stuck mid-flight: `finally` still has to run on the
    // throw path.
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });
});
