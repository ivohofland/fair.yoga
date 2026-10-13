import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { Currency } from '@prisma/client';
import { routerRefresh } from '../../../tests/setup/components';
import { ProfileForm } from './profile-form';
import { timeZoneOptions, type TimeZoneOptions } from '@/lib/timezone-options';

const email = 'anna@example.com';

const initial = {
  firstName: 'Anna',
  lastName: 'de Vries',
  bio: 'Slow flow on Tuesdays.',
  pageSlug: 'anna',
  currency: 'EUR' as Currency,
  defaultVatPercent: 0,
  defaultTimezone: 'Europe/Amsterdam',
};

describe('ProfileForm', () => {
  /** Every request but the live slug check: in these tests, the save. */
  const fetchMock = vi.fn();
  /** The live slug check's answer for the slug it is asked about. */
  const slugCheck = vi.fn((_slug: string): boolean => true);

  afterEach(() => {
    fetchMock.mockReset();
    slugCheck.mockReset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Routes by URL: the page-address field checks a changed slug on its own
   * schedule, so its requests interleave with the save's in no fixed order.
   */
  function stubFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/teachers/slug-available') {
          const available = slugCheck(url.searchParams.get('slug') ?? '');
          return Promise.resolve({ ok: true, json: async () => ({ data: { available } }) });
        }
        return fetchMock(input, init);
      }),
    );
  }

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
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    const init = put?.[1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  function save(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('PUTs the profile and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    stubFetch();
    renderForm();
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teachers/t-1',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence for a page address another teacher holds, and does not refresh', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'SLUG_TAKEN', message: 'That page address is already taken.' },
      }),
    });
    stubFetch();
    renderForm();
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: 'taken-slug' } });
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('That page address is already taken.');
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
    stubFetch();
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save');
  });

  it('reports a thrown fetch', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = new Error('offline');
    fetchMock.mockRejectedValue(offline);
    stubFetch();
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
    stubFetch();
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
      stubFetch();
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

  /**
   * A tab opened before a switch elsewhere still holds the old currency; a
   * save from it that names that currency would switch the teacher back.
   */
  describe('sends currency only when the teacher changed it (#758)', () => {
    it('sends no currency key when only the bio changed', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Bio (max 250 characters)'), { target: { value: 'New bio.' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().bio).toBe('New bio.');
      expect(sentBody()).not.toHaveProperty('currency');
    });

    it('sends the currency the teacher picked', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'CHF' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().currency).toBe('CHF');
    });

    it('does not resend a switched currency on the next save from the same form', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'GBP' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Bio (max 250 characters)'), { target: { value: 'Later bio.' } });
      save();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const second = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(second).not.toHaveProperty('currency');
    });
  });

  describe('default VAT % (#833)', () => {
    it('shows the stored rate and the responsibility hint', () => {
      renderForm({ defaultVatPercent: 14.975 });
      expect(screen.getByLabelText('Default VAT %')).toHaveValue('14.975');
      expect(
        screen.getByText(
          "It's your responsibility to set the right VAT rate. You can change it on each class. This is only the default for new classes. Use 0 if you don't charge VAT.",
        ),
      ).toBeInTheDocument();
    });

    it('sends the rate as a number', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '9' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().defaultVatPercent).toBe(9);
    });

    it('sends 0 when the field is cleared', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm({ defaultVatPercent: 21 });
      fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().defaultVatPercent).toBe(0);
    });

    it('sends 4.5 for a rate typed as 4,5', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '4,5' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().defaultVatPercent).toBe(4.5);
    });

    it('refuses a rate that is not one number, rather than saving 0', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm({ defaultVatPercent: 21 });
      fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '4,5,6' } });
      save();

      expect(await screen.findByRole('alert')).toHaveTextContent('Enter a number for VAT.');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stays empty when cleared, so a new rate replaces the 0 instead of landing after it', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm({ defaultVatPercent: 0 });
      const input = screen.getByLabelText('Default VAT %') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '' } });
      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: '9' } });
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().defaultVatPercent).toBe(9);
    });

    it('leaves a decimal the teacher is still typing alone', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      const input = screen.getByLabelText('Default VAT %') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '5.0' } });
      expect(input.value).toBe('5.0');
      fireEvent.change(input, { target: { value: '5.05' } });
      expect(input.value).toBe('5.05');
      save();

      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().defaultVatPercent).toBe(5.05);
    });

    it('refuses four decimals before sending', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('Default VAT %'), { target: { value: '8.1234' } });
      save();

      expect(await screen.findByRole('alert')).toHaveTextContent('Use at most 3 decimals for VAT.');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('page slug change', () => {
    const warning = (slug: string): string =>
      `Links you’ve already shared to fair.yoga/${slug} will stop working.`;
    // Any slug's warning, so an absence check cannot pass by the caption naming the wrong one.
    const anyWarning = /^Links you’ve already shared to fair\.yoga\/.* will stop working\.$/;

    function slugField(): HTMLInputElement {
      return screen.getByLabelText('Page address') as HTMLInputElement;
    }

    function liveRegion(): Element | null {
      return document.querySelector('[aria-live="polite"]');
    }

    it('shows no warning while the slug is unchanged', () => {
      renderForm();
      expect(screen.queryByText(anyWarning)).toBeNull();
    });

    it('warns that links to the saved slug will stop working, and ties the warning to the field', () => {
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      const caption = screen.getByText(warning('anna'));
      expect(slugField().getAttribute('aria-describedby')?.split(' ')).toContain(caption.id);
    });

    // A region mounted together with its text is often not announced, so the
    // region must already be there, empty, when the caption arrives.
    it('puts the warning into a live region that was mounted before it', () => {
      renderForm();
      const region = liveRegion();
      expect(region).toBeEmptyDOMElement();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      expect(liveRegion()).toBe(region);
      expect(region).toContainElement(screen.getByText(warning('anna')));
    });

    it('drops the warning when the teacher types the saved slug back', () => {
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      const captionId = screen.getByText(warning('anna')).id;
      fireEvent.change(slugField(), { target: { value: 'anna' } });
      expect(screen.queryByText(anyWarning)).toBeNull();
      expect(slugField().getAttribute('aria-describedby')?.split(' ') ?? []).not.toContain(captionId);
    });

    it('clears the warning once the new slug is saved', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(screen.queryByText(anyWarning)).toBeNull();
    });

    it('names the slug saved last when the teacher changes it again', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      fireEvent.change(slugField(), { target: { value: 'anna-flow' } });
      expect(screen.getByText(warning('anna-yoga'))).toBeInTheDocument();
      fireEvent.change(slugField(), { target: { value: 'anna' } });
      expect(screen.getByText(warning('anna-yoga'))).toBeInTheDocument();
    });

    it('neither warns nor sends the slug when only another field changed', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anneke' } });
      expect(screen.queryByText(anyWarning)).toBeNull();
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody()).not.toHaveProperty('pageSlug');
      expect(screen.queryByText(anyWarning)).toBeNull();
    });

    it('sends the slug when the teacher changed it', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(sentBody().pageSlug).toBe('anna-yoga');
    });

    it('keeps the warning when the save cannot reach the server', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      stubFetch();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();
      expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
      expect(screen.getByText(warning('anna'))).toBeInTheDocument();
    });

    it('keeps the warning when the save fails', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'SLUG_TAKEN', message: 'That page address is already taken.' } }),
      });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'taken-slug' } });
      save();
      expect(await screen.findByText('That page address is already taken.')).toBeInTheDocument();
      expect(screen.getByText(warning('anna'))).toBeInTheDocument();
    });

    it('labels the field as signup does', () => {
      renderForm();
      expect(slugField()).toHaveValue('anna');
      expect(screen.queryByLabelText('Page slug')).toBeNull();
    });

    it('asks for a page address when the field is emptied, without sending', () => {
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: '' } });
      save();
      expect(screen.getByRole('alert')).toHaveTextContent('Page address is required');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('live availability check (#827)', () => {
      /** Runs the field's debounce out and lets its answer arrive. */
      async function afterDebounce(): Promise<void> {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
      }

      function checkedSlugs(): string[] {
        return slugCheck.mock.calls.map(([slug]) => slug);
      }

      it('checks a changed slug and says it is available', async () => {
        vi.useFakeTimers();
        stubFetch();
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
        await afterDebounce();
        expect(checkedSlugs()).toEqual(['anna-yoga']);
        expect(screen.getByText('Available')).toBeInTheDocument();
      });

      it('says a changed slug another teacher holds is taken', async () => {
        vi.useFakeTimers();
        slugCheck.mockReturnValue(false);
        stubFetch();
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'taken-slug' } });
        await afterDebounce();
        expect(checkedSlugs()).toEqual(['taken-slug']);
        expect(screen.getByText('That address is taken')).toBeInTheDocument();
      });

      // The endpoint cannot tell who asks: it calls the teacher's own slug taken.
      it('neither checks nor judges the saved slug as loaded', async () => {
        vi.useFakeTimers();
        slugCheck.mockImplementation((slug) => slug !== 'anna');
        stubFetch();
        renderForm();
        await afterDebounce();
        expect(slugCheck).not.toHaveBeenCalled();
        expect(screen.queryByText('That address is taken')).toBeNull();
        expect(screen.queryByText('Available')).toBeNull();
      });

      // A check of another slug has run and been drawn before the switch back.
      it('neither checks nor judges the saved slug when typed back', async () => {
        vi.useFakeTimers();
        slugCheck.mockImplementation((slug) => slug !== 'anna');
        stubFetch();
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
        await afterDebounce();
        expect(screen.getByText('Available')).toBeInTheDocument();

        fireEvent.change(slugField(), { target: { value: 'anna' } });
        await afterDebounce();
        expect(checkedSlugs()).toEqual(['anna-yoga']);
        expect(screen.queryByText('That address is taken')).toBeNull();
        expect(screen.queryByText('Available')).toBeNull();
      });

      it('neither checks nor judges a slug once it is saved', async () => {
        vi.useFakeTimers();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
        stubFetch();
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
        await afterDebounce();
        expect(screen.getByText('Available')).toBeInTheDocument();

        // Saved, the endpoint calls it taken: this teacher holds it now.
        slugCheck.mockReturnValue(false);
        save();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText('Saved')).toBeInTheDocument();
        expect(screen.queryByText('Available')).toBeNull();
        await afterDebounce();
        expect(checkedSlugs()).toEqual(['anna-yoga']);
        expect(screen.queryByText('That address is taken')).toBeNull();
      });

      // The save lands inside the debounce: by the time the check would go
      // out, the server already holds the slug for this teacher and calls it taken.
      it('neither checks nor judges a slug while a save of it is in flight', async () => {
        vi.useFakeTimers();
        let respond: (value: unknown) => void = () => {};
        fetchMock.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
        slugCheck.mockReturnValue(false);
        stubFetch();
        renderForm();
        fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
        save();
        await afterDebounce();
        expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument();
        expect(slugCheck).not.toHaveBeenCalled();
        expect(screen.queryByText('That address is taken')).toBeNull();

        await act(async () => {
          respond({ ok: true, json: async () => ({ data: {} }) });
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByText('Saved')).toBeInTheDocument();
        await afterDebounce();
        expect(slugCheck).not.toHaveBeenCalled();
        expect(screen.queryByText('That address is taken')).toBeNull();
      });
    });

    it('shows a SLUG_TAKEN refusal on the field rather than the form, until the slug is edited', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'SLUG_TAKEN', message: 'That page address is already taken.' } }),
      });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'taken-slug' } });
      save();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That page address is already taken.');
      expect(slugField()).toHaveAttribute('aria-invalid', 'true');
      expect(slugField().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);

      fireEvent.change(slugField(), { target: { value: 'taken-slug-2' } });
      expect(screen.queryByText('That page address is already taken.')).toBeNull();
      expect(slugField()).not.toHaveAttribute('aria-invalid');
    });

    it('drops a SLUG_TAKEN refusal when a resubmit of the same slug saves', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: { code: 'SLUG_TAKEN', message: 'That page address is already taken.' } }),
      });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: {} }) });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'taken-slug' } });
      save();
      expect(await screen.findByText('That page address is already taken.')).toBeInTheDocument();

      save();
      expect(await screen.findByText('Saved')).toBeInTheDocument();
      expect(screen.queryByText('That page address is already taken.')).toBeNull();
    });

    it('keeps any other refusal of a slug change at the form level', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'That address is reserved.' } }),
      });
      stubFetch();
      renderForm();
      fireEvent.change(slugField(), { target: { value: 'anna-yoga' } });
      save();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('That address is reserved.');
      expect(slugField()).not.toHaveAttribute('aria-invalid');
      expect(slugField().getAttribute('aria-describedby')?.split(' ') ?? []).not.toContain(alert.id);
    });
  });

  it('offers every Currency, in declaration order', () => {
    renderForm();
    const options = (screen.getByLabelText('Currency') as HTMLSelectElement).querySelectorAll('option');
    expect([...options].map((o) => o.value)).toEqual(Object.values(Currency));
  });

  // `updateTeacherSchema` names no bank field, so the form neither shows nor sends one.
  it('neither shows nor sends bank fields', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    stubFetch();
    renderForm();
    expect(screen.queryByLabelText('Bank IBAN')).toBeNull();
    expect(screen.queryByText('Students are shown your bank details only for euro payments.')).toBeNull();
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(sentBody()).not.toHaveProperty('bankIban');
    expect(sentBody()).not.toHaveProperty('bankAccountName');
  });
});
