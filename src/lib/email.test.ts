import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendHtmlEmail, sendMagicLinkEmail, sendInvitationEmail, sendPasskeyAddedEmail } from './email';
import { renderMagicLinkEmail, renderInvitationEmail, renderPasskeyAddedEmail } from './email-templates';
import type { BoundSignInLink } from '@/lib/auth/link-delivery';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let savedDryRun: string | undefined;
let savedKey: string | undefined;

beforeEach(() => {
  savedDryRun = process.env.EMAIL_DRY_RUN;
  savedKey = process.env.RESEND_API_KEY;
  sendMock.mockReset();
});

afterEach(() => {
  if (savedDryRun === undefined) delete process.env.EMAIL_DRY_RUN;
  else process.env.EMAIL_DRY_RUN = savedDryRun;
  if (savedKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedKey;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sendHtmlEmail', () => {
  it('resolves ok without calling Resend when EMAIL_DRY_RUN is set', async () => {
    process.env.EMAIL_DRY_RUN = '1';
    process.env.RESEND_API_KEY = 're_real_looking_key';

    const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

    expect(result).toEqual({ ok: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  describe('with no key configured', () => {
    beforeEach(() => {
      delete process.env.EMAIL_DRY_RUN;
      delete process.env.RESEND_API_KEY;
    });

    it('fails in production rather than dry-running', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

      expect(result).toEqual({ ok: false, reason: 'RESEND_API_KEY is not configured' });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('fails in production on the placeholder key too', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.RESEND_API_KEY = 're_placeholder';

      const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

      expect(result).toEqual({ ok: false, reason: 'RESEND_API_KEY is not configured' });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('dry-runs in production when EMAIL_DRY_RUN=1 asks for it', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.EMAIL_DRY_RUN = '1';

      const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

      expect(result).toEqual({ ok: true });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('dry-runs outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');

      const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

      expect(result).toEqual({ ok: true });
      expect(sendMock).not.toHaveBeenCalled();
    });
  });
});

const LINK = 'https://fair.test/verify?token=secret-token' as BoundSignInLink;

function logSpy() {
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

function loggedText(spy: ReturnType<typeof logSpy>): string {
  return spy.mock.calls.flat().join(' ');
}

// The link is the credential: logging it is the leak the production guard
// exists to stop, so every magic-link dry-run case checks what reached stdout.
describe('sendMagicLinkEmail', () => {
  describe('with no key configured', () => {
    beforeEach(() => {
      delete process.env.EMAIL_DRY_RUN;
      delete process.env.RESEND_API_KEY;
    });

    it('throws in production without logging the link', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      const spy = logSpy();

      await expect(sendMagicLinkEmail('a@test.local', LINK)).rejects.toThrow(
        'RESEND_API_KEY is not configured',
      );

      expect(loggedText(spy)).not.toContain('secret-token');
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('throws in production on the placeholder key too', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.RESEND_API_KEY = 're_placeholder';
      const spy = logSpy();

      await expect(sendMagicLinkEmail('a@test.local', LINK)).rejects.toThrow(
        'RESEND_API_KEY is not configured',
      );

      expect(loggedText(spy)).not.toContain('secret-token');
    });

    it('logs the link in production when EMAIL_DRY_RUN=1 asks for it', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      process.env.EMAIL_DRY_RUN = '1';
      const spy = logSpy();

      await expect(sendMagicLinkEmail('a@test.local', LINK)).resolves.toBeUndefined();

      expect(loggedText(spy)).toContain(LINK);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it('logs the link outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const spy = logSpy();

      await expect(sendMagicLinkEmail('a@test.local', LINK)).resolves.toBeUndefined();

      expect(loggedText(spy)).toContain(LINK);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe('with a key configured', () => {
    beforeEach(() => {
      delete process.env.EMAIL_DRY_RUN;
      process.env.RESEND_API_KEY = 're_real_looking_key';
    });

    it('throws with the error message when Resend reports { error }', async () => {
      sendMock.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });

      await expect(sendMagicLinkEmail('a@test.local', LINK)).rejects.toThrow(
        'Failed to send magic-link email: domain not verified',
      );
    });

    it('sends the rendered subject and html', async () => {
      sendMock.mockResolvedValue({ data: { id: 'x' }, error: null });
      const { subject, html } = renderMagicLinkEmail(LINK);

      await sendMagicLinkEmail('a@test.local', LINK);

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@test.local', subject, html }),
      );
    });
  });
});

describe('sendInvitationEmail', () => {
  const URL = 'https://fair.test/sign-in?invite=abc';

  it('has no production throw: a missing key logs', async () => {
    delete process.env.EMAIL_DRY_RUN;
    delete process.env.RESEND_API_KEY;
    vi.stubEnv('NODE_ENV', 'production');
    const spy = logSpy();

    await expect(sendInvitationEmail('a@test.local', 'Teacher T', URL)).resolves.toBeUndefined();

    expect(loggedText(spy)).toContain(URL);
    expect(sendMock).not.toHaveBeenCalled();
  });

  describe('with a key configured', () => {
    beforeEach(() => {
      delete process.env.EMAIL_DRY_RUN;
      process.env.RESEND_API_KEY = 're_real_looking_key';
    });

    it('throws with the error message when Resend reports { error }', async () => {
      sendMock.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

      await expect(sendInvitationEmail('a@test.local', 'Teacher T', URL)).rejects.toThrow(
        'Failed to send invitation email: rate limited',
      );
    });

    it('sends the rendered subject and html', async () => {
      sendMock.mockResolvedValue({ data: { id: 'x' }, error: null });
      const { subject, html } = renderInvitationEmail('Teacher T', URL);

      await sendInvitationEmail('a@test.local', 'Teacher T', URL);

      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@test.local', subject, html }),
      );
    });
  });
});

describe('sendPasskeyAddedEmail', () => {
  const ADDED_AT = new Date('2026-10-06T14:03:00Z');

  it('logs instead of sending without a key', async () => {
    delete process.env.EMAIL_DRY_RUN;
    delete process.env.RESEND_API_KEY;

    await expect(sendPasskeyAddedEmail('a@test.local', ADDED_AT)).resolves.toBeUndefined();

    expect(sendMock).not.toHaveBeenCalled();
  });

  describe('with a key configured', () => {
    beforeEach(() => {
      delete process.env.EMAIL_DRY_RUN;
      process.env.RESEND_API_KEY = 're_real_looking_key';
    });

    it('throws with the error message when Resend reports { error }', async () => {
      sendMock.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

      await expect(sendPasskeyAddedEmail('a@test.local', ADDED_AT)).rejects.toThrow(
        'Failed to send passkey-added email: rate limited',
      );
    });

    it('sends the rendered subject and html', async () => {
      sendMock.mockResolvedValue({ data: { id: 'x' }, error: null });
      const { subject, html } = renderPasskeyAddedEmail(ADDED_AT);

      await sendPasskeyAddedEmail('a@test.local', ADDED_AT);

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@test.local', subject, html }),
      );
    });
  });
});

describe('sendHtmlEmail with a key configured', () => {
  beforeEach(() => {
    delete process.env.EMAIL_DRY_RUN;
    process.env.RESEND_API_KEY = 're_real_looking_key';
  });

  it('answers { ok: false } with the message when Resend reports { error }', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'bounced' } });

    const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

    expect(result).toEqual({ ok: false, reason: 'bounced' });
  });

  it('answers { ok: true } on success', async () => {
    sendMock.mockResolvedValue({ data: { id: 'x' }, error: null });

    const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

    expect(result).toEqual({ ok: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
