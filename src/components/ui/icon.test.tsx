import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { IconSkeleton } from './icon';

describe('IconSkeleton', () => {
  it('renders a hidden placeholder slot sized like the real icon, on the page surface by default', () => {
    const { container } = render(<IconSkeleton size={18} />);
    const slot = container.firstElementChild;
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect((slot as HTMLElement)?.style.width).toBe('18px');
    expect((slot as HTMLElement)?.style.height).toBe('18px');
    expect(slot?.querySelector('.bg-sand-soft')).not.toBeNull();
  });

  it('fills with the card surface step when asked', () => {
    const { container } = render(<IconSkeleton size={20} surface="card" />);
    expect(container.querySelector('.bg-sand')).not.toBeNull();
    expect(container.querySelector('.bg-sand-soft')).toBeNull();
  });
});
