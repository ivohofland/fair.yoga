import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProcessorPayButton } from './processor-pay-button';

const realLocation = window.location;
const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { value: realLocation, writable: true });
});

function show() {
  vi.stubGlobal('fetch', fetchMock);
  return render(<ProcessorPayButton paymentId="pay-1" method="ideal" label="iDEAL" />);
}

describe('ProcessorPayButton', () => {
  it('POSTs the method and sends the browser to the checkout it answers', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { checkoutUrl: 'https://www.mollie.com/checkout/x' } }), { status: 200 }));
    show();

    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://www.mollie.com/checkout/x'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/payments/pay-1/processor-attempt');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ method: 'ideal' });
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('is disabled and says it is opening while the request runs', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));
    const pending = await screen.findByRole('button', { name: 'Opening iDEAL…' });
    expect(pending).toBeDisabled();
  });

  it('shows a refusal inline and lets the student try again', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PROCESSOR_METHOD_UNAVAILABLE', message: 'iDEAL isn’t available for this payment.' } }), { status: 409 }),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));
    expect(await screen.findByText('iDEAL isn’t available for this payment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay with iDEAL' })).toBeEnabled();
  });

  it('says so on a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));
    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
  });

  it('recovers from a success answer that is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>oops</html>', { status: 200 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));
    expect(await screen.findByText('Paying online isn’t available right now. Try again, or choose another way to pay.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay with iDEAL' })).toBeEnabled();
  });

  it('is pressable again when the page comes back from the back-forward cache', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { checkoutUrl: 'https://www.mollie.com/checkout/x' } }), { status: 200 }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Pay with iDEAL' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Opening iDEAL…' })).toBeDisabled();

    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });

    expect(screen.getByRole('button', { name: 'Pay with iDEAL' })).toBeEnabled();
  });
});
