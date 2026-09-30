import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ContactDetailsForm } from './contact-details-form';

describe('Input and Textarea hint', () => {
  it('names both the hint and the error in aria-describedby, and both ids exist', () => {
    render(
      <>
        <Input label="Field one" id="one" hint="A hint" error="An error" />
        <Textarea label="Field two" id="two" hint="A hint" error="An error" />
      </>,
    );
    for (const label of ['Field one', 'Field two']) {
      const field = screen.getByLabelText(label);
      const ids = (field.getAttribute('aria-describedby') ?? '').split(' ');
      expect(ids).toHaveLength(2);
      for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
      expect(field).toHaveAttribute('aria-invalid', 'true');
    }
  });

  // A caller's own description joins the computed ids instead of replacing
  // them, which would silently cut the field off from its error.
  it('keeps a caller aria-describedby alongside the hint and error ids', () => {
    render(
      <>
        <Input label="Field one" id="one" error="An error" aria-describedby="extra" />
        <Textarea label="Field two" id="two" error="An error" aria-describedby="extra" />
      </>,
    );
    for (const label of ['Field one', 'Field two']) {
      const ids = (screen.getByLabelText(label).getAttribute('aria-describedby') ?? '').split(' ');
      expect(ids).toContain('extra');
      expect(ids.some((id) => id.endsWith('-error'))).toBe(true);
    }
  });

  it('leaves aria-describedby off when there is neither hint nor error', () => {
    render(<Textarea label="Plain" id="plain" />);
    expect(screen.getByLabelText('Plain')).not.toHaveAttribute('aria-describedby');
  });
});

