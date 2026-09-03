import { describe, it, expect } from 'vitest';
import { freshIp } from '../helpers';

const DOORS = [
  { name: 'magic-link/send', path: '/api/auth/magic-link/send', body: (e: string) => ({ email: e }) },
  { name: 'teacher-signup', path: '/api/auth/teacher-signup', body: (e: string) => ({ email: e }) },
  {
    name: 'student-signup',
    path: '/api/auth/student-signup',
    body: (e: string) => ({ firstName: 'Test', lastName: 'Student', email: e }),
  },
] as const;

describe('every door that emails a link binds an origin nonce', () => {
  for (const door of DOORS) {
    it(`${door.name} sets fair_yoga_origin for an address with no account`, async () => {
      const email = `nobody-${Date.now()}-${door.name.replace(/\W/g, '')}@example.com`;
      const res = await fetch(`http://localhost:3000${door.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...freshIp() },
        body: JSON.stringify(door.body(email)),
      });

      expect(res.status).toBe(200);
      // Unconditional: an unknown address must be indistinguishable from a
      // known one, in the cookie as well as the body.
      expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_origin=');
    });
  }
});
