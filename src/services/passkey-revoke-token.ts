import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';

/** How long a passkey-added email's "This wasn't me" link works. */
export const PASSKEY_REVOKE_TOKEN_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mints the secret behind one passkey-added email's "This wasn't me" link and
 * returns it raw. Only its SHA-256 is stored, so a database read cannot be
 * turned into a link; the raw value exists in the returned string and the
 * email it goes into, nowhere else. `revokePasskeyByLink` looks it up by
 * `hashToken(raw)`.
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
