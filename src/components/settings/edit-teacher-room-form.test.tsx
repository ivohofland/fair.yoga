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
  });

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
});
