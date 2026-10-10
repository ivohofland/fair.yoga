import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  revokePasskeyByLink: vi.fn(),
  deliverPasskeyRemovedNotice: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { marker: 'prisma' } }));
vi.mock('@/services/passkey-revoke', () => ({ revokePasskeyByLink: m.revokePasskeyByLink }));
vi.mock('@/services/passkey-notice', () => ({ deliverPasskeyRemovedNotice: m.deliverPasskeyRemovedNotice }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { POST } = await import('./route');
const { prisma } = await import('@/lib/db');

function request(): NextRequest {
  return new NextRequest('http://localhost/api/passkey-revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.8.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ token: 'a'.repeat(64) }),
  });
}

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
});

describe('POST /api/passkey-revoke', () => {
  it('emails the removal once and answers 200 when a passkey was removed', async () => {
    const removedAt = new Date('2026-10-10T10:00:00Z');
    m.revokePasskeyByLink.mockResolvedValue({ status: 'revoked', removal: { accountId: 'acct-1', removedAt } });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { revoked: true } });
    expect(m.deliverPasskeyRemovedNotice).toHaveBeenCalledTimes(1);
    expect(m.deliverPasskeyRemovedNotice).toHaveBeenCalledWith(prisma, { accountId: 'acct-1', removedAt });
  });

  it('answers 200 and sends no email when nothing was removed', async () => {
    m.revokePasskeyByLink.mockResolvedValue({ status: 'revoked', removal: null });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(m.deliverPasskeyRemovedNotice).not.toHaveBeenCalled();
  });

  it('answers 404 REVOKE_LINK_INVALID and sends no email for a link that cannot act', async () => {
    m.revokePasskeyByLink.mockResolvedValue({ status: 'invalid' });

    const res = await POST(request());

    const body = (await res.json()) as { error: { code: string } };
    expect({ status: res.status, code: body.error.code }).toEqual({ status: 404, code: 'REVOKE_LINK_INVALID' });
    expect(m.deliverPasskeyRemovedNotice).not.toHaveBeenCalled();
  });
});
