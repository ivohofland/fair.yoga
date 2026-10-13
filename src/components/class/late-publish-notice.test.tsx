import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LatePublishNotice, shortfallSentence } from './late-publish-notice';

describe('shortfallSentence', () => {
  it('reads exactly for a minimum of one', () => {
    expect(shortfallSentence(1)).toBe('If nobody books, you cover what that student would have paid.');
  });

  it('reads exactly for a minimum above one', () => {
    expect(shortfallSentence(3)).toBe(
      'If fewer than 3 students book, you cover what the missing students would have paid.',
    );
  });
});

describe('LatePublishNotice', () => {
  it('renders nothing for none', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="none" minStudents={4} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('past_deadline names the cancellation consequence only', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_deadline" minStudents={4} />,
    );
    expect(container.textContent).toContain("can't cancel for free");
    expect(container.textContent).not.toContain('goes ahead');
  });

  it('past_check names both consequences and the shortfall', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_check" minStudents={4} />,
    );
    expect(container.textContent).toContain("can't cancel for free");
    expect(container.textContent).toContain('fewer than 4 students book');
    expect(container.textContent).toContain('you cover what the missing students would have paid');
  });

  it('past_check with a minimum of one says nobody books', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_check" minStudents={1} />,
    );
    expect(container.textContent).toContain('nobody books');
    expect(container.textContent).not.toContain('fewer than 1');
    expect(container.textContent).toContain('you cover what that student would have paid');
    expect(container.textContent).not.toContain('the missing students');
  });

  it('is gold, not danger', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_deadline" minStudents={4} />,
    );
    const cls = container.firstElementChild?.className ?? '';
    expect(cls).toContain('bg-gold-tint');
    expect(cls).toContain('text-gold-deep');
    expect(cls).not.toContain('text-danger');
  });
});

describe('LatePublishNotice, action publish, exact copy', () => {
  it('past_deadline reads exactly', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_deadline" minStudents={4} />,
    );
    expect(container.textContent).toBe(
      "This class starts inside its cancellation deadline. Students who book after you publish can't cancel for free.",
    );
  });

  it('past_check reads exactly, plural', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_check" minStudents={4} />,
    );
    expect(container.textContent).toBe(
      "This class starts inside its cancellation deadline and its auto-cancel check has passed. Students who book after you publish can't cancel for free, and the class goes ahead however few book. If fewer than 4 students book, you cover what the missing students would have paid.",
    );
  });

  it('past_check reads exactly, singular', () => {
    const { container } = render(
      <LatePublishNotice action="publish" state="past_check" minStudents={1} />,
    );
    expect(container.textContent).toBe(
      "This class starts inside its cancellation deadline and its auto-cancel check has passed. Students who book after you publish can't cancel for free, and the class goes ahead however few book. If nobody books, you cover what that student would have paid.",
    );
  });
});

describe('LatePublishNotice, action move', () => {
  it('renders nothing for none', () => {
    const { container } = render(<LatePublishNotice action="move" state="none" minStudents={4} />);
    expect(container.firstChild).toBeNull();
  });

  it('past_deadline reads exactly', () => {
    const { container } = render(
      <LatePublishNotice action="move" state="past_deadline" minStudents={4} />,
    );
    expect(container.textContent).toBe(
      "The new start is inside this class's cancellation deadline. Students who book after you save can't cancel for free.",
    );
  });

  it('past_check reads exactly, plural', () => {
    const { container } = render(
      <LatePublishNotice action="move" state="past_check" minStudents={4} />,
    );
    expect(container.textContent).toBe(
      "The new start is inside this class's cancellation deadline and past its auto-cancel check. Students who book after you save can't cancel for free, and the class goes ahead however few book. If fewer than 4 students book, you cover what the missing students would have paid.",
    );
  });

  it('past_check reads exactly, singular', () => {
    const { container } = render(
      <LatePublishNotice action="move" state="past_check" minStudents={1} />,
    );
    expect(container.textContent).toBe(
      "The new start is inside this class's cancellation deadline and past its auto-cancel check. Students who book after you save can't cancel for free, and the class goes ahead however few book. If nobody books, you cover what that student would have paid.",
    );
  });
});
