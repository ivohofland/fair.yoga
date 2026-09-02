import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AddWalkIn } from './add-walk-in';

/**
 * #176 deleted `GET /api/students`'s pagination, and with it the picker's
 * 50-student cap — a real reachability bug, not just cleanup: this picker and
 * the public booking flow are the only two components that create a
 * registration, and `/students/[id]` offers no "add to class" control, so a
 * teacher with 51+ students had no way at all to add their 51st. The picker
 * now fetches the full roster and filters it locally.
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
   * UI was no longer showing.
   */
  it('clears the selection when a filter change hides the currently selected student', async () => {
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
});
