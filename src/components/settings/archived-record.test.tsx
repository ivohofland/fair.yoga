import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArchivedRecord } from './archived-record';

/**
 * #97. The counts used to exist only in the post-click confirmation, so a
 * refresh lost them. This line is the durable half; the confirmation stays as
 * the immediate half.
 */
describe('ArchivedRecord', () => {
  it('renders the date and the count', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T00:00:00.000Z')}
        withdrawnCount={3}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 12 Jun 2026 · 3 classes withdrawn')).toBeInTheDocument();
  });

  it('uses the singular for one class', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T00:00:00.000Z')}
        withdrawnCount={1}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 12 Jun 2026 · 1 class withdrawn')).toBeInTheDocument();
  });

  /**
   * "0 classes withdrawn" answers a question nobody asked and reads like a
   * failure. The date still matters — it is when the template was shelved.
   */
  it('omits the count when nothing was withdrawn', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T00:00:00.000Z')}
        withdrawnCount={0}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 12 Jun 2026')).toBeInTheDocument();
  });

  /**
   * Never archived, including every template that existed before #97 shipped.
   * No line, no "unknown" placeholder, no invented history.
   */
  it('renders nothing when the template was never archived', () => {
    const { container } = render(
      <ArchivedRecord archivedAt={null} withdrawnCount={null} timeZone="Europe/Amsterdam" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * `archivedAt` alone governs the guard, which the case above cannot show:
   * with both props null, a guard widened to `!archivedAt || withdrawnCount
   * === null` renders nothing either way and every test still passes. This is
   * the combination that separates them — and it is reachable in production,
   * not hypothetical: `eraseTeacher` (gdpr.ts) bulk-archives without writing
   * either column, and any row archived before #97 shipped carries the same
   * shape once one is backfilled.
   */
  it('renders the bare date when the count was never recorded', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T00:00:00.000Z')}
        withdrawnCount={null}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 12 Jun 2026')).toBeInTheDocument();
  });

  /**
   * `archivedAt` is a true instant, not a `@db.Date` calendar date. 22:30 UTC
   * on Jun 12 is 00:30 CEST on Jun 13 for an Amsterdam teacher — one day
   * later. A component that fed the raw instant straight to the formatter
   * (dropping the local-day conversion) would read the UTC calendar date and
   * print "12 Jun" instead, so this fails if that conversion is ever dropped.
   */
  it('renders the date in the teacher\'s local calendar day, not UTC\'s', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T22:30:00.000Z')}
        withdrawnCount={2}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 13 Jun 2026 · 2 classes withdrawn')).toBeInTheDocument();
  });

  /**
   * The other direction, which every other fixture in this file misses by
   * being Amsterdam. 02:30 UTC on Jun 12 is 22:30 EDT on Jun 11 for a New York
   * teacher — one day *earlier*, where the Amsterdam case above is one day
   * later. A component that dropped the local-day conversion would print
   * "12 Jun" in both, so an east-only file cannot tell a real conversion from
   * one that only ever rounds up.
   */
  it('renders the local calendar day west of UTC too, not just east', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T02:30:00.000Z')}
        withdrawnCount={2}
        timeZone="America/New_York"
      />,
    );

    expect(screen.getByText('Archived 11 Jun 2026 · 2 classes withdrawn')).toBeInTheDocument();
  });

  /**
   * The record's entire purpose is surviving indefinitely, so a date without
   * a year would let a template archived last year read identically to one
   * archived last month. This fixture sits in a year prior to every other
   * fixture in this file, so a formatter that dropped the year (or hardcoded
   * the current one) would not print "2025" here.
   */
  it('carries the year across a year boundary from the other fixtures', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2025-11-03T00:00:00.000Z')}
        withdrawnCount={0}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived 3 Nov 2025')).toBeInTheDocument();
  });
});
