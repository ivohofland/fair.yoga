import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { ProfileForm } from './profile-form';
import { timeZoneOptions, type TimeZoneOptions } from '@/lib/timezone-options';

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

  const NOW = new Date('2026-01-15T12:00:00Z');

  function renderForm(
    overrides: Partial<typeof initial> = {},
    options?: TimeZoneOptions,
  ): void {
    const props = { ...initial, ...overrides };
    render(
      <ProfileForm
        teacherId="t-1"
        initial={props}
        timeZoneOptions={options ?? timeZoneOptions(props.defaultTimezone, NOW)}
      />,
    );
  }

  function timezoneSelect(): HTMLSelectElement {
    return screen.getByLabelText('Timezone') as HTMLSelectElement;
  }

  function sentBody(): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
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

  it('shows a stored zone the list lacks as selected, and saves it untouched', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm({ defaultTimezone: 'UTC' });

    expect(timezoneSelect().value).toBe('UTC');
    save();
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sentBody().defaultTimezone).toBe('UTC');
  });

  it('offers zones outside Europe, North America and Australia, grouped by region', () => {
    renderForm();
    const select = timezoneSelect();
    expect(select.value).toBe('Europe/Amsterdam');
    expect(select.querySelector('optgroup[label="Pacific"] option[value="Pacific/Auckland"]')).not.toBeNull();
    expect(select.querySelector('optgroup[label="Asia"] option[value="Asia/Kolkata"]')).not.toBeNull();
  });

  it('sends the zone the teacher picks', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    fireEvent.change(timezoneSelect(), { target: { value: 'Pacific/Auckland' } });
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sentBody().defaultTimezone).toBe('Pacific/Auckland');
  });

  /** The list comes from the server page; the form builds none of its own. */
  it('renders exactly the options it is given', () => {
    renderForm({}, {
      standalone: [],
      groups: [{ region: 'Europe', options: [{ value: 'Europe/Amsterdam', label: 'Only option' }] }],
    });
    const options = timezoneSelect().querySelectorAll('option');
    expect([...options].map((o) => o.textContent)).toEqual(['Only option']);
  });
});
