import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PaymentStatus } from '@prisma/client';
import { ClassList, ClassListSkeleton } from './class-list';
import { type ClassRow, classRow } from './class-list-fixtures';

/**
 * Pins `PaymentRollup`'s (class-card.tsx) branching: a priority order
 * (overdue beats unpaid beats all-paid) and a `payments.length === 0` guard.
 * Tightening `{ status: string }` to `PaymentStatus` protects the *type*
 * flowing in; it cannot protect the order of two `if`s. Swap them and a class
 * with one overdue payment reports "○ N unpaid"; drop the length guard and a
 * completed class with no payments yet reports "✓ all paid" — the exact false
 * all-clear this branch exists to remove — both with a green build.
 *
 * Rendered through `ClassList` rather than `PaymentRollup` directly, because
 * the rollup is not exported and should not become exported for a test (the
 * lesson of `payment-status.ts`). The whole-list route is also what pins the
 * two guards that live in the *caller's* data shape: `registrations` is
 * optional on `ClassWithDetails`, and only the completed lifecycle stage rolls
 * anything up at all.
 */

function renderOne(status: ClassRow['status'], payments: (PaymentStatus | null)[] | undefined) {
  render(<ClassList classes={[classRow('cls-1', status, payments)]} timeZone="America/Los_Angeles" />);
}

/** A completed class whose registrations carry exactly these payment states. */
function completedClassWith(payments: { status: PaymentStatus }[]): ClassRow {
  return classRow('cls-1', 'completed', payments.map((p) => p.status));
}

function renderClassList(classes: ClassRow[]) {
  render(<ClassList classes={classes} timeZone="America/Los_Angeles" />);
}

/** The four rollup markers, so a "renders nothing" test cannot pass vacuously. */
function expectNoRollup() {
  // The card itself is on screen — otherwise the four negatives below would
  // hold for an empty render just as well.
  expect(screen.getByText('Big Room at Studio Zen')).toBeInTheDocument();
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
  expect(screen.queryByText(/not charged/)).not.toBeInTheDocument();
  expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
}

