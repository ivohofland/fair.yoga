import type { PrismaClient } from '@prisma/client';
import { validateSession } from '@/lib/auth/session';
import { isAdminHost } from '@/lib/admin-host';

/**
 * How recently an admin session must have signed in with a passkey, measured
 * from the session row's `createdAt` like `RECENT_AUTH_WINDOW_MS` — and
 * separate from it, which governs adding a passkey.
 */
export const ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000;

declare const adminProofBrand: unique symbol;

/**
 * Proof that a request passed the admin gate. Minted only by
 * `resolveAdminAccess` and frozen. Admin services take one as a parameter and
 * call `assertAdminProof`, which refuses anything this module did not mint —
 * a cast literal, a spread copy.
 */
export type AdminProof = {
  readonly accountId: string;
  readonly sessionId: string;
  readonly [adminProofBrand]: true;
};

const minted = new WeakSet<object>();

export type AdminAccess = { kind: 'not_found' } | { kind: 'sign_in' } | { kind: 'granted'; proof: AdminProof };

/**
 * The admin gate, in order: the admin host, a session, an active grant, a
 * passkey sign-in within `ADMIN_AUTH_WINDOW_MS`. A non-grantee can reach only
 * `not_found` or the no-session `sign_in`, so the answer never says whether an
 * account holds a grant. docs/technical-architecture.md (Admin surface).
 */
export async function resolveAdminAccess(
  db: PrismaClient,
  input: { host: string | null; sessionToken: string | null; now?: number },
): Promise<AdminAccess> {
  if (!isAdminHost(input.host)) return { kind: 'not_found' };
  if (!input.sessionToken) return { kind: 'sign_in' };

  const session = await validateSession(db, input.sessionToken);
  if (!session) return { kind: 'sign_in' };

  const grant = await db.adminGrant.findFirst({
    where: { accountId: session.accountId, revokedAt: null },
    select: { id: true },
  });
  if (!grant) return { kind: 'not_found' };

  const row = await db.session.findUnique({
    where: { id: session.sessionId },
    select: { passkeyCredentialId: true, createdAt: true },
  });
  const now = input.now ?? Date.now();
  if (!row || row.passkeyCredentialId === null || now - row.createdAt.getTime() >= ADMIN_AUTH_WINDOW_MS) {
    return { kind: 'sign_in' };
  }

  const proof = Object.freeze({ accountId: session.accountId, sessionId: session.sessionId }) as AdminProof;
  minted.add(proof);
  return { kind: 'granted', proof };
}

export function assertAdminProof(proof: AdminProof): void {
  if (!minted.has(proof)) throw new Error('AdminProof was not minted by resolveAdminAccess');
}
