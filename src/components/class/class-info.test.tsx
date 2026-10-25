import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { classRow } from '@/components/schedule/class-list-fixtures';
import { ClassInfo, ClassInfoSkeleton } from './class-info';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));
const INTERACTIVE = 'a, button, input, select, textarea, [tabindex]';

describe('ClassInfoSkeleton', () => {
  it('draws through ClassInfo\'s own frame and badge row, on the page surface, hidden and inert', () => {
    const real = render(
      <ClassInfo cls={classRow('c-1', 'open', [])} registrationCount={3} waitlistCount={0} />,
    ).container.firstElementChild;
    const { container } = render(<ClassInfoSkeleton />);
    const skel = container.firstElementChild;

    expect(skel?.getAttribute('aria-hidden')).toBe('true');
    expect(set(skel?.className)).toEqual(set(real?.className));
    expect(set(skel?.firstElementChild?.className)).toEqual(set(real?.firstElementChild?.className));

    // The frame is the page, not a card: placeholders take the page fill.
    expect(skel?.querySelector('.bg-sand-soft')).not.toBeNull();
    expect(skel?.querySelector('.bg-sand')).toBeNull();

    // The date, room and count lines carry the real lines' type styles and
    // vertical margins, so each placeholder line is its line's height.
    const geometry = (el: Element) => [...set(el.className)].filter((t) => t.startsWith('type-') || /^m[tb]-/.test(t)).sort();
    const lines = [...(real?.querySelectorAll('p') ?? [])].map(geometry);
    const skelLines = [...(skel?.children ?? [])].slice(1).map(geometry);
    expect(skelLines).toEqual(lines);

    expect(container.querySelector(INTERACTIVE)).toBeNull();
  });
});

describe('ClassInfo "needs N to go ahead"', () => {
  const NEEDS = /needs 4 to go ahead/;
  const render1 = (status: 'draft' | 'open' | 'in_progress' | 'completed', decided: boolean, cancelled = false) => {
    const cls = classRow('c-n', status, [], { cancelled });
    cls.autoCancelDecidedAt = decided ? new Date('2026-06-12T07:30:00.000Z') : null;
    return render(<ClassInfo cls={cls} registrationCount={2} waitlistCount={0} />);
  };

  it('shows while open and not yet decided', () => {
    const { container } = render1('open', false);
    expect(container.textContent).toMatch(NEEDS);
  });

  it('shows on a draft, which the check has yet to judge', () => {
    const { container } = render1('draft', false);
    expect(container.textContent).toMatch(NEEDS);
  });

  it('hides once decided, keeping the registered count', () => {
    const { container } = render1('open', true);
    expect(container.textContent).not.toMatch(NEEDS);
    expect(container.textContent).toContain('2 registered');
  });

  it('hides while in progress', () => {
    const { container } = render1('in_progress', false);
    expect(container.textContent).not.toMatch(NEEDS);
    expect(container.textContent).toContain('2 registered');
  });

  it('hides once completed', () => {
    const { container } = render1('completed', false);
    expect(container.textContent).not.toMatch(NEEDS);
    expect(container.textContent).toContain('2 registered');
  });

  it('hides on a cancelled class', () => {
    const { container } = render1('open', false, true);
    expect(container.textContent).not.toMatch(NEEDS);
  });
});

describe('ClassInfo, online (#911)', () => {
  const online = (videoUrl: string | null, over: { cancelled?: boolean; status?: 'draft' | 'open' | 'completed' } = {}) => {
    const cls = classRow('c-o', over.status ?? 'open', [], { cancelled: over.cancelled === true });
    cls.format = 'online';
    cls.teacherRoomId = null;
    cls.teacherRoom = null;
    cls.videoUrl = videoUrl;
    return cls;
  };

  it('names the location Online', () => {
    const { container } = render(<ClassInfo cls={online(null)} registrationCount={0} waitlistCount={0} />);
    expect(container.textContent).toContain('Online');
  });

  it('nudges, in the attention style, when there is no link yet', () => {
    const { getByText } = render(<ClassInfo cls={online(null)} registrationCount={0} waitlistCount={0} />);
    const nudge = getByText('No video link yet');
    expect(nudge.className).toContain('text-gold-deep');
    expect(nudge.className).toContain('bg-gold-tint');
  });

  it('nudges on a draft too', () => {
    const { container } = render(<ClassInfo cls={online(null, { status: 'draft' })} registrationCount={0} waitlistCount={0} />);
    expect(container.textContent).toContain('No video link yet');
  });

  it('shows the link, and no nudge, once there is one', () => {
    const { container, getByRole } = render(
      <ClassInfo cls={online('https://meet.example/a?pwd=1')} registrationCount={0} waitlistCount={0} />,
    );
    expect(getByRole('link')).toHaveAttribute('href', 'https://meet.example/a?pwd=1');
    expect(getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).not.toContain('No video link yet');
  });

  it('does not nudge a class that is over', () => {
    const done = render(<ClassInfo cls={online(null, { status: 'completed' })} registrationCount={0} waitlistCount={0} />);
    expect(done.container.textContent).not.toContain('No video link yet');
    const cancelled = render(<ClassInfo cls={online(null, { cancelled: true })} registrationCount={0} waitlistCount={0} />);
    expect(cancelled.container.textContent).not.toContain('No video link yet');
  });

  it('shows neither for a class in a room', () => {
    const { container, queryByRole } = render(
      <ClassInfo cls={classRow('c-r', 'open', [])} registrationCount={0} waitlistCount={0} />,
    );
    expect(container.textContent).not.toContain('No video link yet');
    expect(queryByRole('link')).toBeNull();
  });
});
