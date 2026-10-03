import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { RegistrationProgress, RegistrationProgressSkeleton } from './registration-progress';

describe('RegistrationProgressSkeleton', () => {
  it("shares the real count row's frame", () => {
    const real = render(<RegistrationProgress registered={3} min={4} max={12} />).container.firstElementChild;
    const skel = render(<RegistrationProgressSkeleton />).container.firstElementChild;
    const realRow = real?.firstElementChild;
    const skelRow = skel?.firstElementChild;
    for (const token of ['flex', 'items-baseline', 'justify-end', 'gap-[5px]', 'mb-1']) {
      expect(realRow?.classList.contains(token)).toBe(true);
      expect(skelRow?.classList.contains(token)).toBe(true);
    }
  });

  it("shares the real track's frame", () => {
    const real = render(<RegistrationProgress registered={3} min={4} max={12} />).container.firstElementChild;
    const skel = render(<RegistrationProgressSkeleton />).container.firstElementChild;
    const realTrack = real?.lastElementChild;
    const skelTrack = skel?.lastElementChild;
    for (const token of ['relative', 'h-2', 'rounded-[4px]']) {
      expect(realTrack?.classList.contains(token)).toBe(true);
      expect(skelTrack?.classList.contains(token)).toBe(true);
    }
  });

  it('is aria-hidden, with a transparent count row', () => {
    const { container } = render(<RegistrationProgressSkeleton className="mt-3" />);
    const root = container.firstElementChild;
    expect(root?.getAttribute('aria-hidden')).toBe('true');
    expect(root?.classList.contains('mt-3')).toBe(true);
    const spans = root?.firstElementChild?.children;
    expect(spans?.[0]?.classList.contains('text-transparent')).toBe(true);
    expect(spans?.[1]?.classList.contains('text-transparent')).toBe(true);
  });

  it('fills the track with bg-sand-soft on the page surface and bg-sand on a card', () => {
    const page = render(<RegistrationProgressSkeleton />).container.firstElementChild?.lastElementChild;
    const card = render(<RegistrationProgressSkeleton surface="card" />).container.firstElementChild?.lastElementChild;
    expect(page?.classList.contains('bg-sand-soft')).toBe(true);
    expect(card?.classList.contains('bg-sand')).toBe(true);
    expect(card?.classList.contains('bg-sand-soft')).toBe(false);
  });
});
