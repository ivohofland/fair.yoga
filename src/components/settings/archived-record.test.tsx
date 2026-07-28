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
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={3} />);

    expect(screen.getByText('Archived Friday, Jun 12 · 3 classes withdrawn')).toBeInTheDocument();
  });

  it('uses the singular for one class', () => {
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={1} />);

    expect(screen.getByText('Archived Friday, Jun 12 · 1 class withdrawn')).toBeInTheDocument();
  });

  /**
   * "0 classes withdrawn" answers a question nobody asked and reads like a
   * failure. The date still matters — it is when the template was shelved.
   */
  it('omits the count when nothing was withdrawn', () => {
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={0} />);

    expect(screen.getByText('Archived Friday, Jun 12')).toBeInTheDocument();
  });

  /**
   * Never archived, including every template that existed before #97 shipped.
   * No line, no "unknown" placeholder, no invented history.
   */
  it('renders nothing when the template was never archived', () => {
    const { container } = render(<ArchivedRecord archivedAt={null} withdrawnCount={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
