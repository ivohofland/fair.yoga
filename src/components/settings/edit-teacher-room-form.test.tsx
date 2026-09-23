import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EditTeacherRoomForm } from './edit-teacher-room-form';

/**
 * #136. `EditTeacherRoomValues` (the `initial` prop's field list) and the
 * payload literal are two separate enumerations of this form's PUT body; the
 * pins and the `Required<UpdateTeacherRoomWire>` annotation in the source
 * file hold them together at compile time. This test holds what neither can
 * see: the keys that actually reach the API — including that the
 * `equipmentNotes` trim survives the move into a typed value.
 *
 * Nothing fetches on mount, so the submit is the first (and only) call.
 */
describe('EditTeacherRoomForm', () => {
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

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  const initial = {
    capacityOverride: 20,
    rentalRate: 15,
    equipmentNotes: 'Bring your own mat',
  };

  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, options] = fetchMock.mock.calls[0] ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all three fields', async () => {
    stubFetch();
    render(<EditTeacherRoomForm teacherRoomId="tr-1" initial={initial} />);
    const { url, method, body } = await submit();
    expect(url).toBe('/api/teacher-rooms/tr-1');
    expect(method).toBe('PUT');
    expect(body).toEqual({
      capacityOverride: 20,
      rentalRate: 15,
      equipmentNotes: 'Bring your own mat',
    });
  });

  it('trims equipmentNotes before sending', async () => {
    stubFetch();
    render(
      <EditTeacherRoomForm
        teacherRoomId="tr-1"
        initial={{ ...initial, equipmentNotes: '  Bring your own mat  ' }}
      />,
    );
    const { body } = await submit();
    expect(body.equipmentNotes).toBe('Bring your own mat');
  });

  it('sends a whitespace-only equipmentNotes as null', async () => {
    stubFetch();
    render(
      <EditTeacherRoomForm teacherRoomId="tr-1" initial={{ ...initial, equipmentNotes: '   ' }} />,
    );
    const { body } = await submit();
    expect(body.equipmentNotes).toBeNull();
  });

  /**
   * A proxy's HTML error page, not the route's own `{ error }` shape. Read
   * through `readErrorMessage`, this shows the form's own fallback and
   * leaves a console record instead of the generic network copy a
   * `SyntaxError` landing in the outer `catch` would produce.
   */
  it('shows the fallback and logs when the refusal body is unreadable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(htmlResponse(502));
    vi.stubGlobal('fetch', fetchMock);
    render(<EditTeacherRoomForm teacherRoomId="tr-1" initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      'API error response body could not be read',
      expect.objectContaining({ status: 502 }),
    );
  });

  it('shows network copy and logs when the request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    render(<EditTeacherRoomForm teacherRoomId="tr-1" initial={initial} />);

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith(
      '[edit-teacher-room-form] request failed',
      expect.any(TypeError),
    );
  });
});
