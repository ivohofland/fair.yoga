/**
 * Shared fixture helpers for the integration AND e2e suites.
 *
 * Owns the mechanical layer most files were hand-rolling: `BASE_URL`,
 * `hashToken`, `cookie(token)`, `sessionCookie(token)`, `uniqueSuffix()`, and
 * `seedSession(db, accountId)`. Semantic fixtures (which class is open, which
 * payment is pending, what a teacher's rates are) stay in each test file so a
 * test's setup stays readable where it is used.
 *
 * This module imports nothing from vitest and takes `PrismaClient` as a
 * parameter rather than constructing one — that's what makes it usable from
 * Playwright specs as-is, not just vitest's integration suite.
 *
 * Full rationale — including why there is no `makeTeacherWithSession`-style
 * wrapper — lives in `docs/technical-architecture.md`, "Testing conventions".
 */

import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import type { PrismaClient } from '@prisma/client';

/** The app under test — the dev server locally, the built app in CI. */
export const BASE_URL = 'http://localhost:3000';

/**
 * The keys `TeacherVisibleStudent` carries, sorted — #167's whole point, as a
 * wire assertion: `expect(Object.keys(student).sort()).toEqual(…)`.
 *
 * Pinning `displayName` and `email` is not enough. The realistic regression is
 * `student: { ...row.student, ...projectStudentForTeacher(row.student, teacherId) }`,
 * where both stay correct while raw `firstName`, `lastName`, `phone`,
 * `birthday`, `address` and the whole `studentPrivacy` array ship alongside
 * them — the surname the projection exists to truncate is then in the response
 * twice, and every value assertion still passes.
 *
 * Shared rather than per-file because the idiom stopped at the registrations
 * family the first time: the same spread applied to `services/payments.ts`
 * left payments-api 22/22 and unit 14/14 green. Every route that returns a
 * projected student should assert against this one list, so a new key on
 * `TeacherVisibleStudent` is one edit and a leaked raw field is caught
 * everywhere at once.
 */
export const PROJECTED_STUDENT_KEYS = [
  'address',
  'birthday',
  'claimedAt',
  'displayName',
  'email',
  'id',
  'phone',
];

/** Matches the production cookie name (src/lib/auth/session.ts) — the one
 *  fact `cookie()` and `sessionCookie()` must never drift apart on. */
const SESSION_COOKIE_NAME = 'fair_yoga_session';

/** A day — comfortably longer than any run. Deliberately not the app's own
 *  lifetime (30 days, src/lib/auth/session.ts); no test depends on the value. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Session rows are keyed by the sha256 hex of the raw token — mirrors
 * `hashToken` in `src/lib/auth/session.ts`, which is module-private (never
 * exported) and so cannot be imported here; this copy must be hand-kept in
 * sync with it. Tests store the hash and send the raw token as the cookie.
 */
export function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

/** Header object authenticating a request as the owner of `token` — for the
 *  integration suite's `fetch` calls. */
export function cookie(token: string): { Cookie: string } {
  return { Cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** Playwright-shaped counterpart to `cookie()` — for `context.addCookies([...])`. */
export function sessionCookie(token: string): { name: string; value: string; url: string } {
  return { name: SESSION_COOKIE_NAME, value: token, url: BASE_URL };
}

/**
 * Per-run suffix for unique columns (email, pageSlug). Within one run every
 * file already namespaces its fixtures with its own prefix, so the random
 * component only matters for *overlapping* runs against the shared database
 * — a watch-mode run left going plus a manual one — which would otherwise
 * collide on a unique constraint (P2002) if both started in the same
 * millisecond.
 */
export function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Seeds a Session row directly and returns the RAW token for the cookie.
 *
 * Deliberately NOT `@/lib/auth`'s `createSession`, despite the near-identical
 * signature: fixtures want a row they fully control, and tests that exercise
 * the real auth path (auth.test.ts, full-flow.test.ts) import the production
 * function instead. If fixtures depended on it, a regression there would fail
 * every file's setup instead of the two tests that name it.
 *
 * The caller creates the Teacher/Student itself, so its field values stay
 * visible at the call site. Tests that need a non-default session (an
 * already-expired one, say) don't bend this helper — `auth.test.ts` creates
 * one via the production `createSession`, then `prisma.session.update`s its
 * `expiresAt` into the past.
 */
export async function seedSession(db: PrismaClient, accountId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex');
  await db.session.create({
    data: { id: hashToken(token), accountId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}

/**
 * Polls `check` until it returns a truthy value, then returns it — for
 * asserting on a side effect the route under test deliberately does NOT
 * await before responding (e.g. `POST /api/students`' fire-and-forget
 * invitee notification, #166 task 8 F1). A fixed `await new Promise(...)`
 * sleep is either too short (flaky under load) or wastefully long on every
 * green run; this returns as soon as the condition is met and only pays the
 * full `timeoutMs` when it genuinely never happens — which is exactly the
 * failure this exists to surface as a clear timeout, naming what it was
 * waiting for via `description`, rather than a mystery missing row.
 *
 * Not for waiting on the ABSENCE of something directly: a negative can't be
 * proven by polling for it. Callers that need a provable absence (not just a
 * probable one) instead invite a second, CONTROL address known to produce
 * the side effect, `waitFor` the control's, and only then assert the first
 * is still absent — delivery is sequential from a single process, so once a
 * later-issued control's side effect is confirmed, an earlier one's would
 * have landed too, if it were ever going to
 * (`tests/integration/invitations-api.test.ts`'s blocked-address and
 * stranger tests, #166 task 8 F6).
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  {
    timeoutMs = 2000,
    intervalMs = 25,
    description,
  }: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) {
      const suffix = description ? ` (${description})` : '';
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms${suffix}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
