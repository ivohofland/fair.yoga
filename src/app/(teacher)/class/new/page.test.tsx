import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CreateClassPage from './page';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';

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
      json: async () => ({
        data: [{
          id: ROOM_ID,
          roomId: 'room-1',
          capacityOverride: 30,
          rentalRate: 20,
          room: { roomName: 'Studio A', venueName: 'Main Venue' },
        }],
      }),
    });
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

  it('sends exactly these twelve fields', async () => {
    stubFetch();
    const { url, method, body } = await fillAndSubmit();
    expect(url).toBe('/api/classes');
    expect(method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'date',
      'durationMinutes',
      'maxStudents',
      'minRate',
      'minStudents',
      'roomCost',
      'startTime',
      'targetRate',
      'teacherRoomId',
    ]);
  });
});
