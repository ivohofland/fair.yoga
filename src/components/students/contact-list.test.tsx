import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ContactList } from './contact-list';

/**
 * #166. `contact-list.tsx` fetches `/api/invitations` directly — nothing in
 * `tests/setup/components.ts` stubs `fetch`, so every test here supplies its
 * own response, same pattern as `create-student-form.test.tsx`.
 */
describe('ContactList', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubInvitations(invitations: unknown[]): void {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { invitations, total: invitations.length } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('fetches /api/invitations', async () => {
    stubInvitations([]);
    render(<ContactList />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/invitations'));
  });

  it('renders one row per contact, with status as plain text', async () => {
    stubInvitations([
      { id: 'inv-1', firstName: 'Lena', lastName: 'Visser', email: 'lena@example.com', status: 'pending' },
      { id: 'inv-2', firstName: 'Nadia', lastName: 'Bakker', email: 'nadia@example.com', status: 'declined' },
    ]);
    render(<ContactList />);

    expect(await screen.findByText('Lena Visser')).toBeInTheDocument();
    expect(screen.getByText('Nadia Bakker')).toBeInTheDocument();

    // Text nodes, not `role="status"` or a badge component — this design
    // system renders relationship state as words (the ✓ Paid / ○ Unpaid
    // precedent), not as a colored pill the way class-card badges do.
    const invited = screen.getByText('Invited');
    const declined = screen.getByText('Declined');
    expect(invited.tagName).toBe('SPAN');
    expect(declined.tagName).toBe('SPAN');
  });

  it('links each row to its contact detail page', async () => {
    stubInvitations([
      { id: 'inv-1', firstName: 'Lena', lastName: 'Visser', email: 'lena@example.com', status: 'pending' },
    ]);
    render(<ContactList />);

    const row = await screen.findByText('Lena Visser');
    const link = row.closest('a');
    expect(link).toHaveAttribute('href', '/students/contacts/inv-1');
  });

  // #166: an `accepted` invitation is a person who is now a real student —
  // `resolveInvitationOnLink`/`acceptInvitation` already put them in
  // `TeacherStudent`, so `StudentDirectory` is where they render. The API
  // does not filter this (only `isArchived`), so the component must: this
  // is the guard that keeps a linked student off both lists' opposite, not
  // the same person listed twice under two different labels.
  it('does not list an accepted invitation', async () => {
    stubInvitations([
      { id: 'inv-1', firstName: 'Lena', lastName: 'Visser', email: 'lena@example.com', status: 'pending' },
      { id: 'inv-2', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', status: 'accepted' },
    ]);
    render(<ContactList />);

    await screen.findByText('Lena Visser');
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('shows the empty state when there are no contacts', async () => {
    stubInvitations([]);
    render(<ContactList />);
    expect(await screen.findByText('No contacts yet.')).toBeInTheDocument();
  });

  // Same reasoning as `student-directory.tsx`'s equivalent branch: an
  // expired session answers 401 to every teacher-scoped GET, and this list
  // has to leave the page rather than render as though it were merely empty.
  it('redirects to /login on a 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal('fetch', fetchMock);

    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, href: '' },
    });

    render(<ContactList />);

    await waitFor(() => expect(window.location.href).toBe('/login'));

    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });
});
