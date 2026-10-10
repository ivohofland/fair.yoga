import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  sendEmail,
  sendMagicLinkEmail,
  sendInvitationEmail,
  sendPasskeyAddedEmail,
  sendPasskeyRemovedEmail,
  sendPayoutChangedEmail,
} from './email';
import {
  renderMagicLinkEmail,
  renderInvitationEmail,
  renderPasskeyAddedEmail,
  renderPasskeyRemovedEmail,
  renderPayoutChangedEmail,
} from './email-templates';
import { log } from '@/lib/log';
import type { BoundSignInLink } from '@/lib/auth/link-delivery';

const deliverMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/email-lettermint', () => ({ deliverViaLettermint: deliverMock }));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const content = { subject: 'S', html: '<p>H</p>', text: 'H' };

const ENV_NAMES = [
  'LETTERMINT_API_TOKEN',
  'LETTERMINT_CLASS_ROUTE',
  'EMAIL_REPLY_TO',
  'EMAIL_FROM',
  'EMAIL_DRY_RUN',
] as const;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  deliverMock.mockReset();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function lastPayload(): Record<string, unknown> {
  const call = deliverMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('adapter not called');
  return call[0] as Record<string, unknown>;
}

describe('sendEmail', () => {
  beforeEach(() => {
    process.env.LETTERMINT_API_TOKEN = 'lm_test';
    deliverMock.mockResolvedValue({ ok: true });
  });

  it('answers sent and hands the adapter the token and the rendered parts', async () => {
    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: true, delivery: 'sent' });
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0]?.[1]).toBe('lm_test');
    expect(lastPayload()).toMatchObject({
      from: 'noreply@fair.yoga',
      to: 'a@test.local',
      subject: 'S',
      html: '<p>H</p>',
      text: 'H',
    });
  });

  it('returns the adapter refusal unchanged', async () => {
    deliverMock.mockResolvedValue({ ok: false, reason: 'lettermint 422: x' });

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: false, reason: 'lettermint 422: x' });
  });

  it('turns an adapter throw into ok: false', async () => {
    deliverMock.mockRejectedValue(new Error('boom'));

    const thrown = new Error('boom');
    deliverMock.mockRejectedValue(thrown);

    await expect(sendEmail({ to: 'a@test.local', audience: 'platform', content })).resolves.toEqual({
      ok: false,
      reason: 'boom',
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledWith(
      { err: thrown, subject: 'S', audience: 'platform' },
      'email adapter threw',
    );
  });

  it('passes EMAIL_FROM verbatim', async () => {
    process.env.EMAIL_FROM = 'fair.yoga <noreply@notify.fair.yoga>';

    await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(lastPayload().from).toBe('fair.yoga <noreply@notify.fair.yoga>');
  });

  describe('platform audience', () => {
    it('replies to hello@fair.yoga on the default route', async () => {
      await sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(lastPayload().replyTo).toBe('hello@fair.yoga');
      expect(lastPayload()).not.toHaveProperty('route');
    });

    it('replies to EMAIL_REPLY_TO when set', async () => {
      process.env.EMAIL_REPLY_TO = 'ops@x.test';

      await sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(lastPayload().replyTo).toBe('ops@x.test');
    });

    it('treats an empty EMAIL_REPLY_TO as unset', async () => {
      process.env.EMAIL_REPLY_TO = '';

      await sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(lastPayload().replyTo).toBe('hello@fair.yoga');
    });
  });

  describe('whitespace-only settings', () => {
    it('treats a whitespace-only EMAIL_REPLY_TO as unset', async () => {
      process.env.EMAIL_REPLY_TO = '  ';

      await sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(lastPayload().replyTo).toBe('hello@fair.yoga');
    });

    it('treats a whitespace-only LETTERMINT_CLASS_ROUTE as unset', async () => {
      process.env.LETTERMINT_CLASS_ROUTE = '  ';

      await sendEmail({ to: 'a@test.local', audience: 'class', content });

      expect(lastPayload()).not.toHaveProperty('route');
    });

    it('sends the trimmed token', async () => {
      process.env.LETTERMINT_API_TOKEN = ' lm_test\n';

      await sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(deliverMock.mock.calls[0]?.[1]).toBe('lm_test');
    });
  });

  describe('class audience', () => {
    it('sends on LETTERMINT_CLASS_ROUTE with no Reply-To', async () => {
      process.env.LETTERMINT_CLASS_ROUTE = 'class-mail';

      await sendEmail({ to: 'a@test.local', audience: 'class', content });

      expect(lastPayload().route).toBe('class-mail');
      expect(lastPayload()).not.toHaveProperty('replyTo');
    });

    it('treats an empty LETTERMINT_CLASS_ROUTE as unset', async () => {
      process.env.LETTERMINT_CLASS_ROUTE = '';

      await sendEmail({ to: 'a@test.local', audience: 'class', content });

      expect(lastPayload()).not.toHaveProperty('route');
    });

    it('warns once in production that the class route is unset', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      const fresh = await import('./email');
      const { log: freshLog } = await import('@/lib/log');

      await fresh.sendEmail({ to: 'a@test.local', audience: 'class', content });
      await fresh.sendEmail({ to: 'b@test.local', audience: 'class', content });

      expect(vi.mocked(freshLog.warn)).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(freshLog.warn).mock.calls[0]?.[1])).toContain('LETTERMINT_CLASS_ROUTE');
    });

    it('does not warn in production when the class route is set', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      process.env.LETTERMINT_CLASS_ROUTE = 'class-mail';
      const fresh = await import('./email');
      const { log: freshLog } = await import('@/lib/log');

      await fresh.sendEmail({ to: 'a@test.local', audience: 'class', content });

      expect(vi.mocked(freshLog.warn)).not.toHaveBeenCalled();
    });

    it('does not warn in production about the class route on platform mail', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      const fresh = await import('./email');
      const { log: freshLog } = await import('@/lib/log');

      await fresh.sendEmail({ to: 'a@test.local', audience: 'platform', content });

      expect(vi.mocked(freshLog.warn)).not.toHaveBeenCalled();
    });

    it('does not let a throwing logger escape while resolving the class route', async () => {
      vi.resetModules();
      vi.stubEnv('NODE_ENV', 'production');
      const fresh = await import('./email');
      const { log: freshLog } = await import('@/lib/log');
      vi.mocked(freshLog.warn).mockImplementation(() => {
        throw new Error('logger down');
      });

      await expect(fresh.sendEmail({ to: 'a@test.local', audience: 'class', content })).resolves.toEqual({
        ok: false,
        reason: 'logger down',
      });
    });

    it('does not warn outside production', async () => {
      await sendEmail({ to: 'a@test.local', audience: 'class', content });

      expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
    });
  });

  it('passes headers and idempotencyKey through unchanged', async () => {
    await sendEmail({
      to: 'a@test.local',
      audience: 'class',
      content,
      headers: { 'List-Unsubscribe': '<https://x.test/u>' },
      idempotencyKey: 'key-1',
    });

    expect(lastPayload().headers).toEqual({ 'List-Unsubscribe': '<https://x.test/u>' });
    expect(lastPayload().idempotencyKey).toBe('key-1');
  });
});

