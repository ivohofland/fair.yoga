import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import { bankAccountDataSelect } from '@/lib/payment-methods';
import { mintPayoutPauseToken, PAUSE_TOKEN_TTL_DAYS } from './payout-pause-token';
import { pausePayments, pauseWindowFloor, pausePasskeyCutoff, PAUSE_PASSKEY_LOOKBACK_DAYS } from './payout-pause';
import { deletePasskey } from './passkey-credentials';
import { savePaymentLink } from './payment-link';
import { PAUSE_PASSKEY_FALLBACK_DAYS, resumePayments } from './payout-resume';
import { uniqueSuffix, seedSession } from '../../tests/helpers';

const sendPasskeyRemovedEmail = vi.hoisted(() => vi.fn<(to: string, removedAt: Date) => Promise<void>>());
vi.mock('@/lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email')>()),
  sendPasskeyRemovedEmail,
}));

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];
const emails: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

interface Fixture {
  teacherId: string;
  accountId: string;
  email: string;
}

async function makeTeacher(): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `pause-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Pause', lastName: 'Teacher', email, bio: '', pageSlug: `pause-${s}`,
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  emails.push(email);
  return { teacherId: t.id, accountId: t.accountId, email };
}

async function event(teacherId: string, createdAt: Date): Promise<string> {
  const e = await prisma.payoutChangeEvent.create({
    data: { teacherId, kind: 'payment_link_changed', before: 'revolut.me/…anna', after: 'revolut.me/…evil', createdAt },
    select: { id: true },
  });
  return e.id;
}

/** A token row for `eventId`, returning the raw value a link would carry. */
async function token(teacherId: string, eventId: string, expiresAt: Date): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.payoutPauseToken.create({ data: { tokenHash: hashToken(raw), teacherId, eventId, expiresAt } });
  return raw;
}

async function passkey(accountId: string, tag: string, createdAt: Date): Promise<string> {
  const id = `pause-pk-${tag}-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  return id;
}

