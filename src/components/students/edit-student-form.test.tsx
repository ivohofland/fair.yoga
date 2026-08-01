import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditStudentForm } from './edit-student-form';

/**
 * #136. This form pins against `createStudentSchema`, not
 * `updateStudentSchema` — it is the teacher-facing CRM path, and
 * `PUT /api/students/[id]` branches on caller identity, not method. See the
 * pin's comment in the source file. Both directions apply here: the form
 * owns its branch's schema outright, three keys mapped to three inputs. This
 * test holds what the pin cannot see, which is what actually reaches the
 * API — including that the trims survive the move into the request body.
 *
 * Nothing fetches on mount, so the submit is the first (and only) call.
 */
describe('EditStudentForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
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

  it('sends exactly firstName, lastName and email', async () => {
    stubFetch();
    render(
      <EditStudentForm
        studentId="student-1"
        initialFirstName="Ada"
        initialLastName="Lovelace"
        initialEmail="ada@example.com"
      />,
    );
    fillForm('Grace', 'Hopper', 'grace@example.com');
    const { url, method, body } = await submit();
    expect(url).toBe('/api/students/student-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual(['email', 'firstName', 'lastName']);
    expect(body).toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
    });
  });

  it('trims all three fields before sending', async () => {
    stubFetch();
    render(
      <EditStudentForm
        studentId="student-1"
        initialFirstName="Ada"
        initialLastName="Lovelace"
        initialEmail="ada@example.com"
      />,
    );
    fillForm('  Grace  ', '  Hopper  ', '  grace@example.com  ');
    const { body } = await submit();
    expect(body).toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@example.com',
    });
  });

  it('rejects a missing first name before any request is sent', async () => {
    stubFetch();
    render(
      <EditStudentForm
        studentId="student-1"
        initialFirstName="Ada"
        initialLastName="Lovelace"
        initialEmail="ada@example.com"
      />,
    );
    fillForm('', 'Hopper', 'grace@example.com');
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/first name and email are required/i)).toBeInTheDocument();
  });
});
