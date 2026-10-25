import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { todayLocal } from '@/lib/format';
import { MAX_CLASS_SIZE } from '@/lib/schemas';
import { DURATION_MAX_MINUTES, MONEY_MAX } from '@/lib/input-bounds';
import { routerRefresh } from '../../../tests/setup/components';
import type { MoveWarning } from '@/lib/late-publish';
import { ClassEditForm, type ClassEditInitial } from './class-edit-form';

/**
 * A real `Response` whose `json()` genuinely throws — the shape a proxy's
 * HTML error page takes, which the plain `{ ok, json }` stubs below cannot
 * express.
 */
function htmlResponse(status = 502): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * #81. This form used to enumerate its field list twice — once as
 * `ClassEditInitial`, once as the payload builder — under a comment claiming it
 * "Mirrors updateClassSchema exactly", which nothing checked. The list is now
 * single and compiler-pinned; what a pin cannot see is which keys actually
 * reach the API, and that is what these tests hold.
 *
 * The `settingsLocked` fork is the reason this file exists. It decides whether
 * the `ECONOMIC_FIELDS` and the schedule are sent, and getting it wrong means either a teacher
 * silently cannot edit their pricing, or a locked class accepts an edit the
 * route will reject with a 400.
 */
describe('ClassEditForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const initial: ClassEditInitial = {
    classType: 'Vinyasa',
    description: 'Bring a mat.',
    date: '2026-06-12',
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
    isPrivate: false,
    videoUrl: '',
    pricingMode: 'tiered',
  };

  async function saveWith(settingsLocked: boolean): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('sends every editable field when settings are unlocked, Private only once changed', async () => {
    const body = await saveWith(false);
    expect(body).toEqual({
      classType: 'Vinyasa',
      description: 'Bring a mat.',
      date: '2026-06-12',
      startTime: '09:30',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      vatPercent: 0,
    });
  });

  it('keeps the Private checkbox enabled on a locked class and sends the toggle (#910)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={true} initial={initial} />);
    const box = screen.getByRole('checkbox', { name: /private class/i });
    expect(box).toBeEnabled();
    expect(screen.getByLabelText('Max students')).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse((options as { body: string }).body)).toHaveProperty('isPrivate', true);
  });

  /**
   * #910. Private goes out only when it differs from the stored flag in
   * `initial`, so a tab opened before the flag changed elsewhere does not send
   * its old value back. A refresh moves an untouched box to the stored flag; a
   * box the teacher changed is kept.
   */
  describe('a Private flag changed elsewhere while this tab is open (#910)', () => {
    function renderForm(isPrivate: boolean) {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      return render(
        <ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, isPrivate }} />,
      );
    }
    async function save(): Promise<Record<string, unknown>> {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const [, options] = fetchMock.mock.calls.at(-1) ?? [];
      return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    }

    it('an untouched box follows the refreshed flag and the save leaves it out', async () => {
      const { rerender } = renderForm(false);
      rerender(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, isPrivate: true }} />);
      expect(screen.getByRole('checkbox', { name: /private class/i })).toBeChecked();
      expect(await save()).not.toHaveProperty('isPrivate');
    });

    it('a box the teacher ticked survives a refresh that leaves the flag alone, and is sent', async () => {
      const { rerender } = renderForm(false);
      fireEvent.click(screen.getByRole('checkbox', { name: /private class/i }));
      rerender(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, isPrivate: false, classType: 'Yin' }} />);
      expect(screen.getByRole('checkbox', { name: /private class/i })).toBeChecked();
      expect(await save()).toHaveProperty('isPrivate', true);
    });
  });

  /**
   * Pins that every `ECONOMIC_FIELDS` member does not reach the API when settings are
   * locked, by whatever mechanism the component uses to leave them out.
   *
   * This does not distinguish `delete payload[f]` from a hypothetical
   * `payload[f] = undefined`: `JSON.stringify` produces byte-identical output
   * for both, and this test only ever observes `JSON.parse(body)`. The route
   * itself would accept either — `updateClass` (`class-lifecycle.ts`) filters
   * on `data[f] !== undefined` when computing `sentEconomic` — so the two are
   * equivalent over the wire, and no test here tells them apart. Not that
   * none could: a spy on
   * `JSON.stringify` sees the object before it is serialized, where the two
   * differ. It would be testing the mechanism rather than what is sent, which
   * is why this file does not.
   */
  it('omits the economic fields and the schedule when settings are locked', async () => {
    const body = await saveWith(true);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'description', 'durationMinutes',
    ]);
    for (const f of ['roomCost', 'minRate', 'targetRate', 'minStudents', 'maxStudents', 'vatPercent', 'date', 'startTime']) {
      expect(body).not.toHaveProperty(f);
    }
  });

  it('shows the stored VAT %, and the room cost label follows whether VAT is charged (#819)', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, vatPercent: 21 }} />);
    expect(screen.getByLabelText('VAT %')).toHaveValue('21');
    expect(screen.getByLabelText('Room cost excl. VAT (€)')).toBeInTheDocument();
    expect(screen.getByText("You reclaim the room's VAT in your own VAT return.")).toBeInTheDocument();
  });

  it('saves an edited non-zero VAT % (#819)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, vatPercent: 21 }} />);
    fireEvent.change(screen.getByLabelText('VAT %'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    expect(body.vatPercent).toBe(9);
  });

  it('keeps the plain room cost label at 0% VAT (#819)', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    expect(screen.getByLabelText('Room cost (€)')).toBeInTheDocument();
    expect(screen.queryByText("You reclaim the room's VAT in your own VAT return.")).toBeNull();
  });

  it('disables the date and start time once booked, and says how to change the time (#836)', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={true} initial={initial} />);
    expect(screen.getByLabelText('Date')).toBeDisabled();
    expect(screen.getByLabelText('Start time')).toBeDisabled();
    expect(screen.getByLabelText('Duration (minutes)')).not.toBeDisabled();
    expect(screen.getByText(/cancel it and create a new one/)).toBeInTheDocument();
  });

  it('leaves the date and start time editable while unbooked', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    expect(screen.getByLabelText('Date')).not.toBeDisabled();
    expect(screen.getByLabelText('Start time')).not.toBeDisabled();
    expect(screen.queryByText(/cancel it and create a new one/)).not.toBeInTheDocument();
  });

  it('steps the start time by five minutes from midnight, whatever is typed', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    const input = screen.getByLabelText<HTMLInputElement>('Start time');
    expect(input).toHaveAttribute('min', '00:00');
    fireEvent.change(input, { target: { value: '14:37' } });
    expect(input).toHaveAttribute('step', '300');
    expect(input.checkValidity()).toBe(false);
  });

  it('keeps a saved start time off the five-minute grid valid', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, startTime: '09:37' }} />);
    const input = screen.getByLabelText<HTMLInputElement>('Start time');
    expect(input).toHaveAttribute('step', '60');
    expect(input.checkValidity()).toBe(true);
  });

  /**
   * F3 (#221 review fold). `handleSave`'s `economicsViolations` check is
   * wrapped in `if (!settingsLocked)`: locked economics are stripped from
   * the payload before it is sent, so they never reach the route for it to
   * validate either. Checking them client-side regardless would block a save
   * the route would accept. `initial` here carries an invalid
   * `minRate`/`targetRate` pair on purpose: were the wrapper removed, the
   * client-side check would fire on these STORED (locked) values before
   * `saveWith`-style stripping ever runs, and no request would be sent.
   */
  it('locked settings: saves despite economically invalid initial values, with no alert', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR"
        classId="cls-1"
        settingsLocked={true}
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('sends an empty description as null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR"
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, description: '' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    expect(body.description).toBeNull();
  });

  /**
   * #700. This form's payload spreads all of `form`, so a cleared
   * `type="date"`/`type="time"` input (or a whitespace-only class type) is
   * sent as `''` rather than omitted. `handleSave` refuses each in field
   * order (class type, then date, then start time) before the request ever
   * leaves, with this form's own prose.
   *
   * Class type is a DETAIL, checked and sent at any lock state. Date and
   * start time are checked only while unlocked: once booked they are
   * disabled and stripped from the payload (#836). The final case pins the
   * class-type check under `settingsLocked={true}`, which a guard placed
   * inside the unlocked branch would fail to do.
   */
  it.each([
    ['class type', 'Class type', '   ', false, /^Enter a class type$/],
    ['date', 'Date', '', false, /^Select a date$/],
    ['start time', 'Start time', '', false, /^Enter a start time$/],
    ['class type, settings locked', 'Class type', '   ', true, /^Enter a class type$/],
  ] as const)(
    'refuses a cleared %s before any request, with product copy',
    async (_label, fieldName, clearedValue, settingsLocked, copy) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);

      fireEvent.change(screen.getByLabelText(fieldName), { target: { value: clearedValue } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    },
  );

  /**
   * #702. A cleared number field holds `0`, and nothing native bounds them: this form has no `<form>` element. The
   * first number field out of range, in this form's copy, is refused before
   * the request leaves. Duration is a detail, sent and checked at any lock
   * state. Room cost and the student counts are economics, checked only while
   * unlocked, since locked economics are never sent.
   */
  it.each([
    ['a cleared duration', 'Duration (minutes)', '', false, /^Duration must be positive$/],
    ['a cleared duration, settings locked', 'Duration (minutes)', '', true, /^Duration must be positive$/],
    ['a negative duration', 'Duration (minutes)', '-5', false, /^Duration must be positive$/],
    ['a fractional duration', 'Duration (minutes)', '60.5', false, /^Duration must be whole minutes$/],
    ['a negative room cost', 'Room cost (€)', '-5', false, /^Room cost cannot be negative$/],
    ['a cleared min students', 'Min students', '', false, /^Min students must be at least 1$/],
    ['a negative min students', 'Min students', '-5', false, /^Min students must be at least 1$/],
    ['a fractional min students', 'Min students', '2.5', false, /^Min students must be a whole number$/],
    ['a cleared max students', 'Max students', '', false, /^Max students must be at least 1$/],
    ['a negative max students', 'Max students', '-5', false, /^Max students must be at least 1$/],
    ['a fractional max students', 'Max students', '12.5', false, /^Max students must be a whole number$/],
    [
      'a max students over the class size limit',
      'Max students',
      String(MAX_CLASS_SIZE + 1),
      false,
      new RegExp(`^Max students cannot exceed ${MAX_CLASS_SIZE}$`),
    ],
    [
      'a duration over a day',
      'Duration (minutes)',
      String(DURATION_MAX_MINUTES + 1),
      false,
      /^Duration cannot exceed 1,440 minutes \(24 hours\)$/,
    ],
    [
      'a duration over a day, settings locked',
      'Duration (minutes)',
      String(DURATION_MAX_MINUTES + 1),
      true,
      /^Duration cannot exceed 1,440 minutes \(24 hours\)$/,
    ],
    ['a room cost over the limit', 'Room cost (€)', String(MONEY_MAX + 1), false, /^Room cost cannot exceed 100,000$/],
    [
      'a min rate below the limit',
      'Min rate (€)',
      String(-MONEY_MAX - 1),
      false,
      /^Min rate must be between -100,000 and 100,000$/,
    ],
    [
      'a target rate over the limit',
      'Target rate (€)',
      String(MONEY_MAX + 1),
      false,
      /^Target rate must be between -100,000 and 100,000$/,
    ],
  ] as const)(
    'refuses %s before any request, with product copy',
    async (_label, fieldName, value, settingsLocked, copy) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);

      fireEvent.change(screen.getByLabelText(fieldName), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    },
  );

  it.each([
    ['Room cost (€)', '4,5,6', 'room cost'],
    ['Room cost (€)', '1.000', 'room cost'],
    ['Min rate (€)', '4,5,6', 'min rate'],
    ['Min rate (€)', '1.000', 'min rate'],
    ['Target rate (€)', '4,5,6', 'target rate'],
    ['Target rate (€)', '1.000', 'target rate'],
  ])('refuses a %s of %s, rather than reading it as some other amount', async (fieldName, text, name) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    fireEvent.change(screen.getByLabelText(fieldName), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(new RegExp(`^Enter a number for ${name}$`));
  });

  it('keeps the minus key on the signed rate fields and the decimal keypad on room cost', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    expect(screen.getByLabelText('Min rate (€)')).not.toHaveAttribute('inputmode');
    expect(screen.getByLabelText('Target rate (€)')).not.toHaveAttribute('inputmode');
    expect(screen.getByLabelText('Room cost (€)')).toHaveAttribute('inputmode', 'decimal');
  });

  it.each([
    ['Room cost (€)', 'roomCost'],
    ['Min rate (€)', 'minRate'],
    ['Target rate (€)', 'targetRate'],
  ])('sends 4.5 for a %s typed as 4,5', async (fieldName, key) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    if (key === 'targetRate') fireEvent.change(screen.getByLabelText('Min rate (€)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText(fieldName), { target: { value: '4,5' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse((options as { body: string }).body)).toMatchObject({ [key]: 4.5 });
  });

  it('lets a cleared min rate be retyped, sending the new rate', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    const field = screen.getByLabelText('Min rate (€)') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '' } });
    expect(field.value).toBe('');
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse((options as { body: string }).body)).toMatchObject({ minRate: 5 });
    expect(field.value).toBe('5');
  });

  /** #702. Each bound is inclusive: every field at its edge still saves. */
  it.each([
    ['the lower edges', { durationMinutes: 1, roomCost: 0, minStudents: 1, maxStudents: 1 }],
    ['the class size limit', { maxStudents: MAX_CLASS_SIZE }],
    [
      'the duration and money limits',
      { durationMinutes: DURATION_MAX_MINUTES, roomCost: MONEY_MAX, minRate: -MONEY_MAX, targetRate: MONEY_MAX },
    ],
  ] as const)('saves every number field at %s, with no alert', async (_label, edges) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, ...edges }} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * #702, #708. Room cost and the student-count checks in `numberFieldError`
   * sit behind `if (settingsLocked) return undefined;` — a locked class's
   * stored economics are never sent, so none of the checks below that line
   * may block a save. Each row here stores one out-of-range value behind the
   * gate and saves anyway, pinning the gate's position against a mutation
   * that moves it past any one of the checks it is meant to skip.
   */
  it.each([
    ['a negative room cost', { roomCost: -5 }],
    ['a stored zero min students', { minStudents: 0 }],
    ['a stored fractional min students', { minStudents: 2.5 }],
    ['a stored zero max students', { maxStudents: 0 }],
    ['a stored fractional max students', { maxStudents: 12.5 }],
    ['a stored max students over the class size limit', { maxStudents: MAX_CLASS_SIZE + 1 }],
  ] as const)('locked settings: saves despite %s, with no alert', async (_label, overrides) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR"
        classId="cls-1"
        settingsLocked={true}
        initial={{ ...initial, ...overrides }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * `updateClassSchema` itself has no cross-field refine — it accepts each
   * economic field independently, and `updateClass` (class-lifecycle.ts)
   * checks this rule on the merged row instead, through
   * `economicsViolations` (class-economics.ts). This form calls that same
   * function so a teacher sees the message immediately instead of after a
   * round trip. The pins in the source file cannot guard that the copy still
   * matches the rule — they compare key sets, not predicates — so this test
   * is the only thing that would notice it drifting.
   */
  it('rejects a min rate above target rate before any request is sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR"
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Min rate cannot exceed target rate$/);
    // The pricing preview names the rule instead of pricing it.
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  /**
   * #221. `updateClass` (class-lifecycle.ts) refuses a `minRate` that
   * subsidizes more than the room cost on any economic edit to an unlocked,
   * live class, checked on the merged row through the same
   * `economicsViolations` function this form calls.
   */
  it('rejects min rate subsidizing more than room cost before any request is sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR"
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, roomCost: 20, minRate: -25, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Min rate cannot subsidize more than the room cost — prices would go negative$/,
    );
  });

  it('emits no date bound from a server render (#249)', () => {
    // THE HALF THAT jsdom CANNOT SEE, and the reason the client test below is
    // not enough on its own. This form is a `'use client'` component under a
    // dynamically-rendered server layout, so Next.js server-renders it on
    // every request and React 19 keeps the server's attribute through
    // hydration rather than correcting it. Whatever `min` the server computes
    // is therefore the `min` the teacher gets — and the server's "local" is
    // the container's zone, which no Dockerfile or compose file in this repo
    // sets, so it is UTC and belongs to no teacher. Measured before this
    // assertion existed: a server render under TZ=UTC at 2026-08-19T01:00Z
    // emitted `min="2026-08-19"`, which is tomorrow for the Los Angeles
    // teacher reading it at 18:00 and makes tonight's class unpickable.
    //
    // Asserting ABSENCE rather than a value is deliberate: there is no value
    // the server can correctly emit, because it does not know the teacher's
    // zone at render time. The only correct server render is one that says
    // nothing and lets the browser fill it in. That makes this assertion
    // zone-independent — it holds under this file's pinned America/New_York
    // as it would under UTC — while still reddening the instant anyone calls
    // a clock-reading formatter during render.
    const html = renderToStaticMarkup(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
    );
    // Scoped to the date field's own tag rather than run over the whole
    // document, because this form legitimately server-renders another `min`:
    // the class-size `<input type="range" min="4">` in the pricing preview.
    // A document-wide `not.toMatch(/min="/)` reads like a stricter assertion
    // and is in fact one that can never pass.
    const dateInput = html.match(/<input[^>]*type="date"[^>]*>/);
    expect(dateInput).not.toBeNull();
    expect(dateInput?.[0]).not.toContain('min=');
  });

  it('fills the bound in during hydration, not just on a fresh client render (#249)', async () => {
    // THE ACTUAL PRODUCTION SEQUENCE, which neither test around this one runs.
    // The server-render test renders only to a string, and the client test
    // mounts fresh into an empty container — but what happens in the browser is
    // server HTML, then `hydrateRoot` over it. That distinction is the entire
    // bug this fix exists for: React 19 KEEPS a server-rendered attribute
    // through hydration rather than replacing it with the client's, which is
    // why `min={todayLocal()}` produced a UTC bound that no client render ever
    // corrected.
    //
    // So "the client value wins after hydration" cannot be assumed here — it is
    // the exact assumption that was false before. `useSyncExternalStore` is
    // supposed to make it true by declaring the two snapshots separately, and
    // this asserts that it does.
    //
    // Both halves run in one process at one zone, so this is not a
    // zone-divergence test — the server-render test above owns that. What it
    // pins is the TRANSITION: absent in the server HTML, present after
    // hydration, on the same DOM node.
    const html = renderToString(
      <ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    // Torn down by hand. Testing Library's automatic cleanup only unmounts the
    // containers IT created, so this one survives into the next test — where a
    // second "Date" label turns `getByLabelText` into "Found multiple
    // elements". That is how this test first failed, in a neighbour rather
    // than in itself.
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      const dateInput = container.querySelector('input[type="date"]');
      expect(dateInput).not.toBeNull();
      expect(dateInput?.hasAttribute('min')).toBe(false);

      await act(async () => {
        root = hydrateRoot(
          container,
          <ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
        );
      });

      // The SAME node, now bounded — identity matters. A different node would
      // mean React threw the server HTML away and re-rendered from scratch,
      // which would make the attribute arrive for a reason that does not hold
      // in production.
      expect(container.querySelector('input[type="date"]')).toBe(dateInput);
      expect(dateInput?.getAttribute('min')).toBe(todayLocal());
    } finally {
      if (root) await act(async () => root!.unmount());
      container.remove();
    }
  });

  it('bounds the date picker at today in the local calendar, not UTC (#249)', () => {
    // A hint, not the guard — `updateClass` refuses independently, and #247 is
    // the reason that distinction is worth a comment.
    //
    // The clock is PINNED rather than recomputed, and that is the whole test.
    // An earlier version compared the attribute against
    // `new Date().toISOString().slice(0, 10)` — the same expression the
    // component used — so both sides moved together and it could not fail.
    // 2026-08-19T00:00Z is 18 August 20:00 in America/New_York, the zone
    // `vitest.config.ts` pins; a UTC-derived `min` answers 2026-08-19 and makes
    // tonight's class unpickable on a mobile date input.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    try {
      render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
      expect(screen.getByLabelText('Date')).toHaveAttribute('min', '2026-08-18');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A proxy's HTML error page, not the route's own `{ error }` shape. Read
   * through `readErrorMessage`, this shows the form's own fallback and leaves
   * a console record instead of the generic catch-all copy a `SyntaxError`
   * landing in the outer catch would produce — and #247's refresh-on-refusal
   * still has to fire, since an unreadable body is still a refusal.
   */
  it('shows the fallback, logs, and still refreshes when the refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(htmlResponse(502));
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Could not save the class. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Could not reach the server. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('[class-edit-form] request failed', { err: expect.any(TypeError) });
    // A fetch failure is not a refusal — nothing about it tells this page
    // its data is stale, so there is nothing here for #247's refresh to do.
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('feeds the pricing preview from the rate fields as the teacher types', () => {
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
    fireEvent.change(screen.getByLabelText('Target rate (€)'), { target: { value: '45' } });

    // 8 students on 4–12: 15 + (45 − 15) × 4 / 8 = 30, plus the €20 room
    expect(screen.getByText('€30.00')).toBeTruthy();
    expect(screen.getByText('€50.00')).toBeTruthy();
  });
});

/**
 * #847. The notice follows the entered date and start time against the clock,
 * in the teacher's zone. 2026-06-12 09:30 in Amsterdam is 07:30Z (CEST).
 */
describe('ClassEditForm, late-move notice', () => {
  const initial: ClassEditInitial = {
    classType: 'Vinyasa',
    description: '',
    date: '2026-06-12',
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
    isPrivate: false,
    videoUrl: '',
    pricingMode: 'tiered',
  };
  const warning: MoveWarning = {
    timeZone: 'Europe/Amsterdam',
    cancelDeadline: 'HOURS_12',
    autoCancelCheck: 'HOURS_2',
  };
  const DEADLINE_COPY =
    "The new start is inside this class's cancellation deadline. Students who book after you save can't cancel for free.";

  function open(moveWarning: MoveWarning | null, minStudents = 4) {
    return render(
      <ClassEditForm format="in_person"
        currency="EUR"
        classId="cls-1"
        settingsLocked={false}
        moveWarning={moveWarning}
        initial={{ ...initial, minStudents }}
      />,
    );
  }
  function move(date: string, startTime: string) {
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: startTime } });
  }
  const notice = () => screen.queryByText(/The new start is inside/);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing for an unchanged schedule already inside its deadline', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    expect(notice()).toBeNull();
  });

  it('shows nothing for an edit that leaves the schedule alone', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Yin' } });
    expect(notice()).toBeNull();
  });

  it('moving inside the deadline but before the check shows the deadline copy', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-12', '02:30');
    expect(notice()?.textContent).toBe(DEADLINE_COPY);
  });

  it('moving inside the check window shows the check copy, plural', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-11', '23:30');
    expect(notice()?.textContent).toBe(
      "The new start is inside this class's cancellation deadline and past its auto-cancel check. Students who book after you save can't cancel for free, and the class goes ahead however few book. If fewer than 4 students book, you cover what the missing students would have paid.",
    );
  });

  it('moving inside the check window shows the check copy, singular', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning, 1);
    move('2026-06-11', '23:30');
    expect(notice()?.textContent).toContain(
      'If nobody books, you cover what that student would have paid.',
    );
  });

  it('names the stored min students while the Min students field is cleared', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-11', '23:30');
    fireEvent.change(screen.getByLabelText('Min students'), { target: { value: '' } });
    expect(notice()?.textContent).toContain('If fewer than 4 students book');
  });

  it('moving further away than the deadline shows nothing, and moving back out removes it', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-12', '02:30');
    expect(notice()).not.toBeNull();
    move('2026-06-13', '09:30');
    expect(notice()).toBeNull();
  });

  it('shows nothing while the start time field is cleared', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-12', '02:30');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
    expect(notice()).toBeNull();
  });

  it('shows nothing while the date field is cleared', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-12', '02:30');
    expect(notice()).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '' } });
    expect(notice()).toBeNull();
  });

  it('shows nothing when the timezone cannot be read, though UTC would put the move inside the deadline', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open({ ...warning, timeZone: 'Not/AZone' });
    // Read as UTC, 02:30 on the 12th is 6.5 h out: inside the 12 h deadline, before the 00:30Z check.
    move('2026-06-12', '02:30');
    expect(notice()).toBeNull();
  });

  it('shows nothing without a move warning, however the start moves', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(null);
    move('2026-06-12', '02:30');
    expect(notice()).toBeNull();
  });

  it('appears when the clock crosses the deadline with the form open and no further edit', () => {
    vi.setSystemTime(new Date('2026-06-11T18:00:00Z'));
    open(warning);
    // 11:30 Amsterdam is 09:30Z: deadline 21:30Z the evening before.
    move('2026-06-12', '11:30');
    expect(notice()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 31 * 60 * 1000);
    });
    expect(notice()?.textContent).toBe(DEADLINE_COPY);
  });

  it('still shows the notice when the timer fires a millisecond early', () => {
    vi.setSystemTime(new Date('2026-06-11T18:00:00Z'));
    open(warning);
    move('2026-06-12', '11:30');
    const wake = new Date('2026-06-11T21:30:00.001Z').getTime();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(wake - 1);
    act(() => {
      vi.advanceTimersByTime(3 * 60 * 60 * 1000 + 31 * 60 * 1000);
    });
    clock.mockRestore();
    vi.setSystemTime(wake + 5);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(notice()?.textContent).toBe(DEADLINE_COPY);
  });

  it('sits before the Save button in document order', () => {
    vi.setSystemTime(new Date('2026-06-11T20:00:00Z'));
    open(warning);
    move('2026-06-12', '02:30');
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(notice()!.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('ClassEditForm video link (#911)', () => {
  const initial: ClassEditInitial = {
    classType: 'Vinyasa',
    description: 'Bring a mat.',
    date: '2026-06-12',
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    vatPercent: 0,
    isPrivate: false,
    videoUrl: '',
    pricingMode: 'tiered',
  };
  const fetchMock = vi.fn();
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });
  const LINK = 'https://meet.example/a?pwd=1';
  const ONLINE_INITIAL: ClassEditInitial = { ...initial, roomCost: 0, videoUrl: LINK };

  function renderOnline(settingsLocked = false, over: Partial<ClassEditInitial> = {}) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm format="online" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={{ ...ONLINE_INITIAL, ...over }} />,
    );
  }

  async function save(): Promise<Record<string, unknown>> {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('shows no link field for a class in a room, and never sends one', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm format="in_person" moveWarning={null} currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, videoUrl: '' }} />);
    const body = await save();
    expect(screen.queryByLabelText('Video link (optional)')).toBeNull();
    expect(body).not.toHaveProperty('videoUrl');
  });

  it('shows the stored link with the one-off hint, and no format switch', () => {
    renderOnline();
    const field = screen.getByLabelText('Video link (optional)');
    expect(field).toHaveValue(LINK);
    expect(field).toHaveAccessibleDescription('Only students who have booked see this link.');
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('shows no room cost for an online class and sends none', async () => {
    renderOnline();
    expect(screen.queryByLabelText(/room cost/i)).toBeNull();
    const body = await save();
    expect(body).not.toHaveProperty('roomCost');
  });

  it('sends videoUrl only when it changed', async () => {
    renderOnline();
    const body = await save();
    expect(body).not.toHaveProperty('videoUrl');
  });

  it('sends the normalised new link', async () => {
    renderOnline();
    fireEvent.change(screen.getByLabelText('Video link (optional)'), { target: { value: ' https://meet.example/b ' } });
    expect((await save()).videoUrl).toBe('https://meet.example/b');
  });

  it('sends null for a cleared link', async () => {
    renderOnline();
    fireEvent.change(screen.getByLabelText('Video link (optional)'), { target: { value: '' } });
    expect((await save()).videoUrl).toBeNull();
  });

  it('adds a first link', async () => {
    renderOnline(false, { videoUrl: '' });
    fireEvent.change(screen.getByLabelText('Video link (optional)'), { target: { value: LINK } });
    expect((await save()).videoUrl).toBe(LINK);
  });

  it('is editable on a locked class and sent', async () => {
    renderOnline(true);
    const field = screen.getByLabelText('Video link (optional)');
    expect(field).toBeEnabled();
    fireEvent.change(field, { target: { value: 'https://meet.example/b' } });
    expect((await save()).videoUrl).toBe('https://meet.example/b');
  });

  it('an untouched link follows a refresh and is not sent back', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const props = { format: 'online', moveWarning: null, currency: 'EUR', classId: 'cls-1', settingsLocked: false } as const;
    const { rerender } = render(<ClassEditForm {...props} initial={ONLINE_INITIAL} />);
    rerender(<ClassEditForm {...props} initial={{ ...ONLINE_INITIAL, videoUrl: 'https://meet.example/new' }} />);
    expect(screen.getByLabelText('Video link (optional)')).toHaveValue('https://meet.example/new');
    expect(await save()).not.toHaveProperty('videoUrl');
  });

  it('a typed link survives a refresh and is sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    const props = { format: 'online', moveWarning: null, currency: 'EUR', classId: 'cls-1', settingsLocked: false } as const;
    const { rerender } = render(<ClassEditForm {...props} initial={ONLINE_INITIAL} />);
    fireEvent.change(screen.getByLabelText('Video link (optional)'), { target: { value: 'https://meet.example/mine' } });
    rerender(<ClassEditForm {...props} initial={{ ...ONLINE_INITIAL, videoUrl: 'https://meet.example/new' }} />);
    expect(screen.getByLabelText('Video link (optional)')).toHaveValue('https://meet.example/mine');
    expect((await save()).videoUrl).toBe('https://meet.example/mine');
  });

  it('refuses a link that is not https, without sending', async () => {
    renderOnline();
    fireEvent.change(screen.getByLabelText('Video link (optional)'), { target: { value: 'http://meet.example/b' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a secure link — one that starts with https://');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
