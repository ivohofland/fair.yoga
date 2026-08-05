import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush } from '../../../tests/setup/components';
import { CreateStudentForm } from './create-student-form';

/**
 * #136. This form's body was a one-line literal with `.trim()` on each
 * value, with nothing checking it against the route's schema
 * (`createInvitationSchema` since #166). The pins in the source file hold the
 * key set at compile time; this test holds what a pin cannot see, which is
 * what actually reaches the API — including that the trims survive the move
 * into a typed value.
 *
 * Nothing fetches on mount, so the submit is the first (and only) call.
 */
describe('CreateStudentForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'student-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function fillForm(firstName: string, lastName: string, email: string) {
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: firstName } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: lastName } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  }

  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all three fields', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('Ada', 'Lovelace', 'ada@example.com');
    const { url, method, body } = await submit();
    expect(url).toBe('/api/students');
    expect(method).toBe('POST');
    expect(body).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
  });

  /**
   * Whole-branch review. The submit used to push straight to `/students`,
   * where the new row appears in a Contacts section below an unchanged
   * student directory — so the whole flow read as a failure. It confirms in
   * place now, and the teacher leaves when they choose to.
   */
  it('confirms in place, naming the address, rather than redirecting on submit', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('Ada', 'Lovelace', 'ada@example.com');
    await submit();
    expect(await screen.findByText(/invitation sent/i)).toBeInTheDocument();
    expect(screen.getByText(/ada@example\.com/)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  // #166. `id` in the response is an Invitation's, so the old
  // `/students/${id}` push landed on a student detail page that will never
  // resolve. Pinned on the literal, not merely on "push was called": the
  // stub still answers `{ data: { id: 'student-1' } }`, so a regression that
  // interpolates it again would produce `/students/student-1` — a plausible
  // enough URL to pass any looser assertion.
  it('leaves for the directory, not for a student page, when Done is pressed', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('Ada', 'Lovelace', 'ada@example.com');
    await submit();
    fireEvent.click(await screen.findByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
    expect(routerPush).toHaveBeenCalledTimes(1);
  });

  it('add another clears the form and sends a second invitation', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('Ada', 'Lovelace', 'ada@example.com');
    await submit();
    fireEvent.click(await screen.findByRole('button', { name: /add another/i }));

    // Cleared, not carrying the previous invitee's details into the next.
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');

    fillForm('Grace', 'Hopper', 'grace@example.com');
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as { body: string }).body,
    ) as Record<string, unknown>;
    expect(secondBody.email).toBe('grace@example.com');
  });

  it('trims all three fields before sending', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('  Ada  ', '  Lovelace  ', '  ada@example.com  ');
    const { body } = await submit();
    expect(body).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
    });
  });

  it('sends an empty last name as an empty string', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('Ada', '', 'ada@example.com');
    const { body } = await submit();
    expect(body.lastName).toBe('');
  });

  it('rejects a missing first name before any request is sent', async () => {
    stubFetch();
    render(<CreateStudentForm />);
    fillForm('', '', 'ada@example.com');
    fireEvent.click(screen.getByRole('button', { name: /send invitation/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/first name is required/i)).toBeInTheDocument();
  });
});