describe('sendEmail dry-run and the production rule', () => {
  it('dry-runs on EMAIL_DRY_RUN=1 even with a token, logging the subject but not the address', async () => {
    process.env.LETTERMINT_API_TOKEN = 'lm_test';
    process.env.EMAIL_DRY_RUN = '1';

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: true, delivery: 'dry-run' });
    expect(deliverMock).not.toHaveBeenCalled();
    expect(vi.mocked(log.info)).toHaveBeenCalledWith({ subject: 'S' }, expect.any(String));
  });

  it('dry-runs with no token outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: true, delivery: 'dry-run' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('refuses with no token in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: false, reason: 'LETTERMINT_API_TOKEN is not configured' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('treats an empty token as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.LETTERMINT_API_TOKEN = '';

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: false, reason: 'LETTERMINT_API_TOKEN is not configured' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only token as unset in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.LETTERMINT_API_TOKEN = '   ';

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: false, reason: 'LETTERMINT_API_TOKEN is not configured' });
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('dry-runs in production when EMAIL_DRY_RUN=1 asks for it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EMAIL_DRY_RUN = '1';

    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: true, delivery: 'dry-run' });
    expect(deliverMock).not.toHaveBeenCalled();
  });
});

const LINK = 'https://fair.test/verify?token=secret-token' as BoundSignInLink;
const INVITE_URL = 'https://fair.test/sign-in?invite=abc';
const WHEN = new Date('2026-10-06T14:03:00Z');
const PAYOUT = {
  kind: 'payment_link_added',
  accountCurrency: null,
  before: null,
  after: 'pay.example',
  identifierChanged: null,
  at: WHEN,
  timezone: 'UTC',
  pauseUrl: 'https://fair.yoga/payout-pause#t=secret-token',
} as const;

