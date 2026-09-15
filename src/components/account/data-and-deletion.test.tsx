import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataAndDeletion } from './data-and-deletion';

/**
 * #171: the student delete confirmation discloses that the address behind a
 * refusal is kept. What is kept and why: `docs/data-model.md` (TeacherBlock).
 */
describe('DataAndDeletion', () => {
  it('tells a student that the email address behind a refusal is kept', () => {
    render(<DataAndDeletion role="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    expect(
      screen.getByText(/we keep your email address only so they can't invite you again/),
    ).toBeInTheDocument();
  });

  it('keeps the refusal sentence out of the teacher copy', () => {
    render(<DataAndDeletion role="teacher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    // Positive first: without it, the negative below would also pass on a
    // confirmation that never opened.
    expect(screen.getByText(/permanently removes your personal data/)).toBeInTheDocument();
    expect(screen.queryByText(/can't invite you again/)).not.toBeInTheDocument();
  });
});