async function pauseState(teacherId: string) {
  return prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { paymentsPausedAt: true, pauseWindowStart: true, pausePasskeyCutoff: true },
  });
}

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { in: emails } } });
  await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('pausePayments', () => {
  it('pauses, signs every device out, removes recent passkeys and spends the token', async () => {
    const now = new Date();
    const me = await makeTeacher();
    const other = await makeTeacher();
    const eventAt = daysAgo(now, 2);
    const eventId = await event(me.teacherId, eventAt);
    const raw = await token(me.teacherId, eventId, new Date(now.getTime() + DAY_MS));
    const cutoff = new Date(eventAt.getTime() - PAUSE_PASSKEY_LOOKBACK_DAYS * DAY_MS);

    const old = await passkey(me.accountId, 'old', new Date(cutoff.getTime() - 1));
    const atCutoff = await passkey(me.accountId, 'at', cutoff);
    const recent = await passkey(me.accountId, 'recent', daysAgo(now, 1));
    const othersRecent = await passkey(other.accountId, 'other', daysAgo(now, 1));
    await seedSession(prisma, me.accountId);
    await seedSession(prisma, me.accountId);
    await seedSession(prisma, other.accountId);
    const sub = (accountId: string) => ({
      accountId, endpoint: `https://push.test/pause-${uniqueSuffix()}`, p256dh: 'p', auth: 'a',
    });
    await prisma.pushSubscription.createMany({ data: [sub(me.accountId), sub(other.accountId)] });
    const link = (email: string) => ({
      tokenHash: hashToken(crypto.randomBytes(32).toString('hex')), email, expiresAt: new Date(now.getTime() + DAY_MS),
    });
    await prisma.magicLinkToken.createMany({ data: [link(me.email), link(other.email)] });

    expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'paused' });

    expect(await pauseState(me.teacherId)).toEqual({
      paymentsPausedAt: now, pauseWindowStart: eventAt, pausePasskeyCutoff: cutoff,
    });
    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: { email: me.email } })).toBe(0);
    const left = await prisma.passkeyCredential.findMany({
      where: { id: { in: [old, atCutoff, recent, othersRecent] } }, select: { id: true },
    });
    expect(left.map((p) => p.id).sort()).toEqual([old, othersRecent].sort());
    expect(await prisma.payoutPauseToken.count({ where: { tokenHash: hashToken(raw) } })).toBe(0);

    // Another account is untouched.
    expect(await pauseState(other.teacherId)).toEqual({ paymentsPausedAt: null, pauseWindowStart: null, pausePasskeyCutoff: null });
    expect(await prisma.session.count({ where: { accountId: other.accountId } })).toBe(1);
    expect(await prisma.pushSubscription.count({ where: { accountId: other.accountId } })).toBe(1);
    expect(await prisma.magicLinkToken.count({ where: { email: other.email } })).toBe(1);
  });

  it('freezes no cutoff when no passkey predates it, and still removes the recent ones', async () => {
    const now = new Date();
    const me = await makeTeacher();
    const eventAt = daysAgo(now, 1);
    const raw = await token(me.teacherId, await event(me.teacherId, eventAt), new Date(now.getTime() + DAY_MS));
    const recent = await passkey(me.accountId, 'only-recent', daysAgo(now, 3));

    expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'paused' });

    expect(await pauseState(me.teacherId)).toEqual({
      paymentsPausedAt: now, pauseWindowStart: eventAt, pausePasskeyCutoff: null,
    });
    expect(await prisma.passkeyCredential.count({ where: { id: recent } })).toBe(0);
  });

  it('works with a token minted by mintPayoutPauseToken', async () => {
    const me = await makeTeacher();
    const eventId = await event(me.teacherId, new Date());
    const raw = await mintPayoutPauseToken(prisma, me.teacherId, eventId);

    expect(await pausePayments(prisma, raw)).toEqual({ status: 'paused' });
    expect((await pauseState(me.teacherId)).paymentsPausedAt).not.toBeNull();
  });

  describe('one answer for every link that cannot pause', () => {
    it('a used token', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, now), new Date(now.getTime() + DAY_MS));
      expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'paused' });
      await seedSession(prisma, me.accountId);

      expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'invalid' });
      // A refused link signs no one out.
      expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(1);
    });

    it('an expired token, which it leaves alone and does not pause on', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 3)), daysAgo(now, 1));
      await seedSession(prisma, me.accountId);

      expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'invalid' });
      expect((await pauseState(me.teacherId)).paymentsPausedAt).toBeNull();
      expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(1);
    });

    it('a token that expires at this very instant', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 3)), now);

      expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'invalid' });
      expect((await pauseState(me.teacherId)).paymentsPausedAt).toBeNull();
    });

    it('an unknown token', async () => {
      expect(await pausePayments(prisma, crypto.randomBytes(32).toString('hex'))).toEqual({ status: 'invalid' });
    });

    it('an erased teacher\'s token', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, now), new Date(now.getTime() + DAY_MS));
      await prisma.teacher.update({ where: { id: me.teacherId }, data: { deletedAt: now } });
      await seedSession(prisma, me.accountId);

      expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'invalid' });
      expect((await pauseState(me.teacherId)).paymentsPausedAt).toBeNull();
      expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(1);
    });
  });

  it('a second link while paused signs out again and keeps the first pause\'s instant, window and cutoff', async () => {
    const first = daysAgo(new Date(), 0.5);
    const me = await makeTeacher();
    const firstEventAt = daysAgo(first, 1);
    const firstRaw = await token(me.teacherId, await event(me.teacherId, firstEventAt), new Date(Date.now() + DAY_MS));
    await passkey(me.accountId, 'old-enough', daysAgo(first, 30));
    expect(await pausePayments(prisma, firstRaw, first)).toEqual({ status: 'paused' });
    const paused = await pauseState(me.teacherId);

    // A later change mails a second link, and a passkey is added after the
    // first pause.
    const later = new Date();
    const secondRaw = await token(me.teacherId, await event(me.teacherId, daysAgo(later, 0.1)), new Date(later.getTime() + DAY_MS));
    const sinceFirstCutoff = await passkey(me.accountId, 'since', daysAgo(later, 0.2));
    await seedSession(prisma, me.accountId);

    expect(await pausePayments(prisma, secondRaw, later)).toEqual({ status: 'paused' });

    expect(await pauseState(me.teacherId)).toEqual(paused);
    expect(paused.paymentsPausedAt).toEqual(first);
    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
    // This pause computes its own cutoff, and the new passkey is past it.
    expect(await prisma.passkeyCredential.count({ where: { id: sinceFirstCutoff } })).toBe(0);
  });

  it('a re-pause whose own cutoff is earlier never removes a passkey the first pause left eligible', async () => {
    const now = new Date();
    const me = await makeTeacher();
    const firstRaw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 2)), new Date(now.getTime() + DAY_MS));
    // Older than the first pause's cutoff (9 days ago), so eligible to resume.
    const eligible = await passkey(me.accountId, 'eligible', daysAgo(now, 10));
    expect(await pausePayments(prisma, firstRaw, now)).toEqual({ status: 'paused' });
    expect((await pauseState(me.teacherId)).pausePasskeyCutoff).toEqual(daysAgo(daysAgo(now, 2), PAUSE_PASSKEY_LOOKBACK_DAYS));

    // An earlier event moves the re-pause's own cutoff to 12 days ago.
    await event(me.teacherId, daysAgo(now, 5));
    const secondRaw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 1)), new Date(now.getTime() + DAY_MS));
    expect(await pausePayments(prisma, secondRaw, now)).toEqual({ status: 'paused' });

    expect(await prisma.passkeyCredential.count({ where: { id: eligible } })).toBe(1);
  });

  describe('the window start', () => {
    it('is the earliest event since the floor, not the token\'s own', async () => {
      const now = new Date();
      const me = await makeTeacher();
      await event(me.teacherId, daysAgo(now, 40));
      const tenDays = daysAgo(now, 10);
      await event(me.teacherId, tenDays);
      const raw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 2)), new Date(now.getTime() + DAY_MS));

      await pausePayments(prisma, raw, now);

      expect((await pauseState(me.teacherId)).pauseWindowStart).toEqual(tenDays);
    });

    it('ignores an event older than the link lifetime', async () => {
      const now = new Date();
      const me = await makeTeacher();
      await event(me.teacherId, daysAgo(now, 40));
      const twoDays = daysAgo(now, 2);
      const raw = await token(me.teacherId, await event(me.teacherId, twoDays), new Date(now.getTime() + DAY_MS));

      await pausePayments(prisma, raw, now);

      expect((await pauseState(me.teacherId)).pauseWindowStart).toEqual(twoDays);
    });

    it('starts no earlier than the last resume, even for a token whose event predates it', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 8)), new Date(now.getTime() + DAY_MS));
      await prisma.teacher.update({ where: { id: me.teacherId }, data: { paymentsResumedAt: daysAgo(now, 5) } });
      const threeDays = daysAgo(now, 3);
      await event(me.teacherId, threeDays);

      await pausePayments(prisma, raw, now);

      expect((await pauseState(me.teacherId)).pauseWindowStart).toEqual(threeDays);
    });

    it('falls back to the token\'s event when nothing lies past the floor', async () => {
      const now = new Date();
      const me = await makeTeacher();
      // Older than the link lifetime, on a token that outlived it.
      const twentyDays = daysAgo(now, 20);
      const raw = await token(me.teacherId, await event(me.teacherId, twentyDays), new Date(now.getTime() + DAY_MS));

      await pausePayments(prisma, raw, now);

      expect(await pauseState(me.teacherId)).toEqual({
        paymentsPausedAt: now,
        pauseWindowStart: twentyDays,
        pausePasskeyCutoff: null,
      });
    });

    it('starts at the floor when nothing lies past it and the token\'s event predates the last resume', async () => {
      const now = new Date();
      const me = await makeTeacher();
      const raw = await token(me.teacherId, await event(me.teacherId, daysAgo(now, 3)), new Date(now.getTime() + DAY_MS));
      const resumedAt = daysAgo(now, 1);
      await prisma.teacher.update({ where: { id: me.teacherId }, data: { paymentsResumedAt: resumedAt } });

      await pausePayments(prisma, raw, now);

      expect(await pauseState(me.teacherId)).toEqual({
        paymentsPausedAt: now,
        pauseWindowStart: resumedAt,
        pausePasskeyCutoff: null,
      });
    });
  });
});

