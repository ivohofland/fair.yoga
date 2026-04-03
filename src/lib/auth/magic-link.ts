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
  email: string
): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + FIFTEEN_MINUTES_MS);

  await db.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      expiresAt,
    },
  });

  return rawToken;
}

export async function verifyMagicLinkToken(
  db: PrismaClient,
  token: string
): Promise<{ email: string } | null> {
  const tokenHash = hashToken(token);

  const record = await db.magicLinkToken.findUnique({
    where: { tokenHash },
  });

  if (!record) {
    return null;
  }

  if (record.expiresAt <= new Date()) {
    // Expired — clean it up and return null
    await db.magicLinkToken.delete({ where: { id: record.id } });
    return null;
  }

  // One-time use: delete before returning
  await db.magicLinkToken.delete({ where: { id: record.id } });

  return { email: record.email };
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
