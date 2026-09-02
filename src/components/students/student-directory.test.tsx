import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
      json: async () => ({ data: { students } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  // Fixture builder for the search/pagination tests below: only `id`,
  // `displayName` and `email` vary per case, the rest is filler the
  // component renders but these tests don't assert on.
  function student(overrides: { id: string; displayName: string; email?: string | null }) {
    return {
      email: null,
      phone: null,
      birthday: null,
      address: null,
      claimedAt: '2026-01-01T00:00:00.000Z',
      lastClassDate: null,
      classCount: 1,
      overduePayments: 0,
      ...overrides,
    };
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

  /**
   * Search and pagination now happen entirely client-side, over the list
   * the server already sent — see `student-directory.tsx`. The fetch mock
   * above returns everything in one response; these tests type into the
   * search box and check what's on screen, with no further fetch calls to
   * stub.
   */
  it('narrows the list on a first-name fragment', async () => {
    stubStudents([
      student({ id: 'student-1', displayName: 'Anna Bakker' }),
      student({ id: 'student-2', displayName: 'Bram k.' }),
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'ann' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();
  });

  it('finds a student on a shared surname fragment', async () => {
    stubStudents([
      student({ id: 'student-1', displayName: 'Anna Bakker' }),
      student({ id: 'student-2', displayName: 'Bram k.' }),
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'bakker' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();
  });

  /**
   * The privacy property: 'Bram k.' is what the server sent for a student
   * who withheld his surname — 'kramer' is nowhere in the response for this
   * test to match. This isn't extra filtering logic holding the line; it's
   * that the data literally isn't there.
   */
  it('finds nothing when searching a withheld surname', async () => {
    stubStudents([
      student({ id: 'student-1', displayName: 'Anna Bakker' }),
      student({ id: 'student-2', displayName: 'Bram k.' }),
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'kramer' } });

    expect(screen.queryByText('Anna Bakker')).not.toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();
    expect(screen.getByText(`No students matching 'kramer'.`)).toBeInTheDocument();
  });

  /**
   * The composed-name case: a query spanning first and last name segments
   * ("anna b") matches 'Anna Bakker' because the whole composed string is
   * searched as one, not first/last name fields independently. No
   * server-side search over raw `firstName`/`lastName` columns could offer
   * this without also being able to answer with a withheld surname, which
   * is exactly the oracle #176 removed.
   */
  it('matches a composed name spanning first and last name', async () => {
    stubStudents([
      student({ id: 'student-1', displayName: 'Anna Bakker' }),
      student({ id: 'student-2', displayName: 'Bram k.' }),
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'anna b' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'anna bakker' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Bram k.')).not.toBeInTheDocument();
  });

  it('matches an email fragment, and never matches a withheld (null) email', async () => {
    stubStudents([
      student({ id: 'student-1', displayName: 'Anna Bakker', email: 'anna@example.com' }),
      student({ id: 'student-2', displayName: 'Carla d.', email: null }),
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'example.com' } });

    expect(screen.getByText('Anna Bakker')).toBeInTheDocument();
    expect(screen.queryByText('Carla d.')).not.toBeInTheDocument();
  });

  it('paginates more than PAGE_SIZE rows, and hides the pager once a search narrows below it', async () => {
    const students = Array.from({ length: 25 }, (_, i) =>
      student({
        id: `student-${i + 1}`,
        displayName: `Student ${String(i + 1).padStart(2, '0')}`,
      }),
    );
    stubStudents(students);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Student 01')).toBeInTheDocument());

    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search students'), { target: { value: 'Student 01' } });

    expect(screen.getByText('Student 01')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });
});
