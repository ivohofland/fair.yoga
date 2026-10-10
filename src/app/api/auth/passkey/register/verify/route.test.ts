import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  hasRecentAuth: vi.fn<(db: unknown, sessionId: string) => Promise<boolean>>(),
  getAndDeleteChallenge: vi.fn<(purpose: string, accountId: string) => string | null>(),
  verifyPasskeyRegistration: vi.fn(),
  sendPasskeyAddedEmail: vi.fn<(to: string, addedAt: Date, revokeUrl?: string | null) => Promise<void>>(),
  mintCreate: vi.fn(),
  create: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    passkeyCredential: { create: m.create },
    account: { findUniqueOrThrow: m.findUniqueOrThrow },
    passkeyRevokeToken: { create: m.mintCreate },
  },
}));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/lib/auth/recent-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/recent-auth')>()),
  hasRecentAuth: m.hasRecentAuth,
}));
vi.mock('@/lib/auth/passkey', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/passkey')>()),
  getAndDeleteChallenge: m.getAndDeleteChallenge,
  verifyPasskeyRegistration: m.verifyPasskeyRegistration,
}));
vi.mock('@/lib/email', () => ({ sendPasskeyAddedEmail: m.sendPasskeyAddedEmail }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { POST } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: null, studentId: 'stu-1' };
const BODY = { response: { id: 'AAAA', rawId: 'AAAA', type: 'public-key', response: {}, clientExtensionResults: {} } };

function request(): NextRequest {
  return new NextRequest('http://localhost/api/auth/passkey/register/verify', {
    method: 'POST',
    headers: { Cookie: 'fair_yoga_session=tok', 'Content-Type': 'application/json' },
    body: JSON.stringify(BODY),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.hasRecentAuth.mockResolvedValue(true);
  m.getAndDeleteChallenge.mockReturnValue('challenge');
  m.verifyPasskeyRegistration.mockResolvedValue({
    verified: true,
    credentialId: 'AAAA',
    publicKey: new Uint8Array([1]),
    counter: 0,
    transports: [],
  });
  m.create.mockResolvedValue({ createdAt: new Date('2026-10-06T14:03:00Z') });
  m.mintCreate.mockResolvedValue({});
  m.findUniqueOrThrow.mockResolvedValue({ email: 'a@test.local' });
  m.sendPasskeyAddedEmail.mockResolvedValue(undefined);
});

describe('POST /api/auth/passkey/register/verify', () => {
  it('stores the credential and mints its revoke token under the one id the verification returned', async () => {
    m.verifyPasskeyRegistration.mockResolvedValue({
      verified: true,
      credentialId: 'verified-credential-id',
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: [],
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: 'verified-credential-id' }) }));
    await vi.waitFor(() => expect(m.mintCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ credentialId: 'verified-credential-id' }) }));
  });

  it('answers 200 and emails the account address after the credential row exists', async () => {
    const res = await POST(request());

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(m.sendPasskeyAddedEmail).toHaveBeenCalledWith('a@test.local', expect.any(Date), expect.stringContaining('/passkey-revoke#t=')));
    expect(m.mintCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ accountId: 'acct-1', credentialId: 'AAAA' }) });
    expect(m.create.mock.invocationCallOrder[0]).toBeLessThan(m.sendPasskeyAddedEmail.mock.invocationCallOrder[0] ?? 0);
  });

  it('still answers 200 when the notice sender rejects', async () => {
    m.sendPasskeyAddedEmail.mockRejectedValue(new Error('resend down'));

    const res = await POST(request());

    expect(res.status).toBe(200);
  });

  it('still answers 200 when the address lookup fails', async () => {
    m.findUniqueOrThrow.mockRejectedValue(new Error('db blip'));

    const res = await POST(request());

    expect(res.status).toBe(200);
  });

  it('refuses a session that is not recent and consumes no challenge', async () => {
    m.hasRecentAuth.mockResolvedValue(false);

    const res = await POST(request());

    const body = (await res.json()) as { error: { code: string } };
    expect({ status: res.status, code: body.error.code }).toEqual({ status: 403, code: 'RECENT_AUTH_REQUIRED' });
    expect(m.getAndDeleteChallenge).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });
});
