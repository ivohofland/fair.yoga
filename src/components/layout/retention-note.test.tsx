import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RetentionNote } from './retention-note';

describe('RetentionNote', () => {
  it('states the policy', () => {
    render(<RetentionNote />);
    expect(screen.getByText('Messages are kept for a year.')).toHaveClass('type-caption');
  });
});
