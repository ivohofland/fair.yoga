import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AddWalkIn } from './add-walk-in';

/**
 * The picker fetches the full roster and filters it locally — no pagination,
 * no truncation notice, no server round-trip on each keystroke.
 *
 * Same mocking idiom as `student-directory.test.tsx`: a shared `fetchMock`,
 * stubbed per test, reset in `afterEach`.
 */
describe('AddWalkIn', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubStudents(students: unknown[]): void {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { students } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  function openPicker() {
    fireEvent.click(screen.getByText('Add walk-in'));
  }

  it('lists every student the response carries, with no truncation notice and no pageSize in the request URL', async () => {
    stubStudents([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Bram k.' },
      { id: 's3', displayName: 'Carla d.' },
    ]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());
    expect(screen.getByText('Bram k.')).toBeInTheDocument();
    expect(screen.getByText('Carla d.')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith('/api/students');
    expect(screen.queryByText(/Showing your first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/find the rest under Students/)).not.toBeInTheDocument();
  });

  it('narrows the options as the teacher types in the filter', async () => {
    stubStudents([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Bram k.' },
    ]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'ann' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();
  });

  it('keeps an already-registered student excluded from the options after filtering', async () => {
    stubStudents([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Anna Smith' },
    ]);
    render(<AddWalkIn classId="c1" registeredStudentIds={['s1']} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Smith')).toBeInTheDocument());

    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'anna' } });

    expect(screen.getByText('Anna Smith')).toBeInTheDocument();
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });

  /**
   * The one behaviour in this task that is a genuine bug if missed: without
   * clearing `selected`, a teacher could narrow the list until their chosen
   * student was no longer visible and still submit them — adding someone the
   * UI was no longer showing. The component clears `selected` on every
   * filter keystroke, not only when the selection would actually become
   * hidden — maximally conservative, and trivially safe to verify here.
   */
  it('clears the selection on any filter change, so a hidden selection can never be submitted', async () => {
    stubStudents([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Bram k.' },
    ]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    const select = screen.getByLabelText('Walk-in student') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 's1' } });
    expect(select.value).toBe('s1');

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'bram' } });

    expect(select.value).toBe('');
    expect(screen.getByText('Add walk-in')).toBeDisabled();
  });

  it('shows a "no student matches" caption instead of an empty select when the filter matches nothing', async () => {
    stubStudents([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Bram k.' },
    ]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'zzz' } });

    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.getByText('No student matches.')).toBeInTheDocument();
    expect(
      screen.getByText('Not in your students yet? Add them under Students first.'),
    ).toBeInTheDocument();
  });

  /**
   * `visible.length === 0` is true the instant the picker opens too, before
   * the fetch resolves — `students` starts `[]`. The "No student matches"
   * condition also requires `query` to be truthy, so a *bare* open (no
   * filter typed) never reaches it regardless of the `loaded` gate — that
   * would pass even with the gate deleted, and would not actually be
   * pinning it. Typing a filter before the fetch resolves is what makes
   * `visible.length === 0 && query` true while still loading, which is the
   * only way to force the code down this branch and prove the `loaded`
   * gate is what's keeping it from rendering.
   */
  it('does not show "No student matches" before the roster fetch resolves, even with a filter already typed', async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'anna' } });

    expect(screen.queryByText('No student matches.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();

    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }),
    });

    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());
  });

  /**
   * A genuinely empty roster (no filter typed) is not a filter mismatch —
   * "No student matches." would misstate why the select is missing. Only the
   * "Add them under Students first" caption, already correct for this case,
   * should show.
   */
  it('shows "Add them under Students first" instead of "No student matches" for an empty roster', async () => {
    stubStudents([]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() =>
      expect(
        screen.getByText('Not in your students yet? Add them under Students first.'),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('No student matches.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
  });

  /**
   * A failed submit sets `error` (`handleAdd`'s catch/else); a failed roster
   * *load* sets the independent `loadFailed`. Gating the Select on `!error`
   * (rather than the load-only `loadFailed`) would hide the picker the
   * moment a submit failed, taking away the control the teacher needs to
   * retry. The trailing filter-to-"zzz" step is what actually pins this: an
   * untyped-filter "No student matches." assertion passes regardless of
   * which gate is used (nothing empties `visible` without a filter), so it
   * would not fail under the bug this test exists to catch.
   */
  it('keeps the picker visible after a failed submit — only a failed roster load hides it', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/students') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }),
        };
      }
      if (url === '/api/registrations' && init?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ error: 'Class is full.' }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Walk-in student'), { target: { value: 's1' } });
    fireEvent.click(screen.getByText('Add walk-in'));

    await waitFor(() => expect(screen.getByText('Class is full.')).toBeInTheDocument());
    expect(screen.getByLabelText('Walk-in student')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'zzz' } });
    expect(screen.getByText('No student matches.')).toBeInTheDocument();
  });

  /**
   * `loadFailed` is what the whole `error`/`loadFailed` split exists to
   * preserve: a failed roster load must still hide the picker. `error`
   * itself is untouched by a load failure now (see the message-lockstep
   * note on `loadFailed`'s declaration), so the failure message here comes
   * from the `loadFailed`-gated paragraph, not `error`.
   */
  it('shows a load-failure message and hides the picker when the roster fetch fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('No student matches.')).not.toBeInTheDocument();
  });

  /**
   * A load failure's `.catch` never clears `students`, so a reopen that
   * fails after an earlier successful load leaves stale roster data sitting
   * in state. Only `loadFailed` keeps that stale roster off the screen —
   * without it, the Select would render the previous (now unverified)
   * roster underneath a message telling the teacher the load just failed.
   */
  it('does not show a stale roster after a reopen whose load fails', async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Close'));
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });

  /**
   * The mirror case: a load that fails once and then succeeds on a later
   * refetch — triggered by the effect's `registeredStudentIds` dependency
   * changing identity, not by the teacher closing and reopening the picker
   * — must not leave the earlier failure's message stuck next to the
   * now-current, correctly loaded picker. Deliberately *not* modelled via
   * Close+reopen: the Close button's own handler calls `setError('')`,
   * which would clear a stale `error`-based message on its own and mask
   * exactly the bug this test exists to catch. Re-rendering with a fresh
   * (but content-equal) array is the realistic trigger — the real caller
   * (`/app/(teacher)/class/[id]/page.tsx`) hands down a freshly-`.map()`d
   * array on every render, and `LiveUpdates`' `router.refresh()` on any
   * inbound notification is what causes that render while the picker is
   * still open. Tying the message to `loadFailed` (reset every effect run)
   * rather than `error` (never reset except by Close) is what keeps the two
   * from drifting apart here.
   */
  it('clears the load-failure message once a later refetch succeeds, without closing the picker', async () => {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );

    rerender(<AddWalkIn classId="c1" registeredStudentIds={[]} />);

    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());
    expect(screen.queryByText('Could not load your students.')).not.toBeInTheDocument();
  });
});
