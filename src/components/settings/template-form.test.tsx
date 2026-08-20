import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateForm } from './template-form';
import { routerPush } from '../../../tests/setup/components';

/**
 * #85. This form enumerated its thirteen fields three times — the `initial`
 * prop, `INITIAL_VALUES`, and the PUT body — and nothing checked that the three
 * agreed with each other or with `updateClassTemplateSchema`. One list now,
 * compiler-pinned; these tests hold what a pin cannot see, which is what
 * actually reaches the API.
 *
 * The form fetches its room list on mount, so `fetch` is stubbed for every
 * test rather than only the saving ones. The first call is that room fetch;
 * the submit is the last call, which is why the assertions read
 * `mock.calls.at(-1)` rather than `calls[0]`.
 */
describe('TemplateForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial = {
    teacherRoomId: '11111111-1111-4111-8111-111111111111',
    classType: '  Vinyasa  ',
    description: '  Bring a mat.  ',
    dayOfWeek: 2,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
  } as const;

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: '11111111-1111-4111-8111-111111111111',
          capacityOverride: 30,
          rentalRate: 20,
          room: { roomName: 'Studio A', venueName: 'Main Venue' },
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body
   * — so a test can pin `calls.at(-1)` to the request it means. Without that,
   * an intervening `fetch` added later could make `.at(-1)` silently select
   * the wrong call while every body assertion still passed.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all thirteen fields when editing', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates/tpl-1');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      teacherRoomId: '11111111-1111-4111-8111-111111111111',
      classType: 'Vinyasa',
      description: 'Bring a mat.',
      dayOfWeek: 2,
      startTime: '09:30',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24',
      autoCancelCheck: 'HOURS_2',
    });
  });

  it('trims classType and description before sending', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { body } = await submit();
    expect(body.classType).toBe('Vinyasa');
    expect(body.description).toBe('Bring a mat.');
  });

  it('sends a whitespace-only description as null', async () => {
    stubFetch();
    render(
      <TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial, description: '   ' }} />,
    );
    const { body } = await submit();
    expect(body.description).toBeNull();
  });

  /**
   * Create sends the same body to a different endpoint, and
   * `createClassTemplateSchema` requires fields the update one leaves optional
   * — so a body good enough for PUT can still be rejected by POST. Asserting
   * the key set on both modes is what makes the create-side pins in the source
   * file mean something at runtime: a forward pin (`_formCoversCreate`) that
   * every `CreateTemplateWire` field is in the form, and a reverse pin
   * (`_formHasNoExtrasOnCreate`) that the form sends nothing create would
   * silently strip. Both only guard the *key set* — the create and update
   * schemas agree on keys while differing in optionality and `.strict()` —
   * differences a key-set pin can't see, which is exactly what this runtime
   * assertion adds.
   */
  it('sends the same thirteen fields when creating', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates');
    expect(method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });

  /**
   * #85's second half. These two fields were typed `string` against Prisma
   * enums of four and three members, so `update('cancelDeadline', 'HOURS_99')`
   * compiled. The dropdown arrays are now the single source of both the union
   * and the `<option>`s, so the two cannot disagree.
   *
   * This asserts the rendered options rather than the type, because the type is
   * held by the pins in the source file and a runtime test cannot see it. What
   * a runtime test *can* see is that every enum member is actually offered —
   * the failure a teacher would meet is a missing choice, not a type error.
   *
   * Narrower than the spec asked for, deliberately. The spec wanted a test of
   * "the enum guard rejecting a value outside the dropdown". The guards are
   * module-private, and exporting them only so a test can reach them is the
   * pattern PR #131's review rejected. Driving an invalid value through the
   * component is not possible either — the `<option>`s are the same array the
   * guard reads, so there is no way to select one it would refuse. What is
   * left is this: assert that the offered set equals the enum, which is the
   * property the guard exists to preserve.
   */
  it('offers every cancellation deadline the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/cancellation deadline/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_12', 'HOURS_24', 'HOURS_48', 'HOURS_6']);
  });

  it('offers every auto-cancel check the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/auto-cancel check/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_1', 'HOURS_2', 'HOURS_4']);
  });

  /**
   * `createClassTemplateSchema`'s and `updateClassTemplateSchema`'s
   * minRate/targetRate refine (schemas.ts) is mirrored by hand in
   * `handleSubmit`, because a client form cannot value-import zod without
   * shipping it to the browser. The pins in the source file cannot guard
   * that mirror — they compare key sets, not predicates — so this test is
   * the only thing that would notice it drifting from the schema.
   *
   * The room fetch fires on mount, so the fetch-not-called assertion checks
   * the call count did not increase across the click rather than that fetch
   * was never called at all.
   */
  it('rejects a min rate above target rate before any request is sent', async () => {
    stubFetch();
    render(
      <TemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{ ...initial, minRate: 30, targetRate: 25 }}
      />,
    );
    const button = await screen.findByRole('button', { name: /save|create/i });
    const callsBeforeSubmit = fetchMock.mock.calls.length;
    fireEvent.click(button);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSubmit);
    expect(await screen.findByText(/min rate cannot exceed target rate/i)).toBeInTheDocument();
  });

  /**
   * #40. POST /api/class-templates is not idempotent: a second request creates
   * a second template AND regenerates a second set of bookable classes. On
   * create this form pushed and reset `submitting` in a `finally`, so a push
   * that never committed left a populated, re-enabled form — and the obvious
   * second click duplicated the teacher's whole recurring schedule.
   *
   * The assertion is on the fetch count, not on rendered text: a partial fix
   * that only changes a label would satisfy a text assertion while still
   * allowing the second POST.
   */
  // G8
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);

    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/recurring'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to recurring classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // Review F8. The settled action must re-issue the *same* navigation the
    // create did — the source held that path as two literals, and a drifted
    // second one would send the teacher somewhere the create never went while
    // every other assertion here still passed.
    expect(routerPush).toHaveBeenNthCalledWith(2, '/settings/recurring');
  });

  /**
   * Issue 76. Archiving refuses while a room is in use, and an archived room
   * refuses new commitments server-side (publish, resume, create) — but
   * `GET /api/teacher-rooms` itself stays unfiltered, so without this the
   * picker would still offer a room the create door will reject.
   */
  it('omits archived rooms from the picker', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teacher-rooms') {
        return new Response(JSON.stringify({ data: [
          { id: 'tr-live', isArchived: false, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Live Venue', roomName: 'Studio A' } },
          { id: 'tr-archived', isArchived: true, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Archived Venue', roomName: 'Studio B' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    render(<TemplateForm mode="create" />);

    expect(await screen.findByRole('option', { name: /Live Venue/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Archived Venue/ })).not.toBeInTheDocument();
  });

  // Editing a paused template on an archived room must not lose its room.
  it('keeps an archived room in the picker when it is the current selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teacher-rooms') {
        return new Response(JSON.stringify({ data: [
          { id: 'tr-live', isArchived: false, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Live Venue', roomName: 'Studio A' } },
          { id: 'tr-archived', isArchived: true, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Archived Venue', roomName: 'Studio B' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    render(
      <TemplateForm
        mode="edit"
        templateId="tpl-1"
        initial={{ ...initial, teacherRoomId: 'tr-archived' }}
      />,
    );

    expect(await screen.findByRole('option', { name: /Archived Venue/ })).toBeInTheDocument();
  });

  /**
   * Issue 76, step 5. The filter above collapses "no rooms at all" and
   * "rooms exist, all archived" to the same `teacherRooms.length === 0` —
   * without distinguishing them a teacher whose only rooms are archived is
   * told to add a room they already have, with no hint that un-archiving is
   * the way out. This is the branch a teacher actually lands in; nothing
   * else in this file covers it.
   */
  it('tells a teacher whose rooms are all archived to unarchive one, not to add a room', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/teacher-rooms') {
        return new Response(JSON.stringify({ data: [
          { id: 'tr-archived', isArchived: true, rentalRate: '30', capacityOverride: 15,
            room: { venueName: 'Archived Venue', roomName: 'Studio B' } },
        ] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    render(<TemplateForm mode="create" />);

    expect(await screen.findByText(/all your rooms are archived/i)).toBeInTheDocument();
    expect(screen.getByText(/unarchive one in settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/no rooms configured/i)).not.toBeInTheDocument();
  });

  /**
   * PR #262 review. The three states above are distinguished carefully; the
   * fourth was not. A non-ok response returned early leaving `allRoomsCount`
   * at 0, so a teacher whose fetch failed was told to add a room they already
   * own — the message the `allRoomsCount` work exists to prevent, reached down
   * the path nobody looked at. There was also no `catch` at all, so a thrown
   * `fetch` escaped `void fetchRooms()` as an unhandled rejection.
   */
  it('distinguishes a failed room load from an absence of rooms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));

    render(<TemplateForm mode="create" />);

    expect(await screen.findByText(/couldn't load your rooms/i)).toBeInTheDocument();
    expect(screen.queryByText(/no rooms configured/i)).not.toBeInTheDocument();
  });

  it('distinguishes a thrown room fetch from an absence of rooms', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    render(<TemplateForm mode="create" />);

    expect(await screen.findByText(/couldn't load your rooms/i)).toBeInTheDocument();
    expect(screen.queryByText(/no rooms configured/i)).not.toBeInTheDocument();
  });

  /**
   * PR #208 review, C3. #196 made `slotTaken` reachable on create for the
   * first time: a teacher creating a template onto a day/time they already
   * occupy gets a live template whose window came back short. Before this,
   * `handleSubmit` read nothing from the POST body and navigated
   * unconditionally on 201 — a live template, an empty-ish window, a silent
   * redirect and no sentence. `resumeMessage` (`template-action-messages.ts`)
   * is the same formatter the PATCH `active` arm's button uses.
   */
  it('stays on the page and reports a short window instead of navigating away', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/teacher-rooms') {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: '11111111-1111-4111-8111-111111111111',
              capacityOverride: 30,
              rentalRate: 20,
              room: { roomName: 'Studio A', venueName: 'Main Venue' },
            }],
          }),
        };
      }
      if (url === '/api/class-templates' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            data: { id: 'tpl-short', added: 3, blockedByCancelled: 0, slotTaken: 1 },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TemplateForm mode="create" />);
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    expect(
      await screen.findByText(/3 classes on your schedule\. 1 date already had a class\./i),
    ).toBeInTheDocument();
    // `created` still latches — the settled guard is not conditional on the
    // window being full — but no navigation happened: the teacher stays here
    // to read the sentence above instead of landing on the list with no
    // explanation for what they see there.
    expect(routerPush).not.toHaveBeenCalled();
  });

  /**
   * #194, the wire→copy seam on the EDIT branch. The service predicts the
   * first week the new schedule reaches and the route sends its Monday back as
   * `firstEffective`; this pins that the form reads that field, converts the
   * ISO string, and renders the whole sentence.
   *
   * A date on a Monday, since that is what the probe returns and what the
   * copy's "week starting …" phrasing depends on. The seam is worth its own
   * case rather than being left to the e2e: this is the shape #93's
   * wrong-shape bug had — a field that arrives and is silently discarded — and
   * a route that stopped sending `firstEffective` would leave the e2e's own
   * assertion to catch it four minutes later.
   */
  it('names the week an edit takes effect, from the field the route sends', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/teacher-rooms') {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: '11111111-1111-4111-8111-111111111111',
              capacityOverride: 30,
              rentalRate: 20,
              room: { roomName: 'Studio A', venueName: 'Main Venue' },
            }],
          }),
        };
      }
      if (url === '/api/class-templates/tpl-1' && init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            data: { id: 'tpl-1', firstEffective: '2026-09-21T00:00:00.000Z' },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));

    // The whole string, not a prefix: a form that dropped the middle clause
    // would still pass a "Template updated" regex, and the middle clause is
    // the entire content of this change.
    expect(
      await screen.findByText(
        'Template updated. It takes effect for newly generated classes — your first class on the new schedule is the week starting Monday, 21 Sep. Change existing classes individually if needed.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The `null` arm of the same seam, and the reason the form reads
   * `?? null` rather than trusting the field to be there. `new Date(undefined)`
   * is an Invalid Date, and `formatDayHeader` renders one as
   * "undefined, NaN undefined" — a sentence, in teal, on the settings page.
   */
  it('drops the week clause when the response names no week', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/teacher-rooms') {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: '11111111-1111-4111-8111-111111111111',
              capacityOverride: 30,
              rentalRate: 20,
              room: { roomName: 'Studio A', venueName: 'Main Venue' },
            }],
          }),
        };
      }
      if (url === '/api/class-templates/tpl-1' && init?.method === 'PUT') {
        // No `firstEffective` at all — a server predating the field, which is
        // the case `null` and `undefined` have to answer the same way.
        return { ok: true, json: async () => ({ data: { id: 'tpl-1' } }) };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));

    expect(
      await screen.findByText(
        'Template updated. It takes effect for newly generated classes. Change existing classes individually if needed.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * #194's Critical, at the seam this form owns. `/settings/recurring/[id]`
   * renders this form for a paused or archived recurring class exactly as it
   * does for a live one — there is no lifecycle guard on that page, only a
   * choice of which toggle button to show — so this branch runs for every
   * such edit.
   *
   * The service sends `firstEffective: null` and `generationState: 'paused'`
   * for those, and the two are not interchangeable: `null` alone is also what
   * a LIVE template sends when no free week is inside the probe's horizon, and
   * that case correctly drops the clause (the case above). Reading only
   * `firstEffective` here would render the same silent sentence for a template
   * that will never generate at all, which is truthful-but-useless — the
   * failure #194 exists to end.
   */
  it('names the resume when the route says the recurring class is paused', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/teacher-rooms') {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: '11111111-1111-4111-8111-111111111111',
              capacityOverride: 30,
              rentalRate: 20,
              room: { roomName: 'Studio A', venueName: 'Main Venue' },
            }],
          }),
        };
      }
      if (url === '/api/class-templates/tpl-1' && init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            data: { id: 'tpl-1', firstEffective: null, generationState: 'paused' },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));

    expect(
      await screen.findByText(
        'Template updated. It takes effect for newly generated classes — this recurring class is paused, so nothing is generated until you resume it. Change existing classes individually if needed.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The wire is data, not a type. `generationState` is narrowed by comparison
   * against the two states that change the sentence, so an unrecognised value
   * — a newer server, a proxy rewriting the body, a typo in a future arm —
   * lands on `'active'` and renders the pre-#194 sentence rather than reaching
   * `templateUpdatedMessage`'s exhaustive `switch`, which throws on anything
   * it does not know. A thrown error here would replace a confirmation with a
   * blank panel after a save that already committed.
   */
  it('falls back to the plain sentence when the route names a state it does not know', async () => {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url === '/api/teacher-rooms') {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: '11111111-1111-4111-8111-111111111111',
              capacityOverride: 30,
              rentalRate: 20,
              room: { roomName: 'Studio A', venueName: 'Main Venue' },
            }],
          }),
        };
      }
      if (url === '/api/class-templates/tpl-1' && init?.method === 'PUT') {
        return {
          ok: true,
          json: async () => ({
            data: { id: 'tpl-1', firstEffective: null, generationState: 'hibernating' },
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));

    expect(
      await screen.findByText(
        'Template updated. It takes effect for newly generated classes. Change existing classes individually if needed.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * Review F4. `handleSubmit`'s `if (created) return;` cannot be reached
   * through the UI: settlement removes the only submit button, and HTML's
   * implicit submission needs one — or a single field that blocks it, where
   * this form has eight. Its comment used to claim the Enter key as the
   * trigger, which is a trigger that does not exist, and that false story is
   * why the guard went unpinned.
   *
   * A dispatched submit event reaches the handler where the UI cannot, which
   * is what defence-in-depth means: the guard is what holds if a submit button
   * is ever re-added outside the settled branch. Delete the guard and this
   * test fails on a second POST to a non-idempotent endpoint.
   */
  it('ignores a submit event dispatched at the form once created', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);

    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    const classType = screen.getByLabelText('Class type');
    fireEvent.change(classType, { target: { value: 'Vinyasa' } });

    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/recurring'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    const form = classType.closest('form');
    if (!form) throw new Error('expected the fields to still be inside a form after settling');

    // Synchronous up to its own `await`: an unguarded handler calls `fetch`
    // before this line returns, so no waiting is needed to observe it.
    fireEvent.submit(form);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
  });
});
