import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deliverSignInLink, deliverSignInLinkIfRegistered } from './link-delivery';
import { hashNonce, type BrowserNonce } from './origin-nonce';

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  return { ...actual, sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined) };
});
import { sendMagicLinkEmail } from '@/lib/email';
import { log } from '@/lib/log';

const db = new PrismaClient();

describe('deliverSignInLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds the token to the nonce that asked for it', async () => {
    const email = `delivery-bind-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-abc' as BrowserNonce);

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.originBrowserHash).toBe(hashNonce('nonce-abc'));
    expect(row?.handoffCode).toBeNull();
    expect(row?.handoffAttempts).toBe(0);
  });

  it('emails a /verify URL carrying the raw token, which is never persisted', async () => {
    const email = `delivery-url-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-def' as BrowserNonce);

    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
    const [to, link] = vi.mocked(sendMagicLinkEmail).mock.calls[0]!;
    expect(to).toBe(email);
    expect(link).toMatch(/\/verify\?token=[0-9a-f]{64}$/);

    const raw = new URL(link).searchParams.get('token')!;
    expect(await db.magicLinkToken.findFirst({ where: { tokenHash: raw } })).toBeNull();
  });

  it('carries redirectTo and purpose onto the row', async () => {
    const email = `delivery-opts-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-ghi' as BrowserNonce, {
      redirectTo: '/studio/book/42',
      purpose: 'teacher_signup',
    });

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.redirectTo).toBe('/studio/book/42');
    expect(row?.purpose).toBe('teacher_signup');
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('deliverSignInLinkIfRegistered', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('returns synchronously, before the address lookup has settled', () => {
    vi.spyOn(db.teacher, 'findUnique').mockImplementation(
      (() => new Promise(() => {})) as unknown as typeof db.teacher.findUnique,
    );
    const returned: unknown = deliverSignInLinkIfRegistered(db, 'pending@example.com', 'n-sync' as BrowserNonce);
    expect(returned).toBeUndefined();
  });

  it('mints no token and sends no email for an address that is neither teacher nor student', async () => {
    const email = `delivery-unknown-${Date.now()}@example.com`;
    deliverSignInLinkIfRegistered(db, email, 'n-unknown' as BrowserNonce);
    await flush();
    await flush();

    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('logs once and lets nothing escape when the lookup rejects', async () => {
    const err = new Error('lookup down');
    vi.spyOn(db.teacher, 'findUnique').mockImplementation(
      (() => Promise.reject(err)) as unknown as typeof db.teacher.findUnique,
    );
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    deliverSignInLinkIfRegistered(db, 'down@example.com', 'n-down' as BrowserNonce);
    await flush();

    expect(logged).toHaveBeenCalledOnce();
    expect(logged.mock.calls[0]![0]).toMatchObject({ err });
    expect(sendMagicLinkEmail).not.toHaveBeenCalled();
  });

  it.each(['teacher', 'student'] as const)('emails once for a registered %s address', async (kind) => {
    const email = `delivery-${kind}-${Date.now()}@example.com`;
    const found = { id: 'x' };
    vi.spyOn(db.teacher, 'findUnique').mockImplementation(
      (() => Promise.resolve(kind === 'teacher' ? found : null)) as unknown as typeof db.teacher.findUnique,
    );
    vi.spyOn(db.student, 'findUnique').mockImplementation(
      (() => Promise.resolve(kind === 'student' ? found : null)) as unknown as typeof db.student.findUnique,
    );

    deliverSignInLinkIfRegistered(db, email, 'n-reg' as BrowserNonce);
    await vi.waitFor(() => expect(sendMagicLinkEmail).toHaveBeenCalledOnce());

    expect(vi.mocked(sendMagicLinkEmail).mock.calls[0]![0]).toBe(email);
    await db.magicLinkToken.deleteMany({ where: { email } });
  });
});
