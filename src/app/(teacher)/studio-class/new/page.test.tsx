import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewStudioClassPage from './page';
import { routerPush } from '../../../../../tests/setup/components';

/**
 * #136. This page keeps its six fields in separate `useState` hooks and used to
 * restate them again in the POST body, with nothing checking the two agreed
 * with `createStudioClassSchema`. The hooks are still there; only the
 * duplication in the body went — the body is now spread from
 * `StudioClassFormValues`. The compile-time pins in the source file hold
 * `StudioClassFormValues` against the schema with no exclusions — `studentCount`
 * and `templateId` are gone from the create schema entirely as of #148, for
 * the reasons at `page.tsx:28-40` — this test holds what a pin cannot see,
 * which is what actually reaches the API.
 *
 * The page fetches nothing on mount, so the submit request is the first (and
 * only) `fetch` call.
 */
describe('NewStudioClassPage', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 'studio-class-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends exactly these six fields', async () => {
    stubFetch();
    render(<NewStudioClassPage />);

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });

    const button = screen.getByRole('button', { name: /log class/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));

    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;

    expect(url).toBe('/api/studio-classes');
    expect(opts.method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'classType',
      'date',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
    ]);
  });

  /**
   * The key-set test above uses inputs with no whitespace and numeric fields
   * that happen to look the same whether or not `Number(...)` runs, so it
   * cannot see `classType.trim()`, `location.trim()`, or the `Number(...)`
   * calls on `durationMinutes`/`hourlyRate` in `page.tsx`'s `handleSubmit`.
   * This test feeds padded text and asserts the full body by value —
   * including `typeof` via `toEqual`, which distinguishes `75` from `'75'`.
   */
  it('trims text fields and sends duration and rate as numbers', async () => {
    stubFetch();
    render(<NewStudioClassPage />);

    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '  Vinyasa  ' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  Studio A  ' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:15' } });
    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '75' } });
    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '22.5' } });

    const button = screen.getByRole('button', { name: /log class/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));

    const [, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    const body = JSON.parse(opts.body) as Record<string, unknown>;

    expect(body).toEqual({
      classType: 'Vinyasa',
      location: 'Studio A',
      date: '2026-08-10',
      startTime: '10:15',
      durationMinutes: 75,
      hourlyRate: 22.5,
    });
  });

  /**
   * Fills everything `handleSubmit` gates before the request — class type,
   * location, and date — so the settled-state tests below reach the POST for
   * the same reason the body tests above do.
   */
  function fillRequired() {
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
  }

  /**
   * #282 / #310. All wire-required fields of `StudioClassFormValues` are validated
   * client-side before any request, refusing invalid values with product copy
   * rather than letting raw Zod developer copy return from the server.
   *
   * The two assertions pin different things — the request not being sent, and
   * the exact copy. On the realistic continuing-guard mutant (the guard fires
   * but its `return` is dropped) both go red: `handleSubmit` clears `error`
   * just before the request, so this banner assertion finds nothing and
   * throws — a red that would read as a missing guard, where the spy's red
   * names the outgoing request. Asserted against a stubbed `fetch` because
   * `tests/setup/components.ts` does not mock it — "not called" must be a spy
   * fact, not an inference from absent network noise.
   *
   * A second submit fills `'   '` — whitespace-only is the boundary the
   * guard's `.trim()` exists for: drop the trim and `''` still refuses while
   * `'   '` reaches the wire schema's `min(1)` and raw Zod returns. The edit
   * form's test (`studio-class-edit-form.test.tsx`) pins the same boundary.
   */
  it('refuses a blank class type before any request, with product copy and alert role', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    // `Class type` is deliberately left empty; everything else that gates the
    // request is filled so only the missing class type can be the reason.
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });

    // The handler is synchronous up to its own `await`: with no guard it calls
    // `fetch` during this click, so neither assertion below needs waiting.
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Class type is required.');

    // Editing the field immediately clears the complaint banner before the next submit (#313)
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '   ' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Class type is required.');
  });

  it('clears error banner when any input field is edited', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Class type is required.');

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * #310. Clearing durationMinutes or entering a non-positive / non-integer
   * duration refuses before any request with product copy.
   */
  it('refuses a blank or invalid duration before any request, with product copy', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter how many minutes the class runs.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '-15' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '45.5' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * #310. Clearing hourlyRate or entering a negative value refuses before any
   * request with product copy. Explicit 0 is allowed for unpaid classes.
   */
  it('refuses a blank or negative hourly rate before any request, with product copy', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Enter an hourly rate — 0 if this class is unpaid.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows 0 as an explicit hourly rate', async () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.change(screen.getByLabelText('Hourly rate'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls.at(-1) ?? [];
    const body = JSON.parse(options?.body as string);
    expect(body.hourlyRate).toBe(0);
  });

  /**
   * #316. The banner validates sequentially, one message at a time, so a
   * teacher walking an empty form reads every message in the same element
   * seconds apart — which makes the three a single copy set rather than three
   * independent strings. These pin the two the classType round left bare.
   *
   * Each submit fills only the fields ahead of the one under test: the guards
   * run classType then location then date, and the first to fire wins. The
   * second copy assertion is falsifiable here where it is not above, because
   * the two submits raise different strings — stale state cannot satisfy it.
   */
  it('refuses a blank location, then a blank date, with punctuated copy', () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Location is required.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(screen.getByRole('button', { name: /log class/i }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Date is required.')).toBeInTheDocument();
  });

  /**
   * #40, whole-branch review F1. This page was outside the branch's census,
   * which was scoped to `src/components/` and `src/lib/` — but it carries the
   * same defect in the same shape: `router.push` on success with
   * `finally { setSubmitting(false) }` behind it, so a push that never commits
   * leaves a populated form with "Log class" re-enabled.
   *
   * `POST /api/studio-classes` writes a bare entry-plus-class pair with no
   * dedupe, and the entry's only unique key is
   * `@@unique([scheduleRuleId, date])`, which a manually logged class cannot
   * trip: its `scheduleRuleId` is null, and Postgres treats NULLs as distinct.
   *
   * WHAT THE SECOND CLICK COSTS CHANGED IN #327, and the guard is still the
   * fix. `CalendarEntry_teacher_slot_excl` spans both families, so a second
   * entry on the same span is refused and the double-count it used to produce
   * is gone; the second request answers 409 instead. An error for clicking
   * twice on a form that was working is still the wrong outcome, and only this
   * guard stops the request going out.
   *
   * Asserted on the fetch count, not on rendered text: a partial fix that only
   * changed a label would satisfy a text assertion and still allow the second
   * POST.
   */
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith('/studio-class/studio-class-1'),
    );

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /log class/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to the studio class/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // One module-level `studioClassPath`, asserted on both pushes (review F8).
    expect(routerPush).toHaveBeenNthCalledWith(2, '/studio-class/studio-class-1');
  });

  /**
   * Review F4. `handleSubmit`'s `if (createdId) return;` cannot be reached
   * through the UI — settling removes the only submit button, and implicit
   * submission needs one, or a single field that blocks it where this form has
   * six. A dispatched submit event reaches the handler where the UI cannot,
   * which is what defence-in-depth means: the guard is what holds if a submit
   * control is ever re-added outside the settled branch.
   */
  it('ignores a submit event dispatched at the form once created', async () => {
    stubFetch();
    render(<NewStudioClassPage />);
    fillRequired();

    fireEvent.click(screen.getByRole('button', { name: /log class/i }));
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith('/studio-class/studio-class-1'),
    );

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    const form = screen.getByLabelText('Location').closest('form');
    if (!form) throw new Error('expected the fields to still be inside a form after settling');

    // Synchronous up to its own `await`: an unguarded handler calls `fetch`
    // before this line returns, so no waiting is needed to observe it.
    fireEvent.submit(form);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
  });
});
