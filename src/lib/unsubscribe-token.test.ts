import { describe, it, expect, afterEach, vi } from 'vitest';
import type { UnsubscribeTarget } from './unsubscribe-kind';

const SECRET = 'x'.repeat(32);
async function load() {
  vi.resetModules();
  return import('./unsubscribe-token');
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('unsubscribe token', () => {
  it('round-trips a target', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'student_reminders', subjectId: 'stu_1' });
    expect(token).not.toBeNull();
    expect(verifyUnsubscribeToken(token!)).toEqual({
      kind: 'student_reminders',
      subjectId: 'stu_1',
    });
  });

  it('refuses a MAC spelled with different padding bits', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const [payload, mac] = signUnsubscribeToken({ kind: 'student_reminders', subjectId: 'stu_1' })!.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const head = mac!.slice(0, -1);
    const variant = [...alphabet].find(
      (c) => c !== mac!.slice(-1) && Buffer.from(head + c, 'base64url').equals(Buffer.from(mac!, 'base64url')),
    );
    expect(variant).toBeDefined();
    expect(verifyUnsubscribeToken(`${payload}.${head}${variant}`)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload}.${mac}`)).not.toBeNull();
  });

  it('refuses a tampered payload, a tampered MAC, and another key', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const mod = await load();
    const token = mod.signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 't_1' })!;
    const [payload, mac] = token.split('.');
    const forgedPayload = Buffer.from('v1.teacher_bookings.t_2').toString('base64url');
    expect(mod.verifyUnsubscribeToken(`${forgedPayload}.${mac}`)).toBeNull();
    expect(mod.verifyUnsubscribeToken(`${payload}.${(mac![0] === 'A' ? 'B' : 'A') + mac!.slice(1)}`)).toBeNull();
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'y'.repeat(32));
    const other = await load();
    expect(other.verifyUnsubscribeToken(token)).toBeNull();
  });

  it.each(['', '.', 'a.b.c', 'garbage', `${'A'.repeat(5000)}.x`, 'v1%2E.x'])(
    'never throws on %j',
    async (t) => {
      vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
      const { verifyUnsubscribeToken } = await load();
      expect(verifyUnsubscribeToken(t)).toBeNull();
    },
  );

  it('in production without a secret: signs nothing, verifies nothing, warns once', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const devToken = (await load()).signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 'i' })!;
    expect(devToken).not.toBeNull();
    vi.stubEnv('NODE_ENV', 'production');
    const { signUnsubscribeToken, unsubscribeLinks, verifyUnsubscribeToken } = await load();
    const { log } = await import('@/lib/log');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(verifyUnsubscribeToken(devToken)).toBeNull();
    expect(signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 'i' })).toBeNull();
    expect(unsubscribeLinks({ kind: 'teacher_bookings', subjectId: 'i' })).toBeNull();
    expect(
      warn.mock.calls.filter(([, m]) => String(m).includes('mail is sent without unsubscribe links')),
    ).toHaveLength(1);
  });

  it('in production without a secret: says once that a link was refused, never logging the token', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const devToken = (await load()).signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 't_1' })!;
    vi.stubEnv('NODE_ENV', 'production');
    const { verifyUnsubscribeToken } = await load();
    const { log } = await import('@/lib/log');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(verifyUnsubscribeToken(devToken)).toBeNull();
    expect(verifyUnsubscribeToken(devToken)).toBeNull();
    const refused = warn.mock.calls.filter(([, m]) =>
      String(m).includes('unsubscribe link was refused because UNSUBSCRIBE_SECRET is not configured'),
    );
    expect(refused).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(devToken);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(devToken.split('.')[0]);
  });

  it('treats a secret shorter than 32 bytes as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'short');
    const { signUnsubscribeToken } = await load();
    const { log } = await import('@/lib/log');
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 'i' })).toBeNull();
  });

  it('uses a development key outside production', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 'i' })!;
    expect(verifyUnsubscribeToken(token)).toEqual({ kind: 'teacher_bookings', subjectId: 'i' });
  });

  it('verifies an invitation token signed for a well-formed subject', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const { invitationSubject, signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const target = { kind: 'invitation', subjectId: invitationSubject('inv_1', 'a@test.local') } as const;
    expect(verifyUnsubscribeToken(signUnsubscribeToken(target)!)).toEqual(target);
  });

  it.each(['inv_1', 'inv_1~', '~tag', 'inv_1~tag~more'])(
    'refuses a validly signed invitation token whose subject is %j',
    async (subjectId) => {
      vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
      const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
      // @ts-expect-error -- a hand-built invitation subject, which only a forged or old token could carry
      const token = signUnsubscribeToken({ kind: 'invitation', subjectId });
      expect(token).not.toBeNull();
      expect(verifyUnsubscribeToken(token!)).toBeNull();
    },
  );

  it('binds an invitation subject to its address', async () => {
    const { invitationSubject, parseInvitationSubject, addressTag } = await load();
    const subject = invitationSubject('inv_1', 'Ana@Example.test');
    expect(subject).not.toContain('.');
    expect(parseInvitationSubject(subject)).toEqual({
      invitationId: 'inv_1',
      tag: addressTag('ana@example.test'),
    });
    expect(addressTag('ana@example.test')).not.toBe(
      addressTag('ana@example.tesT'.replace('T', 'x')),
    );
    expect(parseInvitationSubject('inv_1')).toBeNull();
  });

  it('builds the one-click URL and the fragment page URL', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    const { unsubscribeLinks, signUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 'i' })!;
    expect(unsubscribeLinks({ kind: 'teacher_bookings', subjectId: 'i' })).toEqual({
      oneClick: `https://fair.yoga/api/unsubscribe?t=${token}`,
      page: `https://fair.yoga/unsubscribe#t=${token}`,
    });
  });
});

describe('UnsubscribeTarget', () => {
  it('refuses a hand-built invitation subject at compile time', () => {
    // @ts-expect-error -- an invitation subject comes only from `invitationSubject`
    const handBuilt: UnsubscribeTarget = { kind: 'invitation', subjectId: 'inv_1' };
    const profile: UnsubscribeTarget = { kind: 'teacher_bookings', subjectId: 't_1' };
    expect([handBuilt.kind, profile.kind]).toEqual(['invitation', 'teacher_bookings']);
  });
});
