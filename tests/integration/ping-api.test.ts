import { describe, it, expect } from 'vitest';
import { BASE_URL } from '../helpers';

describe('GET /api/ping', () => {
  it('answers without a session, with the server clock, never cached', async () => {
    const before = Date.now();
    const res = await fetch(`${BASE_URL}/api/ping`);
    const after = Date.now();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body: unknown = await res.json();
    expect(body).toEqual({ now: expect.any(Number) });
    if (typeof body !== 'object' || body === null || !('now' in body) || typeof body.now !== 'number') throw new Error('no now');
    expect(body.now).toBeGreaterThanOrEqual(before - 60_000);
    expect(body.now).toBeLessThanOrEqual(after + 60_000);
  });
});
