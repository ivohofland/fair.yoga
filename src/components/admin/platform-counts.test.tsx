import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlatformCountsView } from './platform-counts';

const counts = { teachers: 3, students: { withAccount: 2, walkInOnly: 4 }, rooms: { public: 5, private: 6 } };

describe('PlatformCountsView', () => {
  it('shows each total as the sum of its parts, with the split beneath', () => {
    render(<PlatformCountsView counts={counts} />);
    expect(screen.getByRole('region', { name: 'Teachers' })).toHaveTextContent('3');
    const students = screen.getByRole('region', { name: 'Students' });
    expect(students).toHaveTextContent('6');
    expect(students).toHaveTextContent('with an account 2 · walk-in only 4');
    const rooms = screen.getByRole('region', { name: 'Rooms' });
    expect(rooms).toHaveTextContent('11');
    expect(rooms).toHaveTextContent('public 5 · private 6');
  });
});
