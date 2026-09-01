import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NameForm } from './name-form';

/**
 * #400. Tests for student NameForm component.
 */
describe('NameForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch(ok = true, errorJson?: Record<string, unknown>) {
    fetchMock.mockResolvedValue({
      ok,
      json: async () => errorJson ?? {},
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  async function save(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save name/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('renders initial first and last name', () => {
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );
    expect(screen.getByLabelText('First name')).toHaveValue('Anna');
    expect(screen.getByLabelText('Last name')).toHaveValue('Smith');
  });

  it('sends exactly firstName and lastName on save', async () => {
    stubFetch();
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );
    const { url, method, body } = await save();
    expect(url).toBe('/api/students/student-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual(['firstName', 'lastName']);
    expect(body).toEqual({ firstName: 'Anna', lastName: 'Smith' });
  });

  it('sends updated first and last names after typing', async () => {
    stubFetch();
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Annabel' } });
    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Jones' } });
    const { body } = await save();
    expect(body).toEqual({ firstName: 'Annabel', lastName: 'Jones' });
  });

  it('disables save button when first name or last name is empty or whitespace', () => {
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );
    const saveButton = screen.getByRole('button', { name: /save name/i });
    expect(saveButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '' } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: '   ' } });
    expect(saveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anna' } });
    expect(saveButton).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Last name'), { target: { value: '' } });
    expect(saveButton).toBeDisabled();
  });

  it('displays error message when saving fails and clears on input change', async () => {
    stubFetch(false, { error: { message: 'Could not update student' } });
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save name/i }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not update student');
    });

    // Clear on change
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Annamarie' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('displays Saved indicator on success', async () => {
    stubFetch(true);
    render(
      <NameForm
        studentId="student-1"
        initialFirstName="Anna"
        initialLastName="Smith"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /save name/i }));
    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });

    // Clear saved indicator on change
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Annamarie' } });
    expect(screen.queryByText('Saved')).toBeNull();
  });
});
