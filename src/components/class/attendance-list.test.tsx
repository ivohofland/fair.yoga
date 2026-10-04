import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { AttendanceList, type AttendanceItem } from './attendance-list';
import { enqueueAttendance, flushOutbox, resetOutboxForTests } from '@/lib/attendance-outbox';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const OWNER = 'acct-1';
const CLASS_ID = 'class-1';
const CLASS_LABEL = 'Hatha on Tue 6 Oct 18:00';

/** The outbox key for a queued mark on `registrationId`: one per registration, under the account. */
function queuedKey(registrationId: string): string {
  return `fy-outbox:${OWNER}:${registrationId}`;
}

function confirmedKey(registrationId: string): string {
  return `fy-outbox-confirmed:${OWNER}:${registrationId}`;
}

/** What a sync in an earlier document or another tab left for `registrationId`. */
function storeConfirmation(registrationId: string, target: string, confirmedAt: number): void {
  localStorage.setItem(confirmedKey(registrationId), JSON.stringify({ v: 1, target, confirmedAt }));
}

/** A render instant a minute back, half a second into its second: well inside a confirmation's day. */
function renderedAMinuteAgo(): number {
  return Math.floor(Date.now() / 1000) * 1000 - 60_000 + 500;
}

function storedTarget(registrationId: string): unknown {
  const raw = localStorage.getItem(queuedKey(registrationId));
  return raw === null ? null : (JSON.parse(raw) as { target: unknown }).target;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The server applying whatever status the PUT asked for. */
function applyRequested(url: string, init: { body: string }): Promise<Response> {
  const id = url.split('/').pop() ?? '';
  const { status } = JSON.parse(init.body) as { status: string };
  return Promise.resolve(json(200, { data: { id, status, classCompleted: false } }));
}

function bodies(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => (c[1] as { body: string }).body);
}

/**
 * A student who cancels late is still charged (`late_cancel` is in
 * `CHARGED_STATUSES`) but their seat is freed. Some of them turn up anyway, and
 * the teacher lets them in — a routine venue scenario.
 *
 * `activeRegistrations` (`(teacher)/class/[id]/(overview)/page.tsx`) keeps those rows
 * deliberately, so they render here with a control. Two things about that row
 * are easy to get wrong and are held below.
 *
 * FIRST: the server refuses `late_cancel -> attended` while the class is still
 * `open`, yet the control is offered regardless. The page is server-rendered
 * with no revalidation and check-in opens from T-15min, so a prop gating it
 * would freeze at render and never unlock once the class actually started — a
 * silent failure in place of a visible one. The server decides each write, and
 * a refusal shows its reason on the row.
 *
 * SECOND: the toggle must not destroy the record. `late_cancel` is what tells
 * the student, on their own `/bookings`, why they were charged for a class they
 * did not attend.
 *
 * Every tap goes through the attendance outbox (#726): it is queued on the
 * device, shown as waiting, and shown as saved only once a sync confirms it.
 */
