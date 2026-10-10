import { describe, it, expect, afterEach, vi } from 'vitest';

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

  it('refuses a tampered payload, a tampered MAC, and another key', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', SECRET);
    const mod = await load();
    const token = mod.signUnsubscribeToken({ kind: 'teacher_bookings', subjectId: 't_1' })!;
    const [payload, mac] = token.split('.');
    const forgedPayload = Buffer.from('v1.teacher_bookings.t_2').toString('base64url');
    expect(mod.verifyUnsubscribeToken(`${forgedPayload}.${mac}`)).toBeNull();
    expect(mod.verifyUnsubscribeToken(`${payload}.${mac!.slice(0, -2)}AA`)).toBeNull();
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
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const { signUnsubscribeToken, unsubscribeLinks } = await load();
    const { log } = await import('@/lib/log');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })).toBeNull();
    expect(unsubscribeLinks({ kind: 'invitation', subjectId: 'i' })).toBeNull();
    expect(
      warn.mock.calls.filter(([, m]) => String(m).includes('UNSUBSCRIBE_SECRET')),
    ).toHaveLength(1);
  });

  it('treats a secret shorter than 32 bytes as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UNSUBSCRIBE_SECRET', 'short');
    const { signUnsubscribeToken } = await load();
    const { log } = await import('@/lib/log');
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })).toBeNull();
  });

  it('uses a development key outside production', async () => {
    vi.stubEnv('UNSUBSCRIBE_SECRET', '');
    const { signUnsubscribeToken, verifyUnsubscribeToken } = await load();
    const token = signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })!;
    expect(verifyUnsubscribeToken(token)).toEqual({ kind: 'invitation', subjectId: 'i' });
  });

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
    const token = signUnsubscribeToken({ kind: 'invitation', subjectId: 'i' })!;
    expect(unsubscribeLinks({ kind: 'invitation', subjectId: 'i' })).toEqual({
      oneClick: `https://fair.yoga/api/unsubscribe?t=${token}`,
      page: `https://fair.yoga/unsubscribe#t=${token}`,
    });
  });
});
