import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BankDetails } from '@/lib/bank-details';
import { PaymentDetails } from './payment-details';

describe('PaymentDetails', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubClipboard(writeText: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
    const spy = vi.fn(writeText);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: spy } });
    return spy;
  }

  function renderDetails(): void {
    render(
      <PaymentDetails
        details={{ scheme: 'sepa', iban: 'NL91 ABNA 0417 1643 00', bic: null }}
        beneficiary="Ivo Hofland"
        reference="Vinyasa Saturday, 12 Sep"
      />,
    );
  }

  function renderScheme(details: BankDetails): void {
    render(<PaymentDetails details={details} beneficiary="Ivo Hofland" reference="Vinyasa Saturday, 12 Sep" />);
  }

  it('shows the name, IBAN and reference a transfer needs', () => {
    renderDetails();
    expect(screen.getByText('Ivo Hofland')).toBeInTheDocument();
    expect(screen.getByText('NL91 ABNA 0417 1643 00')).toBeInTheDocument();
    expect(screen.getByText('Vinyasa Saturday, 12 Sep')).toBeInTheDocument();
  });

  it('copies the name as shown', async () => {
    const writeText = stubClipboard(async () => {});
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy name' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Ivo Hofland'));
  });

  it('copies the IBAN without its display spaces, so a bank field with a length limit takes it whole', async () => {
    const writeText = stubClipboard(async () => {});
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy IBAN' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('NL91ABNA0417164300'));
  });

  it('copies the reference', async () => {
    const writeText = stubClipboard(async () => {});
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy reference' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Vinyasa Saturday, 12 Sep'));
  });

  it('confirms the copy on the button that made it, and only that one', async () => {
    stubClipboard(async () => {});
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy IBAN' }));
    expect(await screen.findByRole('status')).toHaveTextContent('IBAN copied');
    expect(screen.getByRole('button', { name: 'Copy IBAN' })).toHaveTextContent('Copied');
    expect(screen.getByRole('button', { name: 'Copy name' })).toHaveTextContent('Copy');
  });

  it('says so when the clipboard refuses, rather than claiming a copy', async () => {
    stubClipboard(async () => {
      throw new Error('NotAllowedError');
    });
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy IBAN' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Couldn’t copy the IBAN — press and hold it to select',
    );
    expect(screen.getByRole('button', { name: 'Copy IBAN' })).not.toHaveTextContent('Copied');
  });

  it('handles a missing clipboard API without throwing, and says why in the console', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    renderDetails();
    fireEvent.click(screen.getByRole('button', { name: 'Copy IBAN' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Couldn’t copy the IBAN — press and hold it to select',
    );
    expect(screen.getByRole('button', { name: 'Copy IBAN' })).not.toHaveTextContent('Copied');
    expect(warn).toHaveBeenCalledWith('[payment-details] no clipboard API; the copy was not attempted');
  });

  it('has valid dl structure with only dt/dd elements in each row div', () => {
    renderDetails();
    const dl = screen.getByText('Name').closest('dl');
    if (!dl) throw new Error('dl not found');
    const rowDivs = Array.from(dl.querySelectorAll(':scope > div'));
    expect(rowDivs).toHaveLength(3);
    rowDivs.forEach((rowDiv) => {
      const children = Array.from(rowDiv.children);
      children.forEach((child) => {
        expect(['DT', 'DD'].includes(child.tagName)).toBe(true);
      });
    });
  });

  it('shows no BIC row without a BIC', () => {
    renderScheme({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
    expect(screen.queryByText('BIC')).not.toBeInTheDocument();
  });

  it.each(['sepa', 'iban'] as const)('shows and copies the BIC of a %s account that has one', async (scheme) => {
    const writeText = stubClipboard(async () => {});
    renderScheme({ scheme, iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    expect(screen.getByText('IBAN')).toBeInTheDocument();
    expect(screen.getByText('CH9300762011623852957')).toBeInTheDocument();
    expect(screen.getByText('BIC')).toBeInTheDocument();
    expect(screen.getByText('UBSWCHZH80A')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy BIC' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('UBSWCHZH80A'));
  });

  it('shows a UK account as a sort code and an account number, each copyable, and no IBAN', async () => {
    const writeText = stubClipboard(async () => {});
    renderScheme({ scheme: 'uk', sortCode: '123456', accountNumber: '12345678' });
    expect(screen.getByText('Sort code')).toBeInTheDocument();
    expect(screen.getByText('12-34-56')).toBeInTheDocument();
    expect(screen.getByText('Account number')).toBeInTheDocument();
    expect(screen.getByText('12345678')).toBeInTheDocument();
    expect(screen.queryByText('IBAN')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy sort code' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('123456'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy account number' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('12345678'));
  });

  it('shows a US account as a routing number and an account number, each copyable, and no IBAN', async () => {
    const writeText = stubClipboard(async () => {});
    renderScheme({ scheme: 'us', routingNumber: '021000021', accountNumber: '1234567' });
    expect(screen.getByText('Routing number')).toBeInTheDocument();
    expect(screen.getByText('021000021')).toBeInTheDocument();
    expect(screen.getByText('Account number')).toBeInTheDocument();
    expect(screen.getByText('1234567')).toBeInTheDocument();
    expect(screen.queryByText('IBAN')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy routing number' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('021000021'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy account number' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('1234567'));
  });
});
