import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CreateStudentForm } from './create-student-form';

/**
 * #136. This form's body was a one-line literal with `.trim()` on each
 * value, with nothing checking it against `createStudentSchema`. The pins
 * in the source file hold the key set at compile time; this test holds what
 * a pin cannot see, which is what actually reaches the API — including that
 * the trims survive the move into a typed value.
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
    fireEvent.click(screen.getByRole('button', { name: /add student/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /add student/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/first name is required/i)).toBeInTheDocument();
  });
});
