import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush, routerRefresh } from '../../../tests/setup/components';
import { ContactForm, ArchiveContactButton } from './contact-form';

/**
 * #166. `ContactForm` pins against `updateInvitationSchema` (see the source
 * file's `#136` comment) — this test holds what the pin cannot see, which is
 * what actually reaches `PUT /api/invitations/[id]`: a declined contact's
 * PUT 409s with `DECLINED_IS_PERMANENT`, and that specific message — not a
 * generic retry prompt — is what must reach the screen. The precedent is
 * `teacher-privacy-card.tsx:75-84`'s own handling of its 403.
 *
 * Nothing fetches on mount, so the first submit/toggle is the only call.
 */
describe('ContactForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubOk(): void {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { id: 'inv-1' } }) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function renderForm() {
    render(
      <ContactForm
        invitationId="inv-1"
        initialFirstName="Lena"
        initialLastName="Visser"
        initialEmail="lena@example.com"
      />,
    );
  }

  function fillForm(firstName: string, lastName: string, email: string) {
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: firstName } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: lastName } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  }

  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends exactly firstName, lastName and email to /api/invitations/:id', async () => {
    stubOk();
    renderForm();
    fillForm('Lena', 'de Vries', 'lena@newmail.com');
    const { url, method, body } = await submit();
    expect(url).toBe('/api/invitations/inv-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual(['email', 'firstName', 'lastName']);
    expect(body).toEqual({ firstName: 'Lena', lastName: 'de Vries', email: 'lena@newmail.com' });
  });

  it('trims all three fields before sending', async () => {
    stubOk();
    renderForm();
    fillForm('  Lena  ', '  Visser  ', '  lena@example.com  ');
    const { body } = await submit();
    expect(body).toEqual({ firstName: 'Lena', lastName: 'Visser', email: 'lena@example.com' });
  });

  it('refreshes the page on success rather than navigating away', async () => {
    stubOk();
    renderForm();
    await submit();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('rejects a missing first name before any request is sent', async () => {
    stubOk();
    renderForm();
    fillForm('', 'Visser', 'lena@example.com');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/first name and email are required/i)).toBeInTheDocument();
  });

  function stubDeclined(): void {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'This person declined. You can archive this contact, but it cannot be removed.',
          code: 'DECLINED_IS_PERMANENT',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('surfaces the DECLINED_IS_PERMANENT message verbatim, not a generic retry prompt', async () => {
    stubDeclined();
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(
      await screen.findByText(
        'This person declined. You can archive this contact, but it cannot be removed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Failed to update contact')).toBeNull();
  });

  function stubServerErrorWithNoBody(): void {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('falls back to a generic message when the server sends none', async () => {
    stubServerErrorWithNoBody();
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText('Failed to update contact')).toBeInTheDocument();
  });
});

/**
 * `ArchiveContactButton` has no file of its own — it lives in
 * `contact-form.tsx` because Task 9's plan allots no separate one, and its
 * only render site (`/students/contacts/[id]/page.tsx`) is a server
 * component that cannot hold the click handler. Same query-param idiom as
 * `archive-student-button.test.tsx` pins for its sibling; copied here so a
 * broken idiom in either fails its own suite.
 */
describe('ArchiveContactButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubOk(): void {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends state=archived when the contact is not archived', async () => {
    stubOk();
    render(<ArchiveContactButton invitationId="inv-1" isArchived={false} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1?state=archived', {
        method: 'PATCH',
      }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
  });

  it('sends state=unarchived when the contact is archived', async () => {
    stubOk();
    render(<ArchiveContactButton invitationId="inv-1" isArchived={true} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1?state=unarchived', {
        method: 'PATCH',
      }),
    );
  });
});
