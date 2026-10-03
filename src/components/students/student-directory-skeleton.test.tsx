import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { listRowClass } from '@/components/ui/list-row';
import { StudentDirectory } from './student-directory';
import { StudentDirectorySkeleton } from './student-directory-skeleton';

describe('StudentDirectorySkeleton', () => {
  const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares the search wrapper and the directory row frame, hidden and inert', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          students: [{
            id: 's-1', displayName: 'Anna Bakker', email: 'anna@example.com', claimedAt: '2026-01-01T00:00:00.000Z',
            lastClassDate: null, classCount: 2, overduePayments: 0,
          }],
        },
      }),
    }));
    render(<StudentDirectory />);
    const realRow = await screen.findByRole('link', { name: /Anna Bakker/ });
    const realSearchWrap = screen.getByRole('textbox', { name: 'Search students' }).parentElement?.parentElement;

    const { container } = render(<StudentDirectorySkeleton rows={4} />);
    const root = container.firstElementChild;
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    const [searchWrap, list] = [...(root?.children ?? [])];
    expect(set(searchWrap?.className)).toEqual(set(realSearchWrap?.className));
    expect(searchWrap?.firstElementChild?.classList.contains('min-h-12')).toBe(true);

    const rows = [...(list?.children ?? [])];
    expect(rows).toHaveLength(4);
    for (const token of set(listRowClass())) {
      expect(realRow.classList.contains(token)).toBe(true);
      for (const row of rows) expect(row.classList.contains(token)).toBe(true);
    }
    expect(container.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
  });

  it('draws six rows by default', () => {
    const { container } = render(<StudentDirectorySkeleton />);
    expect(container.firstElementChild?.children[1]?.children).toHaveLength(6);
  });
});
