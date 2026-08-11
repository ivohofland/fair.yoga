import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettledNotice } from './settled-notice';

/**
 * #40. The settled state a control reaches once its mutation has committed but
 * the router action that should have replaced it did not. Five components share
 * it, so it is one component rather than five copies — and the name is how the
 * next person finds the invariant.
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
});
