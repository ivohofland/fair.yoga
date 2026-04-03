import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import {
  SESSION_COOKIE_NAME,
  createSession,
  validateSession,
  invalidateSession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from './session';

const db = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

beforeAll(async () => {
  // Ensure DB is reachable
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

afterEach(async () => {
  // Clean up sessions created during tests
  await db.session.deleteMany();
});

describe('SESSION_COOKIE_NAME', () => {
  it('equals fair_yoga_session', () => {
    expect(SESSION_COOKIE_NAME).toBe('fair_yoga_session');
  });
});

describe('createSession', () => {
  it('creates a session in DB and returns a 64-char hex token', async () => {
    const token = await createSession(db, 'user-123', 'teacher');

    // Token should be 64 hex characters (32 bytes)
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Session should exist in DB under the hashed token
    const sessionHash = hashToken(token);
    const session = await db.session.findUnique({ where: { id: sessionHash } });
    expect(session).not.toBeNull();
    expect(session!.userId).toBe('user-123');
    expect(session!.userType).toBe('teacher');
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('stores a hash as the session ID, not the raw token', async () => {
    const token = await createSession(db, 'user-hash-check', 'teacher');

    // The raw token should NOT be found as a session ID
    const byRawToken = await db.session.findUnique({ where: { id: token } });
    expect(byRawToken).toBeNull();

    // The hashed token SHOULD be found
    const sessionHash = hashToken(token);
    const byHash = await db.session.findUnique({ where: { id: sessionHash } });
    expect(byHash).not.toBeNull();
  });
});

describe('validateSession', () => {
  it('returns SessionUser for a valid session', async () => {
    const token = await createSession(db, 'user-456', 'student');

    const result = await validateSession(db, token);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(hashToken(token));
    expect(result!.userId).toBe('user-456');
    expect(result!.userType).toBe('student');
  });

  it('returns null for an expired session and deletes it', async () => {
    const token = await createSession(db, 'user-789', 'teacher');
    const sessionHash = hashToken(token);

    // Manually expire the session
    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const result = await validateSession(db, token);
    expect(result).toBeNull();

    // Expired session should have been cleaned up
    const deleted = await db.session.findUnique({ where: { id: sessionHash } });
    expect(deleted).toBeNull();
  });

  it('returns null for a non-existent token', async () => {
    const result = await validateSession(db, 'nonexistent-token-value');
    expect(result).toBeNull();
  });

  it('extends session expiry when session is more than 15 days old', async () => {
    const token = await createSession(db, 'user-extend', 'teacher');
    const sessionHash = hashToken(token);

    // Set createdAt to 16 days ago
    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days from now
    await db.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const beforeValidate = Date.now();
    const result = await validateSession(db, token);
    expect(result).not.toBeNull();

    // Check that expiresAt was extended
    const session = await db.session.findUnique({ where: { id: sessionHash } });
    expect(session).not.toBeNull();
    // New expiry should be ~30 days from now, not the original 14
    const thirtyDaysFromNow = beforeValidate + 30 * 24 * 60 * 60 * 1000;
    expect(session!.expiresAt.getTime()).toBeGreaterThan(
      thirtyDaysFromNow - 5000
    );
  });

  it('does NOT extend session expiry when session is less than 15 days old', async () => {
    const token = await createSession(db, 'user-no-extend', 'student');
    const sessionHash = hashToken(token);

    // Session was just created (less than 15 days old)
    const session = await db.session.findUnique({ where: { id: sessionHash } });
    const originalExpiry = session!.expiresAt.getTime();

    await validateSession(db, token);

    const sessionAfter = await db.session.findUnique({ where: { id: sessionHash } });
    // Expiry should be unchanged
    expect(sessionAfter!.expiresAt.getTime()).toBe(originalExpiry);
  });
});

describe('invalidateSession', () => {
  it('deletes the session so subsequent validate returns null', async () => {
    const token = await createSession(db, 'user-del', 'teacher');

    // Validate first to confirm it exists
    const before = await validateSession(db, token);
    expect(before).not.toBeNull();

    await invalidateSession(db, token);

    const after = await validateSession(db, token);
    expect(after).toBeNull();
  });
});

describe('getSessionToken', () => {
  it('parses the session cookie from the Cookie header', () => {
    const request = new Request('http://localhost', {
      headers: {
        Cookie: 'fair_yoga_session=abc123; other=xyz',
      },
    });

    const token = getSessionToken(request);
    expect(token).toBe('abc123');
  });

  it('returns null when the session cookie is not present', () => {
    const request = new Request('http://localhost', {
      headers: {
        Cookie: 'other=xyz',
      },
    });

    const token = getSessionToken(request);
    expect(token).toBeNull();
  });

  it('returns null when there is no Cookie header', () => {
    const request = new Request('http://localhost');

    const token = getSessionToken(request);
    expect(token).toBeNull();
  });
});

describe('setSessionCookie', () => {
  it('sets a cookie with correct attributes', () => {
    const headers = new Headers();
    setSessionCookie(headers, 'my-token-value');

    const cookie = headers.get('Set-Cookie');
    expect(cookie).not.toBeNull();
    expect(cookie).toContain('fair_yoga_session=my-token-value');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });
});

describe('clearSessionCookie', () => {
  it('sets a cookie that expires immediately', () => {
    const headers = new Headers();
    clearSessionCookie(headers);

    const cookie = headers.get('Set-Cookie');
    expect(cookie).not.toBeNull();
    expect(cookie).toContain('fair_yoga_session=');
    expect(cookie).toContain('Max-Age=0');
  });
});
