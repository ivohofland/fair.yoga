import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MONEY_MAX } from '@/lib/input-bounds';
import { RoomSettingsStep } from './room-settings-step';

const selectedRoom = {
  id: 'room-1',
  venueName: 'De Studio',
  roomName: 'Main Hall',
  address: 'Keizersgracht 1',
  city: 'Amsterdam',
  postcode: '1018 DT',
  floor: '2nd',
  maxCapacity: 20,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A real `Response` whose `json()` genuinely throws — the shape a proxy's
 * HTML error page takes, which `jsonResponse` above cannot express.
 */
function htmlResponse(status = 502): Response {
  return new Response('<html><body>502 Bad Gateway</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

describe('RoomSettingsStep', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function submit(onSaved: () => void): void {
    render(<RoomSettingsStep currency="EUR" selectedRoom={selectedRoom} onSaved={onSaved} onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^Rental rate/), { target: { value: '15.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  }

  // A retry after a lost response: the link is already there with these
  // values, which is what the teacher asked for.
  it('treats an unchanged answer as saved', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { id: 'tr-1' }, outcome: 'unchanged' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['ROOM_ALREADY_LISTED', 'This room is already in your rooms. Edit it there to change its details.'],
    ['ROOM_ARCHIVED', 'This room is in your archived rooms. Unarchive it to use it again.'],
  ])('shows the %s refusal and stays on this step', async (code, message) => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code, message } }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onSaved).not.toHaveBeenCalled();
  });

  /**
   * A proxy's HTML error page, not the route's own `{ error }` shape. Read
   * through `readErrorMessage`, this shows the step's own fallback and
   * leaves a console record instead of the generic network copy a
   * `SyntaxError` landing in the outer `catch` would produce.
   */
  it('shows the fallback and logs when the refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(htmlResponse(502));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to link room');
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  // `fireEvent.submit`, not a click: the input's native `max` would block a
  // click-submit before the form's own copy runs.
  it('refuses a rental rate one past the cap without posting, and posts the cap itself', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { data: { id: 'tr-1' } }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();
    const { container } = render(
      <RoomSettingsStep currency="EUR" selectedRoom={selectedRoom} onSaved={onSaved} onBack={vi.fn()} />,
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('form not rendered');
    const rate = screen.getByLabelText(/^Rental rate/);

    fireEvent.change(rate, { target: { value: String(MONEY_MAX + 1) } });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('Rental rate cannot exceed 100,000');
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(rate, { target: { value: String(MONEY_MAX) } });
    fireEvent.submit(form);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls.at(0)?.[1]?.body)).rentalRate).toBe(MONEY_MAX);
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Please try again.');
    expect(consoleError).toHaveBeenCalledWith(
      '[room-settings-step] request failed',
      expect.objectContaining({ roomId: 'room-1', err: expect.any(TypeError) }),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
