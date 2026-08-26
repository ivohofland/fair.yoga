import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CreateClassPage from './page';
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
 * #136. This wizard restates its twelve fields three times — the `FormData`
 * interface, `INITIAL_FORM`, and the POST body — and nothing checked that the
 * three agreed with each other or with `createClassSchema`. The compile-time
 * pins in the source file hold `FormData` against the schema; this test holds
 * what a pin cannot see, which is what actually reaches the API.
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
  });

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
    render(<CreateClassPage />);

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
   * both are still numbers, in a body with the same twelve keys. That matters
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
  it('sends exactly these twelve fields, with the values the wizard actually produces', async () => {
    stubFetch();
    const { url, method, body } = await fillAndSubmit();
    expect(url).toBe('/api/classes');
    expect(method).toBe('POST');
    expect(body).toEqual({
      teacherRoomId: ROOM_ID,
      classType: 'Vinyasa',
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

  /**
   * #40, whole-branch review F1. This wizard was outside the branch's census,
   * which was scoped to `src/components/` and `src/lib/` — but it is the same
   * defect in the same shape: `router.push` on success with
   * `finally { setSubmitting(false) }` behind it, so a push that never commits
   * leaves a fully populated review step with "Create class" re-enabled.
   *
   * Nothing downstream catches the obvious second click. `POST /api/classes`
   * writes a bare entry-plus-class pair with no dedupe, and the only unique
   * key on the entry is `@@unique([scheduleRuleId, date])`, which a manually
   * created row cannot trip: its `scheduleRuleId` is null, and Postgres treats
   * NULLs as distinct.
   *
   * WHAT THE SECOND CLICK COSTS CHANGED IN #327, and the guard is still the
   * fix. `CalendarEntry_teacher_slot_excl` refuses a second entry on the same
   * span, so the duplicate is no longer created — the second request answers
   * 409 `DUPLICATE_CLASS_SLOT` instead. The teacher gets an error for having
   * clicked twice on a form that was working, where they used to get two
   * bookable classes. Neither is an outcome to ship, and only this guard
   * prevents the request being sent at all.
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
      render(<CreateClassPage />);
      const date = await screen.findByLabelText('Date');
      await waitFor(() => expect(date).toHaveAttribute('min', '2026-08-18'));
    } finally {
      vi.useRealTimers();
    }
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
      render(<CreateClassPage />);

      expect(await screen.findByText(/Main Venue/)).toBeInTheDocument();
      expect(screen.queryByText(/Shelved Venue/)).not.toBeInTheDocument();
    });

    it('tells a teacher whose rooms are all archived to unarchive, not to add one', async () => {
      stubRooms([ARCHIVED]);
      render(<CreateClassPage />);

      expect(await screen.findByText('All your rooms are archived')).toBeInTheDocument();
      expect(screen.queryByText('No rooms configured')).not.toBeInTheDocument();
    });

    it('still tells a teacher with no rooms at all to add one', async () => {
      stubRooms([]);
      render(<CreateClassPage />);

      expect(await screen.findByText('No rooms configured')).toBeInTheDocument();
    });

    // The failure path the empty list used to speak for: rooms exist, the
    // fetch failed, and the teacher was told to add a room they already own.
    it('distinguishes a failed load from an absence of rooms', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      vi.stubGlobal('fetch', fetchMock);
      render(<CreateClassPage />);

      expect(await screen.findByText("Couldn't load your rooms")).toBeInTheDocument();
      expect(screen.queryByText('No rooms configured')).not.toBeInTheDocument();
    });

    it('distinguishes a thrown fetch from an absence of rooms', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);
      render(<CreateClassPage />);

      expect(await screen.findByText("Couldn't load your rooms")).toBeInTheDocument();
    });
  });
});
