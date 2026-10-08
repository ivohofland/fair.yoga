import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import type { DeletePasskeyOutcome } from '@/services/passkey-credentials';

const m = vi.hoisted(() => ({
  validateSession: vi.fn<(db: unknown, token: string) => Promise<SessionUser | null>>(),
  deletePasskey: vi.fn<(db: unknown, input: { accountId: string; credentialId: string }) => Promise<DeletePasskeyOutcome>>(),
  sendPasskeyRemovedEmail: vi.fn<(to: string, removedAt: Date) => Promise<void>>(),
  findUniqueOrThrow: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { account: { findUniqueOrThrow: m.findUniqueOrThrow } },
}));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateSession: m.validateSession,
}));
vi.mock('@/services/passkey-credentials', () => ({ deletePasskey: m.deletePasskey }));
vi.mock('@/lib/email', () => ({ sendPasskeyRemovedEmail: m.sendPasskeyRemovedEmail }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { DELETE } = await import('./route');

const SESSION: SessionUser = { sessionId: 's1', accountId: 'acct-1', teacherId: null, studentId: 'stu-1' };
const REMOVED_AT = new Date('2026-10-06T14:03:00Z');

function call() {
  const request = new NextRequest('http://localhost/api/auth/passkey/pk-1', {
    method: 'DELETE',
    headers: { Cookie: 'fair_yoga_session=tok' },
  });
  return DELETE(request, { params: Promise.resolve({ id: 'pk-1' }) });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.validateSession.mockResolvedValue(SESSION);
  m.findUniqueOrThrow.mockResolvedValue({ email: 'a@test.local' });
  m.sendPasskeyRemovedEmail.mockResolvedValue(undefined);
});

describe('DELETE /api/auth/passkey/[id]', () => {
  it('emails the account address that a passkey was removed, after the removal', async () => {
    m.deletePasskey.mockResolvedValue({ status: 'deleted', removedAt: REMOVED_AT });

    const res = await call();

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(m.sendPasskeyRemovedEmail).toHaveBeenCalledWith('a@test.local', REMOVED_AT));
    expect(m.deletePasskey.mock.invocationCallOrder[0]).toBeLessThan(m.sendPasskeyRemovedEmail.mock.invocationCallOrder[0] ?? 0);
  });

  it('still answers 200 when the notice sender rejects', async () => {
    m.deletePasskey.mockResolvedValue({ status: 'deleted', removedAt: REMOVED_AT });
    m.sendPasskeyRemovedEmail.mockRejectedValue(new Error('resend down'));

    expect((await call()).status).toBe(200);
  });

  it.each([
    [{ status: 'not_found' } as const, 404, 'NOT_FOUND'],
    [{ status: 'payments_paused' } as const, 409, 'PASSKEY_REMOVAL_PAUSED'],
  ])('sends nothing when the removal is refused (%o)', async (outcome, status, code) => {
    m.deletePasskey.mockResolvedValue(outcome);

    const res = await call();

    const body = (await res.json()) as { error: { code: string } };
    expect({ status: res.status, code: body.error.code }).toEqual({ status, code });
    await new Promise((r) => setTimeout(r, 10));
    expect(m.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(m.sendPasskeyRemovedEmail).not.toHaveBeenCalled();
  });
});