describe('ClassList payment rollup', () => {
  /**
   * Priority, not arithmetic: this class has one of each, and only the overdue
   * count is shown. Swapping the two `if`s makes it report "○ 1 unpaid" and
   * kills this test alone.
   */
  it('reports overdue ahead of unpaid', () => {
    renderOne('completed', ['overdue', 'pending', 'paid']);

    expect(screen.getByText(/! 1 overdue/)).toBeInTheDocument();
    expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
  });

  it('reports the unpaid count when nothing is overdue', () => {
    renderOne('completed', ['pending', 'pending', 'paid']);

    expect(screen.getByText(/○ 2 unpaid/)).toBeInTheDocument();
    expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
  });

  it('reports all paid only when every payment is paid', () => {
    renderOne('completed', ['paid', 'paid']);

    expect(screen.getByText(/✓ all paid/)).toBeInTheDocument();
    expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  /**
   * The guard that gives this branch its name. A completed class whose
   * registrations carry no payment rows yet has *nothing* to report — and
   * reporting "✓ all paid" for it, which is what falling through does, is a
   * false all-clear on a teacher's money.
   */
  it('stays silent when a completed class has no payments yet', () => {
    renderOne('completed', [null, null]);

    expectNoRollup();
  });

  it('renders no rollup for a class that has not completed', () => {
    renderOne('in_progress', ['overdue', 'pending']);

    expectNoRollup();
  });

  /**
   * The other half of the same guard line, and not hypothetical: `registrations`
   * is optional on the prop type, so any future caller that renders `ClassList`
   * without including them hits this. Without the check the `.map` throws and
   * takes the whole schedule down.
   */
  it('stays silent when registrations were not loaded at all', () => {
    renderOne('completed', undefined);

    expectNoRollup();
  });

  it('reports not charged rather than a false "all paid"', () => {
    renderClassList([completedClassWith([{ status: 'not_charged' }, { status: 'not_charged' }])]);
    expect(screen.getByText(/⊘ 2 not charged/)).toBeInTheDocument();
    expect(screen.queryByText(/✓ all paid/)).not.toBeInTheDocument();
  });

  it('still reports all paid when every payment really is paid', () => {
    renderClassList([completedClassWith([{ status: 'paid' }, { status: 'paid' }])]);
    expect(screen.getByText(/✓ all paid/)).toBeInTheDocument();
  });

  it('ranks outstanding above not charged', () => {
    renderClassList([completedClassWith([{ status: 'pending' }, { status: 'not_charged' }])]);
    expect(screen.getByText(/○ 1 unpaid/)).toBeInTheDocument();
  });
});

/**
 * #101. Both behaviours were wrong by the UTC offset: `dimPast` treated a
 * class's wall-clock start as UTC, and `weekLabel` derived its Monday from a
 * UTC reading of `now`. `classStartInstant` and `startOfLocalWeek` take
 * `timeZone` as an explicit argument and resolve it through
 * `Intl.DateTimeFormat({ timeZone })`, never consulting `process.env.TZ`, so
 * these assertions hold regardless of the zone the suite runs in.
 * `America/Los_Angeles` is used deliberately rather than a zone that happens
 * to match the host, so the assertions stay meaningful whatever that zone is.
 * (See `vitest.config.ts` for the suite's own timezone pin.)
 */
describe('ClassList timezone handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not dim a class that has not started in the teacher\'s zone', () => {
    // 19:00 in Los Angeles on 2026-06-01 is 2026-06-02T02:00Z. At 2026-06-01T20:00Z
    // — 13:00 local — the class is still hours away. The old `itemDateTime` read
    // the wall clock as UTC, making it "19:00Z", already past by then.
    vi.setSystemTime(new Date('2026-06-01T20:00:00.000Z'));
    render(
      <ClassList
        classes={[classRow('cls-1', 'open', [], {
          date: new Date('2026-06-01T00:00:00.000Z'),
          startTime: '19:00',
        })]}
        timeZone="America/Los_Angeles"
        dimPast
      />,
    );
    // The card is the `<Link href="/class/{id}">` (class-list.tsx:96-99); `past`
    // adds `opacity-70` to its className. Addressed by role+name because that is
    // how the rest of this file reaches rendered output — no test id exists and
    // none should be added for a test.
    expect(screen.getByRole('link', { name: /Vinyasa/ }).className).not.toContain('opacity-70');
  });

  it('labels a class as "This week" using the teacher\'s week, not UTC\'s', () => {
    // Sunday 20:00 LA = Monday 03:00 UTC. UTC has entered the next week; the
    // teacher has not, so a class dated that Saturday is still "This week".
    vi.setSystemTime(new Date('2026-06-08T03:00:00.000Z'));
    render(
      <ClassList
        classes={[classRow('cls-1', 'open', [], { date: new Date('2026-06-06T00:00:00.000Z') })]}
        timeZone="America/Los_Angeles"
      />,
    );
    expect(screen.getByText('This week')).toBeInTheDocument();
  });
});

describe('ClassListSkeleton', () => {
  it('renders one section with a heading placeholder and (default 3) card skeletons', () => {
    const { container } = render(<ClassListSkeleton />);
    const sections = container.querySelectorAll('section');
    expect(sections.length).toBe(1);
    const section = sections[0]!;
    const heading = section.firstElementChild;
    expect(heading?.classList.contains('type-subtitle')).toBe(true);
    expect(heading?.classList.contains('mb-3')).toBe(true);
    const items = section.lastElementChild;
    expect(items?.classList.contains('flex')).toBe(true);
    expect(items?.classList.contains('flex-col')).toBe(true);
    expect(items?.classList.contains('gap-3')).toBe(true);
    expect(items?.children.length).toBe(3);
  });

  it('draws `cards` card skeletons when given', () => {
    const { container } = render(<ClassListSkeleton cards={5} />);
    const items = container.querySelector('section')?.lastElementChild;
    expect(items?.children.length).toBe(5);
  });
});
