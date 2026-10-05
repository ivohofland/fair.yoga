import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act, type ComponentProps } from 'react';
import {
  enqueueAttendance,
  getOutbox,
  resetOutboxForTests,
  settleEntry,
  type PendingEntry,
} from '@/lib/attendance-outbox';
import { resetSyncForTests } from '@/lib/attendance-sync';
import { AttendanceSyncProvider } from '@/components/layout/attendance-sync-status';
import { AttendanceList, type AttendanceItem } from './attendance-list';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { startAttendanceSync } = vi.hoisted(() => ({
  startAttendanceSync: vi.fn(() => () => {}),
}));
vi.mock('@/lib/attendance-sync', async (orig) => ({
  ...(await orig<typeof import('@/lib/attendance-sync')>()),
  startAttendanceSync,
}));

const CLASS_ID = 'class-1';
/** A minute before the test runs, so a confirmation stamped with the `Date` header of "now" is newer than the render. */
const RENDERED_AT = Date.now() - 60_000;

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

function ok(data: { id: string; status: string }, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ data, ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json', date: new Date().toUTCString() },
  });
}

function refusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, code } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The server's answer to a successful PUT: the registration it wrote, as sent. */
const echo: FetchFn = async (url, init) => {
  const body: unknown = JSON.parse(String(init.body));
  const status =
    typeof body === 'object' && body !== null && 'status' in body ? String(body.status) : '';
  return ok({ id: url.split('/').pop() ?? '', status });
};

