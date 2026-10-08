import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';
import { expectRefusal } from '../api-assertions';

const ID = '00000000-0000-0000-0000-000000000000';

// Two of the bodyless POST handlers that never call parseBody — the CSRF
// surface only this check covers.
const BODYLESS = [`/api/classes/${ID}/cancel`, `/api/payments/${ID}/unpaid`];

describe('Origin check', () => {
  for (const path of BODYLESS) {
    it(`${path}: a foreign Origin is refused before auth`, async () => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { ...freshIp(), origin: 'https://evil.example' },
      });
      await expectRefusal(res, 'CROSS_ORIGIN');
    });
  }

  it('Sec-Fetch-Site: cross-site is refused', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site' },
    });
    await expectRefusal(res, 'CROSS_ORIGIN');
  });

  it('the app’s own Origin reaches the route (401, not 403)', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), origin: new URL(BASE_URL).origin },
    });
    expect(res.status).toBe(401);
  });

  it('no Origin reaches the route as today', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, { method: 'POST', headers: freshIp() });
    expect(res.status).toBe(401);
  });

  it('a cross-site GET is not refused', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site', origin: 'https://mail.example' },
    });
    expect(res.status).not.toBe(403);
  });
});
