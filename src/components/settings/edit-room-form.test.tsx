import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EditRoomForm } from './edit-room-form';

/**
 * #307. This form makes two sequential PUTs — the room, then the
 * teacher-room link — and each reads its error branch through
 * `readErrorMessage`. An unreadable body (a proxy's HTML 502) on either
 * request shows that request's own fallback and leaves a console record,
 * distinct from the outer `catch`'s own `'[edit-room-form] request failed'`
 * log for a request that never lands at all.
 */
describe('EditRoomForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * A real `Response` whose `json()` genuinely throws — the shape a proxy's
   * HTML error page takes.
   */
  function htmlResponse(status = 502): Response {
    return new Response('<html><body>502 Bad Gateway</body></html>', {
      status,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const initial = {
    venueName: 'De Studio',
    roomName: 'Main Hall',
    address: 'Keizersgracht 1',
    city: 'Amsterdam',
    postcode: '1018 DT',
    floor: '2nd',
    maxCapacity: 20,
    equipment: ['mats'],
    notes: 'Bring your own mat',
    rentalRate: 15,
  };

  function renderForm() {
    render(<EditRoomForm roomId="room-1" teacherRoomId="tr-1" initial={initial} />);
  }

  it('shows the fallback and logs when the room refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Only the room PUT is ever issued — the form returns before the
    // teacher-room PUT once the first request refuses.
    fetchMock.mockResolvedValue(htmlResponse(502));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
  });

  it('shows the fallback and logs when the teacher-room refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce(htmlResponse(502));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Failed to save settings')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[edit-room-form] request failed',
      expect.objectContaining({ roomId: 'room-1', teacherRoomId: 'tr-1', err: expect.any(TypeError) }),
    );
  });
});
