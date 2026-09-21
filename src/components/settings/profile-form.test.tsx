import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { ProfileForm } from './profile-form';

const initial = {
  firstName: 'Anna',
  lastName: 'de Vries',
  email: 'anna@example.com',
  bio: 'Slow flow on Tuesdays.',
  pageSlug: 'anna',
  defaultCurrency: 'EUR',
  defaultTimezone: 'Europe/Amsterdam',
  defaultReminder: 'morning_of',
  bankIban: null,
  bankAccountName: null,
};

describe('ProfileForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderForm(): void {
    render(<ProfileForm teacherId="t-1" initial={initial} />);
  }

  function save(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('PUTs the profile and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teachers/t-1',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence for a page slug another teacher holds, and does not refresh', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'SLUG_TAKEN', message: 'That page slug is already taken.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText('Page slug'), { target: { value: 'taken-slug' } });
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('That page slug is already taken.');
    expect(screen.queryByText('Saved')).toBeNull();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to its own message when the error body cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      url: '/api/teachers/t-1',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save');
  });

  it('reports a thrown fetch', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Please try again.');
  });
});
