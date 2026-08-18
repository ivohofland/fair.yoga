import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AddRoomFlow } from './add-room-flow';

/**
 * #136. This form enumerated its two request bodies inline, with nothing
 * checking either against `createRoomSchema` / `createTeacherRoomSchema`.
 * The pins in the source file hold the key sets at compile time; this test
 * holds what a pin cannot see, which is what actually reaches each endpoint
 * — and it is the only form in this batch that posts twice, to two
 * different endpoints, with two unrelated bodies. Asserting only the first
 * would leave the teacher-room payload unpinned at runtime.
 *
 * There is no way to reach the "create a room" step without a completed
 * search first — the "create new room" affordance only renders once
 * `results` is non-null. So `fetch` sees three calls in sequence: the GET
 * search, the POST that creates the room, and the POST that links it to the
 * teacher. The assertions below read specific indices rather than
 * `.at(-1)`, because both POSTs matter, not just the last one.
 */
describe('AddRoomFlow', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
      const url = String(input);
      if (url.startsWith('/api/rooms?')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url === '/api/rooms' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            data: {
              id: 'room-1',
              venueName: 'De Studio',
              roomName: 'Main Hall',
              address: 'Keizersgracht 1',
              city: 'Amsterdam',
              postcode: '1018 DT',
              floor: '2nd',
              maxCapacity: 20,
            },
          }),
        };
      }
      if (url === '/api/teacher-rooms' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ data: {} }) };
      }
      throw new Error(`Unexpected fetch: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('sends both bodies — the new room, then the teacher-room link', async () => {
    stubFetch();
    render(<AddRoomFlow />);

    // Step 1: search. This is the only way to unlock "create new room".
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '1018 DT' } });
    fireEvent.change(screen.getByLabelText('Street'), { target: { value: 'Keizersgracht' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText(/no rooms found/i);
    expect(fetchMock.mock.calls.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));

    // Step 2: create the room. Leading/trailing whitespace on the trimmed
    // fields, to prove the trim survives the move into a typed value.
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: '  De Studio  ' } });
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '  Keizersgracht 1  ' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '  Amsterdam  ' } });
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '  1018 DT  ' } });
    fireEvent.change(screen.getByLabelText('Floor'), { target: { value: '  2nd  ' } });
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: '  Main Hall  ' } });
    fireEvent.change(screen.getByLabelText('Max capacity'), { target: { value: '20' } });
    fireEvent.click(screen.getByLabelText('Mats'));
    fireEvent.click(screen.getByLabelText('Blocks'));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: '  Bring a mat  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    const [roomUrl, roomOptions] = fetchMock.mock.calls[1] ?? [];
    const roomOpts = roomOptions as { method: string; body: string };
    expect(roomUrl).toBe('/api/rooms');
    expect(roomOpts.method).toBe('POST');
    expect(JSON.parse(roomOpts.body)).toEqual({
      venueName: 'De Studio',
      address: 'Keizersgracht 1',
      city: 'Amsterdam',
      postcode: '1018 DT',
      floor: '2nd',
      roomName: 'Main Hall',
      maxCapacity: 20,
      equipment: ['mats', 'blocks'],
      notes: 'Bring a mat',
      isPublic: false,
    });

    // Step 3: link the newly created room to the teacher.
    await screen.findByRole('button', { name: 'Add room' });
    fireEvent.change(screen.getByLabelText('Rental rate'), { target: { value: '15.5' } });
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: '  Extra towels  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));

    const [linkUrl, linkOptions] = fetchMock.mock.calls[2] ?? [];
    const linkOpts = linkOptions as { method: string; body: string };
    expect(linkUrl).toBe('/api/teacher-rooms');
    expect(linkOpts.method).toBe('POST');
    expect(JSON.parse(linkOpts.body)).toEqual({
      roomId: 'room-1',
      capacityOverride: 20,
      rentalRate: 15.5,
      equipmentNotes: 'Extra towels',
    });
  });

  // #73. The assertion that matters is on the REQUEST BODY, not the checkbox.
  // An unchecked box that still posts `isPublic: true` is the regression shape
  // this exists to catch, and `not.toBeChecked()` alone sails straight past it.
  it('posts isPublic false when the share checkbox is left alone', async () => {
    stubFetch();
    render(<AddRoomFlow />);

    // Reach the create step exactly as the existing test does.
    fireEvent.change(screen.getByLabelText('Postcode'), { target: { value: '1018 DT' } });
    fireEvent.change(screen.getByLabelText('Street'), { target: { value: 'Keizersgracht' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByText(/no rooms found/i);

    fireEvent.click(screen.getByRole('button', { name: 'Create new room' }));

    const checkbox = screen.getByRole('checkbox', {
      name: /Share this room with other teachers/,
    });
    expect(checkbox).not.toBeChecked();

    // Fill required fields so the form passes validation.
    fireEvent.change(screen.getByLabelText('Venue name'), { target: { value: 'De Studio' } });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Amsterdam' } });
    fireEvent.change(screen.getByLabelText('Max capacity'), { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: /Create room/ }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));

    const [, roomOptions] = fetchMock.mock.calls[1] ?? [];
    const roomOpts = roomOptions as { method: string; body: string };
    const body = JSON.parse(roomOpts.body) as { isPublic: boolean };
    expect(body.isPublic).toBe(false);
  });
});
