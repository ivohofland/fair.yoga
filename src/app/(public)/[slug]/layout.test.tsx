import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import TeacherPageLayout from './layout';

describe('TeacherPageLayout', () => {
  it('ends the teacher’s pages with a quiet link back to fair.yoga', () => {
    render(TeacherPageLayout({ children: <p>page</p> }));

    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByRole('link', { name: 'Bookings by fair.yoga' }).getAttribute('href')).toBe('/');
    expect(screen.getByText('page')).toBeTruthy();
  });
});
