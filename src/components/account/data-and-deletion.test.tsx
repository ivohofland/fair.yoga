import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DataAndDeletion } from './data-and-deletion';

/**
 * #171. Erasing a student keeps each refusal they made (`TeacherBlock`) with
 * the address it is matched on, so the student confirmation says so before
 * they commit. Why the row is kept: `docs/data-model.md` (TeacherBlock).
 */
describe('DataAndDeletion', () => {
  it('tells a student that the email address behind a refusal is kept', () => {
    render(<DataAndDeletion role="student" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    expect(
      screen.getByText(/we keep your email address only so they can't invite you again/),
    ).toBeInTheDocument();
  });

  it('does not tell a teacher-only confirmation about refusals', () => {
    render(<DataAndDeletion role="teacher" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }));

    // Positive first: without it, the negative below would also pass on a
    // confirmation that never opened.
    expect(screen.getByText(/permanently removes your personal data/)).toBeInTheDocument();
    expect(screen.queryByText(/can't invite you again/)).not.toBeInTheDocument();
  });
});
