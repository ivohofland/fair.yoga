import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { formatMoney } from '@/lib/format';
import { PaymentLinkPanel } from './payment-link-panel';

describe('PaymentLinkPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderPanel(): void {
    render(
      <PaymentLinkPanel
        url="https://revolut.me/anna"
        host="revolut.me"
        amount={12.5}
        currency="EUR"
        reference="Hatha Tue 7 Oct"
      />,
    );
  }

  it('links to the teacher’s page in a new tab, labelled with where it goes', () => {
    renderPanel();
    const link = screen.getByRole('link', { name: 'Pay via revolut.me' });
    expect(link).toHaveAttribute('href', 'https://revolut.me/anna');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('offers the amount and the reference to copy', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Copy amount' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy reference' })).toBeInTheDocument();
    expect(screen.getAllByText(formatMoney(12.5, 'EUR')).length).toBeGreaterThan(0);
  });

  it('copies the amount as a bare decimal, with no currency symbol', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Copy amount' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('12.50'));
  });
});
