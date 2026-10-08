import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { ResumePaymentsForm } from './resume-payments-form';

const FINGERPRINT = 'f'.repeat(64);

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('ResumePaymentsForm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the fingerprint it was given and confirms', async () => {
    const fetchMock = stubFetch(() => respond(200, { data: { resumed: true } }));
    render(<ResumePaymentsForm teacherId="t-1" fingerprint={FINGERPRINT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/teachers/t-1/payments-resume');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ fingerprint: FINGERPRINT });
    expect(screen.getByRole('status')).toHaveTextContent('Payments are running again');
    expect(screen.queryByRole('button', { name: 'Resume payments' })).not.toBeInTheDocument();
  });

  it('treats an unchanged answer as resumed', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: { resumed: true }, outcome: 'unchanged' }), { status: 200 }));
    render(<ResumePaymentsForm teacherId="t-1" fingerprint={FINGERPRINT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('status')).toHaveTextContent('Payments are running again');
  });

  it('reloads the details when they changed since the page loaded', async () => {
    stubFetch(() => respond(409, { error: { code: 'PAYOUT_DETAILS_CHANGED', message: 'Your payment details changed.' } }));
    render(<ResumePaymentsForm teacherId="t-1" fingerprint={FINGERPRINT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Your payment details changed.');
    expect(routerRefresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });

  it('shows the server\'s reason for any other refusal and keeps the button', async () => {
    stubFetch(() => respond(403, { error: { code: 'RECENT_AUTH_REQUIRED', message: 'Please confirm it is you first.' } }));
    render(<ResumePaymentsForm teacherId="t-1" fingerprint={FINGERPRINT} />);

    fireEvent.click(screen.getByRole('button', { name: 'Resume payments' }));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent('Please confirm it is you first.');
    expect(screen.getByRole('button', { name: 'Resume payments' })).toBeEnabled();
  });
});