const wrappers = [
  {
    name: 'magic link',
    label: 'magic-link',
    audience: 'platform',
    send: () => sendMagicLinkEmail('a@test.local', LINK),
    rendered: () => renderMagicLinkEmail(LINK),
  },
  {
    name: 'invitation',
    label: 'invitation',
    audience: 'class',
    send: () => sendInvitationEmail('a@test.local', 'Teacher T', INVITE_URL),
    rendered: () => renderInvitationEmail('Teacher T', INVITE_URL),
  },
  {
    name: 'passkey added',
    label: 'passkey-added',
    audience: 'platform',
    send: () => sendPasskeyAddedEmail('a@test.local', WHEN),
    rendered: () => renderPasskeyAddedEmail(WHEN),
  },
  {
    name: 'passkey removed',
    label: 'passkey-removed',
    audience: 'platform',
    send: () => sendPasskeyRemovedEmail('a@test.local', WHEN),
    rendered: () => renderPasskeyRemovedEmail(WHEN),
  },
  {
    name: 'payout changed',
    label: 'payout-changed',
    audience: 'platform',
    send: () => sendPayoutChangedEmail('a@test.local', PAYOUT),
    rendered: () => renderPayoutChangedEmail(PAYOUT),
  },
] as const;

function logSpy() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe.each(wrappers)('$name wrapper', ({ label, audience, send, rendered }) => {
  describe('with a token', () => {
    beforeEach(() => {
      process.env.LETTERMINT_API_TOKEN = 'lm_test';
    });

    it(`sends the rendered content as ${audience} mail`, async () => {
      deliverMock.mockResolvedValue({ ok: true });
      const { subject, html, text } = rendered();

      await send();

      expect(lastPayload()).toMatchObject({ to: 'a@test.local', subject, html, text });
      if (audience === 'platform') expect(lastPayload()).toHaveProperty('replyTo');
      else expect(lastPayload()).not.toHaveProperty('replyTo');
    });

    it('throws with the reason when the adapter refuses', async () => {
      deliverMock.mockResolvedValue({ ok: false, reason: 'r' });

      await expect(send()).rejects.toThrow(new RegExp(`Failed to send ${label} email: r`));
    });

    it('throws when the adapter throws', async () => {
      deliverMock.mockRejectedValue(new Error('network'));

      await expect(send()).rejects.toThrow(new RegExp(`Failed to send ${label} email: network`));
    });
  });

  it('throws in production without a token', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    await expect(send()).rejects.toThrow(/LETTERMINT_API_TOKEN is not configured/);
    expect(deliverMock).not.toHaveBeenCalled();
  });
});

// The link is the credential: logging it is the leak the production refusal
// exists to stop, so every dry-run case checks what reached stdout.
describe('sendMagicLinkEmail dry-run', () => {
  it('never logs the link when production has no token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const spy = logSpy();

    await expect(sendMagicLinkEmail('a@test.local', LINK)).rejects.toThrow();

    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret-token');
  });

  it('logs the link outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const spy = logSpy();

    await sendMagicLinkEmail('a@test.local', LINK);

    expect(spy).toHaveBeenCalledWith(`\n[DEV] Magic link for a@test.local: ${LINK}\n`);
  });

  it('logs the link in production when EMAIL_DRY_RUN=1 asks for it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.EMAIL_DRY_RUN = '1';
    const spy = logSpy();

    await expect(sendMagicLinkEmail('a@test.local', LINK)).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalledWith(`\n[DEV] Magic link for a@test.local: ${LINK}\n`);
  });
});

describe('sendInvitationEmail dry-run', () => {
  it('logs the sign-in URL outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const spy = logSpy();

    await sendInvitationEmail('a@test.local', 'Teacher T', INVITE_URL);

    expect(spy).toHaveBeenCalledWith(
      `\n[DEV] Invitation email for a@test.local from Teacher T: ${INVITE_URL}\n`,
    );
  });
});

describe('notice wrappers in dry-run', () => {
  it('log neither the address nor the pause link', async () => {
    const spy = logSpy();

    await sendPasskeyAddedEmail('a@test.local', WHEN);
    await sendPasskeyRemovedEmail('a@test.local', WHEN);
    await sendPayoutChangedEmail('a@test.local', PAYOUT);

    expect(spy).not.toHaveBeenCalled();
    const logged = JSON.stringify(vi.mocked(log.info).mock.calls);
    expect(logged).not.toContain('a@test.local');
    expect(logged).not.toContain('secret-token');
  });
});
