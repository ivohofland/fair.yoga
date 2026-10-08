import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BASE_URL, freshIp } from '../helpers';

/** CRON_SECRET from the environment (CI) or .env (local), as the app reads it. */
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  const match = /^CRON_SECRET=(.*)$/m.exec(readFileSync('.env', 'utf8'));
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error('CRON_SECRET must be set in the environment or .env');
  return value;
}

describe('GET /api/health', () => {
  it('without the secret answers exactly status and db', async () => {
    const res = await fetch(`${BASE_URL}/api/health`, { headers: freshIp() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['db', 'status']);
  });

  it('with the secret answers the full body', async () => {
    const secret = cronSecret();
    const res = await fetch(`${BASE_URL}/api/health`, {
      headers: { ...freshIp(), authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('jobs');
  });
});
