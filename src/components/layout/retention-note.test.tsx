import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { STANDARD_RETENTION_DAYS } from '@/lib/notification-retention';
import { RetentionNote } from './retention-note';

describe('RetentionNote', () => {
  it('states the policy', () => {
    render(<RetentionNote />);
    expect(screen.getByText('Messages are kept for a year.')).toHaveClass('type-caption');
  });

  it('says "a year" only while the period is one', () => {
    // The copy is fixed text; this ties it to the constant the sweep uses.
    expect(STANDARD_RETENTION_DAYS).toBe(365);
  });
});
