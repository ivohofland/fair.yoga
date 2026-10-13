import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { LateFirstClassNotice } from './late-first-class-notice';
import type { LateFirstClass } from '@/lib/late-publish';

function late(state: LateFirstClass['state'], minStudents: number): LateFirstClass {
  return { date: '2026-11-10', state, minStudents };
}

describe('LateFirstClassNotice, added', () => {
  it('past_deadline reads exactly', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_deadline', 3)} when="added" />);
    expect(container.textContent).toBe(
      "Your first class, on Tuesday, 10 Nov, starts inside its cancellation deadline. Students who book it can't cancel for free. You can cancel it from your schedule.",
    );
  });

  it('past_check reads exactly, plural', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_check', 3)} when="added" />);
    expect(container.textContent).toBe(
      "Your first class, on Tuesday, 10 Nov, starts inside its cancellation deadline and past its auto-cancel check. Students who book it can't cancel for free, and the class goes ahead however few book. If fewer than 3 students book, you cover what the missing students would have paid. You can cancel it from your schedule.",
    );
  });

  it('past_check reads exactly, singular', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_check', 1)} when="added" />);
    expect(container.textContent).toBe(
      "Your first class, on Tuesday, 10 Nov, starts inside its cancellation deadline and past its auto-cancel check. Students who book it can't cancel for free, and the class goes ahead however few book. If nobody books, you cover what that student would have paid. You can cancel it from your schedule.",
    );
  });
});

describe('LateFirstClassNotice, expected', () => {
  it('past_deadline reads exactly', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_deadline', 3)} when="expected" />);
    expect(container.textContent).toBe(
      "Your first class on the new schedule, on Tuesday, 10 Nov, may be added after its cancellation deadline has passed. Students who book it then can't cancel for free.",
    );
  });

  it('past_check reads exactly, plural', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_check', 3)} when="expected" />);
    expect(container.textContent).toBe(
      "Your first class on the new schedule, on Tuesday, 10 Nov, may be added after its cancellation deadline and auto-cancel check have passed. Students who book it then can't cancel for free, and it may go ahead however few book. If fewer than 3 students book, you cover what the missing students would have paid.",
    );
  });

  it('past_check reads exactly, singular', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_check', 1)} when="expected" />);
    expect(container.textContent).toBe(
      "Your first class on the new schedule, on Tuesday, 10 Nov, may be added after its cancellation deadline and auto-cancel check have passed. Students who book it then can't cancel for free, and it may go ahead however few book. If nobody books, you cover what that student would have paid.",
    );
  });
});

describe('LateFirstClassNotice, markup', () => {
  it('is styled as LatePublishNotice', () => {
    const { container } = render(<LateFirstClassNotice late={late('past_deadline', 3)} when="added" />);
    expect(container.firstElementChild?.tagName).toBe('P');
    expect(container.firstElementChild?.className).toBe(
      'type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4',
    );
  });
});
