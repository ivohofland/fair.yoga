import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { ReportProblemRow } from './report-problem-row';

const CONTRIBUTING = path.resolve(__dirname, '../../../CONTRIBUTING.md');

// GitHub's heading anchor: lowercased, spaces to hyphens, punctuation dropped.
function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
}

describe('ReportProblemRow', () => {
  it('links the public Contributing tab in a new tab, sending no referrer', () => {
    render(<ReportProblemRow />);
    const link = screen.getByRole('link', { name: /Report a problem/ });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/ivohofland/fair.yoga?tab=contributing-ov-file#contributing-to-fairyoga',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('says in its accessible name that it opens in a new tab', () => {
    render(<ReportProblemRow />);
    expect(screen.queryByRole('link', { name: /Report a problem.*opens in a new tab/ })).not.toBeNull();
  });

  // The row's caption and its whole reason for not linking the chooser rest on
  // what CONTRIBUTING.md holds; a renamed title or a removed address breaks here.
  it('lands on the CONTRIBUTING title, whose document gives the email address and links the issue forms', () => {
    render(<ReportProblemRow />);
    const fragment = new URL(screen.getByRole('link', { name: /Report a problem/ }).getAttribute('href')!).hash.slice(1);

    const document = readFileSync(CONTRIBUTING, 'utf8');
    const title = /^# (.+)$/m.exec(document)?.[1] ?? '';

    expect(githubSlug(title), `the "# " title of CONTRIBUTING.md does not slug to #${fragment}`).toBe(fragment);
    expect(document).toContain('hello@fair.yoga');
    expect(document).toContain('/issues/new/choose');
  });
});
