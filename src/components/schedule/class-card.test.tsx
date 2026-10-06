import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Decimal } from '@prisma/client/runtime/library';
import {
  ClassCard,
  ClassCardSkeleton,
  StudioClassCard,
  StudioClassCardSkeleton,
  type StudioClassWithEntry,
} from './class-card';
import { AT, classRow } from './class-list-fixtures';
import { Card } from '@/components/ui/card';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

/** Text visible to assistive tech — empty under an `aria-hidden="true"` ancestor. */
function visibleText(el: Element): string {
  if (el.getAttribute('aria-hidden') === 'true') return '';
  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    else if (node.nodeType === Node.ELEMENT_NODE) out += visibleText(node as Element);
  }
  return out;
}

function studioRow(overrides?: { cancelled?: boolean; studentCount?: number | null }): StudioClassWithEntry {
  return {
    id: 'sc-1',
    calendarEntryId: 'entry-sc-1',
    kind: 'studio' as const,
    calendarEntry: {
      id: 'entry-sc-1',
      teacherId: 'teacher-1',
      kind: 'studio' as const,
      classType: 'Studio Flow',
      date: new Date('2026-06-12T00:00:00.000Z'),
      startTime: new Date('1970-01-01T09:30:00.000Z'),
      durationMinutes: 60,
      cancelledAt: overrides?.cancelled === true ? AT : null,
      live: overrides?.cancelled !== true,
      classCompletedAt: null,
      scheduleRuleId: null,
      createdAt: AT,
      updatedAt: AT,
    },
    location: 'Studio Zen',
    currency: 'EUR' as const,
    studentCount: overrides?.studentCount ?? null,
    hourlyRate: new Decimal(50),
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('ClassCard', () => {
  it('renders a link to /class/<id> with the card frame', () => {
    render(<ClassCard cls={classRow('cls-1', 'open', [])} isPast={false} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/class/cls-1');
    expect(set(link.className)).toEqual(
      set('block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand'),
    );
  });

  it('dims a cancelled class with opacity-70', () => {
    render(<ClassCard cls={classRow('cls-1', 'open', [], { cancelled: true })} isPast={false} />);
    const link = screen.getByRole('link');
    expect(link.classList.contains('opacity-70')).toBe(true);
  });
});

describe('ClassCardSkeleton', () => {
  it("matches Card's plain class set, with no link and no visible text", () => {
    // Derived from a real plain `<Card>`, not a hardcoded string: both sit on
    // the same surface frame, so this equality survives that frame changing
    // and only catches the skeleton diverging from it.
    const cardRoot = render(<Card>x</Card>).container.firstElementChild;
    const { container } = render(<ClassCardSkeleton />);
    const root = container.firstElementChild;
    expect(root?.tagName).toBe('DIV');
    expect(set(root?.className)).toEqual(set(cardRoot?.className));
    expect(container.querySelector('a')).toBeNull();
    expect(visibleText(root!).trim()).toBe('');
  });

  it('draws every bar on the card surface (bg-sand), never bg-sand-soft', () => {
    const { container } = render(<ClassCardSkeleton />);
    const root = container.firstElementChild!;
    const bars = Array.from(root.querySelectorAll('*')).filter(
      (el) => el.classList.contains('bg-sand') || el.classList.contains('bg-sand-soft'),
    );
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.classList.contains('bg-sand')).toBe(true);
      expect(bar.classList.contains('bg-sand-soft')).toBe(false);
    }
  });
});

describe('StudioClassCard', () => {
  it('renders a link with the dashed card frame', () => {
    render(<StudioClassCard sc={studioRow()} isPast={false} />);
    const link = screen.getByRole('link');
    expect(set(link.className)).toEqual(
      set('block border border-dashed border-border rounded-card px-5 py-3 no-underline hover:bg-sand-soft'),
    );
  });
});

describe('StudioClassCardSkeleton', () => {
  it('carries the dashed frame on a plain div, with no link', () => {
    const { container } = render(<StudioClassCardSkeleton />);
    const root = container.firstElementChild;
    expect(root?.tagName).toBe('DIV');
    expect(container.querySelector('a')).toBeNull();
    for (const token of ['border', 'border-dashed', 'border-border', 'rounded-card', 'px-5', 'py-3']) {
      expect(root?.classList.contains(token)).toBe(true);
    }
  });

  it('draws its bars on the page surface (bg-sand-soft), since the dashed card sits on cream', () => {
    const { container } = render(<StudioClassCardSkeleton />);
    const root = container.firstElementChild!;
    const bars = Array.from(root.querySelectorAll('*')).filter(
      (el) => el.classList.contains('bg-sand') || el.classList.contains('bg-sand-soft'),
    );
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar.classList.contains('bg-sand-soft')).toBe(true);
      expect(bar.classList.contains('bg-sand')).toBe(false);
    }
  });
});
