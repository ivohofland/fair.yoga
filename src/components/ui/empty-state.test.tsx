import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders a note as its last child, after the action', () => {
    render(
      <EmptyState
        title="Nothing here."
        body="Things appear here."
        action={<button type="button">Add one</button>}
        note={<p>A footnote.</p>}
      />,
    );

    const note = screen.getByText('A footnote.');
    const root = screen.getByText('Nothing here.').parentElement;
    expect(note.parentElement?.parentElement).toBe(root);
    expect(root?.lastElementChild).toBe(note.parentElement);
    expect(screen.getByRole('button', { name: 'Add one' }).compareDocumentPosition(note)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders no note wrapper without a note', () => {
    render(<EmptyState title="Nothing here." body="Things appear here." />);

    expect(screen.getByText('Nothing here.').parentElement?.lastElementChild).toBe(
      screen.getByText('Things appear here.'),
    );
  });
});
