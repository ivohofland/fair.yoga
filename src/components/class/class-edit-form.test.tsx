import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { todayLocal } from '@/lib/format';
import { MAX_CLASS_SIZE } from '@/lib/schemas';
import { routerRefresh } from '../../../tests/setup/components';
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
 * five economic fields are sent, and getting it wrong means either a teacher
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
  };

  async function saveWith(settingsLocked: boolean): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('sends every editable field when settings are unlocked', async () => {
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
    });
  });

  /**
   * Pins that the five economic keys do not reach the API when settings are
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
  it('omits the economic fields when settings are locked', async () => {
    const body = await saveWith(true);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'date', 'description', 'durationMinutes', 'startTime',
    ]);
    for (const f of ['roomCost', 'minRate', 'targetRate', 'minStudents', 'maxStudents']) {
      expect(body).not.toHaveProperty(f);
    }
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
      <ClassEditForm currency="EUR"
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
      <ClassEditForm currency="EUR"
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
   * Checked regardless of `settingsLocked`: these three are DETAILS, always
   * editable and always sent regardless of lock state (see the file-level
   * comment above the component), unlike the five economic fields the block
   * below strips when locked. The final case pins exactly that — clearing
   * start time with `settingsLocked={true}` still refuses, which a guard
   * placed inside the unlocked branch would fail to do.
   */
  it.each([
    ['class type', 'Class type', '   ', false, /^Enter a class type$/],
    ['date', 'Date', '', false, /^Select a date$/],
    ['start time', 'Start time', '', false, /^Enter a start time$/],
    ['start time, settings locked', 'Start time', '', true, /^Enter a start time$/],
  ] as const)(
    'refuses a cleared %s before any request, with product copy',
    async (_label, fieldName, clearedValue, settingsLocked, copy) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);

      fireEvent.change(screen.getByLabelText(fieldName), { target: { value: clearedValue } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    },
  );

  /**
   * #702. The number inputs store `Number(value)`, so a cleared one is `0`,
   * and nothing native bounds them: this form has no `<form>` element. The
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
  ] as const)(
    'refuses %s before any request, with product copy',
    async (_label, fieldName, value, settingsLocked, copy) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);

      fireEvent.change(screen.getByLabelText(fieldName), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(copy);
    },
  );

  /** #702. Each bound is inclusive: every field at its edge still saves. */
  it.each([
    ['the lower edges', { durationMinutes: 1, roomCost: 0, minStudents: 1, maxStudents: 1 }],
    ['the class size limit', { maxStudents: MAX_CLASS_SIZE }],
  ] as const)('saves every number field at %s, with no alert', async (_label, edges) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={{ ...initial, ...edges }} />);
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
      <ClassEditForm currency="EUR"
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
      <ClassEditForm currency="EUR"
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/min rate cannot exceed target rate/i)).toBeInTheDocument();
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
      <ClassEditForm currency="EUR"
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
      <ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
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
      <ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
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
          <ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />,
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
      render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);
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
    render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);

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
    render(<ClassEditForm currency="EUR" classId="cls-1" settingsLocked={false} initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Could not reach the server. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith('[class-edit-form] request failed', { err: expect.any(TypeError) });
    // A fetch failure is not a refusal — nothing about it tells this page
    // its data is stale, so there is nothing here for #247's refresh to do.
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('feeds the pricing preview from the rate fields as the teacher types', () => {
    render(<ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />);
    fireEvent.change(screen.getByLabelText('Target rate (€)'), { target: { value: '45' } });

    // 8 students on 4–12: 15 + (45 − 15) × 4 / 8 = 30, plus the €20 room
    expect(screen.getByText('€30.00')).toBeTruthy();
    expect(screen.getByText('€50.00')).toBeTruthy();
  });
});
