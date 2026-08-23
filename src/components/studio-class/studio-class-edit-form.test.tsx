import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  StudioClassEditForm,
  type StudioClassEditInitial,
} from './studio-class-edit-form';
import { routerRefresh } from '../../../tests/setup/components';
import { STUDIO_CLASS_EDIT_REFUSALS } from '@/services/studio-class-edit-refusals';

/**
 * The payload discipline is what this file exists to hold. The API refuses a
 * `date` whose PRESENCE is illegitimate — a generated row's unchanged date
 * included — so "send everything and let the server sort it out" would turn
 * every save of a template-born class into a 409. Which keys reach the wire,
 * not how they render, is the part a pin cannot see (see class-edit-form.test.tsx).
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
  };

  async function saveWith(dateEditable: boolean): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <StudioClassEditForm studioClassId="sc-1" dateEditable={dateEditable} initial={initial} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('renders every field prefilled with the row it was handed', () => {
    render(<StudioClassEditForm studioClassId="sc-1" dateEditable initial={initial} />);

    expect(screen.getByLabelText('Class type')).toHaveValue('Hatha');
    expect(screen.getByLabelText('Location')).toHaveValue('Community Studio');
    expect(screen.getByLabelText('Date')).toHaveValue('2099-06-01');
    expect(screen.getByLabelText('Start time')).toHaveValue('09:30');
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(60);
    expect(screen.getByLabelText(/Hourly rate/)).toHaveValue(45);
  });

  it('sends all six fields when the date may move', async () => {
    const body = await saveWith(true);
    expect(body).toEqual({
      classType: 'Hatha',
      location: 'Community Studio',
      date: '2099-06-01',
      startTime: '09:30',
      durationMinutes: 60,
      hourlyRate: 45,
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
      'classType', 'durationMinutes', 'hourlyRate', 'location', 'startTime',
    ]);
    expect(body).not.toHaveProperty('date');
  });

  it('confirms a saved edit and refreshes the page', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudioClassEditForm studioClassId="sc-1" dateEditable initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message verbatim instead of "Saved" when the save is refused', async () => {
    // Gate 2's own words, imported — not a second copy: this form is one of
    // the surfaces that must deliver the refusal unedited (#197), so the
    // stub and the assertion both read the constant the API answers with.
    const refusal = STUDIO_CLASS_EDIT_REFUSALS.generated_date.message;
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: refusal, code: 'STUDIO_CLASS_GENERATED_DATE' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StudioClassEditForm studioClassId="sc-1" dateEditable initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('disables the date input and names the remedy when the date may not move', () => {
    render(
      <StudioClassEditForm studioClassId="sc-1" dateEditable={false} initial={initial} />,
    );

    expect(screen.getByLabelText('Date')).toBeDisabled();
    expect(screen.getByText(STUDIO_CLASS_EDIT_REFUSALS.generated_date.message)).toBeInTheDocument();
  });

  it('leaves the date input enabled with no explainer when the date may move', () => {
    render(<StudioClassEditForm studioClassId="sc-1" dateEditable initial={initial} />);

    expect(screen.getByLabelText('Date')).toBeEnabled();
    expect(screen.queryByText(/recurring template/)).not.toBeInTheDocument();
  });
});
