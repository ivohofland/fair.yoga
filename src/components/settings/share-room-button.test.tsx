import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { ShareRoomButton } from './share-room-button';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const identity = { address: 'Prinsengracht 42', floor: '2', roomName: 'Studio A' };

function room(over: Partial<{ id: string; floor: string; roomName: string }> = {}) {
  return {
    id: 'other', venueName: 'Yoga Loft', roomName: 'Studio A',
    address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
    floor: '2', maxCapacity: 20, ...over,
  };
}

function mockSearch(rooms: unknown[]) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ data: rooms }),
  }) as unknown as typeof fetch;
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('ShareRoomButton', () => {
  it('offers the confirm when nothing is shared at the address', async () => {
    mockSearch([]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Sharing a room is permanent/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  // The fixture below carries BOTH a neighbour and an exact match on purpose.
  // A fixture with only the exact match would pass equally against code that
  // blocks on ANY search result, and could not tell the two behaviours apart.
  it('warns but still allows when only a same-street neighbour is shared', async () => {
    mockSearch([room({ id: 'neighbour', floor: '9', roomName: 'Attic' })]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Rooms already shared at this address/)).toBeDefined();
    expect(screen.getByRole('button', { name: /^Share room$/ })).toBeDefined();
  });

  it('removes the confirm entirely on an exact identity match', async () => {
    mockSearch([
      room({ id: 'neighbour', floor: '9', roomName: 'Attic' }),
      room({ id: 'exact' }),
    ]);
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    fireEvent.click(screen.getByRole('button', { name: /Share with other teachers/ }));

    expect(await screen.findByText(/Already shared/)).toBeDefined();
    // Absent, not disabled — there is no state that would enable it.
    expect(screen.queryByRole('button', { name: /^Share room$/ })).toBeNull();
  });
});
