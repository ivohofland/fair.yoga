/**
 * Shared fixture helpers for the integration AND e2e suites.
 *
 * Owns the mechanical layer most files were hand-rolling: `BASE_URL`,
 * `hashToken`, `cookie(token)`, `sessionCookie(token)`, `uniqueSuffix()`,
 * `freshIp()`, and `seedSession(db, accountId)`. Semantic fixtures (which class
 * is open, which payment is pending, what a teacher's rates are) stay in each
 * test file so a test's setup stays readable where it is used.
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

/**
 * The app under test — the dev server locally, the built app in CI.
 *
 * `INTEGRATION_BASE_URL` overrides it for a worktree whose dev server holds
 * another port. `playwright.config.ts` reads the same variable for its
 * `baseURL` and `webServer.url`, because this module mints the session cookie
 * for whatever origin this constant names: point one side elsewhere and the
 * other half of the suite runs unauthenticated. Unset in CI, where the
 * fallback is byte-identical to what stood here before.
 */
export const BASE_URL = process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000';

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
 * A unique `x-forwarded-for` per call, so a request lands in a rate-limit
 * bucket nothing else has touched.
 *
 * Three routes throttle per IP — `POST /api/auth/magic-link/send` (10/15min),
 * `POST /api/auth/student-signup` (5/hour) and `POST /api/teachers` (3/hour) —
 * and `clientIp()` reads the first comma-separated entry of this header.
 * Before this helper the suite made 8 such calls, and *five of them* hit
 * `student-signup`'s 5/hour budget — exactly zero headroom, so one pass spent
 * it and the next 429'd. The suite could not be run twice in an hour and
 * therefore was never run whole. The aggregate was never the number that
 * mattered; one route's own budget was. The other two were roomy by comparison
 * (2 against `/api/teachers`' 3, 1 against `magic-link/send`'s 10).
 *
 * A fresh address *per request* — not per file — is what fixes that. No bucket
 * reaches a count of 2 except where a test deliberately reuses one address (the
 * per-IP budget test in `tests/integration/signup-api.test.ts`), so the limits
 * become unreachable rather than merely roomy: the suite now makes 14 of these
 * calls and could make many more for free. Per-file uniqueness would have left
 * signup-api's four calls sharing a bucket against a limit of 5 — the same
 * tripwire with a bigger number.
 *
 * A random 24-bit base picks the starting point somewhere in 10.0.0.0/8, and
 * the sequence walks forward from there by construction — not chance — so
 * distinctness is guaranteed *per module load*, not per process: vitest's
 * default `isolate: true` gives each test file its own module registry and so
 * its own `ipBase` (one file would have to make 16.7M calls to wrap). Between
 * files, and between overlapping runs, it stays probabilistic.
 *
 * The numbers, since they are easy to get wrong: `signup-api.test.ts` draws
 * ~100,008 addresses per module load, 100,000 of them inside the distinctness
 * guard. Two loads therefore overlap in *range* with probability
 * ≈ 2 × 100k / 16.7M ≈ 1e-2. That is almost entirely harmless — all but 7 of
 * those draws are pure computation and never reach the network — so the figure
 * that matters is two loads colliding on a *request-issuing* address, which is
 * ≈ 7² / 16.7M ≈ 3e-6. Far below the old 1/256, still probabilistic across
 * processes, same as before. 10.0.0.0/8 is private, so one of these in a log
 * is obviously synthetic.
 *
 * Callers that want several requests to share a bucket — the limiter's own
 * test — call this once and reuse the result.
 *
 * If you are temporarily mutating this function's body to prove a guard bites
 * (the `describe('freshIp', ...)` tests in
 * `tests/integration/signup-api.test.ts`), use an address this
 * function cannot emit — 203.0.113.0/24 (RFC 5737 TEST-NET-3) — never a
 * literal inside 10.0.0.0/8. A constant in this function's own range can land
 * on a real rate-limit bucket and poison it for up to an hour; that happened
 * once with `10.0.0.1`, and the collision surfaced later as a 429 in an
 * unrelated test run.
 */
const ipBase = crypto.randomInt(1 << 24);
let ipSeq = 0;

export function freshIp(): { 'x-forwarded-for': string } {
  const n = (ipBase + ipSeq++) % (1 << 24);
  return { 'x-forwarded-for': `10.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}` };
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
