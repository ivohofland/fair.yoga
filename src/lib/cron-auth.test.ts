import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { requireCronAuth } from './cron-auth';

/**
 * `requireCronAuth` is the shared guard on all five `/api/cron/*` routes, and
 * it is the only thing standing between a stranger and a sweep that generates
 * classes, sends email, or transitions class states.
 *
 * Per `docs/technical-architecture.md`, a shared guard earns coverage **once**,
 * at the helper — not a ladder repeated across every route that calls it. The
 * five cron routes are otherwise a guard plus a service call whose sweeps are
 * already unit-tested, so this file is what #53 needed from them.
 *
 * Note it returns `null` to mean "allowed" and a `NextResponse` to mean
 * "rejected" — the inverse of the truthiness a reader might expect, which is
 * why each case asserts the shape rather than just falsiness.
 */
describe('requireCronAuth', () => {
  const original = process.env.CRON_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  const req = (authorization?: string) =>
    new NextRequest('http://localhost:3000/api/cron/generate-classes', {
      method: 'POST',
      ...(authorization ? { headers: { authorization } } : {}),
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
