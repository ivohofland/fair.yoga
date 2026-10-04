import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
        iban="NL91 ABNA 0417 1643 00"
        beneficiary="Ivo Hofland"
        reference="Vinyasa Saturday, 12 Sep"
      />,
    );
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
      "Couldn't copy the IBAN — press and hold it to select",
    );
    expect(screen.getByRole('button', { name: 'Copy IBAN' })).not.toHaveTextContent('Copied');
  });
});
