import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LatePublishNotice } from './late-publish-notice';

describe('LatePublishNotice', () => {
  it('renders nothing for none', () => {
    const { container } = render(<LatePublishNotice state="none" minStudents={4} />);
    expect(container.firstChild).toBeNull();
  });

  it('past_deadline names the cancellation consequence only', () => {
    const { container } = render(<LatePublishNotice state="past_deadline" minStudents={4} />);
    expect(container.textContent).toContain("can't cancel for free");
    expect(container.textContent).not.toContain('goes ahead');
  });

  it('past_check names both consequences and the shortfall', () => {
    const { container } = render(<LatePublishNotice state="past_check" minStudents={4} />);
    expect(container.textContent).toContain("can't cancel for free");
    expect(container.textContent).toContain('fewer than 4 students book');
    expect(container.textContent).toContain('you cover what the missing students would have paid');
  });

  it('past_check with a minimum of one says nobody books', () => {
    const { container } = render(<LatePublishNotice state="past_check" minStudents={1} />);
    expect(container.textContent).toContain('nobody books');
    expect(container.textContent).not.toContain('fewer than 1');
    expect(container.textContent).toContain('you cover what that student would have paid');
    expect(container.textContent).not.toContain('the missing students');
  });

  it('is gold, not danger', () => {
    const { container } = render(<LatePublishNotice state="past_deadline" minStudents={4} />);
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('bg-gold-tint');
    expect(cls).toContain('text-gold-deep');
    expect(cls).not.toContain('text-danger');
  });
});
