import { describe, it, expect } from 'vitest';

import { BASE_URL } from './helpers';

// The header set from next.config.ts — served on every route. CSP details
// differ between dev and prod (unsafe-eval, ws:), so assert the invariant
// parts only.
describe('security headers', () => {
  it('serves the full set on pages', async () => {
    const res = await fetch(`${BASE_URL}/login`);
    expect(res.status).toBe(200);

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");

    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });

  it('serves the set on API routes too', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
