import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { act } from 'react';
import { todayLocal } from '@/lib/format';
import { ClassEditForm, type ClassEditInitial } from './class-edit-form';

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
    render(<ClassEditForm classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);
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

  it('sends an empty description as null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm
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
   * `updateClassSchema`'s minRate/targetRate refine (schemas.ts) is mirrored
   * by hand in `handleSave`, because a client form cannot value-import zod
   * without shipping it to the browser. The pins in the source file cannot
   * guard that mirror — they compare key sets, not predicates — so this test
   * is the only thing that would notice it drifting from the schema.
   */
  it('rejects a min rate above target rate before any request is sent', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/min rate cannot exceed target rate/i)).toBeInTheDocument();
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
      <ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />,
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
      <ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />,
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
          <ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />,
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
      render(<ClassEditForm classId="cls-1" settingsLocked={false} initial={initial} />);
      expect(screen.getByLabelText('Date')).toHaveAttribute('min', '2026-08-18');
    } finally {
      vi.useRealTimers();
    }
  });
});
