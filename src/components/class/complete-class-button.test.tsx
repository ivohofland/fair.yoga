import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompleteClassButton } from './complete-class-button';
import { routerRefresh } from '../../../tests/setup/components';
import { enqueueAttendance, getOutbox, resetOutboxForTests, type QueuedStatus } from '@/lib/attendance-outbox';
import { resetSyncForTests } from '@/lib/attendance-sync';

/**
 * Same defect as `PublishClassButton` (#166 re-review M5), with more behind
 * it: completing runs the pricing engine, writes the payment rows and
 * notifies everyone registered. A silent failure leaves the teacher looking
 * at an unchanged page with no idea whether any of that happened, and the
 * obvious response — click again — is the one thing they should not do while
 * uncertain.
 */
describe('CompleteClassButton', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    resetOutboxForTests();
    resetSyncForTests();
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('attendance changes still on the device', () => {
    function queue(registrationId: string, classId = 'c-9', ownerId = 'acct-1', status: QueuedStatus = 'attended') {
      return enqueueAttendance({ ownerId, registrationId, classId, studentName: 'Ada', status });
    }

    function answer(attendance: (url: string) => Promise<unknown>) {
      fetchMock.mockImplementation((url: string) =>
        url === '/api/classes/c-9/complete' ? Promise.resolve({ ok: true }) : attendance(url),
      );
      vi.stubGlobal('fetch', fetchMock);
    }

    const offline = () => Promise.reject(new TypeError('Failed to fetch'));

    function finish() {
      fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    }

    const completeCalls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/classes/c-9/complete');

    it('sends this class\'s queued changes first, then finishes', async () => {
      await queue('r1');
      await queue('rX', 'c-other');
      await queue('rY', 'c-9', 'acct-2');
      // Another class's change stays unsent, and another account's is never sent by this account's flush.
      answer(async (url) =>
        url === '/api/registrations/rX'
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ data: { id: url.split('/').pop(), status: 'attended' } }), { status: 200 }),
      );
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        '/api/registrations/r1',
        '/api/registrations/rX',
        '/api/classes/c-9/complete',
      ]);
      expect(Object.keys(getOutbox().pending).sort()).toEqual(['rX', 'rY']);
      expect(screen.queryByText(/haven't synced|hasn't synced/)).not.toBeInTheDocument();
    });

    it('asks before finishing while this class still has unsynced changes, and posts nothing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await queue('r1');
      await queue('r2', 'c-9', 'acct-1', 'no_show');
      answer(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();

      const cancel = await screen.findByRole('button', { name: 'Cancel' });
      const reason = "2 attendance changes for this class haven't synced.";
      expect(screen.getByText(reason)).toBeInTheDocument();
      await waitFor(() => expect(cancel).toHaveFocus());
      expect(cancel).toHaveAccessibleDescription(reason);
      expect(screen.getByRole('button', { name: 'Finish anyway' })).toHaveAccessibleDescription(reason);
      expect(completeCalls()).toHaveLength(0);
    });

    it('says one change, singular', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await queue('r1');
      answer(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();

      expect(await screen.findByText("1 attendance change for this class hasn't synced.")).toBeInTheDocument();
    });

    it('finishes at once when only another class, or another account, has unsynced changes', async () => {
      await queue('r1', 'c-other');
      await queue('r2', 'c-9', 'acct-2');
      answer(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/classes/c-9/complete']);
      expect(Object.keys(getOutbox().pending).sort()).toEqual(['r1', 'r2']);
    });

    it('Finish anyway posts the completion', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await queue('r1');
      answer(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();
      fireEvent.click(await screen.findByRole('button', { name: 'Finish anyway' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(completeCalls()).toEqual([['/api/classes/c-9/complete', { method: 'POST' }]]);
    });

    it('Cancel posts nothing and returns focus to Finish class', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await queue('r1');
      answer(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      const main = screen.getByRole('button', { name: 'Finish class' });
      await waitFor(() => expect(main).toHaveFocus());
      expect(completeCalls()).toHaveLength(0);
    });

    it('waits on a flush that never settles no longer than sign-out does', async () => {
      vi.useFakeTimers();
      await queue('r1');
      answer(() => new Promise(() => {}));
      render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

      finish();
      await act(() => vi.advanceTimersByTimeAsync(2_999));
      expect(screen.queryByRole('button', { name: 'Finish anyway' })).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole('button', { name: 'Finish anyway' })).toBeInTheDocument();
      expect(completeCalls()).toHaveLength(0);
    });
  });

  it('posts the completion once confirmed and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-9/complete', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('asks before finishing, and posts nothing until confirmed', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));

    screen.getByText('Finish class? Payment requests go to 2 students now.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the class open when the teacher backs out', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));

    expect(fetchMock).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Finish class' });
  });

  /**
   * The POST cannot be recalled once sent, so "Keep open" must not offer to
   * while it is in flight.
   */
  it('disables Keep open while the finish is in flight', async () => {
    let answer: (value: { ok: boolean }) => void = () => {};
    fetchMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep open' })).toBeDisabled());

    answer({ ok: true });
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('says one student, not one students', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={1} ownerId="acct-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? A payment request goes to 1 student now.');
  });

  // Review Focus 4.
  it('does not promise payment requests when nobody is charged', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={0} ownerId="acct-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? No one is charged for this class.');
  });

  it('treats an unchanged answer as success: the class was already completed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, newStatus: 'completed' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server message when completion is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'CLASS_CANCELLED', message: 'This class has been cancelled.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This class has been cancelled.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = new Error('offline');
    fetchMock.mockRejectedValue(offline);
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} ownerId="acct-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('[complete-class-button] request failed', {
      classId: 'c-9',
      err: offline,
    });
    consoleError.mockRestore();
  });
});
