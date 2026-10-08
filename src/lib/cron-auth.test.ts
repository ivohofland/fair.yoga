import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireCronAuth, hasCronSecret } from './cron-auth';

/**
 * `hasCronSecret` answers whether a request carries the cron secret,
 * compared in constant time; `requireCronAuth` wraps it into an HTTP refusal
 * (null to allow, NextResponse to reject).
 *
 * Per `docs/technical-architecture.md`, a shared guard earns coverage **once**,
 * at the helper — not a ladder repeated across every route that calls it. The
 * cron routes are otherwise a guard plus a service call whose sweeps are
 * already unit-tested, so this file is what #53 needed from them.
 */

const req = (authorization?: string) =>
  new NextRequest('http://localhost:3000/api/cron/generate-classes', {
    method: 'POST',
    ...(authorization ? { headers: { authorization } } : {}),
  });

describe('hasCronSecret', () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('is true for the configured secret', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer right-secret'))).toBe(true);
  });

  it('is false for a wrong secret of the same length', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer wrong-secret'))).toBe(false);
  });

  it('is false for a wrong secret of another length, without throwing', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req('Bearer x'))).toBe(false);
    expect(hasCronSecret(req('Bearer right-secret-and-more'))).toBe(false);
  });

  it('is false with no header', () => {
    process.env.CRON_SECRET = 'right-secret';
    expect(hasCronSecret(req())).toBe(false);
  });

  it('is false for "Bearer undefined" when no secret is configured', () => {
    delete process.env.CRON_SECRET;
    expect(hasCronSecret(req('Bearer undefined'))).toBe(false);
  });

  it('is false when no secret is configured, or it is empty', () => {
    delete process.env.CRON_SECRET;
    expect(hasCronSecret(req('Bearer '))).toBe(false);
    process.env.CRON_SECRET = '';
    expect(hasCronSecret(req('Bearer '))).toBe(false);
  });
});

describe('requireCronAuth', () => {
  const original = process.env.CRON_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it('allows a request carrying the configured secret', () => {
    process.env.CRON_SECRET = 'right-secret';

    expect(requireCronAuth(req('Bearer right-secret'))).toBeNull();
  });

  it('rejects a wrong secret with 401', async () => {
    process.env.CRON_SECRET = 'right-secret';

    const res = requireCronAuth(req('Bearer wrong-secret'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('rejects a missing Authorization header with 401', async () => {
    process.env.CRON_SECRET = 'right-secret';

    const res = requireCronAuth(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it('rejects the bare secret without the Bearer scheme', () => {
    process.env.CRON_SECRET = 'right-secret';

    const res = requireCronAuth(req('right-secret'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  // The interesting branch: an unconfigured deployment fails closed with a 500
  // rather than open. Worth pinning precisely because the tempting "fix" for a
  // 500 in production is to make the guard permissive when no secret is set,
  // which would leave every sweep publicly triggerable.
  it('fails closed with 500 when CRON_SECRET is not configured', () => {
    delete process.env.CRON_SECRET;

    const res = requireCronAuth(req('Bearer anything'));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });

  it('does not treat an empty CRON_SECRET as configured', () => {
    process.env.CRON_SECRET = '';

    const res = requireCronAuth(req('Bearer '));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(500);
  });
});
