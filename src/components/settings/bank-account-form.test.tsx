import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { Currency } from '@prisma/client';
import { routerRefresh } from '../../../tests/setup/components';
import { BankAccountForm, EMPTY_BANK_ACCOUNT, type BankAccountValues } from './bank-account-form';

const fetchMock = vi.fn();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderForm(
  currency: Currency,
  initial: BankAccountValues = EMPTY_BANK_ACCOUNT,
  others: { currency: Currency; masked: string }[] = [],
  hasAccount = false,
): void {
  vi.stubGlobal('fetch', fetchMock);
  render(<BankAccountForm teacherId="t1" currency={currency} initial={initial} hasAccount={hasAccount} others={others} />);
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

function sentBody(): unknown {
  return JSON.parse(sent().init.body as string);
}

/** A stored row as the PUT answers it. */
function storedRow(currency: Currency, columns: Partial<BankAccountValues>): Response {
  const data = { id: 'a1', teacherId: 't1', currency, holderName: '', iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null, ...columns };
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function saveForm(): HTMLElement {
  const form = screen.getByRole('button', { name: 'Save bank details' }).closest('form');
  if (form === null) throw new Error('no save form');
  return form;
}

const QUESTION_EUR = 'Remove EUR details? Students with unpaid EUR classes will no longer see them.';
const QUESTION_GBP = 'Remove GBP details? Students with unpaid GBP classes will no longer see them.';

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
    fetchMock.mockResolvedValue(storedRow('GBP', { holderName: 'A. Teacher', sortCode: '123456', accountNumber: '12345678' }));
    renderForm('GBP');
    fireEvent.change(screen.getByLabelText('Sort code'), { target: { value: '12-34-56' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A. Teacher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    const { url, init } = sent();
    expect(url).toBe('/api/teachers/t1/bank-accounts/GBP');
    expect(init.method).toBe('PUT');
    expect(sentBody()).toEqual({ holderName: 'A. Teacher', sortCode: '12-34-56', accountNumber: '12345678' });
  });

  it('sends a euro account’s IBAN and BIC', async () => {
    fetchMock.mockResolvedValue(storedRow('EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }));
    renderForm('EUR');
    fireEvent.change(screen.getByLabelText('IBAN'), { target: { value: 'NL91ABNA0417164300' } });
    fireEvent.change(screen.getByLabelText('BIC (needed for an IBAN outside the EEA)'), { target: { value: 'ABNANL2A' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A. Teacher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(sent().url).toBe('/api/teachers/t1/bank-accounts/EUR');
    expect(sentBody()).toEqual({ holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
  });

  it('omits a blank field from the body rather than sending it empty', async () => {
    fetchMock.mockResolvedValue(storedRow('EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }));
    renderForm('EUR', { ...EMPTY_BANK_ACCOUNT, holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
    fireEvent.change(screen.getByLabelText('BIC (needed for an IBAN outside the EEA)'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(sentBody()).toEqual({ holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
  });

  it('sends a dollar account’s routing and account numbers', async () => {
    fetchMock.mockResolvedValue(storedRow('USD', { holderName: 'A. Teacher', routingNumber: '021000021', accountNumber: '1234567' }));
    renderForm('USD');
    fireEvent.change(screen.getByLabelText('Routing number'), { target: { value: '021000021' } });
    fireEvent.change(screen.getByLabelText('Account number'), { target: { value: '1234567' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: 'A. Teacher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(sent().url).toBe('/api/teachers/t1/bank-accounts/USD');
    expect(sentBody()).toEqual({ holderName: 'A. Teacher', routingNumber: '021000021', accountNumber: '1234567' });
  });

  it('shows the stored, normalised values after a save', async () => {
    fetchMock.mockResolvedValue(storedRow('EUR', { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }));
    renderForm('EUR');
    fireEvent.change(screen.getByLabelText('IBAN'), { target: { value: 'nl91 abna 0417 1643 00' } });
    fireEvent.change(screen.getByLabelText('Account holder name'), { target: { value: ' A. Teacher ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(screen.getByLabelText('IBAN')).toHaveValue('NL91ABNA0417164300'));
    expect(screen.getByLabelText('Account holder name')).toHaveValue('A. Teacher');
    expect(screen.getByLabelText('BIC (needed for an IBAN outside the EEA)')).toHaveValue('');
  });

  it('marks the BIC field on a BIC_REQUIRED refusal', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'BIC_REQUIRED', message: 'bic: Add the BIC. This IBAN is from outside the EEA.' } }),
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
      JSON.stringify({ error: { message: 'iban: Enter a valid IBAN.' } }),
      { status: 400 },
    ));
    renderForm('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(screen.getByLabelText('IBAN')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Enter a valid IBAN.')).toBeInTheDocument();
  });

  it('marks the holder name on a holder_required refusal', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'holderName: Enter the account holder’s name.' } }),
      { status: 400 },
    ));
    renderForm('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));

    await waitFor(() => expect(screen.getByLabelText('Account holder name')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByLabelText('Account holder name')).toHaveAccessibleDescription(
      'Exactly as your bank shows it — your students’ banks check this name. Enter the account holder’s name.',
    );
    expect(screen.getByLabelText('IBAN')).not.toHaveAttribute('aria-invalid');
  });

  it('shows the holder-name hint', () => {
    renderForm('EUR');
    expect(screen.getByText('Exactly as your bank shows it — your students’ banks check this name.')).toBeInTheDocument();
  });

  describe('removing an account', () => {
    it('lists accounts in other currencies, masked, and removes one with DELETE after a confirmation', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { currency: 'EUR' } }), { status: 200 }));
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
      expect(screen.getByText('•••• 4300')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      const { url, init } = sent();
      expect(url).toBe('/api/teachers/t1/bank-accounts/EUR');
      expect(init.method).toBe('DELETE');
    });

    it('focuses the confirmation’s Remove button, which the question describes', () => {
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));

      const confirm = screen.getByRole('button', { name: 'Remove' });
      expect(confirm).toHaveFocus();
      expect(confirm).toHaveAccessibleDescription(QUESTION_EUR);
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('Cancel restores the trigger, returns focus to it and sends nothing', () => {
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.getByRole('button', { name: 'Remove EUR details' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('shows its progress on the confirmation’s Remove button while the request is in flight', async () => {
      let answer: (r: Response) => void = () => undefined;
      fetchMock.mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      const progress = await screen.findByRole('button', { name: 'Removing...' });
      expect(progress).toBeDisabled();
      expect(progress).toHaveAccessibleDescription(QUESTION_EUR);
      answer(new Response(JSON.stringify({ data: { currency: 'EUR' } }), { status: 200 }));
      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    });

    it('says what it removed and moves focus to the section heading', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { currency: 'EUR' } }), { status: 200 }));
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('EUR details removed.'));
      expect(screen.getByRole('heading', { name: 'Bank details' })).toHaveFocus();
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    });

    it('offers no Remove for the current currency while it has no stored account', () => {
      renderForm('GBP');
      expect(screen.queryByRole('button', { name: 'Remove GBP details' })).not.toBeInTheDocument();
    });

    it('removes the current currency’s stored account with DELETE after a confirmation, and clears the fields', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { currency: 'GBP' } }), { status: 200 }));
      renderForm('GBP', { ...EMPTY_BANK_ACCOUNT, holderName: 'A. Teacher', sortCode: '12-34-56', accountNumber: '12345678' }, [], true);
      fireEvent.click(screen.getByRole('button', { name: 'Remove GBP details' }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Remove' })).toHaveAccessibleDescription(QUESTION_GBP);
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      const { url, init } = sent();
      expect(url).toBe('/api/teachers/t1/bank-accounts/GBP');
      expect(init.method).toBe('DELETE');
      expect(screen.getByLabelText('Sort code')).toHaveValue('');
      expect(screen.getByLabelText('Account holder name')).toHaveValue('');
      expect(screen.getByRole('status')).toHaveTextContent('GBP details removed.');
    });

    it('shows a refusal beside the control that failed, not in the save form, and keeps the confirmation open', async () => {
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Nope' } }), { status: 500 }));
      renderForm('GBP', EMPTY_BANK_ACCOUNT, [{ currency: 'EUR', masked: '•••• 4300' }], true);
      fireEvent.click(screen.getByRole('button', { name: 'Remove EUR details' }));
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Nope');
      expect(within(saveForm()).queryByRole('alert')).not.toBeInTheDocument();
      const row = screen.getByText('•••• 4300').closest('li');
      if (row === null) throw new Error('no EUR row');
      expect(within(row).getByRole('alert')).toBe(alert);
      expect(within(row).getByRole('button', { name: 'Remove' })).toHaveFocus();
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  });
});
