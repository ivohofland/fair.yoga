import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SendAnnouncement } from './send-announcement';
import { SendAnnouncementSkeleton } from './send-announcement-skeleton';

describe('SendAnnouncementSkeleton', () => {
  it('draws the collapsed trigger\'s line in its type style, hidden and inert', () => {
    render(<SendAnnouncement recipientHint="your booked students" />);
    const trigger = screen.getByRole('button', { name: 'Send announcement' });
    const { container } = render(<SendAnnouncementSkeleton />);
    const line = container.firstElementChild;
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    const typeStyle = trigger.className.split(/\s+/).find((t) => t.startsWith('type-'));
    expect(typeStyle).toBe('type-label');
    expect(line?.classList.contains(typeStyle ?? '')).toBe(true);
    // Inline like the button, so its wrapper's line box matches the real page's.
    expect(line?.classList.contains('inline-block')).toBe(true);
    expect(container.querySelector('a, button, input, select, textarea, [tabindex]')).toBeNull();
  });
});
