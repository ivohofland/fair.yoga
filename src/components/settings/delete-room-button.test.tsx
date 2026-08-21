import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { DeleteRoomButton } from './delete-room-button';

/**
 * Added under issue 279's PR review, which folded a navigation fix into this
 * button and found it was the only room control without a test file
 * (`archive-room-button`, `share-room-button`, `room-match-list` and
 * `edit-teacher-room-form` all have one). CLAUDE.md asks for tests covering the
 * change, and the change here is behavioural: how the button leaves the page.
 *
 * The success path exits with a full navigation rather than `router.push`,
 * because on Next 16 a soft push to the rooms list serves the destination's
 * pre-deletion prefetch and the deleted room keeps rendering for a moment.
 * jsdom's `location` is replaced wholesale so each test gets a fresh spy, and
 * restored afterwards — without that, later tests run against a `location`
 * carrying nothing but `assign`.
 */
const realLocation = window.location;

const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  return assign;
};

describe('DeleteRoomButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { value: realLocation, writable: true });
  });

  const openConfirm = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Delete room' }));
  const confirmDelete = () => fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  it('names the room before asking, and asks nothing of the server yet', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();

    expect(
      screen.getByText('Permanently delete Sunrise Studio? This cannot be undone.'),
    ).toBeInTheDocument();
    // The first click opens the confirm; it must not delete anything.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * THE ESCAPE HATCH. Two plausible regressions ship green without this: Cancel
   * wired to `handleDelete` — a copy-paste from the `<Button>` two lines above
   * it, which makes the NO button delete the room — or Cancel failing to clear
   * `confirming`, which makes the confirm inescapable.
   */
  it('backs out on Cancel without deleting anything', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Delete room' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  /**
   * THE BEHAVIOUR THIS FILE EXISTS FOR. A soft `router.push` would leave the
   * router mocked and unobserved; a full navigation is observable, and pinning
   * it is what stops someone "tidying" it back into a push.
   */
  it('leaves with a full navigation, which cannot serve a pre-deletion list', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/settings/rooms'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1', { method: 'DELETE' });
  });

  /**
   * `deleting` is deliberately NOT cleared on the success path — the page is
   * leaving, and an enabled "Delete" under an in-flight navigation is the
   * silence half of confirm-then-silence.
   *
   * ASSERTED AFTER EVERYTHING HAS SETTLED, and the first draft of this test got
   * that wrong. `waitFor` resolves on its first passing poll, and "Deleting..."
   * is briefly on screen in BOTH versions — so waiting for it to appear passed
   * against the regression too. Scored: restoring the old
   * `finally { setDeleting(false) }` left this test green. It now waits for the
   * navigation, flushes React, and asserts the label has NOT gone back.
   */
  it('stays busy after the navigation starts, rather than re-arming', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    await waitFor(() => expect(assign).toHaveBeenCalled());
    // Let any pending state update flush — the regression's `setDeleting(false)`
    // runs immediately after `assign`, so it would land here.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('surfaces the server’s own refusal and does not navigate', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'This room is still in use.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.getByText('This room is still in use.')).toBeInTheDocument(),
    );
    expect(assign).not.toHaveBeenCalled();
    // Re-enabled, because the teacher is still on this page and may retry.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('reports a network failure rather than falling silent', async () => {
    const assign = stubLocation();
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    await waitFor(() =>
      expect(screen.getByText('Network error. Please try again.')).toBeInTheDocument(),
    );
    expect(assign).not.toHaveBeenCalled();
  });
});
