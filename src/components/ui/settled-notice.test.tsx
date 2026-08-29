import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettledNotice } from './settled-notice';

/**
 * #40. The settled state a control reaches once its mutation has committed but
 * the router action that should have replaced it did not. Every control that
 * reaches it shows the same thing, so it is one component rather than a copy
 * per call site — and the name is how the next person finds the invariant.
 * Deliberately not a count: it was five until the whole-branch review found
 * two more call sites, which is what a number in a comment always does.
 */
describe('SettledNotice', () => {
  it('renders the label and an operable action', () => {
    const onAction = vi.fn();
    render(<SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={onAction} />);

    expect(screen.getByText('Marked unpaid')).toBeInTheDocument();

    const action = screen.getByRole('button', { name: 'Refresh' });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('uses the caption scale by default and the sm scale on request', () => {
    const { rerender } = render(
      <SettledNotice label="Removed" actionLabel="Refresh" onAction={() => {}} />,
    );
    expect(screen.getByText('Removed')).toHaveClass('type-caption');

    rerender(
      <SettledNotice label="Created" actionLabel="Go to recurring classes" onAction={() => {}} size="sm" />,
    );
    expect(screen.getByText('Created')).toHaveClass('text-sm');
  });

  // The action is never disabled: this component exists because something else
  // failed, so it must always be the way out.
  it('never renders a disabled action', () => {
    render(<SettledNotice label="Accepted" actionLabel="Refresh" onAction={() => {}} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled();
  });

  /**
   * #40, #128. This never arrives on a page the user is reading: it replaces
   * the control they just activated, so without focus management focus drops
   * to `document.body` at the same moment. `role="status"` is what makes the
   * swap audible, `focus-visible:shadow-focus` is what makes the exit visible,
   * and shifting focus to the action button on mount (#128) is what keeps
   * keyboard and screen-reader users anchored on a deliberate control.
   */
  it('announces itself as a live region, and rings its action on focus', () => {
    render(<SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Marked unpaid');
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveClass(
      'focus-visible:shadow-focus',
    );
  });

  it('moves focus to the action button on mount', () => {
    render(<SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh' }));
  });
});