describe('AttendanceList', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    refresh.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    resetOutboxForTests();
  });

  const lateCancel: AttendanceItem = {
    registrationId: 'reg-late',
    studentName: 'Ada Lovelace',
    status: 'late_cancel',
  };
  const untouched: AttendanceItem = { registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' };

  function renderList(
    items: AttendanceItem[],
    extra: { locked?: boolean; completed?: boolean; renderedAt?: number } = {},
  ) {
    const props = {
      owner: OWNER,
      classId: CLASS_ID,
      classLabel: CLASS_LABEL,
      completed: false,
      renderedAt: Date.now(),
      ...extra,
    };
    return render(<AttendanceList items={items} {...props} />);
  }

  it('labels a late-cancelled student as such rather than as a no-show', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    // `getByText` throws on a miss, so its return value asserts nothing — the
    // real assertion is the negative one beside it.
    screen.getByText('Late cancel');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  /**
   * The control is OFFERED regardless of class status, because this component
   * cannot know it. Whether the write lands is the server's call.
   */
  it('offers the control and marks the student present once the sync confirms it', async () => {
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    const button = screen.getByRole('button', { name: /mark them present/i });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'attended' }) }),
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('queues the absolute target and shows the row as waiting until a sync confirms it', async () => {
    // Offline: every PUT fails, so the mark stays queued.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched]);

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

    await screen.findByText('Waiting to sync');
    expect(screen.queryByText('Present')).toBeNull();
    expect(screen.queryByText('Not marked')).toBeNull();
    expect(storedTarget('reg-1')).toBe('attended');
    // The toggle already reflects the queued target, so the next tap means "no-show".
    screen.getByRole('button', { name: 'Mark Grace Hopper as no-show' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * Spec §3: the page was rendered before the sync, so `items` still says
   * `registered`. A row whose entry cleared keeps the status the sync
   * confirmed, never falls back to that stale render.
   */
  it('keeps a mark queued on another page once a sync confirms it, although items still says registered', async () => {
    enqueueAttendance(OWNER, {
      registrationId: 'reg-1',
      classId: CLASS_ID,
      classLabel: CLASS_LABEL,
      studentName: 'Grace Hopper',
      target: 'attended',
      knownCompleted: false,
    });
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched]);
    screen.getByText('Waiting to sync');

    // The layout's sync, not a tap in this list.
    await act(() => flushOutbox(OWNER));

    expect(localStorage.getItem(queuedKey('reg-1'))).toBeNull();
    screen.getByText('Present');
    expect(screen.queryByText('Not marked')).toBeNull();
  });

  it('keeps the confirmed status after the sync although items still says registered', async () => {
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = renderList([untouched]);

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));
    await waitFor(() => expect(localStorage.getItem(queuedKey('reg-1'))).toBeNull());
    await screen.findByText('Present');

    rerender(
      <AttendanceList
        items={[{ ...untouched }]}
        owner={OWNER}
        classId={CLASS_ID}
        classLabel={CLASS_LABEL}
        completed={false}
        renderedAt={0}
      />,
    );
    screen.getByText('Present');
    expect(screen.queryByText('Not marked')).toBeNull();
  });

  /**
   * A stored page hard-loaded offline is a new document: it holds nothing of
   * the old one's memory and renders `items` from before the taps. The
   * confirmation the old document's sync stored is what keeps the row marked.
   */
  it('keeps a confirmed mark in a new document that renders the page stored before the tap', async () => {
    const storedPageRenderedAt = Date.now() - 60_000;
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderList([untouched], { renderedAt: storedPageRenderedAt });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));
    await waitFor(() => expect(localStorage.getItem(queuedKey('reg-1'))).toBeNull());
    await screen.findByText('Present');

    unmount();
    resetOutboxForTests();
    renderList([untouched], { renderedAt: storedPageRenderedAt });

    await screen.findByText('Present');
    expect(screen.queryByText('Not marked')).toBeNull();
  });

  it('prefers a confirmation from after the render over items', async () => {
    const renderedAt = renderedAMinuteAgo();
    storeConfirmation('reg-1', 'attended', renderedAt + 2_000);
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { renderedAt });
    await screen.findByText('Present');
  });

  it('prefers a confirmation from the render’s own second, which the Date header cannot split', async () => {
    const renderedAt = renderedAMinuteAgo();
    storeConfirmation('reg-1', 'attended', Math.floor(renderedAt / 1000) * 1000);
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { renderedAt });
    await screen.findByText('Present');
  });

  /** Spec §3: a queued mark shows over a confirmation, so the toggle follows the tap, not the older sync. */
  it('lets a queued mark win over a fresh confirmation', async () => {
    const renderedAt = renderedAMinuteAgo();
    storeConfirmation('reg-1', 'attended', renderedAt + 2_000);
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { renderedAt });
    await screen.findByText('Present');

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as no-show' }));
    await waitFor(() => expect(storedTarget('reg-1')).toBe('no_show'));
    screen.getByText('Waiting to sync');
    const toPresent = screen.getByRole('button', { name: 'Mark Grace Hopper as present' });

    fireEvent.click(toPresent);
    await waitFor(() => expect(storedTarget('reg-1')).toBe('attended'));
    screen.getByText('Waiting to sync');
    screen.getByRole('button', { name: 'Mark Grace Hopper as no-show' });
  });

  /** Another device corrected the row after this device's sync; the newer render shows that. */
  it('lets items win over a confirmation from before the render', () => {
    const renderedAt = renderedAMinuteAgo();
    storeConfirmation('reg-1', 'attended', Math.floor(renderedAt / 1000) * 1000 - 1_000);
    vi.stubGlobal('fetch', fetchMock);
    renderList([{ ...untouched, status: 'no_show' }], { renderedAt });
    screen.getByText('No-show');
    expect(screen.queryByText('Present')).toBeNull();
  });

  /**
   * The second tap, which a plain attended/no_show toggle would use to erase
   * `late_cancel` for good — no teacher-side path writes that value back.
   * A student who cancelled late is not a no-show; the only meaningful
   * correction for them is "they came after all", and it has to be undoable.
   */
  it('returns a walked-in late cancel to late_cancel, never to no_show', async () => {
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /mark them cancelled again/i }));
    await waitFor(() => expect(screen.getByText('Late cancel')).toBeTruthy());

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ body: JSON.stringify({ status: 'late_cancel' }) }),
    );
    expect(bodies(fetchMock).some((b) => b.includes('no_show'))).toBe(false);
  });

  it('returns a queued walk-in of a late cancel to late_cancel while offline', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await waitFor(() => expect(storedTarget('reg-late')).toBe('attended'));

    fireEvent.click(screen.getByRole('button', { name: /mark them cancelled again/i }));
    await waitFor(() => expect(storedTarget('reg-late')).toBe('late_cancel'));
    screen.getByText('Waiting to sync');
    expect(bodies(fetchMock).some((b) => b.includes('no_show'))).toBe(false);
  });

  it('still toggles an ordinary registration between present and no-show', async () => {
    fetchMock.mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched]);

    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as no-show/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/registrations/reg-1',
        expect.objectContaining({ body: JSON.stringify({ status: 'no_show' }) }),
      ),
    );
    await screen.findByText('No-show');
  });

  it("shows the server's reason for a refusal on the row, with Dismiss, and does not refresh", async () => {
    // The shape `respondError` actually emits — `{ error: { message, code } }`.
    fetchMock.mockResolvedValue(
      json(409, {
        error: {
          message: 'This student cancelled late. Attendance can be recorded once the class has started.',
          code: 'CLASS_NOT_STARTED',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);
    // The live region is there, empty, before any refusal arrives — a region
    // mounted together with its text is often not announced.
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    const reason = await screen.findByText(/once the class has started/);
    expect(reason).toHaveClass('text-danger');
    expect(screen.queryByText('Waiting to sync')).toBeNull();
    // Never shown as saved: the row falls back to what the server holds.
    screen.getByText('Late cancel');
    expect(refresh).not.toHaveBeenCalled();

    // Announced, since it usually arrives from a background sync.
    expect(reason).toHaveAttribute('role', 'status');

    const dismiss = screen.getByRole('button', { name: 'Dismiss refused change for Ada Lovelace' });
    expect(dismiss.textContent).toBe('Dismiss');
    expect(dismiss).toHaveAttribute('data-offline-writable');
    fireEvent.click(dismiss);
    expect(screen.queryByText(/once the class has started/)).toBeNull();
  });

  it('clears a refusal when the row is tapped again, sending the target its shown status implies', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(409, {
          error: {
            message: 'This student cancelled late. Attendance can be recorded once the class has started.',
            code: 'CLASS_NOT_STARTED',
          },
        }),
      )
      .mockImplementation(applyRequested);
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await screen.findByText(/once the class has started/);
    screen.getByText('Late cancel');

    // The refused entry left the queue, so the row still reads late_cancel and
    // the re-tap asks for `attended` again — never `no_show`.
    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    await screen.findByText('Present');
    expect(screen.queryByText(/once the class has started/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies(fetchMock)).toEqual([
      JSON.stringify({ status: 'attended' }),
      JSON.stringify({ status: 'attended' }),
    ]);
  });

  it('ignores storage in its first render', () => {
    enqueueAttendance(OWNER, {
      registrationId: 'reg-1',
      classId: CLASS_ID,
      classLabel: CLASS_LABEL,
      studentName: 'Grace Hopper',
      target: 'attended',
      knownCompleted: false,
    });
    expect(storedTarget('reg-1')).toBe('attended');

    const html = renderToString(
      <AttendanceList
        items={[untouched]}
        owner={OWNER}
        classId={CLASS_ID}
        classLabel={CLASS_LABEL}
        completed={false}
        renderedAt={0}
      />,
    );
    expect(html).toContain('Not marked');
    expect(html).not.toContain('Waiting to sync');
  });

  it('records whether the page showed the class completed on the queued entry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { locked: true, completed: true });

    fireEvent.click(screen.getByRole('button', { name: 'Edit attendance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

    await waitFor(() => expect(localStorage.getItem(queuedKey('reg-1'))).not.toBeNull());
    const entry = JSON.parse(localStorage.getItem(queuedKey('reg-1')) ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      classId: CLASS_ID,
      classLabel: CLASS_LABEL,
      studentName: 'Grace Hopper',
      target: 'attended',
      knownCompleted: true,
    });
  });

  describe('when storage cannot hold the mark', () => {
    function breakStorage() {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    }

    it('writes directly instead and shows the result', async () => {
      breakStorage();
      fetchMock.mockResolvedValue(json(200, { data: { id: 'reg-1', status: 'attended' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderList([untouched]);

      fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

      await screen.findByText('Present');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registrations/reg-1',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ status: 'attended' }),
          redirect: 'error',
          cache: 'no-store',
          signal: expect.any(AbortSignal) as unknown,
        }),
      );
      expect(screen.queryByText('Waiting to sync')).toBeNull();
    });

    it('times the direct write out after 10 s', async () => {
      breakStorage();
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(json(200, { data: { id: 'reg-1', status: 'attended' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderList([untouched]);

      fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

      await screen.findByText('Present');
      expect(timeout).toHaveBeenCalledWith(10_000);
    });

    it.each([
      ['an HTML page (a captive portal)', () => new Response('<html>Hotel wifi</html>', { status: 200 })],
      ['JSON naming another status', () => json(200, { data: { id: 'reg-1', status: 'no_show' } })],
      ['JSON without data', () => json(200, { ok: true })],
    ])('a 200 that is not the app confirming the write — %s — is not shown as saved', async (_name, answer) => {
      breakStorage();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      fetchMock.mockResolvedValue(answer());
      vi.stubGlobal('fetch', fetchMock);
      renderList([untouched]);

      fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Couldn't confirm the change was saved. Check your connection and try again.",
      );
      screen.getByText('Not marked');
      expect(screen.queryByText('Present')).toBeNull();
      expect(consoleError).toHaveBeenCalledWith(
        '[attendance-list] request failed',
        expect.objectContaining({ registrationId: 'reg-1', newStatus: 'attended', status: 200 }),
      );
    });

    it("surfaces the server's reason for a direct refusal without refreshing", async () => {
      breakStorage();
      fetchMock.mockResolvedValue(
        json(409, {
          error: {
            message: 'This student cancelled late. Attendance can be recorded once the class has started.',
            code: 'CLASS_NOT_STARTED',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderList([lateCancel]);

      fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('once the class has started');
      expect(alert.textContent).not.toContain('try again');
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  it('labels an untouched registration "Not marked", never "No-show"', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched]);
    screen.getByText('Not marked');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  it('labels a recorded no-show as such', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([{ ...untouched, status: 'no_show' }]);
    screen.getByText('No-show');
  });

  it('shows locked rows without controls until "Edit attendance" is chosen', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { locked: true, completed: true });

    screen.getByText('Not marked');
    expect(screen.queryByRole('button', { name: 'Mark Grace Hopper as present' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit attendance' }));

    screen.getByRole('button', { name: 'Mark Grace Hopper as present' });
    screen.getByText('Corrections update the record — the payment request already sent stays as it is.');
  });

  it('marks the toggle and "Edit attendance" as writable offline', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched], { locked: true, completed: true });

    expect(screen.getByRole('button', { name: 'Edit attendance' })).toHaveAttribute('data-offline-writable');
    fireEvent.click(screen.getByRole('button', { name: 'Edit attendance' }));
    expect(screen.getByRole('button', { name: 'Mark Grace Hopper as present' })).toHaveAttribute(
      'data-offline-writable',
    );
  });

  it('shows no edit affordance during check-in', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList([untouched]);
    expect(screen.queryByRole('button', { name: 'Edit attendance' })).toBeNull();
  });

  it('marks the student present when the server finds that already recorded', async () => {
    fetchMock.mockResolvedValue(json(200, { data: { id: 'reg-late', status: 'attended' }, outcome: 'unchanged' }));
    vi.stubGlobal('fetch', fetchMock);
    renderList([lateCancel]);

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });
});
