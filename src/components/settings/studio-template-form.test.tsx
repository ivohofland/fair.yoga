import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StudioTemplateForm } from './studio-template-form';
import { routerPush } from '../../../tests/setup/components';

/**
 * #136. This form enumerated its six fields four times — the `initial` prop's
 * inline type, `INITIAL_VALUES`, the POST/PUT body, and the caller's own
 * inline literal in `settings/studio-classes/[id]/page.tsx` — and nothing
 * checked that they agreed with each other or with
 * `createStudioClassTemplateSchema` / `updateStudioClassTemplateSchema`.
 * That fourth copy is why `StudioTemplateFormValues` is exported rather than
 * kept module-private. The compile-time pins in the source file hold it
 * against both wire schemas; this test holds what a pin cannot see, which is
 * what actually reaches the API in each mode.
 *
 * Neither mode fetches anything on mount, so the submit request is the first
 * (and only) `fetch` call.
 */
describe('StudioTemplateForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body
   * — so a test can pin `calls.at(-1)` to the request it means.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  const SIX_KEYS = ['classType', 'dayOfWeek', 'durationMinutes', 'hourlyRate', 'location', 'startTime'];

  /**
   * One body serves two endpoints, so the key-set has to hold in both modes —
   * a create-only or edit-only assertion would miss a schema that drifted
   * only on the other endpoint. Each mode gets its own `render`/`unmount`
   * rather than `rerender`, because `useState(initial ?? INITIAL_VALUES)`
   * only reads its initializer on mount: reusing one instance across modes
   * would carry the create-mode fill-ins into the edit-mode assertion instead
   * of exercising `initial` at all.
   */
  it('sends the same six fields in both create and update modes', async () => {
    stubFetch();
    const create = render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    const created = await submit();
    expect(created.url).toBe('/api/studio-class-templates');
    expect(created.method).toBe('POST');
    expect(Object.keys(created.body).sort()).toEqual(SIX_KEYS);
    create.unmount();

    fetchMock.mockReset();
    stubFetch();
    render(
      <StudioTemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{
          classType: 'Vinyasa',
          dayOfWeek: 2,
          startTime: '09:30',
          durationMinutes: 60,
          location: 'Studio A',
          hourlyRate: 20,
        }}
      />,
    );
    const updated = await submit();
    expect(updated.url).toBe('/api/studio-class-templates/tpl-1');
    expect(updated.method).toBe('PUT');
    expect(Object.keys(updated.body).sort()).toEqual(SIX_KEYS);
  });

  /**
   * The key-set test above uses inputs with no whitespace, so it cannot see
   * `form.classType.trim()` / `form.location.trim()` in `handleSubmit`'s
   * payload construction. This asserts the full body by value.
   */
  it('trims classType and location before sending', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '  Vinyasa  ' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: '  Studio A  ' } });
    const created = await submit();
    expect(created.body).toEqual({
      classType: 'Vinyasa',
      dayOfWeek: 0,
      startTime: '09:00',
      durationMinutes: 60,
      location: 'Studio A',
      hourlyRate: 0,
    });
  });

  /**
   * #40, the studio twin of the class-template guard. POST
   * /api/studio-class-templates is not idempotent: a second request creates a
   * second template and a second generated window, double-counting studio
   * income. Asserted on the fetch count, not on rendered text.
   *
   * `handleSubmit` only guards `location` before the request (not `classType`),
   * but both are filled here to match the create-mode setup used by the tests
   * above — an empty `classType` reaching the server is not this test's
   * concern, and filling it keeps this test unaffected if that guard changes.
   */
  // G9
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to studio classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // Review F8, as in the class-template twin: one path, asserted on both the
    // create push and the settled retry.
    expect(routerPush).toHaveBeenNthCalledWith(2, '/settings/studio-classes');
  });

  /**
   * PR #208 review, C3. #196 made `slotTaken` reachable on create for the
   * first time: a teacher creating a template onto a day/time they already
   * occupy gets a live template whose window came back short. Before this,
   * `handleSubmit` read nothing from the POST body and navigated
   * unconditionally on 201. `resumeStudioMessage` is the same formatter the
   * PATCH `active` arm's button uses.
   */
  it('stays on the page and reports a short window instead of navigating away', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: 'tpl-short',
          added: 2,
          // All FOUR members: the create path is gated on `hasIntegerCounts`
          // since PR #300's third pass, so a three-member fixture is refused
          // and the page navigates instead — which is how this fixture was
          // found stale, the same way the two toggle-button ones were.
          counts: {
            blockedByCancelled: 1,
            slotTaken: 0,
            alreadyThisWeek: 0,
            blockedByOtherFamily: 0,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    expect(
      await screen.findByText(
        /2 classes on your schedule\. 1 cancelled class still holds that date\./i,
      ),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  /**
   * PR #300 fourth pass. The arm this file stopped covering.
   *
   * Splitting one `else` into two — clean window versus unreadable payload —
   * moved three existing tests off the arm they were covering without failing
   * any of them. `stubFetch()` returns no usable `data`, which the OLD gate
   * read as falsy and sent down the single `else` that carried both cases; the
   * new gate sends it to the diagnostic arm instead. No fixture supplied a
   * full four-integer all-zeros `counts`, so the primary success path of
   * creating a template — 201, full window, navigate to the list — had zero
   * coverage, and had coverage before that change.
   *
   * Mutation-proved: deleting the clean-window `router.push` failed nothing at
   * that commit, and failed two tests at its parent.
   *
   * Asserts `console.warn` was NOT called as well as the push, because half of
   * what needs pinning is that a WELL-FORMED clean payload does not take the
   * diagnostic branch — the regression that produced this test.
   */
  it('navigates on a clean window, without warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: 'tpl-clean',
          added: 4,
          counts: {
            blockedByCancelled: 0,
            slotTaken: 0,
            alreadyThisWeek: 0,
            blockedByOtherFamily: 0,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * PR #300 fourth pass. The diagnostic arm this file never had.
   *
   * The third pass put the `hasIntegerCounts` gate into BOTH create forms and
   * a test under only one of them. Measured on this file: deleting the
   * `console.warn` below, deleting the `hasIntegerCounts` term, and deleting
   * the `Number.isInteger(result.added)` term each failed nothing. A guard
   * added to twin files and pinned in one reads as covered to anyone who greps
   * for the guard, and reads as uncovered only to someone who tries to break
   * it — which is the shape this PR has now hit four times.
   *
   * The class twin's version of this test is
   * `'warns rather than silently deciding, when the counts payload is
   * unreadable'`; this is deliberately its mirror rather than a variation, so
   * that a future change to either gate fails on both sides at once.
   *
   * `counts` present but one-membered — a bundle against a rolled-back server,
   * not a truncated body: a body that does not parse throws inside
   * `res.json()` and is caught as "Network error" without ever reaching this
   * gate. `anyBlocked` reduces over the PAYLOAD's own values, so this fixture
   * reduces to `false` and took the clean-window path in silence before the
   * gate existed.
   */
  it('warns rather than silently deciding, when the counts payload is unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { id: 'tpl-short-payload', added: 0, counts: { blockedByCancelled: 0 } },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/unreadable counts/i);
    warn.mockRestore();
  });

  /**
   * PR #300 fourth pass. The gate's OTHER term, which nothing could break.
   *
   * The test above pins `hasIntegerCounts`; this one pins
   * `Number.isInteger(result.added)`. Measured: deleting that term failed
   * nothing across both form suites, because every fixture reaching the
   * diagnostic arm carried a well-formed integer `added` and was refused on
   * its `counts` alone. A term no fixture can fail is a term the next reader
   * may delete as redundant.
   *
   * The fixture is the shape that makes it not redundant: `counts` whole and
   * four-membered, `added` absent. Nesting the counts under `counts` (#296)
   * MOVED fields on this very payload, so a bundle one deploy out of step with
   * its server is exactly how one half of a shape arrives intact and the other
   * does not.
   *
   * A SHORT window deliberately, not a clean one, because `added` is only read
   * on the short arm: `resumeStudioMessage(result.added, result.added, …)`
   * builds its head with a template literal, so an ungated `undefined` is not
   * a silent wrong number but the word "undefined" rendered into a sentence
   * the teacher reads — which is what the last assertion names.
   */
  it('refuses a payload whose counts survive but whose added does not', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        // No `added` at all. `counts` is whole, so `hasIntegerCounts` passes
        // and this payload reaches the diagnostic arm on the `added` term or
        // not at all.
        data: {
          id: 'tpl-no-added',
          counts: {
            blockedByCancelled: 1,
            slotTaken: 0,
            alreadyThisWeek: 0,
            blockedByOtherFamily: 0,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));
    expect(warn).toHaveBeenCalled();
    expect(screen.queryByText(/undefined/)).toBeNull();
    warn.mockRestore();
  });

  /**
   * PR #300 fourth pass, the class twin's mirror. Pins the sentence the two
   * arms above are JUSTIFIED by, because the first version of that sentence
   * was wrong.
   *
   * The diagnostic arm's comment named "a truncated body" as its motivating
   * case. A truncated body never gets there: `await res.json()` is inside the
   * `try`, so a body that will not parse throws and lands in the outer
   * `catch` as "Network error. Please try again." — the same route
   * `class-edit-form.tsx` already records for "a truncated body or a 502 with
   * no JSON". The case the gate actually defends is a body that parses
   * cleanly into the WRONG SHAPE: a tab holding this bundle against a
   * rolled-back server.
   *
   * Worth a test rather than a corrected comment alone: an unpinned claim
   * about which code path a failure takes is exactly the kind that was wrong
   * here in the first place.
   */
  it('reports a network error, not an unreadable payload, when the body will not parse', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: true,
      // What a 201 with a truncated body does at this seam: `res.json()`
      // rejects. Real `Response.json()` throws a `SyntaxError`.
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(warn).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  /**
   * PR #300 review, C2 — the studio mirror. The gate enumerated
   * `blockedByCancelled > 0 || slotTaken > 0`; #296's `blockedByOtherFamily` is
   * reachable on create here too (a manually logged `Class` at that day and
   * time does not block creating a studio TEMPLATE, since the template trigger
   * reads `ClassTemplate`), and the window came back short in silence.
   *
   * Note the sentence names the OTHER family — "your own classes" — where the
   * class family's twin says "studio classes". On this side the neighbouring
   * `slotTaken` clause already means another STUDIO class, so the distinction
   * is doing real work rather than restating.
   */
  it('reports a window the OTHER family holds, instead of navigating away', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: 'tpl-other-family',
          added: 0,
          counts: {
            blockedByCancelled: 0,
            slotTaken: 0,
            alreadyThisWeek: 0,
            blockedByOtherFamily: 2,
          },
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Studio A' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    expect(
      await screen.findByText(/2 dates are held by your own classes\./i),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  /**
   * Review F4, the studio twin. The `if (created) return;` guard is
   * unreachable through the UI — no submit button survives settling, and
   * implicit submission needs one or a single blocking field, where this form
   * has five — so a dispatched submit event is what pins it. Without the
   * guard this sends a second POST to a non-idempotent endpoint.
   */
  it('ignores a submit event dispatched at the form once created', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    const location = screen.getByLabelText('Location');
    fireEvent.change(location, { target: { value: 'Studio A' } });

    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    const form = location.closest('form');
    if (!form) throw new Error('expected the fields to still be inside a form after settling');

    fireEvent.submit(form);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
  });
});
