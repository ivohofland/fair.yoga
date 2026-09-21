import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

describe('RoomSettingsStep', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function submit(onSaved: () => void): void {
    render(<RoomSettingsStep selectedRoom={selectedRoom} onSaved={onSaved} onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rental rate'), { target: { value: '15.5' } });
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
});
