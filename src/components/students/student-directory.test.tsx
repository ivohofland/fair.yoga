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
 * The fixture below is a full name (`'Anna Bakker'`), not an already-truncated
 * one (`'Anna b.'`): a truncated name is a fixed point of `formatStudentName` —
 * composing it again returns it unchanged — so a mutation that reintroduced
 * composition would pass against that fixture for the same reason the
 * original code did. A full name is not a fixed point, so recomposing it
 * (splitting on the first space and re-truncating) changes what renders.
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
        displayName: 'Anna Bakker',
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
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());
  });

  /**
   * Two students who shared an email, one who did not.
   *
   * The assertion is structural, and deliberately so. Counting `@`-bearing
   * text — what this test did before the PR review of #167, under a comment
   * claiming it caught per-row gate removal — cannot catch that removal at
   * any fixture size: deleting the `student.email &&` gate renders
   * `<span>{null}</span>`, an element with no text node, so every text query
   * returns exactly what it did before. Verified by deleting the gate and
   * watching `getAllByText(/@/)).toHaveLength(2)` stay green against this same
   * three-row fixture.
   *
   * What the gate actually decides is whether the name column has one child or
   * two, so that is what this reads. It fails on gate removal (an empty span
   * joins the withholder's column), on the email span disappearing entirely,
   * and on the row recomposing the name it was handed.
   */
  it('renders an email row only for the students who shared one', async () => {
    stubStudents([
      {
        id: 'student-1',
        displayName: 'Anna Bakker',
        email: 'anna@example.com',
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 3,
        overduePayments: 0,
      },
      {
        id: 'student-2',
        displayName: 'Bob c.',
        email: 'bob@example.com',
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 1,
        overduePayments: 0,
      },
      {
        id: 'student-3',
        displayName: 'Carla d.',
        email: null,
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 2,
        overduePayments: 0,
      },
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    // The name column is the row link's first child: a name span, plus an
    // email span only for the students who shared one.
    const nameColumn = (row: HTMLElement) =>
      Array.from(row.firstElementChild!.children).map((el) => el.textContent);

    expect(screen.getAllByRole('link').map(nameColumn)).toEqual([
      ['Anna Bakker', 'anna@example.com'],
      ['Bob c.', 'bob@example.com'],
      ['Carla d.'],
    ]);
  });
});
