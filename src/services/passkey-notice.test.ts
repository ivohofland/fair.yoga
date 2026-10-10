import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';

const sendPasskeyAddedEmail = vi.hoisted(() => vi.fn<(to: string, addedAt: Date, revokeUrl?: string | null) => Promise<void>>());
const sendPasskeyRemovedEmail = vi.hoisted(() => vi.fn<(to: string, removedAt: Date) => Promise<void>>());
vi.mock('@/lib/email', () => ({ sendPasskeyAddedEmail, sendPasskeyRemovedEmail }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { deliverPasskeyAddedNotice, deliverPasskeyRemovedNotice } = await import('./passkey-notice');

const findUniqueOrThrow = vi.fn<(args: unknown) => Promise<{ email: string }>>();
const create = vi.fn<(args: unknown) => Promise<unknown>>();
const db = { account: { findUniqueOrThrow }, passkeyRevokeToken: { create } } as unknown as PrismaClient;
const input = { accountId: 'acct-1', addedAt: new Date('2026-10-06T14:03:00Z'), credentialId: 'cred-1' };

beforeEach(() => {
  sendPasskeyAddedEmail.mockReset();
  sendPasskeyRemovedEmail.mockReset();
  findUniqueOrThrow.mockReset();
  create.mockReset();
  create.mockResolvedValue({});
  findUniqueOrThrow.mockResolvedValue({ email: 'a@test.local' });
  vi.mocked(log.error).mockReset();
});

describe('deliverPasskeyAddedNotice', () => {
  it('sends the notice to the account address', async () => {
    sendPasskeyAddedEmail.mockResolvedValue(undefined);

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(sendPasskeyAddedEmail).toHaveBeenCalledWith('a@test.local', input.addedAt, expect.any(String)));
    expect(findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'acct-1' } }));
  });

  it('mints a link for the credential and sends it with the notice', async () => {
    sendPasskeyAddedEmail.mockResolvedValue(undefined);

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(sendPasskeyAddedEmail).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: 'acct-1', credentialId: 'cred-1' }),
    });
    expect(sendPasskeyAddedEmail).toHaveBeenCalledWith(
      'a@test.local',
      input.addedAt,
      expect.stringMatching(/\/passkey-revoke#t=[0-9a-f]{64}$/),
    );
  });

  it('still sends the notice, without a link, when the mint fails, and logs it', async () => {
    create.mockRejectedValue(new Error('db down'));
    sendPasskeyAddedEmail.mockResolvedValue(undefined);

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(sendPasskeyAddedEmail).toHaveBeenCalledWith('a@test.local', input.addedAt, null));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), expect.stringContaining('revoke link'));
  });

  it('returns before a slow sender settles — the caller never waits for it', () => {
    sendPasskeyAddedEmail.mockReturnValue(new Promise<void>(() => {}));

    const result: unknown = deliverPasskeyAddedNotice(db, input);

    expect(result).toBeUndefined();
  });

  it('owns a rejecting sender: logs it and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    sendPasskeyAddedEmail.mockRejectedValue(new Error('resend down'));

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({ accountId: 'acct-1' });
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('owns a failing address lookup and sends nothing', async () => {
    findUniqueOrThrow.mockRejectedValue(new Error('db down'));

    expect(() => deliverPasskeyAddedNotice(db, input)).not.toThrow();

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(sendPasskeyAddedEmail).not.toHaveBeenCalled();
  });
});

describe('deliverPasskeyRemovedNotice', () => {
  const removed = { accountId: 'acct-1', removedAt: new Date('2026-10-06T14:03:00Z') };

  it('sends the notice to the account address', async () => {
    sendPasskeyRemovedEmail.mockResolvedValue(undefined);

    deliverPasskeyRemovedNotice(db, removed);

    await vi.waitFor(() => expect(sendPasskeyRemovedEmail).toHaveBeenCalledWith('a@test.local', removed.removedAt));
    expect(sendPasskeyAddedEmail).not.toHaveBeenCalled();
  });

  it('returns before a slow sender settles', () => {
    sendPasskeyRemovedEmail.mockReturnValue(new Promise<void>(() => {}));

    const result: unknown = deliverPasskeyRemovedNotice(db, removed);

    expect(result).toBeUndefined();
  });

  it('owns a rejecting sender: logs it and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    sendPasskeyRemovedEmail.mockRejectedValue(new Error('resend down'));

    deliverPasskeyRemovedNotice(db, removed);

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({ accountId: 'acct-1' });
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
