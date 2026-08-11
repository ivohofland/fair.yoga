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
   * is a bare `prisma.class.create` with no dedupe, and the only unique
   * constraint on `Class` is `@@unique([templateId, date])`, which a manually
   * created row cannot trip: its `templateId` is null, and Postgres treats
   * NULLs as distinct. Two identical classes, both bookable.
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
});
