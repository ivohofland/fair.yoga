import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RetentionNote } from './retention-note';

describe('RetentionNote', () => {
  it('states the policy as a bare caption, placed by its caller', () => {
    render(<RetentionNote />);
    expect(screen.getByText('Messages are kept for a year.')).toHaveAttribute(
      'class',
      'type-caption',
    );
  });
});
