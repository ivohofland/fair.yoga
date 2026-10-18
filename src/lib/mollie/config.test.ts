import { describe, it, expect } from 'vitest';
import { diagnoseMollieConfig } from './config';

const key = Buffer.alloc(32, 7).toString('base64');
const full = { MOLLIE_CLIENT_ID: 'app_x', MOLLIE_CLIENT_SECRET: 's', PROCESSOR_TOKEN_KEY: key, NEXT_PUBLIC_APP_URL: 'https://fair.yoga' };

describe('diagnoseMollieConfig', () => {
  it('is unset when none of the three is set', () => {
    expect(diagnoseMollieConfig({ NEXT_PUBLIC_APP_URL: 'https://fair.yoga' })).toEqual({ ok: false, reason: 'unset' });
  });
  it('is partial when only some are set', () => {
    expect(diagnoseMollieConfig({ MOLLIE_CLIENT_ID: 'app_x' })).toEqual({ ok: false, reason: 'partial' });
  });
  it('refuses a key that does not decode to 32 bytes', () => {
    expect(diagnoseMollieConfig({ ...full, PROCESSOR_TOKEN_KEY: Buffer.alloc(16).toString('base64') }))
      .toEqual({ ok: false, reason: 'token-key-length' });
  });
  it('needs the app URL for redirect and webhook URLs', () => {
    expect(diagnoseMollieConfig({ ...full, NEXT_PUBLIC_APP_URL: undefined })).toEqual({ ok: false, reason: 'app-url' });
  });
  it('answers the config, live by default', () => {
    const d = diagnoseMollieConfig(full);
    expect(d.ok && d.config.testmode).toBe(false);
    expect(d.ok && d.config.tokenKey.length).toBe(32);
  });
  it('reads MOLLIE_TESTMODE=1 as test mode', () => {
    const d = diagnoseMollieConfig({ ...full, MOLLIE_TESTMODE: '1' });
    expect(d.ok && d.config.testmode).toBe(true);
  });
});
