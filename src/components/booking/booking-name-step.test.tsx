import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { BookingNameStep } from './booking-name-step';

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anna' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Smith' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
}

describe('BookingNameStep', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the two names and nothing else', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/account/student-profile');
    // The address comes from the ticket the server verified, never from here.
    expect(JSON.parse(init.body as string)).toEqual({ firstName: 'Anna', lastName: 'Smith' });
    // The response set the session cookie; the refresh is what moves this
    // branch to BookingFlow. Without it the student sits on a dead form.
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('offers a fresh link when the ticket has expired, rather than an error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { delivered: true, message: 'Check your inbox for a sign-in link.' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/emailed you a fresh link/i)).toBeInTheDocument();
    const [resendUrl, resendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resendUrl).toBe('/api/auth/student-signup');
    expect(resendInit.method).toBe('POST');
    expect(JSON.parse(resendInit.body as string)).toEqual({
      email: 'anna@example.com',
      redirect: '/t/book/c1',
    });
  });

  it('reports the stuck state, not a false promise of a fresh link, when the resend itself fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/couldn't send a fresh one/i)).toBeInTheDocument();
    const [resendUrl, resendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resendUrl).toBe('/api/auth/student-signup');
    expect(resendInit.method).toBe('POST');
  });

  // PR #427 review, C2: `student-signup` answers 200 whether or not the
  // email actually sent — `res.ok` alone cannot tell the two apart, so the
  // resend must be keyed on the body's own `delivered` field.
  it('reports the stuck state when the resend answers 200 but did not actually deliver', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { delivered: false, message: "We couldn't send the email just now." } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/couldn't send a fresh one/i)).toBeInTheDocument();
    expect(screen.queryByText(/emailed you a fresh link/i)).not.toBeInTheDocument();
    // The server's own explanation of why, not the generic fallback.
    expect(screen.getByText(/We couldn't send the email just now\./i)).toBeInTheDocument();
  });

  // PR #427 review, I6: a resend refused by rate limiting collapsed into the
  // same fixed "try again in a moment" copy as every other failure, even
  // though the server's own message names the real retry time.
  it('renders the resend rate limit message instead of the generic fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'Too many signup attempts. Try again in 12 minutes.' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/Try again in 12 minutes\./i)).toBeInTheDocument();
    expect(screen.queryByText(/try again in a moment/i)).not.toBeInTheDocument();
  });

  it('surfaces a failure without disabling the button forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).not.toBeDisabled();
  });
});