describe('a passkey removed before the pause', () => {
  async function fingerprintOf(teacherId: string): Promise<string> {
    const t = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
    });
    return payoutFingerprint(t);
  }

  async function removed(accountId: string, credentialCreatedAt: Date, removedAt: Date): Promise<void> {
    await prisma.removedPasskey.create({ data: { accountId, credentialCreatedAt, removedAt } });
  }

  it('still requires a passkey to resume, so a magic-link session waits for the fallback', async () => {
    const me = await makeTeacher();
    const own = await passkey(me.accountId, 'own', daysAgo(new Date(), 30));
    // Signed in by an emailed link, someone removes the passkey, then changes the details.
    expect((await deletePasskey(prisma, { accountId: me.accountId, credentialId: own })).status).toBe('deleted');
    const saved = await savePaymentLink(prisma, me.teacherId, 'https://revolut.me/someoneelse');
    if (saved.kind !== 'saved') throw new Error(`expected a saved link, got ${saved.kind}`);
    const raw = await mintPayoutPauseToken(prisma, me.teacherId, saved.eventId);
    const pausedAt = new Date();

    expect(await pausePayments(prisma, raw, pausedAt)).toEqual({ status: 'paused' });
    expect((await pauseState(me.teacherId)).pausePasskeyCutoff).not.toBeNull();

    const sessionId = hashToken(await seedSession(prisma, me.accountId));
    const fingerprint = await fingerprintOf(me.teacherId);
    const fallback = new Date(pausedAt.getTime() + PAUSE_PASSKEY_FALLBACK_DAYS * DAY_MS);
    expect(await resumePayments(prisma, { teacherId: me.teacherId, sessionId, fingerprint, now: new Date(fallback.getTime() - 1) }))
      .toEqual({ status: 'passkey_required' });
    expect(await resumePayments(prisma, { teacherId: me.teacherId, sessionId, fingerprint, now: fallback }))
      .toEqual({ status: 'resumed' });
  });

  it('counts a pre-cutoff passkey removed at the cutoff, not one removed before it', async () => {
    const now = new Date();
    const eventAt = daysAgo(now, 1);
    const cutoff = pausePasskeyCutoff(eventAt);

    const atCutoff = await makeTeacher();
    await removed(atCutoff.accountId, new Date(cutoff.getTime() - 1), cutoff);
    await pausePayments(prisma, await token(atCutoff.teacherId, await event(atCutoff.teacherId, eventAt), new Date(now.getTime() + DAY_MS)), now);
    expect((await pauseState(atCutoff.teacherId)).pausePasskeyCutoff).toEqual(cutoff);

    const beforeCutoff = await makeTeacher();
    await removed(beforeCutoff.accountId, daysAgo(cutoff, 10), new Date(cutoff.getTime() - 1));
    await pausePayments(prisma, await token(beforeCutoff.teacherId, await event(beforeCutoff.teacherId, eventAt), new Date(now.getTime() + DAY_MS)), now);
    expect((await pauseState(beforeCutoff.teacherId)).pausePasskeyCutoff).toBeNull();
  });

  it('does not count a removed passkey created at or after the cutoff', async () => {
    const now = new Date();
    const eventAt = daysAgo(now, 1);
    const cutoff = pausePasskeyCutoff(eventAt);
    const me = await makeTeacher();
    await removed(me.accountId, cutoff, now);

    await pausePayments(prisma, await token(me.teacherId, await event(me.teacherId, eventAt), new Date(now.getTime() + DAY_MS)), now);

    expect((await pauseState(me.teacherId)).pausePasskeyCutoff).toBeNull();
  });

  it('records no removal and sends no removal email for the passkeys the pause itself deletes', async () => {
    const now = new Date();
    const me = await makeTeacher();
    const recent = await passkey(me.accountId, 'pause-deletes', daysAgo(now, 1));
    sendPasskeyRemovedEmail.mockClear();

    await pausePayments(prisma, await token(me.teacherId, await event(me.teacherId, daysAgo(now, 2)), new Date(now.getTime() + DAY_MS)), now);

    expect(await prisma.passkeyCredential.count({ where: { id: recent } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId: me.accountId } })).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendPasskeyRemovedEmail).not.toHaveBeenCalled();
  });
});

describe('pauseWindowFloor', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const ttlFloor = daysAgo(now, PAUSE_TOKEN_TTL_DAYS);

  it('is the link lifetime ago with no resume', () => {
    expect(pauseWindowFloor(now, null)).toEqual(ttlFloor);
  });

  it('is a resume later than that', () => {
    expect(pauseWindowFloor(now, daysAgo(now, 3))).toEqual(daysAgo(now, 3));
  });

  it('ignores a resume earlier than that', () => {
    expect(pauseWindowFloor(now, daysAgo(now, 30))).toEqual(ttlFloor);
  });
});

describe('pausePasskeyCutoff', () => {
  it('is the lookback before the window start', () => {
    const start = new Date('2026-10-08T12:00:00Z');
    expect(pausePasskeyCutoff(start)).toEqual(daysAgo(start, PAUSE_PASSKEY_LOOKBACK_DAYS));
  });
});
