import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { PAYMENT_LINK_MAX } from '@/lib/input-bounds';
import { PAYMENT_LINK_MESSAGES } from '@/lib/payment-link';
import { PaymentLinkForm } from './payment-link-form';

const fetchMock = vi.fn();
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function renderForm(initial = '', hasLink = false): void {
  vi.stubGlobal('fetch', fetchMock);
  render(<PaymentLinkForm teacherId="t1" initial={initial} hasLink={hasLink} />);
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Payment link'), { target: { value } });
}

function sent(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init };
}

describe('PaymentLinkForm', () => {
  it('renders the label, the stored link and the hint', () => {
    renderForm('https://paypal.me/anna', true);
    expect(screen.getByLabelText('Payment link')).toHaveValue('https://paypal.me/anna');
    expect(screen.getByText('A Tikkie, PayPal.me, Revolut or similar link without a fixed amount. Students see it next to what they owe.')).toBeInTheDocument();
  });

  it('is a url field that neither autocompletes nor truncates a paste, inside a form the browser does not validate', () => {
    renderForm();
    const input = screen.getByLabelText('Payment link');
    expect(input).toHaveAttribute('type', 'url');
    expect(input).toHaveAttribute('inputmode', 'url');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).not.toHaveAttribute('maxlength');
    expect(input.closest('form')).toHaveAttribute('novalidate');
  });

  it('PUTs the link to the teacher’s payment-link URL and refreshes on 200', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { paymentLink: 'https://paypal.me/anna' } }), { status: 200 }));
    renderForm();
    type('https://paypal.me/anna');
    fireEvent.click(screen.getByRole('button', { name: 'Save payment link' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(sent().url).toBe('/api/teachers/t1/payment-link');
    expect(sent().init.method).toBe('PUT');
    expect(JSON.parse(sent().init.body as string)).toEqual({ paymentLink: 'https://paypal.me/anna' });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('shows a 400’s message on the field, without its path prefix', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: `paymentLink: ${PAYMENT_LINK_MESSAGES.invalid}` } }), { status: 400 }));
    renderForm();
    type('https://x.example');
    fireEvent.click(screen.getByRole('button', { name: 'Save payment link' }));
    expect(await screen.findByText(PAYMENT_LINK_MESSAGES.invalid)).toBeInTheDocument();
    expect(screen.getByLabelText('Payment link')).toHaveAttribute('aria-invalid', 'true');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('refuses a scheme-less or http link on the client, without fetching', () => {
    renderForm();
    type('paypal.me/anna');
    fireEvent.click(screen.getByRole('button', { name: 'Save payment link' }));
    expect(screen.getByText(PAYMENT_LINK_MESSAGES.invalid)).toBeInTheDocument();
    type('http://paypal.me/anna');
    fireEvent.click(screen.getByRole('button', { name: 'Save payment link' }));
    expect(screen.getByText(PAYMENT_LINK_MESSAGES.not_https)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a pasted link over the bound with the parser’s message, without fetching', () => {
    renderForm();
    type(`https://example.com/${'a'.repeat(PAYMENT_LINK_MAX)}`);
    fireEvent.click(screen.getByRole('button', { name: 'Save payment link' }));
    expect(screen.getByText(PAYMENT_LINK_MESSAGES.too_long)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers Remove only when a link is stored', () => {
    renderForm('', false);
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  const QUESTION = 'Remove your payment link? Students with unpaid classes will no longer see it.';

  it('the first tap on Remove asks for confirmation and sends nothing', () => {
    renderForm('https://paypal.me/anna', true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove payment link' }));
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirming sends DELETE, clears the field and refreshes', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { paymentLink: null } }), { status: 200 }));
    renderForm('https://paypal.me/anna', true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove payment link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(sent().url).toBe('/api/teachers/t1/payment-link');
    expect(sent().init.method).toBe('DELETE');
    expect(screen.getByLabelText('Payment link')).toHaveValue('');
  });

  it('cancelling sends nothing and keeps the link', () => {
    renderForm('https://paypal.me/anna', true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove payment link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(QUESTION)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Payment link')).toHaveValue('https://paypal.me/anna');
  });

  it('shows a failed removal’s message beside the control and keeps the link', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Teacher not found' } }), { status: 404 }));
    renderForm('https://paypal.me/anna', true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove payment link' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Teacher not found')).toBeInTheDocument();
    expect(screen.getByLabelText('Payment link')).toHaveValue('https://paypal.me/anna');
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
