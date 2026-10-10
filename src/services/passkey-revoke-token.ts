import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';

/** How long a passkey-added email's "This wasn't me" link works. */
export const PASSKEY_REVOKE_TOKEN_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mints the secret behind one passkey-added email's "This wasn't me" link and
 * returns it raw. Only its SHA-256 is stored, so a database read cannot be
 * turned into a link; the raw value is never persisted, only its hash is
 * stored. The stored row is found again by
 * `hashToken(raw)`, the unique `tokenHash`.
 */
export async function mintPasskeyRevokeToken(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.passkeyRevokeToken.create({
    data: {
      tokenHash: hashToken(raw),
      accountId: input.accountId,
      credentialId: input.credentialId,
      expiresAt: new Date(Date.now() + PASSKEY_REVOKE_TOKEN_TTL_DAYS * DAY_MS),
    },
  });
  return raw;
}