describe('ContactDetailsForm', () => {
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

  function renderForm() {
    return render(
      <ContactDetailsForm
        studentId="student-1"
        initialPhone="+31 6 1234 5678"
        initialBirthday="1990-04-17"
        initialAddress={'Straat 1\n1011 AB Amsterdam'}
      />,
    );
  }

  function clickSave() {
    fireEvent.click(screen.getByRole('button', { name: 'Save contact details' }));
  }

  it('renders the initial values, the address in a textarea', () => {
    renderForm();
    expect(screen.getByLabelText('Phone')).toHaveValue('+31 6 1234 5678');
    expect(screen.getByLabelText('Birthday')).toHaveValue('1990-04-17');
    const address = screen.getByLabelText('Address');
    expect(address).toHaveValue('Straat 1\n1011 AB Amsterdam');
    expect(address.tagName).toBe('TEXTAREA');
    expect(screen.getByRole('textbox', { name: 'Address' }).tagName).toBe('TEXTAREA');
  });

  it('sends exactly phone, birthday and address, trimmed, a cleared field as an empty string', async () => {
    stubFetch();
    renderForm();
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '  +31 6 0000 0000  ' } });
    fireEvent.change(screen.getByLabelText('Birthday'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '  Laan 2  ' } });
    clickSave();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    expect(url).toBe('/api/students/student-1');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({
      phone: '+31 6 0000 0000',
      birthday: '',
      address: 'Laan 2',
    });
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Phone')).toHaveValue('+31 6 0000 0000');
    expect(screen.getByLabelText('Address')).toHaveValue('Laan 2');
  });

  it('renders a field-prefixed 400 against that field, not as a banner', async () => {
    stubFetch(false, {
      error: { message: 'birthday: Birthday must be a real date (YYYY-MM-DD)' },
    });
    renderForm();
    clickSave();
    await waitFor(() => {
      expect(screen.getByText('Birthday must be a real date (YYYY-MM-DD)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Birthday')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Birthday')).toHaveFocus();
    expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-invalid');
    // The field's own message is the only alert; no form-level banner.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').tagName).toBe('SPAN');
  });

  it('marks every field a multi-issue 400 names, and leaves the banner empty', async () => {
    stubFetch(false, { error: { message: 'phone: Phone A, address: Address B' } });
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByText('Phone A')).toBeInTheDocument());
    expect(screen.getByText('Address B')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Phone')).toHaveFocus();
    expect(screen.getAllByRole('alert').every((el) => el.tagName === 'SPAN')).toBe(true);
  });

  it('renders a 400 without a field prefix in the form-level banner', async () => {
    stubFetch(false, { error: { message: 'Could not save right now' } });
    renderForm();
    clickSave();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Could not save right now');
    });
    expect(screen.getByRole('alert').tagName).toBe('P');
    expect(screen.getByLabelText('Birthday')).not.toHaveAttribute('aria-invalid');
  });

  it('editing a field clears its error and the Saved notice', async () => {
    stubFetch(false, { error: { message: 'phone: Phone is not valid' } });
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByText('Phone is not valid')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+31 6 1' } });
    expect(screen.queryByText('Phone is not valid')).toBeNull();
    expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-invalid');

    stubFetch(true);
    clickSave();
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Elsewhere' } });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('refuses a half-typed birthday before sending anything', () => {
    stubFetch();
    renderForm();
    const birthday = screen.getByLabelText('Birthday');
    Object.defineProperty(birthday, 'validity', { value: { badInput: true } });
    clickSave();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a full date, or clear the field')).toBeInTheDocument();
    expect(birthday).toHaveAttribute('aria-invalid', 'true');
    expect(birthday).toHaveFocus();
  });

  it('focuses the field a server refusal names, whichever it is', async () => {
    stubFetch(false, { error: { message: 'address: Address is too long' } });
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByText('Address is too long')).toBeInTheDocument());
    expect(screen.getByLabelText('Address')).toHaveFocus();
  });

  it('a half-typed birthday clears a stale banner and the Saved notice', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error'));
    logged.mockRestore();

    Object.defineProperty(screen.getByLabelText('Birthday'), 'validity', {
      value: { badInput: true },
    });
    clickSave();
    expect(screen.queryByText('Network error. Try again.')).toBeNull();
    expect(screen.getByText('Enter a full date, or clear the field')).toBeInTheDocument();
  });

  it('a half-typed birthday clears a Saved notice from the save before', async () => {
    stubFetch();
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());

    // A half-typed date fires no onChange, so nothing but the submit clears it.
    Object.defineProperty(screen.getByLabelText('Birthday'), 'validity', {
      value: { badInput: true },
    });
    clickSave();
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('editing a field clears the form-level banner', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error'));
    logged.mockRestore();
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+31 6 2' } });
    expect(screen.queryByText('Network error. Try again.')).toBeNull();
  });

  it('a new save drops field errors from the one before, edited or not', async () => {
    stubFetch(false, { error: { message: 'phone: Phone is not valid' } });
    renderForm();
    clickSave();
    await waitFor(() => expect(screen.getByText('Phone is not valid')).toBeInTheDocument());

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    clickSave();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error'));
    logged.mockRestore();
    expect(screen.queryByText('Phone is not valid')).toBeNull();
  });

  it('shows a message that only mentions a field later on as a banner, whole', async () => {
    stubFetch(false, { error: { message: 'Something went wrong, phone: X' } });
    renderForm();
    clickSave();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong, phone: X');
    });
    expect(screen.getByLabelText('Phone')).not.toHaveAttribute('aria-invalid');
  });

  describe('an edit made while the save is in flight', () => {
    function deferFetch() {
      let release!: (value: unknown) => void;
      fetchMock.mockReturnValue(new Promise((resolve) => (release = resolve)));
      vi.stubGlobal('fetch', fetchMock);
      return (value: unknown) => release(value);
    }

    it('survives the success, which then claims no Saved', async () => {
      const release = deferFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '222' } });
      clickSave();
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '2223' } });
      release({ ok: true, json: async () => ({}) });
      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.getByLabelText('Phone')).toHaveValue('2223');
      expect(screen.queryByText('Saved')).toBeNull();
    });

    it('is not marked with the error for the value it replaced', async () => {
      const release = deferFetch();
      renderForm();
      clickSave();
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '+31 6 3' } });
      release({
        ok: false,
        json: async () => ({ error: { message: 'phone: Phone A, address: Address B' } }),
      });
      await waitFor(() => expect(screen.getByText('Address B')).toBeInTheDocument());
      expect(screen.queryByText('Phone A')).toBeNull();
      expect(screen.getByLabelText('Address')).toHaveFocus();
    });
  });

  it('points the Birthday field at its hint', () => {
    renderForm();
    const birthday = screen.getByLabelText('Birthday');
    const hintId = (birthday.getAttribute('aria-describedby') ?? '').split(' ')[0] ?? '';
    expect(document.getElementById(hintId)).toHaveTextContent(
      'Share it per teacher under Privacy — as your birthday (day and month), your age, or both.',
    );
  });

  it('tells the student when fetch itself fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    clickSave();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Network error. Try again.');
    });
    expect(logged).toHaveBeenCalledWith('[contact-details-form] request failed', {
      err: expect.any(Error),
    });
    logged.mockRestore();
  });
});
