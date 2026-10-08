import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { hashToken } from '@/lib/auth/magic-link';

type Sent = {
  kind: string; accountCurrency: string | null; before: string | null; after: string | null;
  identifierChanged: boolean | null; at: Date; timezone: string; pauseUrl: string;
};
const sendPayoutChangedEmail = vi.hoisted(() => vi.fn<(to: string, input: Sent) => Promise<void>>());
vi.mock('@/lib/email', () => ({ sendPayoutChangedEmail }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { deliverPayoutChangedNotice } = await import('./payout-notice');
const { PAUSE_TOKEN_TTL_DAYS } = await import('./payout-pause-token');

const at = new Date('2026-10-06T14:03:00Z');
const event = {
  id: 'ev-1', teacherId: 't-1', kind: 'bank_account_changed', accountCurrency: 'EUR',
  before: 'NL•• 1234', after: 'NL•• 9876', identifierChanged: true, createdAt: at,
  teacher: { defaultTimezone: 'Europe/Amsterdam', account: { email: 'a@test.local' } },
};
const findUnique = vi.fn<(args: unknown) => Promise<typeof event | null>>();
const create = vi.fn<(args: { data: { tokenHash: string; teacherId: string; eventId: string; expiresAt: Date } }) => Promise<unknown>>();
const db = { payoutChangeEvent: { findUnique }, payoutPauseToken: { create } } as unknown as PrismaClient;

beforeEach(() => {
  sendPayoutChangedEmail.mockReset().mockResolvedValue(undefined);
  findUnique.mockReset().mockResolvedValue(event);
  create.mockReset().mockResolvedValue({});
  vi.mocked(log.error).mockReset();
  vi.mocked(log.warn).mockReset();
});

describe('deliverPayoutChangedNotice', () => {
  it('mints exactly one token, stores its hash not the raw value, and expires it in 14 days', async () => {
    const before = Date.now();
    deliverPayoutChangedNotice(db, 'ev-1');
    await vi.waitFor(() => expect(sendPayoutChangedEmail).toHaveBeenCalledTimes(1));

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    const [, sent] = sendPayoutChangedEmail.mock.calls[0]!;
    const raw = sent.pauseUrl.split('#t=')[1]!;
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(data.tokenHash).toBe(hashToken(raw));
    expect(data.tokenHash).not.toBe(raw);
    expect(JSON.stringify(create.mock.calls)).not.toContain(raw);
    expect(data).toMatchObject({ teacherId: 't-1', eventId: 'ev-1' });
    const ttl = data.expiresAt.getTime() - before;
    expect(PAUSE_TOKEN_TTL_DAYS).toBe(14);
    expect(Math.abs(ttl - 14 * 24 * 3600 * 1000)).toBeLessThan(10_000);
  });

  it('emails the account address the event, the teacher timezone and a /payout-pause#t= link', async () => {
    deliverPayoutChangedNotice(db, 'ev-1');
    await vi.waitFor(() => expect(sendPayoutChangedEmail).toHaveBeenCalledTimes(1));

    const [to, sent] = sendPayoutChangedEmail.mock.calls[0]!;
    expect(to).toBe('a@test.local');
    expect(sent).toMatchObject({
      kind: 'bank_account_changed', accountCurrency: 'EUR', before: 'NL•• 1234', after: 'NL•• 9876',
      identifierChanged: true, at, timezone: 'Europe/Amsterdam',
    });
    expect(sent.pauseUrl).toMatch(/\/payout-pause#t=[0-9a-f]{64}$/);
  });

  it('returns before a slow sender settles', () => {
    sendPayoutChangedEmail.mockReturnValue(new Promise<void>(() => {}));
    const result: unknown = deliverPayoutChangedNotice(db, 'ev-1');
    expect(result).toBeUndefined();
  });

  it('owns a rejecting sender: logs it and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    sendPayoutChangedEmail.mockRejectedValue(new Error('resend down'));

    deliverPayoutChangedNotice(db, 'ev-1');

    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(log.error).mock.calls[0]?.[0]).toMatchObject({ eventId: 'ev-1' });
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('owns a failing token mint and sends nothing', async () => {
    create.mockRejectedValue(new Error('db down'));
    expect(() => deliverPayoutChangedNotice(db, 'ev-1')).not.toThrow();
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(1));
    expect(sendPayoutChangedEmail).not.toHaveBeenCalled();
  });

  it('warns, not errors, and sends nothing when the teacher is erased between the read and the mint', async () => {
    create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated', { code: 'P2003', clientVersion: 'test' }));

    deliverPayoutChangedNotice(db, 'ev-1');

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatchObject({ eventId: 'ev-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(log.error).not.toHaveBeenCalled();
    expect(sendPayoutChangedEmail).not.toHaveBeenCalled();
  });

  it('logs and sends nothing, minting nothing, when the event is gone with an erased teacher', async () => {
    findUnique.mockResolvedValue(null);

    deliverPayoutChangedNotice(db, 'ev-1');

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(log.warn).mock.calls[0]?.[0]).toMatchObject({ eventId: 'ev-1' });
    expect(create).not.toHaveBeenCalled();
    expect(sendPayoutChangedEmail).not.toHaveBeenCalled();
  });
});
