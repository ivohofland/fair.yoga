import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RoomMatchList } from './room-match-list';
import type { RoomResult } from '@/lib/room-search';

const rooms: RoomResult[] = [
  {
    id: 'r1', venueName: 'Yoga Loft', roomName: 'Studio A',
    address: 'Prinsengracht 42', city: 'Amsterdam', postcode: '1015DX',
    floor: '2', maxCapacity: 20,
  },
];

describe('RoomMatchList', () => {
  it('renders each room as a button when onSelect is given', () => {
    const onSelect = vi.fn();
    render(<RoomMatchList rooms={rooms} onSelect={onSelect} />);

    const row = screen.getByRole('button', { name: /Studio A/ });
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(rooms[0]);
  });

  it('renders plain rows with no button when onSelect is omitted', () => {
    render(<RoomMatchList rooms={rooms} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Studio A/)).toBeDefined();
  });
});
