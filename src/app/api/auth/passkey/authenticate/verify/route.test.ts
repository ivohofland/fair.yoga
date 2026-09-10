import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { storeChallenge } from '@/lib/auth';

/**
 * #439. `passkey/authenticate/verify`'s destination logic claimed to mirror
 * `magic-link/verify`'s #431 guard but never got it — #431 touched one
 * route, not both sign-in doors. This proves the guard now actually fires
 * here, in both directions: refused for an account that already teaches,
 * honoured for one that doesn't (the second-hat flow).
 *
 * WHY THIS IS MOCKED, following `magic-link/verify/account-not-found.test.ts`
 * (which names the same reasoning): reaching this branch needs
 * `verifyPasskeyAuthentication` to return `{ verified: true }`, which means a
 * real WebAuthn assertion signature — not something the `integration` tier's
 * HTTP-only driving can produce. `verifyPasskeyAuthentication` and
 * `createSession` are mocked; the handler underneath them is real —
 * `withErrorHandler`, `parseBody`, the schema, and the destination logic all
 * run.
 */

const verifyPasskeyAuthentication = vi.fn();
const createSession = vi.fn();

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    verifyPasskeyAuthentication: (...args: unknown[]) => verifyPasskeyAuthentication(...args),
    createSession: (...args: unknown[]) => createSession(...args),
  };
});

const passkeyCredentialFindUnique = vi.fn();
const passkeyCredentialUpdate = vi.fn();
const accountFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    passkeyCredential: {
      findUnique: (...args: unknown[]) => passkeyCredentialFindUnique(...args),
      update: (...args: unknown[]) => passkeyCredentialUpdate(...args),
    },
    account: {
      findUnique: (...args: unknown[]) => accountFindUnique(...args),
    },
  },
}));

const { POST } = await import('./route');

function verify(challengeId: string, redirect?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/authenticate/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response: {}, challengeId, ...(redirect ? { redirect } : {}) }),
  });
}

function primeCredential(accountId: string) {
  passkeyCredentialFindUnique.mockResolvedValue({
    id: 'cred-1',
    accountId,
    publicKey: Buffer.from('pk'),
    counter: BigInt(0),
  });
  passkeyCredentialUpdate.mockResolvedValue({});
  verifyPasskeyAuthentication.mockResolvedValue({ verified: true, newCounter: 1 });
  createSession.mockResolvedValue('session-token');
}

describe('POST /api/auth/passkey/authenticate/verify — teacher-signup destination for an existing account', () => {
  it('sends an account that already teaches to its schedule, not to a page it would be bounced from', async () => {
    primeCredential('acc-teacher');
    accountFindUnique.mockResolvedValue({ teacher: { deletedAt: null } });
    storeChallenge('authentication', 'chal-teacher', 'expected-challenge');

    const res = await POST(verify('chal-teacher', '/signup/profile'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    expect(body.data.redirectTo).toBe('/schedule');
  });

  it('still sends an account with no teacher profile to the profile form', async () => {
    primeCredential('acc-student');
    accountFindUnique.mockResolvedValue({ teacher: null });
    storeChallenge('authentication', 'chal-student', 'expected-challenge');

    const res = await POST(verify('chal-student', '/signup/profile'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    // The second-hat flow: a student becoming a teacher too. This is what a
    // guard written as `redirect === TEACHER_PROFILE_PATH ? fallback : redirect`
    // would destroy while the case above still passed.
    expect(body.data.redirectTo).toBe('/signup/profile');
  });
});
