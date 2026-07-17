import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

export async function generateMagicLinkToken(
  db: PrismaClient,
  email: string,
  redirectTo?: string,
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + FIFTEEN_MINUTES_MS);

  await db.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      redirectTo: redirectTo ?? null,
      expiresAt,
    },
  });

  return rawToken;
}

export async function verifyMagicLinkToken(
  db: PrismaClient,
  token: string
): Promise<{ email: string; redirectTo: string | null } | null> {
  const tokenHash = hashToken(token);

  const record = await db.magicLinkToken.findUnique({
    where: { tokenHash },
  });

  if (!record) {
    return null;
  }

  // Atomic single-use: exactly one concurrent verification wins the delete;
  // any other sees count 0 and fails. (find-then-delete was a race.)
  const deleted = await db.magicLinkToken.deleteMany({ where: { id: record.id } });
  if (deleted.count === 0) {
    return null;
  }

  if (record.expiresAt <= new Date()) {
    return null;
  }

  return { email: record.email, redirectTo: record.redirectTo };
}

export async function cleanupExpiredTokens(
  db: PrismaClient
): Promise<number> {
  const result = await db.magicLinkToken.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });

  return result.count;
}
