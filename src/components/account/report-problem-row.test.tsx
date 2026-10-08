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

  // The row's caption and its whole reason for not linking the chooser rest on
  // what this section holds; a renamed heading or a removed address breaks here.
  it('lands on a CONTRIBUTING section that gives the email address and links the issue forms', () => {
    render(<ReportProblemRow />);
    const fragment = new URL(screen.getByRole('link', { name: /Report a problem/ }).getAttribute('href')!).hash.slice(1);

    const sections = readFileSync(CONTRIBUTING, 'utf8').split(/^## /m).slice(1);
    const section = sections.find((s) => githubSlug(s.split('\n', 1)[0]) === fragment);

    expect(section, `no "## " heading in CONTRIBUTING.md slugs to #${fragment}`).toBeDefined();
    expect(section).toContain('hello@fair.yoga');
    expect(section).toContain('/issues/new/choose');
  });
});
