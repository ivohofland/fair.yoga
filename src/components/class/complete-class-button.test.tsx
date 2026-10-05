import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompleteClassButton } from './complete-class-button';
import { routerRefresh } from '../../../tests/setup/components';
import { enqueueAttendance, flushOutbox, getOutboxSnapshot, resetOutboxForTests } from '@/lib/attendance-outbox';

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

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts the completion once confirmed and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-9/complete', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('asks before finishing, and posts nothing until confirmed', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));

    screen.getByText('Finish class? Payment requests go to 2 students now.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the class open when the teacher backs out', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

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
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    expect(screen.getByRole('button', { name: 'Keep open' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep open' })).toBeDisabled());

    answer({ ok: true });
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('says one student, not one students', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? A payment request goes to 1 student now.');
  });

  // Review Focus 4.
  it('does not promise payment requests when nobody is charged', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={0} />);
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
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

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
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

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
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('[complete-class-button] request failed', {
      classId: 'c-9',
      err: offline,
    });
    consoleError.mockRestore();
  });

  /**
   * Completion reads the server's statuses and picks each student's payment
   * wording from them, so a mark still queued on this device would be billed
   * as the server last heard it. Finish syncs first, and asks before going on
   * without what did not sync.
   */
  describe('with attendance queued on this device', () => {
    const OWNER = 'acct-1';

    function queue(registrationId: string, classId = 'c-9'): void {
      enqueueAttendance(OWNER, {
        registrationId,
        classId,
        classLabel: 'Hatha on Tue 6 Oct 18:00',
        studentName: `Student ${registrationId}`,
        target: 'attended',
        knownCompleted: false,
      });
    }

    /** The class's completion answers ok; every attendance PUT fails as `put` says. */
    function server(put: (url: string) => Promise<Response>): void {
      fetchMock.mockImplementation((url: string) =>
        url.endsWith('/complete') ? Promise.resolve({ ok: true }) : put(url),
      );
      vi.stubGlobal('fetch', fetchMock);
    }

    const offline = () => Promise.reject(new TypeError('Failed to fetch'));

    function completions(): unknown[][] {
      return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/complete'));
    }

    function finish(): void {
      fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
      fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    }

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      localStorage.clear();
      resetOutboxForTests();
    });

    it('names an unsynced mark for this class and posts nothing until the teacher chooses', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1');
      server(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      const reason = await screen.findByText("1 attendance change for this class hasn't synced.");
      expect(completions()).toEqual([]);
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      const anyway = screen.getByRole('button', { name: 'Finish anyway' });
      expect(cancel).toHaveFocus();
      expect(reason.id).not.toBe('');
      expect(cancel).toHaveAttribute('aria-describedby', reason.id);
      expect(anyway).toHaveAttribute('aria-describedby', reason.id);

      fireEvent.click(anyway);
      await waitFor(() => expect(completions()).toEqual([['/api/classes/c-9/complete', { method: 'POST' }]]));
      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    });

    it('counts every unsynced mark for this class', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1');
      queue('r2');
      server(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await screen.findByText("2 attendance changes for this class haven't synced.");
    });

    it('Cancel keeps the class open and returns to Finish class', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1');
      server(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('button', { name: 'Finish class' })).toHaveFocus();
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
      expect(completions()).toEqual([]);
    });

    it('syncs first, and finishes straight away once everything synced', async () => {
      queue('r1');
      server((url) =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { id: url.split('/').pop(), status: 'attended' } }), { status: 200 }),
        ),
      );
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await waitFor(() => expect(completions()).toHaveLength(1));
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
        '/api/registrations/r1',
        '/api/classes/c-9/complete',
      ]);
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
    });

    it("is not held up by another class's unsynced mark", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1', 'other-class');
      server(offline);
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await waitFor(() => expect(completions()).toHaveLength(1));
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
    });

    /** Three 500s: the outbox gives up on the mark, though the server never refused it. */
    async function exhaustRetries(): Promise<void> {
      for (let i = 0; i < 3; i++) await flushOutbox(OWNER);
      expect(getOutboxSnapshot(OWNER).refused.map((e) => e.kind)).toEqual(['retries-exhausted']);
    }

    const serverError = () => Promise.resolve(new Response('<html>Internal error</html>', { status: 500 }));

    it('counts a mark the outbox gave up retrying: the server never refused it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1');
      server(serverError);
      await exhaustRetries();
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await screen.findByText("1 attendance change for this class hasn't synced.");
      expect(completions()).toEqual([]);
    });

    it("is not held up by another class's mark the outbox gave up retrying", async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1', 'other-class');
      server(serverError);
      await exhaustRetries();
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await waitFor(() => expect(completions()).toHaveLength(1));
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
    });

    it('is not held up by a mark the server refused: it already said no to it', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      queue('r1');
      server(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Gone' } }), { status: 404 }),
        ),
      );
      await flushOutbox(OWNER);
      expect(getOutboxSnapshot(OWNER).refused.map((e) => e.kind)).toEqual(['verdict']);
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await waitFor(() => expect(completions()).toHaveLength(1));
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
    });

    it('waits at most 5 s for a sync that does not answer', async () => {
      vi.useFakeTimers();
      queue('r1');
      server(() => new Promise<Response>(() => {}));
      render(<CompleteClassButton classId="c-9" chargedCount={2} outboxOwner={OWNER} />);

      finish();

      await act(() => vi.advanceTimersByTimeAsync(4_999));
      expect(screen.queryByText(/hasn't synced/)).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      screen.getByText("1 attendance change for this class hasn't synced.");
      expect(completions()).toEqual([]);
    });
  });
});
