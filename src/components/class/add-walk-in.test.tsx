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
   * `visible.length === 0` is also true the instant the picker opens, before
   * the fetch resolves — every single time, not just on a genuine empty
   * filter match. Without a `loaded` gate, this state briefly (or, with a
   * slow/never-resolving fetch, indefinitely) shows "No student matches."
   * before there is any roster to judge.
   */
  it('does not show "No student matches" before the roster fetch resolves', async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
    openPicker();

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
});
