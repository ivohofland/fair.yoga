import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  StudioClassEditForm,
  type StudioClassEditInitial,
} from './studio-class-edit-form';
import { routerRefresh } from '../../../tests/setup/components';
import { BOOKING_LINK_MESSAGES } from '@/lib/payment-link';
import { STUDIO_CLASS_EDIT_REFUSALS } from '@/services/studio-class-edit-refusals';
import { CLASS_TYPE_MAX, DURATION_MAX_MINUTES, LOCATION_MAX, MONEY_MAX } from '@/lib/input-bounds';

/**
 * The payload discipline is what this file exists to hold. The API refuses a
 * `date` whose PRESENCE is illegitimate — a generated row's unchanged date
 * included — so "send everything and let the server sort it out" would turn
 * every save of a template-born class into a 409. Which keys reach the wire,
 * not how they render, is the part a pin cannot see (see class-edit-form.test.tsx).
 *
 * The second thing it holds is that no field reaches the wire as a number the
 * teacher did not type. `hourlyRate` is `nonnegative`, so a cleared box coerced
 * per keystroke would save €0 at 200 — silently, since nothing rejects it.
 */
describe('StudioClassEditForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial: StudioClassEditInitial = {
    classType: 'Hatha',
    location: 'Community Studio',
    date: '2099-06-01',
    startTime: '09:30',
    durationMinutes: 60,
    hourlyRate: 45,
    bookingUrl: null,
  };

  function renderForm(dateEditable = true) {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    return render(
      <StudioClassEditForm currency="EUR" studioClassId="sc-1" dateEditable={dateEditable} initial={initial} />,
    );
  }

  function save() {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
  }

  async function sentBody(): Promise<Record<string, unknown>> {
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  async function saveWith(dateEditable: boolean): Promise<Record<string, unknown>> {
    renderForm(dateEditable);
    save();
    return sentBody();
  }

  it('renders every field prefilled with the row it was handed', () => {
    renderForm();

    expect(screen.getByLabelText('Class type')).toHaveValue('Hatha');
    expect(screen.getByLabelText('Location')).toHaveValue('Community Studio');
    expect(screen.getByLabelText('Date')).toHaveValue('2099-06-01');
    expect(screen.getByLabelText('Start time')).toHaveValue('09:30');
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(60);
    expect(screen.getByLabelText(/Hourly rate/)).toHaveValue('45');
  });

  it('steps the start time by five minutes from midnight, whatever is typed', () => {
    renderForm();
    const input = screen.getByLabelText<HTMLInputElement>('Start time');
    expect(input).toHaveAttribute('min', '00:00');
    fireEvent.change(input, { target: { value: '14:37' } });
    expect(input).toHaveAttribute('step', '300');
    expect(input.checkValidity()).toBe(false);
  });

  it('keeps a saved start time off the five-minute grid valid', () => {
    render(<StudioClassEditForm currency="EUR" studioClassId="sc-1" dateEditable initial={{ ...initial, startTime: '09:37' }} />);
    const input = screen.getByLabelText<HTMLInputElement>('Start time');
    expect(input).toHaveAttribute('step', '60');
    expect(input.checkValidity()).toBe(true);
  });

  it('sends every field it owns when the date may move', async () => {
    const body = await saveWith(true);
    expect(body).toEqual({
      classType: 'Hatha',
      location: 'Community Studio',
      date: '2099-06-01',
      startTime: '09:30',
      durationMinutes: 60,
      hourlyRate: 45,
      bookingUrl: null,
    });
  });

  /**
   * Presence, not difference: the route 409s any `date` on a non-dateEditable
   * row, so an unchanged-but-present date fails identically to a moved one.
   * The key must be absent from the JSON entirely.
   */
  it('omits the date key entirely when the date may not move', async () => {
    const body = await saveWith(false);
    expect(Object.keys(body).sort()).toEqual([
      'bookingUrl', 'classType', 'durationMinutes', 'hourlyRate', 'location', 'startTime',
    ]);
    expect(body).not.toHaveProperty('date');
  });

  /**
   * Every input's `onChange` carries ITS OWN field. Six near-identical handlers
   * differing only by key is where a copy-paste slip lives, and neither the
   * prefill test (which reads `value`) nor the payload tests (which send the
   * initials unchanged) can see one — both pass with two inputs wired to the
   * same key.
   */
  it('carries each field its own edit, not its neighbours', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Yin' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Loft' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-07-02' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '18:45' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '75' } });
    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '52.5' } });
    fireEvent.change(screen.getByLabelText('Booking page'), { target: { value: 'https://studio.example/b' } });
    save();

    expect(await sentBody()).toEqual({
      classType: 'Yin',
      location: 'Loft',
      date: '2099-07-02',
      startTime: '18:45',
      durationMinutes: 75,
      hourlyRate: 52.5,
      bookingUrl: 'https://studio.example/b',
    });
  });

  it('reads a decimal comma in the hourly rate (#844)', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '4,5' } });
    save();
    expect((await sentBody()).hourlyRate).toBe(4.5);
  });

  it('refuses a grouped hourly rate such as 1.000 and sends nothing (#844)', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '1.000' } });
    save();
    expect(await screen.findByText('Enter an hourly rate — 0 if this class is unpaid.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trims the two free-text fields — `min(1)` counts a space', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '  Yin  ' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: ' Loft ' } });
    save();

    const body = await sentBody();
    expect(body.classType).toBe('Yin');
    expect(body.location).toBe('Loft');
  });

  /**
   * THE SILENT ONE. `<input type="number">` reports `''` for a cleared box, and
   * `Number('') === 0` passes `z.number().nonnegative()` — so before this the
   * rate saved as €0 at 200 with "Saved" on screen, and the class counted as
   * zero income in reporting. Nothing reaches the wire at all now.
   */
  it('refuses a cleared hourly rate in prose instead of saving zero', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '' } });
    save();

    expect(await screen.findByText(/Enter an hourly rate/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('refuses a cleared duration in prose, not in Zod\'s words', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '' } });
    save();

    expect(await screen.findByText(/how many minutes/)).toBeInTheDocument();
    // The string the teacher used to get, straight off `parseBody`.
    expect(screen.queryByText(/durationMinutes/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a cleared start time in prose, not in Zod\'s words', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    save();

    expect(await screen.findByText('Pick a start time.')).toBeInTheDocument();
    expect(screen.queryByText(/HH:mm/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only class type rather than blanking the heading', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '   ' } });
    save();

    expect(await screen.findByText('Class type is required.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a field's complaint as soon as that field is edited", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '' } });
    save();
    expect(await screen.findByText(/Enter an hourly rate/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Hourly rate/), { target: { value: '50' } });
    expect(screen.queryByText(/Enter an hourly rate/)).not.toBeInTheDocument();
  });

  it('confirms a saved edit and refreshes the page', async () => {
    renderForm();

    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  /**
   * REFRESH ON REFUSAL TOO. A 409 means the server knows something this page
   * does not — a class dated today whose form sat open across local midnight is
   * now an income record, and every later save fails identically. Re-reading is
   * what lets the server page redirect to the detail view. The teacher still
   * sees the refusal in the meantime, verbatim (#197).
   */
  it('shows the server message verbatim and re-reads the page when refused', async () => {
    const refusal = STUDIO_CLASS_EDIT_REFUSALS.generated_date.message;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: refusal, code: 'STUDIO_CLASS_GENERATED_DATE' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudioClassEditForm currency="EUR" studioClassId="sc-1" dateEditable initial={initial} />);

    save();

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('does not re-read the page when nothing was asked of the server', async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '' } });
    save();

    expect(await screen.findByText('Location is required.')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('disables the date input and names the remedy when the date may not move', () => {
    renderForm(false);

    expect(screen.getByLabelText('Date')).toBeDisabled();
    expect(screen.getByText(STUDIO_CLASS_EDIT_REFUSALS.generated_date.message)).toBeInTheDocument();
  });

  it('leaves the date input enabled with no explainer when the date may move', () => {
    renderForm(true);

    expect(screen.getByLabelText('Date')).toBeEnabled();
    expect(screen.queryByText(/recurring template/)).not.toBeInTheDocument();
  });

  /**
   * A hint, not a guard — gate 3 refuses a past date on its own. Asserted as
   * "some bound is present" rather than a literal day: `useTodayLocal` reads
   * the host clock, and pinning today's date here would make this test expire
   * overnight.
   */
  it('bounds the date picker at today so the picker cannot offer the past', () => {
    renderForm();

    expect(screen.getByLabelText('Date')).toHaveAttribute('min', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it.each([
    ['a duration over a day', 'Duration (minutes)', String(DURATION_MAX_MINUTES + 1), 'A class can run at most 1,440 minutes (24 hours).'],
    ['an hourly rate over the limit', 'Hourly rate', String(MONEY_MAX + 1), 'The hourly rate can be at most 100,000.'],
  ])('refuses %s with this form\'s own copy and sends nothing (#769)', async (_label, field, value, copy) => {
    renderForm();

    fireEvent.change(screen.getByLabelText(new RegExp('^' + field.replace(/[()]/g, '\\$&'))), { target: { value } });
    save();

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits the class type and location text (#769)', () => {
    renderForm();
    expect(screen.getByLabelText('Class type')).toHaveAttribute('maxlength', String(CLASS_TYPE_MAX));
    expect(screen.getByLabelText('Location')).toHaveAttribute('maxlength', String(LOCATION_MAX));
  });

  it('refuses a booking link that is not https, naming the field, before any request', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Booking page'), { target: { value: 'http://studio.example' } });
    save();
    expect(screen.getByText(BOOKING_LINK_MESSAGES.not_https)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
