import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewClassForm } from './new-class-form';
import { MAX_CLASS_SIZE } from '@/lib/schemas';
import { routerPush } from '../../../../../tests/setup/components';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';

const ROOM = {
  id: ROOM_ID,
  roomId: 'room-1',
  capacityOverride: 30,
  rentalRate: 20,
  room: { roomName: 'Studio A', venueName: 'Main Venue' },
};

/**
 * #136. This wizard restates its thirteen fields three times — the `FormData`
 * interface, `INITIAL_FORM`, and the POST body (the last derived from `form`
 * with `description` normalized at submit — see `page.tsx`) — and nothing
 * checked that the three agreed with each other or with `createClassSchema`.
 * The compile-time pins in the source file hold `FormData` against the
 * schema; this test holds what a pin cannot see, which is what actually
 * reaches the API.
 *
 * The wizard fetches the teacher's rooms on mount, so `fetch` is stubbed with
 * room-shaped data for every test, and the submit call is the *second* fetch
 * call, not the first.
 */
describe('NewClassPage', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * A real `Response` whose `json()` genuinely throws — the shape a proxy's
   * HTML error page takes, which the plain object stubs elsewhere in this
   * file cannot express.
   */
  function htmlResponse(status = 502): Response {
    return new Response('<html><body>502 Bad Gateway</body></html>', {
      status,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  /**
   * The room-list mount fetch answers normally; only the create POST answers
   * with an unreadable body, so the wizard reaches step 4 and submits before
   * hitting the refusal.
   */
  function stubFetchCreateRefusing() {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/classes' ? htmlResponse(502) : { ok: true, json: async () => ({ data: [ROOM] }) }),
    );
    vi.stubGlobal('fetch', fetchMock);
  }

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [ROOM] }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * The stub above answers every call with the room list, which is all the
   * body assertions need. The settled state needs more: the wizard reads
   * `data.id` off the *create* response to know where it was navigating. This
   * answers by URL rather than by call order, so an added mount fetch could
   * not silently feed the room list to the create call.
   */
  function stubFetchCreating(id: string) {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/classes'
          ? { ok: true, json: async () => ({ data: { id } }) }
          : { ok: true, json: async () => ({ data: [ROOM] }) },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body —
   * so a test can pin `calls.at(-1)` to the request it means. Without that, an
   * intervening `fetch` added later could make `.at(-1)` silently select the
   * wrong call while every body assertion still passed.
   *
   * `toBeGreaterThan(1)`, not `(0)`: the mount fetch for the teacher's rooms
   * is call zero, so the submit is never the first call.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /create|save/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return { url: url as string, method: opts.method, body: JSON.parse(opts.body) as Record<string, unknown> };
  }

  /**
   * Advances through all four steps, filling only what `validateStep` gates
   * (step 1: room, class type, date, start time — duration keeps its valid
   * default; step 2 and step 3 defaults already validate), then submits.
   */
  async function fillAndSubmit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    render(<NewClassForm currency="EUR" />);

    // Step 1: Basics
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Pricing — defaults already validate once a room is selected.
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 3: Policies — validateStep has no branch for this step.
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 4: Confirm and submit.
    return submit();
  }

  /**
   * A key-set assertion alone cannot see a value transposed between two
   * same-typed fields — e.g. `minRate` and `targetRate` swapped — because
   * both are still numbers, in a body with the same thirteen keys. That matters
   * more here than anywhere else in this batch: this is the one form in scope
   * carrying pricing fields, and `createClassSchema`'s refinements
   * (`minRate <= targetRate`, `minRate >= -roomCost`) reject some wrong
   * combinations but would happily accept plenty of wrong-but-well-typed
   * ones. `toEqual` on the whole body subsumes the key-set check and catches
   * value drift too, so it replaces that check rather than sitting beside it.
   *
   * `fillAndSubmit` only types `classType`, `date`, and `startTime` (via the
   * room select, `teacherRoomId`); `roomCost`, `maxStudents`, and
   * `minStudents` come from `handleRoomChange` reacting to the selected
   * room's `rentalRate` (20) and `capacityOverride` (30) — see `stubFetch`
   * above — and everything else is `INITIAL_FORM`'s default, untouched by
   * step 2 and step 3's no-op "Next" clicks.
   */
  it('sends exactly these thirteen fields, with the values the wizard actually produces', async () => {
    stubFetch();
    const { url, method, body } = await fillAndSubmit();
    expect(url).toBe('/api/classes');
    expect(method).toBe('POST');
    expect(body).toEqual({
      teacherRoomId: ROOM_ID,
      classType: 'Vinyasa',
      description: null,
      date: '2026-08-10',
      startTime: '09:00',
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

  it('sends description when entered and renders it in step 4 review', async () => {
    stubFetch();
    render(<NewClassForm currency="EUR" />);

    // Step 1: Basics
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Bring a yoga mat and water.  ' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Pricing
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 3: Policies
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 4: Review
    expect(await screen.findByText('Review your class')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Bring a yoga mat and water.')).toBeInTheDocument();

    const { body } = await submit();
    expect(body.description).toBe('Bring a yoga mat and water.');
  });

  it('sends whitespace-only description as null', async () => {
    stubFetch();
    render(<NewClassForm currency="EUR" />);

    // Step 1: Basics
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Pricing
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 3: Policies
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 4: Review - description row should not be rendered
    expect(await screen.findByText('Review your class')).toBeInTheDocument();
    expect(screen.queryByText('Description')).toBeNull();

    const { body } = await submit();
    expect(body.description).toBeNull();
  });

  it('sends empty-string description as null', async () => {
    stubFetch();
    render(<NewClassForm currency="EUR" />);

    // Step 1: Basics
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Pricing
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 3: Policies
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 4: Review - description row should not be rendered
    expect(await screen.findByText('Review your class')).toBeInTheDocument();
    expect(screen.queryByText('Description')).toBeNull();

    const { body } = await submit();
    expect(body.description).toBeNull();
  });

  it('renders formatted date, time, and class summary on the step 4 review screen', async () => {
    stubFetch();
    render(<NewClassForm currency="EUR" />);

    // Step 1: Basics
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Pricing
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 3: Policies
    fireEvent.click(await screen.findByRole('button', { name: /next/i }));

    // Step 4: Review
    expect(await screen.findByText('Review your class')).toBeInTheDocument();
    expect(screen.getByText('Date & time')).toBeInTheDocument();
    expect(screen.getByText(/10 Aug 2026 at 09:00 · 60 min/)).toBeInTheDocument();
    expect(screen.getByText('Vinyasa')).toBeInTheDocument();
    expect(screen.getByText('Studio A at Main Venue')).toBeInTheDocument();
    expect(screen.queryByText('Description')).toBeNull();
  });

  /**
   * A proxy's HTML error page, not the route's own `{ error }` shape. Read
   * through `readErrorMessage`, this shows the wizard's own fallback and
   * leaves a console record instead of the outer catch's generic
   * unreadable-network copy a `SyntaxError` landing there would produce.
   */
  it('shows the fallback and logs when the create refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetchCreateRefusing();
    await fillAndSubmit();

    expect(await screen.findByText('Failed to create class')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
  });

  /**
   * A 2xx means the server accepted the create, so an unreadable body must
   * not read as a failure that invites a resend. The wizard has no id to
   * settle on or push to, so it neither settles nor navigates; "Create
   * class" is disabled instead of staying enabled for a click that would
   * resend the same create.
   */
  it('shows the fallback and logs when the create success body is unreadable, and does not navigate', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/classes' ? htmlResponse(201) : { ok: true, json: async () => ({ data: [ROOM] }) },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fillAndSubmit();

    expect(
      await screen.findByText('Class created — find it on your Schedule.'),
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[class-new] created, but the response was unreadable',
      expect.objectContaining({ err: expect.anything() }),
    );
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create class/i })).toBeDisabled();
  });

  /**
   * H. Same outcome as the test above, reached through a readable body that
   * lacks `data.id` rather than an unreadable one — the `typeof … !==
   * 'string'` guard is what catches this shape.
   */
  it('shows the fallback and logs when the create success body has no id, and does not navigate', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === '/api/classes'
          ? { ok: true, status: 201, json: async () => ({ data: {} }) }
          : { ok: true, json: async () => ({ data: [ROOM] }) },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fillAndSubmit();

    expect(
      await screen.findByText('Class created — find it on your Schedule.'),
    ).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[class-new] created, but the response was unreadable',
      expect.objectContaining({ err: expect.anything() }),
    );
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create class/i })).toBeDisabled();
  });

  it('shows network copy and logs when the create request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) =>
      url === '/api/classes'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve({ ok: true, json: async () => ({ data: [ROOM] }) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fillAndSubmit();

    expect(await screen.findByText('Could not reach the server. Try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[class-new] request failed',
      expect.objectContaining({ err: expect.any(TypeError) }),
    );
  });

  /**
   * #40, whole-branch review F1. A push that never commits must not leave a
   * populated review step with "Create class" re-enabled — that invites a
   * resend of the same create.
   *
   * The assertion is on the fetch count, not on rendered text: a partial fix
   * that only changed a label would satisfy a text assertion and still allow
   * the second POST.
   */
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetchCreating('class-1');
    await fillAndSubmit();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/class/class-1'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create class$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to the class/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
    // The retry must re-issue the *same* navigation the create did — one
    // module-level `classPath`, asserted on both pushes (review F8).
    expect(routerPush).toHaveBeenNthCalledWith(2, '/class/class-1');
  });

  /**
   * PR #198 review P2. The settled state replaced the *submit* control and
   * left the wizard's other exit alone. Steps 1–3 are still mounted state —
   * populated, valid and editable — so after a create whose push was dropped,
   * Back walked the teacher into a form for a class that already exists. Edit
   * the date, page forward, and step 4 shows the same "Created" notice, still
   * pointing at the original class: every edit in that detour is discarded in
   * silence, and the teacher has no way to tell.
   *
   * Not a duplicate-create risk — `createdId` replaces the submit button, so
   * `handleSubmit` stays unreachable however many times the wizard is paged.
   * The harm is lost edits, which is quieter.
   *
   * The assertion is that the control is gone, not that clicking it is inert:
   * a disabled Back on a settled wizard would still say "there is more to do
   * here" about a class that is finished.
   */
  it('offers no way back into the form once the create has settled', async () => {
    stubFetchCreating('class-1');
    await fillAndSubmit();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/class/class-1'));
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull();
    expect(screen.queryByLabelText('Date')).toBeNull();
  });

  /**
   * PR #198 review P2, second half. Both the settled notice and `submitError`
   * render inside `{step === 4 && …}`, so leaving step 4 while the POST is in
   * flight discards the outcome — success and failure alike. The teacher saw
   * step 3 exactly as though nothing had been submitted, over a request that
   * was still on its way to creating a class.
   *
   * The create promise is held open across the Back click and released only
   * after it, so the click lands squarely mid-flight rather than racing it.
   */
  it('keeps the outcome on screen when Back is clicked mid-flight', async () => {
    type StubResponse = { ok: boolean; json: () => Promise<unknown> };
    let release!: (value: StubResponse) => void;
    fetchMock.mockImplementation(
      (url: string): Promise<StubResponse> =>
        url === '/api/classes'
          ? new Promise<StubResponse>((resolve) => {
              release = resolve;
            })
          : Promise.resolve({ ok: true, json: async () => ({ data: [ROOM] }) }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fillAndSubmit();

    const back = screen.getByRole('button', { name: /^back$/i });
    expect(back).toBeDisabled();
    fireEvent.click(back);
    expect(screen.getByText('Review your class')).toBeInTheDocument();

    release({ ok: true, json: async () => ({ data: { id: 'class-1' } }) });

    expect(await screen.findByText(/^Created/)).toBeInTheDocument();
  });

  /**
   * #249. The create wizard's own date bound, which had none of its own until
   * this test — the edit form's twin was covered from the day it landed and
   * this one was not, so "both pickers are bounded" rested on reading the two
   * diffs side by side.
   *
   * The clock is PINNED and the expected day is written out, rather than
   * recomputed from `new Date()`. Deriving the expectation with the same
   * expression the component uses is the failure mode the edit form's version
   * of this test already carries a warning about: both sides move together and
   * nothing can ever be red. 2026-08-19T00:00Z is 18 August 20:00 in
   * America/New_York, the zone `vitest.config.ts` pins; a UTC-derived bound
   * answers 2026-08-19 and makes tonight's class unpickable.
   *
   * Awaited because of THIS WIZARD's `if (loading)` gate, not because the bound
   * is late. An earlier revision of this comment said "the bound arrives from
   * an effect rather than from the first render", which was true of the hook's
   * first implementation and false of the one that shipped: `useSyncExternalStore`
   * calls `getSnapshot` — not `getServerSnapshot` — on a client-only mount, so
   * `min` is present on the FIRST client render. Its sibling in
   * `class-edit-form.test.tsx` asserts exactly that, synchronously, which is
   * the contradiction that outed this. The field simply does not exist here
   * until the rooms fetch settles.
   *
   * `toFake: ['Date']` and not the whole timer suite, which the edit form's
   * twin can afford and this one cannot. That test renders a component with no
   * async work and reads the attribute straight out of `render`'s own `act`.
   * This wizard fetches its rooms on mount, so the field does not exist until a
   * promise settles and the assertions have to go through `findBy`/`waitFor` —
   * both of which poll on `setTimeout`. Freezing that too deadlocks them
   * against a clock nothing advances: the first version of this test failed on
   * the 5s timeout rather than on the attribute.
   */
  it('bounds the date picker at today in the local calendar, not UTC (#249)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
    try {
      stubFetch();
      render(<NewClassForm currency="EUR" />);
      const date = await screen.findByLabelText('Date');
      await waitFor(() => expect(date).toHaveAttribute('min', '2026-08-18'));
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * #740. The page's header — back link, display title, step caption —
   * renders in every state the rooms fetch can leave it in, not only in the
   * wizard.
   */
  describe('header whatever the rooms fetch returns (#740)', () => {
    function expectHeader() {
      expect(screen.getByRole('heading', { level: 1, name: 'New class' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Schedule' })).toBeInTheDocument();
      expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();
    }

    it('shows the wizard header while the rooms are loading', () => {
      fetchMock.mockImplementation(() => new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(screen.getByText('Loading rooms...')).toBeInTheDocument();
      expectHeader();
    });

    it('shows the wizard header when the rooms fail to load', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText("Couldn't load your rooms")).toBeInTheDocument();
      expectHeader();
    });

    it('shows the wizard header when the teacher has no rooms', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText('No rooms configured')).toBeInTheDocument();
      expectHeader();
    });

    it('shows the wizard header when every room is archived', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ ...ROOM, isArchived: true }] }) });
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText('All your rooms are archived')).toBeInTheDocument();
      expectHeader();
    });
  });

  /**
   * #436. The single studio create page already links up to its recurring
   * template flow; this wizard had no equivalent, only the sideways link to
   * the studio flow. Both links now render together, so this pins the studio
   * link's destination alongside the new one rather than trusting it stayed
   * unchanged by the same edit that added its neighbor.
   */
  it('offers both a recurring class and a studio class as alternatives to the wizard (#436)', async () => {
    stubFetch();
    render(<NewClassForm currency="EUR" />);

    fireEvent.click(await screen.findByRole('button', { name: /set up a recurring class/i }));
    expect(routerPush).toHaveBeenCalledWith('/settings/recurring/new');

    fireEvent.click(screen.getByRole('button', { name: /log a studio class/i }));
    expect(routerPush).toHaveBeenCalledWith('/studio-class/new');
  });

  /**
   * Issue 76, added at PR review. `TemplateForm` got three tests for the
   * identical picker change; this wizard got none, and deleting BOTH the
   * `!tr.isArchived` filter and the `allRoomsCount > 0` branch left all 235
   * component tests green.
   *
   * Note `ROOM` above carries no `isArchived` key, which is why the existing
   * tests could not have caught this: `!undefined` is truthy, so every stubbed
   * room passes the filter whether or not the filter is there. These stubs set
   * the field explicitly.
   */
  describe('archived rooms (issue 76)', () => {
    const ARCHIVED = { ...ROOM, id: '22222222-2222-4222-8222-222222222222',
      room: { roomName: 'Attic', venueName: 'Shelved Venue' }, isArchived: true };
    const LIVE = { ...ROOM, isArchived: false };

    function stubRooms(data: unknown[]) {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data }) });
      vi.stubGlobal('fetch', fetchMock);
    }

    it('does not offer an archived room in the picker', async () => {
      stubRooms([LIVE, ARCHIVED]);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText(/Main Venue/)).toBeInTheDocument();
      expect(screen.queryByText(/Shelved Venue/)).not.toBeInTheDocument();
    });

    it('tells a teacher whose rooms are all archived to unarchive, not to add one', async () => {
      stubRooms([ARCHIVED]);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText('All your rooms are archived')).toBeInTheDocument();
      expect(screen.queryByText('No rooms configured')).not.toBeInTheDocument();
    });

    it('still tells a teacher with no rooms at all to add one', async () => {
      stubRooms([]);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText('No rooms configured')).toBeInTheDocument();
    });

    // The failure path the empty list used to speak for: rooms exist, the
    // fetch failed, and the teacher was told to add a room they already own.
    it('distinguishes a failed load from an absence of rooms', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText("Couldn't load your rooms")).toBeInTheDocument();
      expect(screen.queryByText('No rooms configured')).not.toBeInTheDocument();
    });

    it('distinguishes a thrown fetch from an absence of rooms', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const down = new Error('network down');
      fetchMock.mockRejectedValue(down);
      vi.stubGlobal('fetch', fetchMock);
      render(<NewClassForm currency="EUR" />);

      expect(await screen.findByText("Couldn't load your rooms")).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith('[class-new-rooms] request failed', {
        err: down,
      });
    });
  });

  describe('step 1 validation (#318)', () => {
    async function renderAtStep1() {
      stubFetch();
      render(<NewClassForm currency="EUR" />);
      await screen.findByLabelText('Room');
    }

    /** The step-1 fields render every message in the same pass. */
    it('refuses an empty step 1 with every field message at once, and does not advance', async () => {
      await renderAtStep1();
      fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '0' } });
      const callsBefore = fetchMock.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: /next/i }));

      const room = screen.getByLabelText('Room');
      expect(room).toHaveAccessibleDescription('Select a room');
      expect(room).toBeInvalid();
      const roomErrorId = room.getAttribute('aria-describedby');
      if (!roomErrorId) throw new Error('expected Room to name its error element');
      expect(document.getElementById(roomErrorId)).toHaveAttribute('role', 'alert');
      expect(screen.getByLabelText('Class type')).toHaveAccessibleDescription('Enter a class type');
      expect(screen.getByLabelText('Date')).toHaveAccessibleDescription('Select a date');
      expect(screen.getByLabelText('Start time')).toHaveAccessibleDescription('Enter a start time');
      expect(screen.getByLabelText('Duration (minutes)')).toHaveAccessibleDescription('Duration must be positive');
      expect(screen.queryByLabelText(/^Room cost/)).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('refuses a whitespace-only class type', async () => {
      await renderAtStep1();
      fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM_ID } });
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: '   ' } });
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
      fireEvent.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByLabelText('Class type')).toHaveAccessibleDescription('Enter a class type');
      expect(screen.queryByLabelText(/^Room cost/)).not.toBeInTheDocument();
    });

    it('refuses a duration that is not whole minutes', async () => {
      await renderAtStep1();
      fireEvent.change(screen.getByLabelText('Room'), { target: { value: ROOM_ID } });
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
      fireEvent.change(screen.getByLabelText('Duration (minutes)'), { target: { value: '60.5' } });
      fireEvent.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByLabelText('Duration (minutes)')).toHaveAccessibleDescription('Duration must be whole minutes');
      expect(screen.queryByLabelText(/^Room cost/)).not.toBeInTheDocument();
    });

    it('clears a field message when that field is edited', async () => {
      await renderAtStep1();
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Yin' } });

      expect(screen.getByLabelText('Class type')).not.toHaveAccessibleDescription();
      expect(screen.getByLabelText('Date')).toHaveAccessibleDescription('Select a date');
    });

    it('unwires the Room error once a room is picked', async () => {
      await renderAtStep1();
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      const room = screen.getByLabelText('Room');
      expect(room).toHaveAccessibleDescription('Select a room');
      fireEvent.change(room, { target: { value: ROOM_ID } });

      expect(room).not.toHaveAccessibleDescription();
      expect(room).not.toBeInvalid();
      expect(room).not.toHaveAttribute('aria-describedby');
    });
  });

  describe('step 2 validation (#318)', () => {
    // A room whose capacity differs from `?? 30`'s fallback, so a mutant that
    // drops the room lookup (or reads the wrong field) can't pass by
    // coincidence — see the capacity test below.
    const STEP2_ROOM_ID = '22222222-2222-4222-8222-222222222222';
    const STEP2_ROOM = {
      ...ROOM,
      id: STEP2_ROOM_ID,
      capacityOverride: 24,
    };

    function stubRooms(rooms: readonly (typeof ROOM)[]) {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: rooms }),
      });
      vi.stubGlobal('fetch', fetchMock);
    }

    /** Renders the wizard over `rooms` and fills step 1 validly with `roomId`, then presses Next. */
    async function renderAndPassStep1(rooms: readonly (typeof ROOM)[], roomId: string) {
      stubRooms(rooms);
      render(<NewClassForm currency="EUR" />);
      fireEvent.change(await screen.findByLabelText('Room'), { target: { value: roomId } });
      fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
      fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      await screen.findByLabelText(/^Room cost/);
    }

    /** Step 1 filled validly with the 24-capacity room; defaults then read room cost 20, min rate 15, target 25, min 4, max 12. */
    async function renderAtStep2() {
      await renderAndPassStep1([STEP2_ROOM], STEP2_ROOM_ID);
    }

    function set(label: string, value: string) {
      fireEvent.change(screen.getByLabelText(new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), { target: { value } });
    }

    function next() {
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
    }

    function expectStillOnStep2() {
      expect(screen.getByLabelText(/^Room cost/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Cancellation deadline')).not.toBeInTheDocument();
    }

    it('refuses a negative room cost', async () => {
      await renderAtStep2();
      set('Room cost', '-1');
      next();
      expect(screen.getByLabelText(/^Room cost/)).toHaveAccessibleDescription('Room cost cannot be negative');
      expectStillOnStep2();
    });

    it('refuses min students below 1', async () => {
      await renderAtStep2();
      set('Min students', '0');
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
      expectStillOnStep2();
    });

    it('refuses max students below 1', async () => {
      await renderAtStep2();
      set('Max students', '0');
      next();
      expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Max students must be at least 1');
      expectStillOnStep2();
    });

    it('refuses max students above the room capacity, keeping what was typed', async () => {
      await renderAtStep2();
      set('Max students', '40');
      expect(screen.getByLabelText('Max students')).toHaveValue(40);
      next();
      expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Cannot exceed room capacity (24)');
      expectStillOnStep2();
    });

    it('refuses a min students that is not a whole number', async () => {
      await renderAtStep2();
      set('Min students', '2.5');
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be a whole number');
      expectStillOnStep2();
    });

    it('refuses a max students that is not a whole number', async () => {
      await renderAtStep2();
      set('Max students', '12.5');
      next();
      expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Max students must be a whole number');
      expectStillOnStep2();
    });

    describe('in a room whose capacity exceeds the class size limit', () => {
      const LARGE_ROOM_ID = '44444444-4444-4444-8444-444444444444';
      const LARGE_ROOM = { ...ROOM, id: LARGE_ROOM_ID, capacityOverride: MAX_CLASS_SIZE + 50 };

      it('refuses max students above the class size limit', async () => {
        await renderAndPassStep1([LARGE_ROOM], LARGE_ROOM_ID);
        set('Max students', String(MAX_CLASS_SIZE + 1));
        next();
        expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription(
          `Max students cannot exceed ${MAX_CLASS_SIZE}`,
        );
        expectStillOnStep2();
      });

      it('advances with max students at the class size limit', async () => {
        await renderAndPassStep1([LARGE_ROOM], LARGE_ROOM_ID);
        set('Max students', String(MAX_CLASS_SIZE));
        next();
        expect(await screen.findByLabelText('Cancellation deadline')).toBeInTheDocument();
      });

      it('names the class-size bound, not the room capacity, above the room capacity too', async () => {
        await renderAndPassStep1([LARGE_ROOM], LARGE_ROOM_ID);
        set('Max students', String(MAX_CLASS_SIZE + 60));
        next();
        expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription(
          `Max students cannot exceed ${MAX_CLASS_SIZE}`,
        );
        expectStillOnStep2();
      });
    });

    it('refuses min students above max students, on Min students, with the class family copy', async () => {
      await renderAtStep2();
      set('Min students', '10');
      set('Max students', '8');
      expect(screen.getByLabelText('Min students')).toHaveValue(10);
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
      expectStillOnStep2();
    });

    it('refuses a min rate above the target rate before any request', async () => {
      await renderAtStep2();
      set('Min rate', '30');
      const callsBefore = fetchMock.mock.calls.length;
      next();
      expect(screen.getByLabelText(/^Min rate/)).toHaveAccessibleDescription('Min rate cannot exceed target rate');
      expectStillOnStep2();
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
    });

    it('refuses a min rate subsidizing more than the room cost', async () => {
      await renderAtStep2();
      set('Room cost', '10');
      set('Min rate', '-15');
      next();
      expect(screen.getByLabelText(/^Min rate/)).toHaveAccessibleDescription(
        'Min rate cannot subsidize more than the room cost — prices would go negative',
      );
      expectStillOnStep2();
    });

    it('shows the rate-order refusal on min rate when the room-subsidy rule also fires', async () => {
      await renderAtStep2();
      set('Room cost', '5');
      set('Target rate', '-10');
      set('Min rate', '-8');
      next();
      expect(screen.getByLabelText(/^Min rate/)).toHaveAccessibleDescription('Min rate cannot exceed target rate');
      expectStillOnStep2();
    });

    it('shows the single-field message where a field also breaks a cross-field rule', async () => {
      await renderAtStep2();
      set('Max students', '-1');
      set('Min students', '0');
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
      expect(screen.getByLabelText('Max students')).toHaveAccessibleDescription('Max students must be at least 1');
      expectStillOnStep2();
    });

    it('advances at every legal boundary: max at capacity, min equal to max, min rate at minus the room cost', async () => {
      await renderAtStep2();
      set('Max students', '24');
      set('Min students', '24');
      set('Room cost', '10');
      set('Min rate', '-10');
      next();
      expect(await screen.findByLabelText('Cancellation deadline')).toBeInTheDocument();
    });

    it('advances with a zero room cost and a zero min rate', async () => {
      await renderAtStep2();
      set('Room cost', '0');
      set('Min rate', '0');
      next();
      expect(await screen.findByLabelText('Cancellation deadline')).toBeInTheDocument();
    });

    /** Spec §1 correction 2: select-all in Max students and type 20; the first keystroke is 2. */
    it('does not drag min students down while max students is being typed', async () => {
      await renderAtStep2();
      set('Max students', '2');
      set('Max students', '20');
      expect(screen.getByLabelText('Min students')).toHaveValue(4);
      expect(screen.getByLabelText('Max students')).toHaveValue(20);
    });

    it('keeps a refused min students above max when another room is picked', async () => {
      const OTHER_ROOM_ID = '33333333-3333-4333-8333-333333333333';
      const OTHER_ROOM = {
        ...ROOM,
        id: OTHER_ROOM_ID,
        capacityOverride: 16,
        room: { roomName: 'Studio B', venueName: 'Main Venue' },
      };
      await renderAndPassStep1([STEP2_ROOM, OTHER_ROOM], STEP2_ROOM_ID);
      set('Min students', '10');
      set('Max students', '8');
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.change(screen.getByLabelText('Room'), { target: { value: OTHER_ROOM_ID } });
      next();
      expect(screen.getByLabelText('Min students')).toHaveValue(10);
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
      expectStillOnStep2();
    });

    it('clamps min students to a smaller room picked after Back', async () => {
      const SMALL_ROOM_ID = '55555555-5555-4555-8555-555555555555';
      const SMALL_ROOM = {
        ...ROOM,
        id: SMALL_ROOM_ID,
        capacityOverride: 10,
        room: { roomName: 'Studio C', venueName: 'Main Venue' },
      };
      await renderAndPassStep1([STEP2_ROOM, SMALL_ROOM], STEP2_ROOM_ID);
      set('Min students', '20');
      set('Max students', '20');

      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.change(screen.getByLabelText('Room'), { target: { value: SMALL_ROOM_ID } });
      fireEvent.click(screen.getByRole('button', { name: /next/i }));
      await screen.findByLabelText(/^Room cost/);

      expect(screen.getByLabelText('Min students')).toHaveValue(10);
      expect(screen.getByLabelText('Max students')).toHaveValue(10);
    });

    it('clears a students-order refusal when max students is raised', async () => {
      await renderAtStep2();
      set('Max students', '3');
      next();
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
      set('Max students', '5');
      expect(screen.getByLabelText('Min students')).not.toHaveAccessibleDescription();
    });

    it('clears a rate-order refusal when the target rate is raised', async () => {
      await renderAtStep2();
      set('Min rate', '30');
      next();
      expect(screen.getByLabelText(/^Min rate/)).toHaveAccessibleDescription('Min rate cannot exceed target rate');
      set('Target rate', '35');
      expect(screen.getByLabelText(/^Min rate/)).not.toHaveAccessibleDescription();
    });

    it('keeps a students-order refusal that is still true when room cost is edited', async () => {
      await renderAtStep2();
      set('Min students', '10');
      set('Max students', '8');
      next();
      set('Room cost', '15');
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students cannot exceed max students');
    });

    it('keeps a single-field message when a different economics field is edited', async () => {
      await renderAtStep2();
      set('Min students', '0');
      next();
      set('Target rate', '30');
      expect(screen.getByLabelText('Min students')).toHaveAccessibleDescription('Min students must be at least 1');
    });
  });

  it('feeds the pricing preview from the rate fields as the teacher types', async () => {
    stubFetch();
    render(<CreateClassPage />);
    fireEvent.change(await screen.findByLabelText('Room'), { target: { value: ROOM_ID } });
    fireEvent.change(screen.getByLabelText('Class type'), { target: { value: 'Vinyasa' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-08-10' } });
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    fireEvent.change(await screen.findByLabelText('Target rate'), { target: { value: '45' } });

    // the room's 30 places on a minimum of 4 open the preview at 17 students:
    // 15 + (45 − 15) × 13 / 26 = 30, plus the room's €20
    expect(screen.getByText('€30.00')).toBeTruthy();
    expect(screen.getByText('€50.00')).toBeTruthy();
  });
});
