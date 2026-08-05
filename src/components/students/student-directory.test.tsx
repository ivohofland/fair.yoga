import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StudentDirectory } from './student-directory';

/**
 * The directory renders whatever name the API hands it. Before #167 it
 * re-truncated an already-truncated surname through `formatStudentName`, which
 * was correct only because that composition happens to be idempotent — nothing
 * tested it, and a future call site had no way to know. The API now sends one
 * composed `displayName`; this pins that the component stopped composing.
 *
 * Same mocking idiom as `contact-list.test.tsx`: a shared `fetchMock`, stubbed
 * per test via a helper, reset in `afterEach`.
 */
describe('StudentDirectory', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubStudents(students: unknown[]): void {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { students, total: students.length, page: 1, pageSize: 20 },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('renders the name the API composed, without recomposing it', async () => {
    stubStudents([
      {
        id: 'student-1',
        displayName: 'Anna b.',
        email: null,
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 3,
        overduePayments: 0,
      },
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna b.')).toBeInTheDocument());
  });

  it('renders no email row when the student withheld it', async () => {
    stubStudents([
      {
        id: 'student-1',
        displayName: 'Anna b.',
        email: null,
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 3,
        overduePayments: 0,
      },
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna b.')).toBeInTheDocument());
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});
