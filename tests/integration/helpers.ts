/**
 * Shared fixture helpers for the integration suite.
 *
 * Deliberately narrow: this owns only the *mechanical* layer every file was
 * hand-rolling — the base URL, the session-token hashing contract, the cookie
 * header, and a collision-safe run suffix. Semantic fixtures (which class is
 * open, which payment is pending, what a teacher's rates are) stay in each
 * test file so a test's setup stays readable where it is used.
 *
 * That is why there is no `makeTeacherWithSession`-style wrapper: it would
 * need parameters for slug, bio, timezone, tier and claim state, growing with
 * every caller until the interesting values disappear behind a helper call.
 */

import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import type { PrismaClient } from '@prisma/client';

/** The app under test — the integration project runs against the dev server. */
export const BASE_URL = 'http://localhost:3000';

/** A session's default lifetime, matching what the app issues. */
const SESSION_TTL_MS = 86400000;

/**
 * Session rows are keyed by the sha256 hex of the raw token — mirrors
 * `hashToken` in `src/lib/auth/session.ts`. Tests store the hash and send the
 * raw token as the cookie.
 */
export function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

/** Header object authenticating a request as the owner of `token`. */
export function cookie(token: string): { Cookie: string } {
  return { Cookie: `fair_yoga_session=${token}` };
}

/**
 * Per-run suffix for unique columns (email, pageSlug). The random component is
 * load-bearing: two runs starting in the same millisecond against the shared
 * database would otherwise collide on a unique constraint (P2002).
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Creates a Session row for an existing account and returns the RAW token to
 * put in the cookie. The caller creates the Teacher/Student itself, so its
 * field values stay visible at the call site.
 *
 * Tests that need a non-default session (an already-expired one, say) should
 * keep creating the row inline rather than bending this helper.
 */
export async function createSession(db: PrismaClient, accountId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await db.session.create({
    data: { id: hashToken(token), accountId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}
