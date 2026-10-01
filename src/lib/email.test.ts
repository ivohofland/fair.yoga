import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendHtmlEmail } from './email';

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('sendHtmlEmail', () => {
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
  });

  it('resolves ok without calling Resend when EMAIL_DRY_RUN is set', async () => {
    process.env.EMAIL_DRY_RUN = '1';
    process.env.RESEND_API_KEY = 're_real_looking_key';

    const result = await sendHtmlEmail({ to: 'a@test.local', subject: 's', html: '<p>h</p>' });

    expect(result).toEqual({ ok: true });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
