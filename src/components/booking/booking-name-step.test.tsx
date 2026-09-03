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
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/emailed you a fresh link/i)).toBeInTheDocument();
    const [resendUrl, resendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(resendUrl).toBe('/api/auth/student-signup');
    expect(JSON.parse(resendInit.body as string)).toEqual({
      email: 'anna@example.com',
      redirect: '/t/book/c1',
    });
  });

  it('surfaces a failure without disabling the button forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).not.toBeDisabled();
  });
});
