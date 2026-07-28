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

    expect(screen.getByText('Archived Friday, Jun 12 · 3 classes withdrawn')).toBeInTheDocument();
  });

  it('uses the singular for one class', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T00:00:00.000Z')}
        withdrawnCount={1}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived Friday, Jun 12 · 1 class withdrawn')).toBeInTheDocument();
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

    expect(screen.getByText('Archived Friday, Jun 12')).toBeInTheDocument();
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
   * `archivedAt` is a true instant, not a `@db.Date` calendar date. 22:30 UTC
   * on Jun 12 is 00:30 CEST on Jun 13 for an Amsterdam teacher — one day
   * later. A component that fed the raw instant straight to `formatDayHeader`
   * (dropping the local-day conversion) would read the UTC calendar date and
   * print "Jun 12" instead, so this fails if that conversion is ever dropped.
   */
  it('renders the date in the teacher\'s local calendar day, not UTC\'s', () => {
    render(
      <ArchivedRecord
        archivedAt={new Date('2026-06-12T22:30:00.000Z')}
        withdrawnCount={2}
        timeZone="Europe/Amsterdam"
      />,
    );

    expect(screen.getByText('Archived Saturday, Jun 13 · 2 classes withdrawn')).toBeInTheDocument();
  });
});
