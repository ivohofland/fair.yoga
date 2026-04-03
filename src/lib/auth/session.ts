import crypto from 'crypto';
import type { PrismaClient, RecipientType } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import type { SessionUser } from '../types';

export const SESSION_COOKIE_NAME = 'fair_yoga_session';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60; // 2592000

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

export async function createSession(
  db: PrismaClient,
  userId: string,
  userType: RecipientType
): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  const sessionHash = hashToken(token);
  const expiresAt = new Date(Date.now() + THIRTY_DAYS_MS);

  await db.session.create({
    data: {
      id: sessionHash,
      userId,
      userType,
      expiresAt,
    },
  });

  return token;
}

export async function validateSession(
  db: PrismaClient,
  token: string
): Promise<SessionUser | null> {
  const sessionHash = hashToken(token);

  const session = await db.session.findUnique({
    where: { id: sessionHash },
  });

  if (!session) {
    return null;
  }

  if (session.expiresAt <= new Date()) {
    await db.session.delete({ where: { id: sessionHash } }).catch(() => {});
    return null;
  }

  // Extend session if more than 15 days old
  const fifteenDaysAgo = new Date(Date.now() - FIFTEEN_DAYS_MS);
  if (session.createdAt < fifteenDaysAgo) {
    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() + THIRTY_DAYS_MS) },
    });
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    userType: session.userType,
  };
}

export async function invalidateSession(
  db: PrismaClient,
  token: string
): Promise<void> {
  const sessionHash = hashToken(token);
  await db.session.delete({
    where: { id: sessionHash },
  });
}

export function getSessionToken(request: Request): string | null {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(';').map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split('=');
    if (name === SESSION_COOKIE_NAME) {
      return valueParts.join('=') || null;
    }
  }

  return null;
}

export function setSessionCookie(headers: Headers, token: string): void {
  let cookie = `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${THIRTY_DAYS_SECONDS}`;
  if (process.env.NODE_ENV === 'production') {
    cookie += '; Secure';
  }
  headers.append('Set-Cookie', cookie);
}

export function clearSessionCookie(headers: Headers): void {
  let cookie = `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (process.env.NODE_ENV === 'production') {
    cookie += '; Secure';
  }
  headers.append('Set-Cookie', cookie);
}
