import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { ProfileForm } from './profile-form';
import { timeZoneOptions, type TimeZoneOptions } from '@/lib/timezone-options';

const email = 'anna@example.com';

const initial = {
  firstName: 'Anna',
  lastName: 'de Vries',
  bio: 'Slow flow on Tuesdays.',
  pageSlug: 'anna',
  currency: 'EUR' as const,
  defaultTimezone: 'Europe/Amsterdam',
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
        email={email}
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
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = new Error('offline');
    fetchMock.mockRejectedValue(offline);
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Please try again.');
    expect(consoleError).toHaveBeenCalledWith('[profile-form] request failed', {
      teacherId: 't-1',
      err: offline,
    });
    consoleError.mockRestore();
  });

  it('shows a stored zone the list lacks as selected', () => {
    renderForm({ defaultTimezone: 'UTC' });
    expect(timezoneSelect().value).toBe('UTC');
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

  describe('after a currency switch (#758)', () => {
    type Kept = { currency: string; classes: number; studioClasses: number };
    function switched(relabelled: { classes: number; studioClasses: number }, kept: Kept[]): void {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: { currency: 'GBP', currencySwitch: { relabelled, kept } } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderForm();
      fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'GBP' } });
      save();
    }

    it('says how many classes now show the new currency and how many keep theirs', async () => {
      switched({ classes: 10, studioClasses: 2 }, [{ currency: 'EUR', classes: 2, studioClasses: 1 }]);
      expect(
        await screen.findByText(
          '12 upcoming classes now show £. 3 classes keep €, because they’re booked, finished or cancelled.',
        ),
      ).toBeInTheDocument();
      expect(sentBody().currency).toBe('GBP');
    });

    it('names each currency the kept classes show, in the order given', async () => {
      switched({ classes: 2, studioClasses: 0 }, [
        { currency: 'EUR', classes: 3, studioClasses: 0 },
        { currency: 'USD', classes: 0, studioClasses: 1 },
      ]);
      expect(
        await screen.findByText(
          '2 upcoming classes now show £. 3 classes keep €, 1 class keeps $, because they’re booked, finished or cancelled.',
        ),
      ).toBeInTheDocument();
    });

    it('omits the kept clause when nothing kept its currency', async () => {
      switched({ classes: 4, studioClasses: 0 }, []);
      expect(await screen.findByText('4 upcoming classes now show £.')).toBeInTheDocument();
    });

    it('omits the relabelled clause when nothing was relabelled', async () => {
      switched({ classes: 0, studioClasses: 0 }, [{ currency: 'EUR', classes: 0, studioClasses: 3 }]);
      expect(
        await screen.findByText('3 classes keep €, because they’re booked, finished or cancelled.'),
      ).toBeInTheDocument();
    });

    it('speaks of one class in the singular', async () => {
      switched({ classes: 0, studioClasses: 1 }, [{ currency: 'EUR', classes: 1, studioClasses: 0 }]);
      expect(
        await screen.findByText(
          '1 upcoming class now shows £. 1 class keeps €, because it’s booked, finished or cancelled.',
        ),
      ).toBeInTheDocument();
    });

    it('says only Saved when the teacher had no classes to relabel or keep', async () => {
      switched({ classes: 0, studioClasses: 0 }, []);
      expect(await screen.findByText('Saved')).toBeInTheDocument();
    });
  });

  it('tells the teacher the holder name must match their bank', () => {
    renderForm();
    expect(
      screen.getByText('Exactly as your bank shows it — your students’ banks check this name.'),
    ).toBeInTheDocument();
  });
});
