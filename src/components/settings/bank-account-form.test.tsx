import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Currency } from '@prisma/client';
import { routerRefresh } from '../../../tests/setup/components';
import { BankAccountForm, EMPTY_BANK_ACCOUNT, type BankAccountValues } from './bank-account-form';

const fetchMock = vi.fn();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderForm(
  currency: Currency,
  initial: BankAccountValues = EMPTY_BANK_ACCOUNT,
  others: { currency: Currency; masked: string }[] = [],
): void {
  vi.stubGlobal('fetch', fetchMock);
  render(<BankAccountForm teacherId="t1" currency={currency} initial={initial} others={others} />);
}

/** The labels of every text field the block renders, in order. */
function fieldLabels(): string[] {
  return screen.getAllByRole('textbox').map((el) => {
    const id = el.getAttribute('id');
    return document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
  });
}

function sent(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

describe('BankAccountForm', () => {
  it('shows the SEPA fields for EUR', () => {
    renderForm('EUR');
    expect(fieldLabels()).toEqual(['IBAN', 'BIC (needed for an IBAN outside the EEA)', 'Account holder name']);
  });

  it('shows sort code and account number for GBP', () => {
    renderForm('GBP');
    expect(fieldLabels()).toEqual(['Sort code', 'Account number', 'Account holder name']);
  });

  it('shows routing and account number for USD', () => {
    renderForm('USD');
    expect(fieldLabels()).toEqual(['Routing number', 'Account number', 'Account holder name']);
  });

  it('shows the IBAN fields with an optional BIC for CHF', () => {
    renderForm('CHF');
    expect(fieldLabels()).toEqual(['IBAN', 'BIC (optional)', 'Account holder name']);
  });

  it('saves to the current currency’s URL with only its scheme’s fields, and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    renderForm('GBP');
    fireEvent.change(screen.getByLabelText('Sort code'), { target: { value: '12-34-56' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A. Teacher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const { url, init } = sent();
    expect(url).toBe('/api/teachers/t1/bank-accounts/GBP');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ holderName: 'A. Teacher', sortCode: '12-34-56', accountNumber: '12345678' });
  });

  it('marks the BIC field on a BIC_REQUIRED refusal', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'BIC_REQUIRED', message: 'bic: Add the BIC' } }),
      { status: 400 },
    ));
    renderForm('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(screen.getByLabelText('BIC (needed for an IBAN outside the EEA)')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByLabelText('IBAN')).not.toHaveAttribute('aria-invalid');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('marks the field a validation message names', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'iban: Enter a valid IBAN' } }),
      { status: 400 },
    ));
    renderForm('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(screen.getByLabelText('IBAN')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Enter a valid IBAN')).toBeInTheDocument();
  });

  it('lists accounts in other currencies, masked, and removes one with DELETE', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { currency: 'EUR' } }), { status: 200 }));
    renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
    expect(screen.getByText('•••• 4300')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove EUR account' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const { url, init } = sent();
    expect(url).toBe('/api/teachers/t1/bank-accounts/EUR');
    expect(init.method).toBe('DELETE');
  });
});
