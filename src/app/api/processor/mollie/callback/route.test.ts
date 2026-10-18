import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { codedRefusal } from '@/lib/api-error-codes';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  completeConnect: vi.fn(),
  deliverPayoutChangedNotice: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-connection', () => ({ completeConnect: m.completeConnect }));
vi.mock('@/services/payout-notice', () => ({ deliverPayoutChangedNotice: m.deliverPayoutChangedNotice }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { GET } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const DEPS = { marker: 'deps', config: { appUrl: 'https://fair.yoga' } };

function request(query: string, cookie = true): NextRequest {
  return new NextRequest(`http://localhost/api/processor/mollie/callback?${query}`, {
    method: 'GET',
    headers: cookie ? { Cookie: 'fair_yoga_session=tok' } : {},
  });
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('GET /api/processor/mollie/callback', () => {
  it('completes the connect for this session, delivers the event and lands on connected', async () => {
    m.completeConnect.mockResolvedValue({ kind: 'connected', teacherId: 't-1', eventId: 'ev-1' });
    const res = await GET(request('code=c1&state=s-plain'));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('https://fair.yoga/settings/profile?mollie=connected');
    expect(m.completeConnect).toHaveBeenCalledWith({ marker: 'db' }, DEPS, { state: 's-plain', code: 'c1', sessionId: 's1' });
    expect(m.deliverPayoutChangedNotice).toHaveBeenCalledWith({ marker: 'db' }, 'ev-1');
  });

  it('delivers nothing when the reconnect changed no identity', async () => {
    m.completeConnect.mockResolvedValue({ kind: 'connected', teacherId: 't-1', eventId: null });
    expect(location(await GET(request('code=c1&state=s')))).toBe('https://fair.yoga/settings/profile?mollie=connected');
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('sends the teacher to the picker without a notice when a profile must be chosen', async () => {
    m.completeConnect.mockResolvedValue({ kind: 'choose_profile', teacherId: 't-1' });
    expect(location(await GET(request('code=c1&state=s')))).toBe('https://fair.yoga/settings/profile?mollie=choose');
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('lands on expired for a refused state', async () => {
    m.completeConnect.mockResolvedValue({ kind: 'refused', refusal: codedRefusal('OAUTH_STATE_INVALID', 'x') });
    expect(location(await GET(request('code=c1&state=s')))).toBe('https://fair.yoga/settings/profile?mollie=expired');
    expect(m.deliverPayoutChangedNotice).not.toHaveBeenCalled();
  });

  it('lands on unavailable when Mollie fails', async () => {
    m.completeConnect.mockResolvedValue({ kind: 'unavailable' });
    expect(location(await GET(request('code=c1&state=s')))).toBe('https://fair.yoga/settings/profile?mollie=unavailable');
  });

  it('lands on cancelled when the teacher declined at Mollie, without completing anything', async () => {
    expect(location(await GET(request('error=access_denied&state=s')))).toBe('https://fair.yoga/settings/profile?mollie=cancelled');
    expect(m.completeConnect).not.toHaveBeenCalled();
  });

  it('lands on expired when the code or state is missing', async () => {
    expect(location(await GET(request('state=s')))).toBe('https://fair.yoga/settings/profile?mollie=expired');
    expect(location(await GET(request('code=c1')))).toBe('https://fair.yoga/settings/profile?mollie=expired');
    expect(m.completeConnect).not.toHaveBeenCalled();
  });

  it('lands on unavailable when Mollie is not configured', async () => {
    m.mollieDeps.mockReturnValue(null);
    expect(location(await GET(request('code=c1&state=s')))).toMatch(/\/settings\/profile\?mollie=unavailable$/);
    expect(m.completeConnect).not.toHaveBeenCalled();
  });

  it('sends a visitor with no session to sign in, returning to the profile settings', async () => {
    m.validateSession.mockResolvedValue(null);
    const res = await GET(request('code=c1&state=s', false));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('https://fair.yoga/login?redirect=%2Fsettings%2Fprofile');
    expect(m.completeConnect).not.toHaveBeenCalled();
  });

  it('sends a session without a teacher profile to sign in as well', async () => {
    m.validateSession.mockResolvedValue({ ...SESSION, teacherId: null, studentId: 'st-1' } as SessionUser);
    expect(location(await GET(request('code=c1&state=s')))).toBe('https://fair.yoga/login?redirect=%2Fsettings%2Fprofile');
    expect(m.completeConnect).not.toHaveBeenCalled();
  });
});
