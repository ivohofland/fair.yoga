import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AddWalkIn } from './add-walk-in';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * The picker fetches the whole roster and the whole pending-invitation list
 * and merges them locally — no pagination, no truncation notice, no server
 * round-trip on each keystroke. Both requests are stubbed on one
 * `fetchMock`, routed by URL, since the component issues two GETs per open.
 * Same mocking idiom as `student-directory.test.tsx` otherwise: a
 * shared mock, reset in `afterEach`.
 */
describe('AddWalkIn', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  type ListResult = unknown[] | 'error';

  function stubLists(students: ListResult, invitations: ListResult): void {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/students') {
        if (students === 'error') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: { students } }) };
      }
      if (url === '/api/invitations?status=pending') {
        if (invitations === 'error') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ data: { invitations } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  function openPicker() {
    fireEvent.click(screen.getByText('Add walk-in'));
  }

  it('lists the roster merged with pending invitees, alphabetical, invitees carrying a quiet "· invited" suffix', async () => {
    stubLists(
      [{ id: 's1', displayName: 'Bram V.' }],
      [{ id: 'i1', firstName: 'Anna', lastName: 'Bergsma', email: 'anna@test.local', status: 'pending' }],
    );
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    const select = await screen.findByLabelText('Walk-in student');
    const optionLabels = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels).toEqual(['Choose a student…', 'Anna Bergsma · invited', 'Bram V.']);
  });

  it('posts invitationId for an invitee pick and studentId for a roster pick', async () => {
    stubLists(
      [{ id: 's1', displayName: 'Bram V.' }],
      [{ id: 'i1', firstName: 'Anna', lastName: 'Bergsma' }],
    );
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    const select = (await screen.findByLabelText('Walk-in student')) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'invitation:i1' } });
    fireEvent.click(screen.getByText('Add walk-in', { selector: 'button' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registrations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ classId: 'c1', invitationId: 'i1' }),
        }),
      ),
    );

    fireEvent.change(select, { target: { value: 'student:s1' } });
    fireEvent.click(screen.getByText('Add walk-in', { selector: 'button' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registrations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ classId: 'c1', studentId: 's1' }),
        }),
      ),
    );
  });

  it('posts newContact from the new-person form', async () => {
    stubLists([], []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Dana' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Green' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dana@test.local' } });
    fireEvent.click(screen.getByText('Add new person'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/registrations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            classId: 'c1',
            newContact: { firstName: 'Dana', lastName: 'Green', email: 'dana@test.local' },
          }),
        }),
      ),
    );
  });

  it('disables "Add new person" until first name and email are both filled', async () => {
    stubLists([], []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());

    expect(screen.getByText('Add new person')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Dana' } });
    expect(screen.getByText('Add new person')).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dana@test.local' } });
    expect(screen.getByText('Add new person')).not.toBeDisabled();
  });

  it('shows the server\'s message in the alert region for a 409, whatever its code', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/students') {
        return { ok: true, status: 200, json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }) };
      }
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      if (url === '/api/registrations' && init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: { message: 'This person can\'t be added to your classes.', code: 'WALK_IN_REFUSED' } }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    const select = (await screen.findByLabelText('Walk-in student')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'student:s1' } });
    fireEvent.click(screen.getByText('Add walk-in', { selector: 'button' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This person can\'t be added to your classes.');
  });

  it('does not show a "Not in your students yet?" caption', async () => {
    stubLists([], []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await waitFor(() => expect(screen.getByLabelText('First name')).toBeInTheDocument());

    expect(
      screen.queryByText('Not in your students yet? Add them under Students first.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the roster offered, with its own message, when only the invitations fetch fails', async () => {
    stubLists([{ id: 's1', displayName: 'Anna Bakker' }], 'error');
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your invited contacts.')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Walk-in student')).toBeInTheDocument();
    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Could not load your students.')).not.toBeInTheDocument();
  });

  it('shows a load-failure message and drops the roster from the picker when the roster fetch fails, with no invitees to fall back on', async () => {
    stubLists('error', []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load your invited contacts.')).not.toBeInTheDocument();
  });

  /**
   * The test above alone doesn't pin that invitees are actually offered on a
   * roster failure — an empty invitee list there is indistinguishable from
   * "everything is hidden on any roster failure." A non-empty invitee list
   * is what actually proves the roster's own failure doesn't take the
   * invitations half down with it.
   */
  it('still offers a non-empty invitee list when only the roster fetch fails', async () => {
    stubLists('error', [{ id: 'i1', firstName: 'Anna', lastName: 'Bergsma' }]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Walk-in student')).toBeInTheDocument();
    expect(screen.getByText('Anna Bergsma · invited')).toBeInTheDocument();
    expect(screen.queryByText('Could not load your invited contacts.')).not.toBeInTheDocument();
  });

  /**
   * A load that succeeds once and then fails on a reopen must not leave the
   * earlier open's rows sitting in state, rendered as current beside the new
   * failure message — a list in its `failed` state holds no rows. Covered
   * for both lists: each is fetched and settles independently, so either
   * one's stale-on-reopen bug is invisible to a test that only ever
   * exercises the other.
   */
  it('does not show a stale roster after a reopen whose roster fetch fails', async () => {
    let studentsCall = 0;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      studentsCall += 1;
      if (studentsCall === 1) {
        return { ok: true, status: 200, json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    fireEvent.click(screen.getByText('Close'));
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your students.')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });

  it('does not show a stale invitee list after a reopen whose invitations fetch fails', async () => {
    let invitationsCall = 0;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/students') {
        return { ok: true, status: 200, json: async () => ({ data: { students: [] } }) };
      }
      invitationsCall += 1;
      if (invitationsCall === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { invitations: [{ id: 'i1', firstName: 'Anna', lastName: 'Bergsma' }] } }),
        };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bergsma · invited');

    fireEvent.click(screen.getByText('Close'));
    openPicker();

    await waitFor(() =>
      expect(screen.getByText('Could not load your invited contacts.')).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('Anna Bergsma · invited')).not.toBeInTheDocument();
  });

  it('narrows the options as the teacher types in the filter, matching only the name part', async () => {
    stubLists(
      [{ id: 's1', displayName: 'Bram K.' }],
      [{ id: 'i1', firstName: 'Anna', lastName: 'Bakker' }],
    );
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Bram K.');

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'ann' } });

    expect(screen.getByText('Anna Bakker · invited')).toBeInTheDocument();
    expect(screen.queryByText('Bram K.')).not.toBeInTheDocument();

    // "invited" itself must not spuriously match every invitee row — the
    // filter matches the name part of the label, not the suffix.
    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'invited' } });
    expect(screen.queryByText('Anna Bakker · invited')).not.toBeInTheDocument();
  });

  it('keeps an already-registered student excluded from the options after filtering', async () => {
    stubLists(
      [{ id: 's1', displayName: 'Anna Bakker' }, { id: 's2', displayName: 'Anna Smith' }],
      [],
    );
    render(<AddWalkIn classId="c1" registeredStudentIds={['s1']} />);
    openPicker();
    await screen.findByText('Anna Smith');

    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'anna' } });

    expect(screen.getByText('Anna Smith')).toBeInTheDocument();
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });

  /**
   * The one behaviour in this task that is a genuine bug if missed: without
   * clearing `selected`, a teacher could narrow the list until their chosen
   * option was no longer visible and still submit it — adding someone the
   * UI was no longer showing. The component clears `selected` on every
   * filter keystroke, not only when the selection would actually become
   * hidden — maximally conservative, and trivially safe to verify here.
   */
  it('clears the selection on any filter change, so a hidden selection can never be submitted', async () => {
    stubLists([{ id: 's1', displayName: 'Anna Bakker' }, { id: 's2', displayName: 'Bram K.' }], []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    const select = screen.getByLabelText('Walk-in student') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'student:s1' } });
    expect(select.value).toBe('student:s1');

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'bram' } });

    expect(select.value).toBe('');
    expect(screen.getByText('Add walk-in', { selector: 'button' })).toBeDisabled();
  });

  it('shows a "no student matches" caption instead of an empty select when the filter matches nothing', async () => {
    stubLists([{ id: 's1', displayName: 'Anna Bakker' }], []);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'zzz' } });

    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.getByText('No student matches.')).toBeInTheDocument();
  });

  /**
   * `visible.length === 0` is true the instant the picker opens too, before
   * either fetch resolves — both lists open in `loading`, with no rows. The "No
   * student matches" condition also requires `query` to be truthy, so a
   * *bare* open (no filter typed) never reaches it regardless of the
   * `loaded` gate. Typing a filter before either fetch resolves is what
   * forces the code down this branch and proves `loaded` — which requires
   * BOTH fetches to have settled — is what's keeping it from rendering
   * early.
   */
  it('does not show "No student matches" before both fetches resolve, even with a filter already typed', async () => {
    let resolveStudents!: (value: unknown) => void;
    let resolveInvitations!: (value: unknown) => void;
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url === '/api/students') return new Promise((r) => { resolveStudents = r; });
      if (url === '/api/invitations?status=pending') return new Promise((r) => { resolveInvitations = r; });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'anna' } });

    expect(screen.queryByText('No student matches.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();

    resolveStudents({ ok: true, status: 200, json: async () => ({ data: { students: [] } }) });
    await Promise.resolve();
    await Promise.resolve();
    // Students settled, invitations still pending: still must not render.
    expect(screen.queryByText('No student matches.')).not.toBeInTheDocument();

    resolveInvitations({
      ok: true,
      status: 200,
      json: async () => ({ data: { invitations: [{ id: 'i1', firstName: 'Anna', lastName: 'Bakker' }] } }),
    });

    await waitFor(() => expect(screen.getByText('Anna Bakker · invited')).toBeInTheDocument());
  });

  it('keeps the picker visible after a failed submit — only a failed roster load hides it', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/students') {
        return { ok: true, status: 200, json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }) };
      }
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      if (url === '/api/registrations' && init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: { message: 'This class is full.', code: 'CLASS_FULL' } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    fireEvent.change(screen.getByLabelText('Walk-in student'), { target: { value: 'student:s1' } });
    fireEvent.click(screen.getByText('Add walk-in', { selector: 'button' }));

    await waitFor(() => expect(screen.getByText('This class is full.')).toBeInTheDocument());
    expect(screen.getByLabelText('Walk-in student')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Filter students'), { target: { value: 'zzz' } });
    expect(screen.getByText('No student matches.')).toBeInTheDocument();
  });

  it('closes the picker and refreshes when the pick turns out to be booked already', async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/students') {
        return { ok: true, status: 200, json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }) };
      }
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      if (url === '/api/registrations' && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ data: { id: 'r1', status: 'registered' }, outcome: 'unchanged' }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    fireEvent.change(screen.getByLabelText('Walk-in student'), { target: { value: 'student:s1' } });
    fireEvent.click(screen.getByText('Add walk-in', { selector: 'button' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * A load that fails once and then succeeds on a later refetch — triggered
   * by the effect's `registeredStudentIds` dependency changing identity, not
   * by the teacher closing and reopening the picker — must not leave the
   * earlier failure's message stuck next to the now-current, correctly
   * loaded picker. Deliberately *not* modelled via Close+reopen: the Close
   * button's own handler calls `setError('')`, which would clear a stale
   * `error`-based message on its own and mask exactly the bug this test
   * exists to catch. Re-rendering with a fresh (but content-equal) array is
   * the realistic trigger — the real caller
   * (`/app/(teacher)/class/[id]/(overview)/page.tsx`) hands down a freshly-`.map()`d
   * array on every render, and `LiveUpdates`' `router.refresh()` on any
   * inbound notification is what causes that render while the picker is
   * still open. The message reads the roster's own `failed` state, which
   * the refetch's success replaces, rather than `error` (never reset except
   * by Close) — that is what keeps the two from drifting apart here.
   */
  it('clears the load-failure message once a later refetch succeeds, without closing the picker', async () => {
    let call = 0;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      call += 1;
      if (call === 1) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }) };
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

  /**
   * Routes the roster GET to `first` on its first call and to a held promise
   * on every later one, so a test can look at the picker while a refetch is
   * in flight. Invitations always answer at once with an empty list.
   */
  function stubRosterWithHeldRefetch(first: unknown[]): {
    studentsCalls: () => number;
    release: (students: unknown[]) => void;
  } {
    let calls = 0;
    let releaseHeld: ((value: unknown) => void) | undefined;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === '/api/invitations?status=pending') {
        return { ok: true, status: 200, json: async () => ({ data: { invitations: [] } }) };
      }
      if (url === '/api/students') {
        calls += 1;
        if (calls === 1) {
          return { ok: true, status: 200, json: async () => ({ data: { students: first } }) };
        }
        return new Promise((r) => { releaseHeld = r; });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return {
      studentsCalls: () => calls,
      release: (students) => {
        releaseHeld?.({ ok: true, status: 200, json: async () => ({ data: { students } }) });
      },
    };
  }

  /**
   * A refetch while the picker is open — the `registeredStudentIds` identity
   * change `LiveUpdates`' `router.refresh()` produces — leaves the current
   * options on screen until its own result replaces them, rather than
   * blanking the picker for the length of the request.
   */
  it('keeps the current options on screen while a refetch is pending', async () => {
    const roster = stubRosterWithHeldRefetch([{ id: 's1', displayName: 'Anna Bakker' }]);
    const { rerender } = render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    rerender(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    await waitFor(() => expect(roster.studentsCalls()).toBe(2));

    expect(screen.getByLabelText('Walk-in student')).toBeInTheDocument();
    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();

    roster.release([{ id: 's2', displayName: 'Bram K.' }]);
    await screen.findByText('Bram K.');
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });

  /**
   * The already-registered filter reads the current `registeredStudentIds`
   * at render, so the refresh that registered a student takes them off the
   * picker at once, not when the refetch it triggered comes back.
   */
  it('drops a newly registered student from the options before the refetch resolves', async () => {
    const roster = stubRosterWithHeldRefetch([
      { id: 's1', displayName: 'Anna Bakker' },
      { id: 's2', displayName: 'Bram K.' },
    ]);
    const { rerender } = render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    rerender(<AddWalkIn classId="c1" registeredStudentIds={['s1']} />);
    await waitFor(() => expect(roster.studentsCalls()).toBe(2));

    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
    expect(screen.getByText('Bram K.')).toBeInTheDocument();
  });

  /**
   * Opening the picker starts both lists from loading, so a reopen whose
   * fetch is still in flight offers nothing from the earlier open.
   */
  it('shows no options from an earlier open while a reopen\'s fetch is pending', async () => {
    const roster = stubRosterWithHeldRefetch([{ id: 's1', displayName: 'Anna Bakker' }]);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();
    await screen.findByText('Anna Bakker');

    fireEvent.click(screen.getByText('Close'));
    openPicker();
    await waitFor(() => expect(roster.studentsCalls()).toBe(2));

    expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
  });
});