function held(): { promise: Promise<Response>; release: (res: Response) => void } {
  let release: (res: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn<FetchFn>>): string[] {
  return fetchMock.mock.calls.map((c) => String(c[1].body));
}

type ListProps = ComponentProps<typeof AttendanceList>;

function tree(props: Partial<ListProps> & Pick<ListProps, 'items'>) {
  return (
    <AttendanceSyncProvider ownerId="acct-1">
      <AttendanceList classId={CLASS_ID} renderedAt={RENDERED_AT} {...props} />
    </AttendanceSyncProvider>
  );
}

function renderList(props: Partial<ListProps> & Pick<ListProps, 'items'>) {
  return render(tree(props));
}

function entry(over: Partial<Omit<PendingEntry, 'id' | 'recordedAt'>> = {}): Omit<PendingEntry, 'id' | 'recordedAt'> {
  return {
    ownerId: 'acct-1',
    registrationId: 'reg-1',
    classId: CLASS_ID,
    studentName: 'Grace Hopper',
    status: 'attended',
    ...over,
  };
}

async function storeRefusal(over: Partial<Omit<PendingEntry, 'id' | 'recordedAt'>>, message: string): Promise<void> {
  const queued = await enqueueAttendance(entry(over));
  await settleEntry(queued, { kind: 'refused', message });
}

/** Server HTML first, then `hydrateRoot` over it — what a reload does. Torn down by the returned function. */
async function hydrate(
  props: Partial<ListProps> & Pick<ListProps, 'items'>,
  beforeHydrate: () => Promise<void> = async () => {},
): Promise<{ container: HTMLElement; onRecoverableError: ReturnType<typeof vi.fn>; teardown: () => void }> {
  const html = renderToString(tree(props));
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  await beforeHydrate();
  const onRecoverableError = vi.fn();
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, tree(props), { onRecoverableError });
  });
  return {
    container,
    onRecoverableError,
    teardown: () => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

/**
 * A student who cancels late is still charged (`late_cancel` is in
 * `CHARGED_STATUSES`) but their seat is freed. Some of them turn up anyway, and
 * the teacher lets them in — a routine venue scenario, and the reason this file
 * exists.
 *
 * `activeRegistrations` (`(teacher)/class/[id]/(overview)/page.tsx`) keeps those rows
 * deliberately, so they render here with a control. Two things about that row
 * are easy to get wrong and are held below.
 *
 * FIRST: the server refuses `late_cancel -> attended` while the class is still
 * `open`, and the control is offered anyway. The page is server-rendered with
 * no revalidation and check-in opens from T-15min, so any class-status prop
 * would be frozen at render, and a control gated on it would stay dead once the
 * class actually started — a silent failure in place of a visible one. The
 * server decides; a refusal refreshes.
 *
 * SECOND: the toggle must not destroy the record. `late_cancel` is what tells
 * the student, on their own `/bookings`, why they were charged for a class they
 * did not attend.
 *
 * Every tap is queued in the attendance outbox and sent by a flush (the real
 * `flushAttendance`; only the layout's `startAttendanceSync` is stubbed), so a
 * test that waits on the server's answer waits on the flush.
 */
describe('AttendanceList', () => {
  const fetchMock = vi.fn<FetchFn>();

  beforeEach(() => {
    localStorage.clear();
    resetOutboxForTests();
    resetSyncForTests();
    startAttendanceSync.mockClear();
  });

  afterEach(() => {
    fetchMock.mockReset();
    refresh.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const lateCancel: AttendanceItem = {
    registrationId: 'reg-late',
    studentName: 'Ada Lovelace',
    status: 'late_cancel',
  };

  it('labels a late-cancelled student as such rather than as a no-show', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    // `getByText` throws on a miss, so its return value asserts nothing — the
    // real assertion is the negative one beside it.
    screen.getByText('Late cancel');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  /**
   * The control is OFFERED regardless of class status, because this component
   * cannot know it. Whether the write lands is the server's call; a control
   * that tried to pre-empt it would be judged against a render-time snapshot
   * and could stay dead for the whole class.
   */
  it('offers the control and marks the student present', async () => {
    fetchMock.mockImplementation(echo);
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    const button = screen.getByRole('button', { name: /mark them present/i });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ status: 'attended' }) }),
    );
  });

  /**
   * The second tap, which a plain attended/no_show toggle would use to erase
   * `late_cancel` for good — no teacher-side path writes that value back.
   * A student who cancelled late is not a no-show; the only meaningful
   * correction for them is "they came after all", and it has to be undoable.
   */
  it('returns a walked-in late cancel to late_cancel, never to no_show', async () => {
    fetchMock.mockImplementation(echo);
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /mark them cancelled again/i }));
    await waitFor(() => expect(screen.getByText('Late cancel')).toBeTruthy());

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/registrations/reg-late',
      expect.objectContaining({ body: JSON.stringify({ status: 'late_cancel' }) }),
    );
    expect(sentBodies(fetchMock).some((b) => b.includes('no_show'))).toBe(false);
  });

  it('still toggles an ordinary registration between present and no-show', async () => {
    fetchMock.mockImplementation(echo);
    vi.stubGlobal('fetch', fetchMock);
    renderList({
      items: [{ registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' }],
    });

    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as present/i }));
    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Mark Grace Hopper as no-show/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/registrations/reg-1',
        expect.objectContaining({ body: JSON.stringify({ status: 'no_show' }) }),
      ),
    );
  });

  it("surfaces the server's reason for a refusal and refreshes the stale page", async () => {
    // The shape `respondError` actually emits — `{ error: { message, code } }`,
    // not a bare string. The bare-string branch of `readError` exists for
    // defensiveness; mocking it here would exercise a path the server never
    // produces and quietly stop testing the real one.
    fetchMock.mockResolvedValue(
      refusal(
        409,
        'CLASS_NOT_STARTED',
        'This student cancelled late. Attendance can be recorded once the class has started.',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('once the class has started');
    expect(alert.textContent).not.toContain('try again');
    // Without this the teacher is stuck: the page's class status is a render-time
    // snapshot, so a refusal it no longer reflects would repeat forever.
    expect(refresh).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: `Dismiss: ${alert.textContent ?? ''}` });
  });

  const untouched: AttendanceItem = { registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' };

  it('a queued late cancel reads as such while it waits', async () => {
    fetchMock.mockReturnValue(held().promise);
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));
    await screen.findByText('Present · waiting to sync');
    fireEvent.click(await screen.findByRole('button', { name: /mark them cancelled again/i }));

    await screen.findByText('Late cancel · waiting to sync');
    expect(getOutbox().pending['reg-late']?.status).toBe('late_cancel');
  });

  it('gives an inline Dismiss a full-height tap target', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await storeRefusal({ registrationId: 'reg-1' }, 'This class was cancelled.');
    renderList({ items: [untouched] });
    expect(screen.getByRole('button', { name: /^Dismiss: / })).toHaveClass('min-h-11');
  });

  it('labels an untouched registration "Not marked", never "No-show"', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched] });
    screen.getByText('Not marked');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  it('labels a recorded no-show as such', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [{ ...untouched, status: 'no_show' }] });
    screen.getByText('No-show');
  });

  it('shows locked rows without controls until "Edit attendance" is chosen', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched], locked: true });

    screen.getByText('Not marked');
    expect(screen.queryByRole('button', { name: 'Mark Grace Hopper as present' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit attendance' }));

    screen.getByRole('button', { name: 'Mark Grace Hopper as present' });
    screen.getByText('Corrections update the record — the payment request already sent stays as it is.');
  });

  it('shows no edit affordance during check-in', () => {
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched] });
    expect(screen.queryByRole('button', { name: 'Edit attendance' })).toBeNull();
  });

  it('offers no row control outside the attendance sync provider', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[untouched]} classId={CLASS_ID} renderedAt={RENDERED_AT} />);
    screen.getByText('Not marked');
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
  });

  it('marks the student present when the server finds that already recorded', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'reg-late', status: 'attended' }, { outcome: 'unchanged' }));
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [lateCancel] });

    fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

    await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('shows the queued status waiting to sync until the flush confirms', async () => {
    const answer = held();
    fetchMock.mockReturnValueOnce(answer.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched] });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

    await screen.findByText('Present · waiting to sync');
    screen.getByText('1 waiting to sync');
    expect(screen.queryByText('Present')).toBeNull();
    // The checkbox already reflects the queued status.
    screen.getByRole('button', { name: 'Mark Grace Hopper as no-show' });

    await act(async () => {
      answer.release(ok({ id: 'reg-1', status: 'attended' }));
    });

    await screen.findByText('Present');
    expect(screen.queryByText(/waiting to sync/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a confirmation made elsewhere keeps the new status with stale props', async () => {
    const queued = await enqueueAttendance(entry({ status: 'attended' }));
    await settleEntry(queued, { kind: 'confirmed', at: 2000 });
    vi.stubGlobal('fetch', fetchMock);

    renderList({ items: [untouched], renderedAt: 1000 });

    screen.getByText('Present');
    expect(screen.queryByText('Not marked')).toBeNull();
  });

  it('a confirmation older than the render yields to the props', async () => {
    const queued = await enqueueAttendance(entry({ status: 'attended' }));
    await settleEntry(queued, { kind: 'confirmed', at: 500 });
    vi.stubGlobal('fetch', fetchMock);

    // More than a second after the stamp, so not within the `Date` header's resolution.
    renderList({ items: [untouched], renderedAt: 1_700 });

    screen.getByText('Not marked');
    expect(screen.queryByText('Present')).toBeNull();
  });

  it('second tap before the first confirms', async () => {
    const first = held();
    const second = held();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched] });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: 'Mark Grace Hopper as no-show' }));
    // The second status, still pending.
    await screen.findByRole('button', { name: 'Mark Grace Hopper as present' });
    screen.getByText('No-show · waiting to sync');

    await act(async () => {
      first.release(ok({ id: 'reg-1', status: 'attended' }));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.release(ok({ id: 'reg-1', status: 'no_show' }));
    });

    await screen.findByText('No-show');
    expect(sentBodies(fetchMock).at(-1)).toBe(JSON.stringify({ status: 'no_show' }));
    expect(screen.queryByText(/· waiting to sync/)).toBeNull();
  });

  it('pending entry reapplies after remount without a hydration error', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error');
    const { container, onRecoverableError, teardown } = await hydrate({ items: [untouched] }, async () => {
      await enqueueAttendance(entry({ status: 'attended' }));
      resetOutboxForTests();
    });
    try {
      expect(onRecoverableError).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Present · waiting to sync');
      expect(container.textContent).toContain('1 waiting to sync');
    } finally {
      teardown();
    }
  });

  /**
   * A reload is server HTML hydrated: the first client pass reads the empty
   * server snapshot, and only the pass after it reads the stored refusal. A
   * plain `render` reads the stored outbox from its first pass, so it could
   * not tell a refusal seen at mount from one that arrived later.
   */
  it('a stored refusal does not refresh on reload', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await storeRefusal({ registrationId: 'reg-1' }, 'This class was cancelled.');
    const { container, teardown } = await hydrate({ items: [untouched] });
    try {
      expect(refresh).not.toHaveBeenCalled();
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe("Couldn't record Grace Hopper as present: This class was cancelled.");
    } finally {
      teardown();
    }
  });

  it('a refusal for a row no longer in items still shows inline', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await storeRefusal({ registrationId: 'reg-gone', studentName: 'Ada Lovelace' }, 'This booking was cancelled.');
    await storeRefusal(
      { registrationId: 'reg-other', classId: 'class-2', studentName: 'Alan Turing' },
      'This class was cancelled.',
    );

    renderList({ items: [untouched] });

    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toEqual([
      "Couldn't record Ada Lovelace as present: This booking was cancelled.",
    ]);

    fireEvent.click(
      screen.getByRole('button', {
        name: "Dismiss: Couldn't record Ada Lovelace as present: This booking was cancelled.",
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(Object.keys(getOutbox().refused)).toEqual(['reg-other']);
  });

  it('ignores another account’s pending and refused entries for this class', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await storeRefusal({ ownerId: 'acct-2', registrationId: 'reg-2', studentName: 'Ada Lovelace' }, 'Nope.');
    await enqueueAttendance(entry({ ownerId: 'acct-2', status: 'no_show' }));

    renderList({ items: [untouched] });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/waiting to sync/i)).toBeNull();
    expect(screen.getByText('Not marked')).toBeTruthy();
  });

  it('a network failure leaves the row waiting, with no error text', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderList({ items: [untouched] });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });

    screen.getByText('Present · waiting to sync');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Network error/)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(Object.keys(getOutbox().pending)).toEqual(['reg-1']);
  });

  /**
   * The `Date` header has one-second resolution and is truncated, so a write
   * landing in the same second as the render carries a stamp up to 999 ms
   * before `renderedAt`.
   */
  it('keeps a confirmation whose Date header falls in the render’s own second', async () => {
    const second = Math.floor(Date.now() / 1000) * 1000 - 5_000;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'reg-1', status: 'attended' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', date: new Date(second).toUTCString() },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderList({ items: [untouched], renderedAt: second + 700 });

    fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

    await waitFor(() => expect(getOutbox().confirmed['reg-1']?.confirmedAt).toBe(second));
    screen.getByText('Present');
    expect(screen.queryByText('Not marked')).toBeNull();
  });

  /**
   * With Web Locks the outbox write waits for its lock grant, so a second tap
   * can arrive while neither the store nor the render holds the first one.
   * The stub grants each request on a later task, in order, as the real lock
   * manager does.
   */
  it('a second tap while the first waits on the storage lock toggles from the first', async () => {
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: (_name: string, fn: () => Promise<unknown>) =>
          new Promise((resolve) => setTimeout(resolve, 0)).then(fn),
      },
      configurable: true,
    });
    try {
      fetchMock.mockReturnValue(held().promise);
      vi.stubGlobal('fetch', fetchMock);
      renderList({ items: [untouched] });
      const button = screen.getByRole('button', { name: 'Mark Grace Hopper as present' });

      fireEvent.click(button);
      fireEvent.click(button);

      await waitFor(() => expect(getOutbox().pending['reg-1']?.status).toBe('no_show'));
      await screen.findByRole('button', { name: 'Mark Grace Hopper as present' });
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('says so, and logs, when a tap cannot be saved on the device; the next saved tap clears it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(navigator, 'locks', {
      value: { request: () => Promise.reject(new Error('lock unavailable')) },
      configurable: true,
    });
    try {
      fetchMock.mockReturnValue(held().promise);
      vi.stubGlobal('fetch', fetchMock);
      renderList({ items: [untouched] });

      fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("Couldn't save this mark on this device.");
      expect(alert).toHaveClass('text-danger');
      const row = screen.getByText('Grace Hopper');
      expect(row.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith(
        '[attendance-list] request failed',
        expect.objectContaining({ registrationId: 'reg-1' }),
      );
      expect(fetchMock).not.toHaveBeenCalled();

      Reflect.deleteProperty(navigator, 'locks');
      fireEvent.click(screen.getByRole('button', { name: 'Mark Grace Hopper as present' }));
      await screen.findByText('Present · waiting to sync');
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('shows a refusal after the rows, so its arrival moves none of them', async () => {
    vi.stubGlobal('fetch', fetchMock);
    await storeRefusal({ registrationId: 'reg-1' }, 'This class was cancelled.');

    renderList({ items: [untouched] });

    const row = screen.getByText('Grace Hopper');
    const alert = screen.getByRole('alert');
    expect(row.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
