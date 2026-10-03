import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleHeader, ScheduleHeaderSkeleton } from './schedule-header';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('ScheduleHeader', () => {
  it('renders the title, caption, profile link and add-class link', () => {
    const { container } = render(
      <ScheduleHeader firstName="Visual" lastName="Teacher" photoId={null} today="Friday, 3 October" />,
    );
    expect(screen.getByRole('heading', { name: 'Schedule' }).tagName).toBe('H1');
    expect(screen.getByText('Friday, 3 October')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/settings/profile');
    expect(screen.getByRole('link', { name: '+ Add class' })).toHaveAttribute('href', '/class/new');
    expect(container.firstElementChild?.getAttribute('data-layout-anchor')).toBe('header');
  });
});

describe('ScheduleHeader (literal class-set pin)', () => {
  // Literal, not derived from ScheduleHeaderFrame: the skeleton test below
  // compares the skeleton to this component at test time, so an edit to the
  // shared frame moves both together and that test would not notice. These
  // strings pin what a reader actually sees today, so that same edit shows
  // up as a diff here.
  it('pins the root and inner-wrapper class sets as literal strings', () => {
    const { container } = render(
      <ScheduleHeader firstName="Visual" lastName="Teacher" photoId={null} today="Friday, 3 October" />,
    );
    const root = container.firstElementChild;
    const inner = root?.firstElementChild;
    expect(set(root?.className)).toEqual(set('flex items-center justify-between gap-3 mb-6'));
    expect(set(inner?.className)).toEqual(set('flex items-center gap-3 min-w-0'));
  });
});

describe('ScheduleHeaderSkeleton', () => {
  it('shares the real header\'s frame, with no link, no heading, and a same-sized avatar placeholder', () => {
    const real = render(
      <ScheduleHeader firstName="Visual" lastName="Teacher" photoId={null} today="Friday, 3 October" />,
    ).container.firstElementChild;
    const { container } = render(<ScheduleHeaderSkeleton />);
    const skel = container.firstElementChild;
    expect(skel?.getAttribute('data-layout-anchor')).toBe('header');
    expect(set(skel?.className)).toEqual(set(real?.className));
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('[style*="width: 40px"]')).not.toBeNull();
  });
});
