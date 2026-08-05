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

  it('renders an email row only for the student who shared it', async () => {
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
        email: null,
        phone: null,
        birthday: null,
        address: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        lastClassDate: null,
        classCount: 1,
        overduePayments: 0,
      },
    ]);
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

    // Anna shared her email — it renders.
    expect(screen.getByText('anna@example.com')).toBeInTheDocument();
    // Bob withheld his — his row renders, but no address does. Checking the
    // total count of `@`-bearing text (rather than just `queryByText` with a
    // single-row fixture) is what makes this fail if the component stopped
    // gating per-row instead of merely deleting the email span outright: a
    // one-row fixture can't tell "never renders an email" apart from
    // "correctly withheld this one".
    expect(screen.getByText('Bob c.')).toBeInTheDocument();
    expect(screen.getAllByText(/@/)).toHaveLength(1);
  });
});
