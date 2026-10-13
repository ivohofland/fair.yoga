import { describe, it, expect } from 'vitest';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

// The email is invisible to this tier, so this pins only that each sign-in
// door accepts a `timeZone` key, a recognised zone or not, without refusing.
const ROUTES = ['/api/auth/magic-link/send', '/api/auth/teacher-signup', '/api/auth/student-signup'] as const;

describe('sign-in requests carry the browser zone (#825)', () => {
  it.each(
    ROUTES.flatMap((route) => [
      [route, 'Europe/Amsterdam'],
      [route, 'Mars/Olympus_Mons'],
    ] as const),
  )('%s answers 200 with timeZone %s', async (route, timeZone) => {
    const email = `tz-${uniqueSuffix()}@test.local`;
    const res = await fetch(`${BASE_URL}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email, timeZone }),
    });
    expect(res.status).toBe(200);
  });
});
