import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { expectApplied, expectRefusal } from '../../../../../../../tests/api-assertions';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  startConnect: vi.fn(),
  mollieDeps: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/processor-connection', () => ({ startConnect: m.startConnect }));
vi.mock('@/services/mollie-deps', () => ({ mollieDeps: m.mollieDeps }));
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { POST } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: 't-1', defaultTimezone: 'UTC', studentId: null };
const DEPS = { marker: 'deps' };
const ctx = { params: Promise.resolve({ id: 't-1' }) };

function request(): NextRequest {
  return new NextRequest('http://localhost/api/teachers/t-1/processor/connect', { method: 'POST', headers: { Cookie: 'fair_yoga_session=tok' } });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.mollieDeps.mockReturnValue(DEPS);
});

describe('POST /api/teachers/[id]/processor/connect', () => {
  it('starts a connect bound to this session and answers the authorize URL', async () => {
    m.startConnect.mockResolvedValue({ authorizeUrl: 'https://my.mollie.com/oauth2/authorize?state=x' });
    expect(await expectApplied(await POST(request(), ctx))).toEqual({ authorizeUrl: 'https://my.mollie.com/oauth2/authorize?state=x' });
    expect(m.startConnect).toHaveBeenCalledWith({ marker: 'db' }, DEPS, { teacherId: 't-1', sessionId: 's1' });
  });

  it('answers 503 PROCESSOR_UNAVAILABLE when Mollie is not configured', async () => {
    m.mollieDeps.mockReturnValue(null);
    await expectRefusal(await POST(request(), ctx), 'PROCESSOR_UNAVAILABLE');
    expect(m.startConnect).not.toHaveBeenCalled();
  });

  it('refuses another teacher', async () => {
    expect((await POST(request(), { params: Promise.resolve({ id: 't-2' }) })).status).toBe(403);
    expect(m.startConnect).not.toHaveBeenCalled();
  });
});
