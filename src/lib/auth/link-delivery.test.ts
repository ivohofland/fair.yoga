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
  const createdFor: string[] = [];
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.magicLinkToken.deleteMany({ where: { email: { in: createdFor.splice(0) } } });
  });

  it('returns synchronously, before the address lookup has settled', () => {
    vi.spyOn(db.teacher, 'findUnique').mockImplementation(
      (() => new Promise(() => {})) as unknown as typeof db.teacher.findUnique,
    );
    const returned: unknown = deliverSignInLinkIfRegistered(db, 'pending@example.com', 'n-sync' as BrowserNonce);
    expect(returned).toBeUndefined();
  });

  it('mints no token and sends no email for an address that is neither teacher nor student', async () => {
    const stamp = Date.now();
    const unknown = `delivery-unknown-${stamp}@example.com`;
    const control = `delivery-control-${stamp}@example.com`;
    createdFor.push(unknown, control);
    // Only the control address is registered. The unknown address's lookups
    // resolve as microtasks, so they finish long before the control's mint and
    // send (real database round-trips) do: once the control's email is seen,
    // anything the unknown address was going to deliver has been started too.
    vi.spyOn(db.teacher, 'findUnique').mockImplementation(
      (({ where }: { where: { email: string } }) =>
        Promise.resolve(where.email === control ? { id: 'x' } : null)) as unknown as typeof db.teacher.findUnique,
    );
    vi.spyOn(db.student, 'findUnique').mockImplementation(
      (() => Promise.resolve(null)) as unknown as typeof db.student.findUnique,
    );

    deliverSignInLinkIfRegistered(db, unknown, 'n-unknown' as BrowserNonce);
    deliverSignInLinkIfRegistered(db, control, 'n-control' as BrowserNonce);
    await vi.waitFor(() => expect(sendMagicLinkEmail).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 100));

    const recipients = vi.mocked(sendMagicLinkEmail).mock.calls.map((c) => c[0]);
    expect(recipients).toEqual([control]);
    expect(await db.magicLinkToken.findFirst({ where: { email: unknown } })).toBeNull();
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
    createdFor.push(email);
    await vi.waitFor(() => expect(sendMagicLinkEmail).toHaveBeenCalledOnce());

    expect(vi.mocked(sendMagicLinkEmail).mock.calls[0]![0]).toBe(email);
  });
});
