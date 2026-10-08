import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReportProblemRow } from './report-problem-row';

describe('ReportProblemRow', () => {
  it('links the public reporting section in a new tab, sending no referrer', () => {
    render(<ReportProblemRow />);
    const link = screen.getByRole('link', { name: /Report a problem/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/ivohofland/fair.yoga/blob/main/CONTRIBUTING.md#teachers-and-students',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('says in its accessible name that it opens in a new tab', () => {
    render(<ReportProblemRow />);
    expect(screen.queryByRole('link', { name: /Report a problem.*opens in a new tab/ })).not.toBeNull();
  });
});
