import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deliverSignInLink } from './link-delivery';
import { hashNonce } from './origin-nonce';

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  return { ...actual, sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined) };
});
import { sendMagicLinkEmail } from '@/lib/email';

const db = new PrismaClient();

describe('deliverSignInLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds the token to the nonce that asked for it', async () => {
    const email = `delivery-bind-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-abc');

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.originBrowserHash).toBe(hashNonce('nonce-abc'));
    expect(row?.handoffCode).toBeNull();
    expect(row?.handoffAttempts).toBe(0);
  });

  it('emails a /verify URL carrying the raw token, which is never persisted', async () => {
    const email = `delivery-url-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-def');

    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
    const [to, link] = vi.mocked(sendMagicLinkEmail).mock.calls[0]!;
    expect(to).toBe(email);
    expect(link).toMatch(/\/verify\?token=[0-9a-f]{64}$/);

    const raw = new URL(link).searchParams.get('token')!;
    expect(await db.magicLinkToken.findFirst({ where: { tokenHash: raw } })).toBeNull();
  });

  it('carries redirectTo and purpose onto the row', async () => {
    const email = `delivery-opts-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-ghi', {
      redirectTo: '/studio/book/42',
      purpose: 'teacher_signup',
    });

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.redirectTo).toBe('/studio/book/42');
    expect(row?.purpose).toBe('teacher_signup');
  });
});
