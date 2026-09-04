# Signup Ticket vs Session Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the signup-ticket / session precedence rule one home, so the teacher and student signup families cannot diverge on it again — closing #428, settling #421, and restoring the "existing account becomes a teacher" flow.

**Architecture:** Extract the authorization half of both profile routes into `src/lib/auth/profile-authorization.ts` — two thin wrappers over shared helpers, one of which (`ticketTokenFrom`) is the entire rule as a pure function. Profile *creation* stays family-specific. Three satellite fixes ride along: the teacher signup destination, the passkey door's cookie hygiene, and making ticket cancellation visible.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma, Zod, Vitest (`unit` + `integration` projects), Postgres.

**Spec:** `docs/superpowers/specs/2026-09-04-signup-ticket-session-precedence-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no non-null assertions to paper over a union. Every step must leave `npm run typecheck` at exit 0.
- **Test-first.** Every task writes a failing test, runs it to *see* it fail, then implements. A test that has never been observed red has not been written.
- **Integration tests need the dev server** on `http://localhost:3000` with the test database. Start it detached; do not run it in the foreground. If a route 404s unexpectedly, wipe `.next` and restart.
- **Comment discipline (CLAUDE.md).** A comment annotates the code it sits on. No counts, no member lists, no facts about another module in a comment — those go in `docs/`. Where membership matters, tether it to the compiler.
- **Never edit an applied Prisma migration.** This plan adds no migration.
- **Commit messages** end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Branch:** `428-signup-ticket-session-precedence` (already checked out; the spec is committed on it).
- **Test commands:**
  - unit: `npx vitest run --project unit <path>`
  - integration: `npx vitest run --project integration <path>`
  - components: `npx vitest run --project components <path>`
  - everything: `npm run verify`

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/auth/profile-authorization.ts` | **New.** The precedence rule, the peek→parse→consume ordering, the session-path account lookup. Two exported wrappers. |
| `src/lib/auth/profile-authorization.test.ts` | **New.** Unit tests, real test DB (the `unit` project provides one). |
| `src/lib/auth/index.ts` | Re-export the new module. |
| `src/app/api/account/teacher-profile/route.ts` | Loses its hand-rolled authorization; keeps creation. |
| `src/app/api/account/student-profile/route.ts` | Same. |
| `src/app/(public)/signup/profile/page.tsx` | Identity precedence flips to session-first. |
| `src/app/api/auth/teacher-signup/route.ts` | Destination passed unconditionally. |
| `src/app/api/auth/passkey/authenticate/verify/route.ts` | Clears the ticket cookie. |
| `src/app/api/auth/magic-link/verify/route.ts`, `claim/route.ts` | Report `signupCancelled`. |
| `src/app/(public)/verify/page.tsx` | Renders the cancellation line. |
| `tests/integration/teacher-profile-precedence.test.ts` | **New.** The #428 coexistence cases. |
| `docs/technical-architecture.md` | The session-issuing-door census, with its re-derivation command. |

---

### Task 1: The shared resolver

**Files:**
- Create: `src/lib/auth/profile-authorization.ts`
- Create: `src/lib/auth/profile-authorization.test.ts`
- Modify: `src/lib/auth/index.ts`

**Interfaces:**
- Consumes: `peekSignupTicket`, `consumeSignupTicket`, `SIGNUP_TICKET_COOKIE`, `SignupFamily` (`./signup-ticket`); `SESSION_COOKIE_NAME` (`./session`); `requireSession`, `isErrorResponse`, `parseBody` (`@/lib/api-utils`); `SessionUser` (`@/lib/types`).
- Produces, for Tasks 2 and 4:
  - `ticketTokenFrom(request: NextRequest): string | undefined`
  - `resolveProfileAuthorization<TBody>(db, request, family, schema): Promise<ProfileAuthorizationOutcome<FormProfileAuthorization<TBody>>>`
  - `resolveTicketOnlyProfileAuthorization<TBody>(db, request, family, schema): Promise<ProfileAuthorizationOutcome<TicketFormProfileAuthorization<TBody>>>`
  - Types `FormProfileAuthorization<TBody>`, `TicketFormProfileAuthorization<TBody>`, `ProfileAuthorizationOutcome<TAuth>`.

- [ ] **Step 1: Write the failing test for the rule itself**

Create `src/lib/auth/profile-authorization.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from './signup-ticket';
import {
  ticketTokenFrom,
  resolveProfileAuthorization,
  resolveTicketOnlyProfileAuthorization,
} from './profile-authorization';
import { teacherProfileSchema, studentProfileSchema } from '@/lib/schemas';

const prisma = new PrismaClient();
const suffix = `pa-${Date.now()}`;

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

function req(cookies: string, body?: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/account/teacher-profile', {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('ticketTokenFrom — the precedence rule', () => {
  it('returns the ticket token when no session cookie is present', () => {
    expect(ticketTokenFrom(req('fair_yoga_signup=abc'))).toBe('abc');
  });

  it('returns undefined when a session cookie is present, however invalid', () => {
    // Presence, not validity: an unparseable session cookie must surface
    // `requireSession`'s own 401, never fall through to someone else's ticket.
    expect(ticketTokenFrom(req('fair_yoga_session=not-a-real-token; fair_yoga_signup=abc')))
      .toBeUndefined();
  });

  it('returns undefined when neither cookie is present', () => {
    expect(ticketTokenFrom(req(''))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/lib/auth/profile-authorization.test.ts`
Expected: FAIL — `Failed to resolve import "./profile-authorization"`.

- [ ] **Step 3: Create the module with the rule and the two helpers**

Create `src/lib/auth/profile-authorization.ts`:

```ts
import type { NextRequest, NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { requireSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import type { SessionUser } from '@/lib/types';
import { log } from '@/lib/log';
import { SESSION_COOKIE_NAME } from './session';
import {
  SIGNUP_TICKET_COOKIE,
  peekSignupTicket,
  consumeSignupTicket,
  type SignupFamily,
} from './signup-ticket';

/**
 * The precedence rule, and the only place it is spelled: a signup ticket is
 * readable only when the request carries no session cookie at all.
 *
 * PRESENCE, not validity. An unparseable or expired session cookie still
 * routes to the session path, so the caller meets `requireSession`'s own 401
 * rather than silently spending a ticket that is not theirs.
 *
 * Callers outside this module have no reason to reach for
 * `SIGNUP_TICKET_COOKIE` directly; every route that needs a ticket goes
 * through one of the two resolvers below, which apply this first.
 */
export function ticketTokenFrom(request: NextRequest): string | undefined {
  return request.cookies.get(SESSION_COOKIE_NAME)?.value
    ? undefined
    : request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
}

/** Both paths submit the same form (teacher). */
export type FormProfileAuthorization<TBody> =
  | { source: 'ticket'; email: string; body: TBody }
  | {
      source: 'session';
      email: string;
      session: SessionUser;
      staleTicketCookie: boolean;
      body: TBody;
    };

/** Only the ticket path submits a form; the session path posts nothing (student). */
export type TicketFormProfileAuthorization<TBody> =
  | { source: 'ticket'; email: string; body: TBody }
  | {
      source: 'session';
      email: string;
      session: SessionUser;
      staleTicketCookie: boolean;
    };

/**
 * `reason` is redundant to today's callers, which return `response` verbatim.
 * It is here so the two failures stay distinguishable to tests and to the
 * next refactor — a helper with more than one failure mode that reports only
 * a response has already collapsed them.
 */
export type ProfileAuthorizationOutcome<TAuth> =
  | { ok: true; auth: TAuth }
  | { ok: false; reason: 'invalid_body' | 'no_session'; response: NextResponse };

type TicketOutcome<TBody> =
  | { kind: 'authorized'; email: string; body: TBody }
  | { kind: 'invalid_body'; response: NextResponse }
  | { kind: 'fall_through' };

/**
 * Peek, then parse, then consume — the order is the whole point.
 *
 * Peek first so a stale cookie falls through to the session path instead of
 * failing a body parse the caller never needed. Parse before consuming so a
 * typo does not burn a single-use ticket. Take the address from the CONSUMED
 * value, never the peek: `consumeSignupTicket` is explicit that a profile
 * route must take the authorized email from nowhere else.
 */
async function ticketAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
  token: string,
): Promise<TicketOutcome<TBody>> {
  const peeked = await peekSignupTicket(db, token, family);
  if (!peeked) return { kind: 'fall_through' };

  const parsed = await parseBody(request, schema);
  if ('error' in parsed) return { kind: 'invalid_body', response: parsed.error };

  const email = await consumeSignupTicket(db, token, family);
  if (!email) {
    // The peek found a live, correct-family ticket moments ago and the
    // consume then lost it — a TTL boundary crossed, or a concurrent
    // double-submit spent it first. Benign, but otherwise indistinguishable
    // from a request that never carried a ticket.
    log.warn({ family }, 'profile authorization: ticket peeked live but did not consume');
    return { kind: 'fall_through' };
  }
  return { kind: 'authorized', email, body: parsed.data };
}

type SessionOutcome =
  | { ok: true; email: string; session: SessionUser }
  | { ok: false; reason: 'no_session'; response: NextResponse };

/**
 * `db` covers the account lookup only. `requireSession` reaches for
 * `api-utils`' own module-level client and takes no client argument — that
 * is its existing shape, not an oversight here, and both resolve the same
 * `DATABASE_URL`. Do not "fix" it by threading `db` through `requireSession`;
 * that widens this change into every route that calls it.
 */
async function sessionAuthorization(
  db: PrismaClient,
  request: NextRequest,
): Promise<SessionOutcome> {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return { ok: false, reason: 'no_session', response: session };
  const account = await db.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });
  return { ok: true, email: account.email, session };
}

/** For a family whose session path submits the same form as its ticket path. */
export async function resolveProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<FormProfileAuthorization<TBody>>> {
  const token = ticketTokenFrom(request);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    if (ticket.kind === 'invalid_body') {
      return { ok: false, reason: 'invalid_body', response: ticket.response };
    }
    if (ticket.kind === 'authorized') {
      return { ok: true, auth: { source: 'ticket', email: ticket.email, body: ticket.body } };
    }
  }

  const session = await sessionAuthorization(db, request);
  if (!session.ok) return session;

  const parsed = await parseBody(request, schema);
  if ('error' in parsed) return { ok: false, reason: 'invalid_body', response: parsed.error };

  return {
    ok: true,
    auth: {
      source: 'session',
      email: session.email,
      session: session.session,
      staleTicketCookie: request.cookies.get(SIGNUP_TICKET_COOKIE) !== undefined,
      body: parsed.data,
    },
  };
}

/** For a family whose session path submits no body at all. */
export async function resolveTicketOnlyProfileAuthorization<TBody>(
  db: PrismaClient,
  request: NextRequest,
  family: SignupFamily,
  schema: z.ZodType<TBody>,
): Promise<ProfileAuthorizationOutcome<TicketFormProfileAuthorization<TBody>>> {
  const token = ticketTokenFrom(request);
  if (token) {
    const ticket = await ticketAuthorization(db, request, family, schema, token);
    if (ticket.kind === 'invalid_body') {
      return { ok: false, reason: 'invalid_body', response: ticket.response };
    }
    if (ticket.kind === 'authorized') {
      return { ok: true, auth: { source: 'ticket', email: ticket.email, body: ticket.body } };
    }
  }

  const session = await sessionAuthorization(db, request);
  if (!session.ok) return session;

  return {
    ok: true,
    auth: {
      source: 'session',
      email: session.email,
      session: session.session,
      staleTicketCookie: request.cookies.get(SIGNUP_TICKET_COOKIE) !== undefined,
    },
  };
}
```

- [ ] **Step 4: Run the rule tests and see them pass**

Run: `npx vitest run --project unit src/lib/auth/profile-authorization.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the failing tests for the two resolvers**

Append to `src/lib/auth/profile-authorization.test.ts`:

```ts
const VALID_TEACHER_BODY = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  bio: '',
  pageSlug: 'ada-lovelace-plan-fixture',
};

describe('resolveProfileAuthorization — ticket path', () => {
  it('authorizes with the address from the ticket and returns the parsed body', async () => {
    const email = `resolver-ok-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.auth.source).toBe('ticket');
    expect(outcome.auth.email).toBe(email);
    if (outcome.auth.source !== 'ticket') return;
    expect(outcome.auth.body.firstName).toBe('Ada');
  });

  it('reports invalid_body and does NOT consume the ticket', async () => {
    const email = `resolver-badbody-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: '' }),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('invalid_body');

    // The whole reason parse precedes consume: a typo must not cost the ticket.
    const still = await prisma.magicLinkToken.findFirst({ where: { email } });
    expect(still).not.toBeNull();
  });

  it('reports no_session when the ticket is absent and nothing else authorizes', async () => {
    const outcome = await resolveProfileAuthorization(
      prisma,
      req('', VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');
    expect(outcome.response.status).toBe(401);
  });

  it('ignores a live ticket entirely when a session cookie is present', async () => {
    const email = `resolver-precedence-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveProfileAuthorization(
      prisma,
      req(`fair_yoga_session=bogus; fair_yoga_signup=${token}`, VALID_TEACHER_BODY),
      'teacher',
      teacherProfileSchema,
    );

    // Falls to the session path, which 401s on the bogus session cookie.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');

    // And the ticket is untouched — it was never anyone's to spend here.
    const still = await prisma.magicLinkToken.findFirst({ where: { email } });
    expect(still).not.toBeNull();
  });
});

describe('resolveTicketOnlyProfileAuthorization', () => {
  it('authorizes a ticket without requiring a session-path body', async () => {
    const email = `resolver-student-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'student');

    const outcome = await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: 'Bo', lastName: 'Peep' }),
      'student',
      studentProfileSchema,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.auth.source !== 'ticket') return;
    expect(outcome.auth.email).toBe(email);
  });

  it('discards a cross-family ticket rather than honouring it', async () => {
    const email = `resolver-crossfam-${suffix}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');

    const outcome = await resolveTicketOnlyProfileAuthorization(
      prisma,
      req(`fair_yoga_signup=${token}`, { firstName: 'Bo', lastName: 'Peep' }),
      'student',
      studentProfileSchema,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('no_session');
  });
});
```

- [ ] **Step 6: Run and confirm all pass**

Run: `npx vitest run --project unit src/lib/auth/profile-authorization.test.ts`
Expected: PASS, 8 tests.

Note the cross-family test passes because `peekSignupTicket` returns `null` for a mismatched purpose, so the resolver falls through *without* consuming. That is a deliberate improvement on `consumeSignupTicket`'s standalone behaviour (which consumes then discards); the peek now shields it.

- [ ] **Step 7: Export the module**

In `src/lib/auth/index.ts`, add after the `signup-ticket` line:

```ts
export * from './profile-authorization';
```

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/lib/auth/profile-authorization.ts src/lib/auth/profile-authorization.test.ts src/lib/auth/index.ts
git commit -m "feat(auth): one home for the signup-ticket vs session precedence rule

Extracts the authorization half both profile routes hand-roll: the rule
itself (\`ticketTokenFrom\` — a ticket is readable only when no session cookie
is present, by presence not validity), the peek-parse-consume ordering, and
the session-path account lookup.

Two wrappers because the families genuinely differ on whether the SESSION
path carries a body — teacher yes, student no. The rule and the ordering live
in the shared helpers; only the return shape forks, and the compiler checks
which wrapper each route picked.

Unused so far; the routes adopt it next.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: teacher-profile adopts the resolver (closes #428)

**Files:**
- Create: `tests/integration/teacher-profile-precedence.test.ts`
- Modify: `src/app/api/account/teacher-profile/route.ts:31-65`

**Interfaces:**
- Consumes: `resolveProfileAuthorization`, `FormProfileAuthorization` (Task 1).
- Produces: nothing new; the route's response contract is unchanged.

- [ ] **Step 1: Start the dev server if it is not already running**

```bash
(cd /Users/ivohofland/Projects/fair.yoga && npm run dev > /tmp/fairyoga-dev.log 2>&1 &)
```

Wait for `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/login` to answer `200`.

- [ ] **Step 2: Write the failing coexistence tests**

Create `tests/integration/teacher-profile-precedence.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  const accountIds = (
    await prisma.account.findMany({ where: { email: { contains: suffix } }, select: { id: true } })
  ).map((a) => a.id);
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  // Teacher before Account: Teacher.accountId has no cascade.
  await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

/** A signed-in account with a student profile and no teacher profile. */
async function seedStudentAccount(label: string) {
  const email = `${label}-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Signed',
      lastName: 'In',
      email,
      incomeTier: 3,
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  if (!student.accountId) throw new Error('fixture: student created without an account');
  const token = await seedSession(prisma, student.accountId);
  return { email, accountId: student.accountId, sessionToken: token };
}

function post(cookieHeader: string, body: unknown) {
  return fetch(`${BASE_URL}/api/account/teacher-profile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader, ...freshIp() },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/teacher-profile — a session always beats a ticket (#428)', () => {
  it('creates the teacher on the SIGNED-IN account, not the ticket address', async () => {
    const me = await seedStudentAccount('tp-precedence-session');
    const ticketEmail = `tp-precedence-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=${ticket}`,
      {
        firstName: 'Session',
        lastName: 'Wins',
        bio: '',
        pageSlug: `tp-precedence-${suffix}`,
      },
    );

    expect(res.status).toBe(201);

    // The teacher hangs off the caller's own account.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { email: me.email } });
    expect(teacher.accountId).toBe(me.accountId);

    // No second account was minted for the ticket's address.
    const ticketAccount = await prisma.account.findUnique({ where: { email: ticketEmail } });
    expect(ticketAccount).toBeNull();

    // And the caller's session was not replaced.
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
  });

  it('clears the stray ticket cookie it declined to honour', async () => {
    const me = await seedStudentAccount('tp-precedence-clear');
    const ticketEmail = `tp-precedence-clear-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=${me.sessionToken}; fair_yoga_signup=${ticket}`,
      { firstName: 'Clear', lastName: 'Cookie', bio: '', pageSlug: `tp-clear-${suffix}` },
    );

    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });

  it('401s on an INVALID session cookie rather than spending the ticket', async () => {
    const ticketEmail = `tp-precedence-invalid-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(
      `fair_yoga_session=not-a-real-session-token; fair_yoga_signup=${ticket}`,
      { firstName: 'No', lastName: 'Entry', bio: '', pageSlug: `tp-invalid-${suffix}` },
    );

    // Presence, not validity — the ticket is never reached.
    expect(res.status).toBe(401);

    const still = await prisma.magicLinkToken.findFirst({ where: { email: ticketEmail } });
    expect(still).not.toBeNull();
  });

  it('still honours a ticket when no session cookie is present at all', async () => {
    const ticketEmail = `tp-precedence-ticketonly-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, ticketEmail, 'teacher');

    const res = await post(`fair_yoga_signup=${ticket}`, {
      firstName: 'Ticket',
      lastName: 'Path',
      bio: '',
      pageSlug: `tp-ticketonly-${suffix}`,
    });

    expect(res.status).toBe(201);
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { email: ticketEmail } });
    expect(teacher.accountId).not.toBeNull();
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('fair_yoga_session=');
    expect(cookies).toContain('fair_yoga_signup=;');
  });
});
```

- [ ] **Step 3: Run and watch the first three fail**

Run: `npx vitest run --project integration tests/integration/teacher-profile-precedence.test.ts`
Expected: FAIL. Test 1 fails because the route honours the ticket — a `Teacher` is created for the ticket address and a new session cookie is set. Test 2 fails (no `fair_yoga_signup=;`). Test 3 fails with 201 instead of 401. Test 4 passes already.

**Record which assertion each failure hits** — that is the #428 reproduction, and Step 7's mutation check re-uses it.

- [ ] **Step 4: Replace the route's authorization block**

In `src/app/api/account/teacher-profile/route.ts`, replace everything from the `parseBody` call through the end of the `else` branch that builds `auth` (lines 31-65 at `4966475a`) with:

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  const outcome = await resolveProfileAuthorization(
    prisma,
    request,
    'teacher',
    teacherProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const auth = outcome.auth;
  const { firstName, lastName, bio, pageSlug, defaultTimezone } = auth.body;

  if (auth.source === 'session' && auth.session.teacherId) {
    return respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER');
  }
```

Update the imports: drop `SIGNUP_TICKET_COOKIE`, `consumeSignupTicket`, `requireSession`, `isErrorResponse`, `parseBody`; add `resolveProfileAuthorization`.

Then in the success response block, extend the existing ticket-source branch:

```ts
    const response = respondOk({ teacherId: teacher.id }, 201);
    if (auth.source === 'ticket') {
      const sessionToken = await createSession(prisma, teacher.accountId);
      setSessionCookie(response.headers, sessionToken);
      clearSignupTicketCookie(response.headers);
    } else if (auth.staleTicketCookie) {
      // Declined above, so it is dead weight on every later request this
      // browser makes. Cleared here rather than left to age out.
      clearSignupTicketCookie(response.headers);
    }
    return response;
```

The `accountId` the create needs on the session path is now `auth.session.accountId`; update the spread accordingly:

```ts
        ...(auth.source === 'session'
          ? { accountId: auth.session.accountId }
          : { account: { create: { email: auth.email } } }),
```

And `SLUG_TAKEN`'s re-mint keeps its guard unchanged (`auth.source === 'ticket'`), still using `auth.email`.

- [ ] **Step 5: Run the new tests and see them pass**

Run: `npx vitest run --project integration tests/integration/teacher-profile-precedence.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Run the pre-existing teacher suite unedited**

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts`
Expected: PASS.

One behaviour change to expect and accept: a caller with **no** ticket, **no** session and a malformed body now gets 401 rather than 400, because `requireSession` runs before the session-path parse. That matches `student-profile` and is the better order — an unauthenticated caller learns nothing about the schema. If a test asserts 400 for that shape, update it and say why in the commit.

- [ ] **Step 7: Mutation check — prove the new tests watch the guard**

Temporarily invert the rule in `src/lib/auth/profile-authorization.ts`:

```ts
// MUTATION — revert immediately after observing the result
export function ticketTokenFrom(request: NextRequest): string | undefined {
  return request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
}
```

Run: `npx vitest run --project integration tests/integration/teacher-profile-precedence.test.ts`
Expected: FAIL — tests 1, 2 and 3 go red.

**Revert the mutation** and re-run to confirm green. A guard whose test cannot fail is not a guard.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/account/teacher-profile/route.ts tests/integration/teacher-profile-precedence.test.ts
git commit -m "fix(auth): a session beats a ticket on teacher-profile (#428)

teacher-profile read and consumed the signup-ticket cookie before any session
check, so a signed-in browser carrying a live ticket for another address
created a second account for that address and replaced the caller's session.
student-profile was fixed for this in a817142a; this route was not.

Not fixed with a guard: the route now obtains its authorization from
\`resolveProfileAuthorization\`, which applies the rule before returning a
token at all, so the bad state has no expression here to guard against.

Also 401s an unauthenticated caller with a malformed body where it used to
400 — the session check now precedes the session-path parse, matching
student-profile, and an unauthenticated caller learns nothing about the
schema.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The profile page's precedence flips to match

**Files:**
- Modify: `src/app/(public)/signup/profile/page.tsx:37-52`
- Create: `src/app/(public)/signup/profile/page.test.tsx` (verified absent at `4966475a`)

**Interfaces:**
- Consumes: nothing from Task 1 — the page reads cookies via `next/headers`, not `NextRequest`. It restates the rule in the shape available to it, which is one branch.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/signup/profile/page.test.tsx` (it does not exist yet). It lands in the `components` project, whose `include` already covers `src/app/**/*.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();
const peekSignupTicket = vi.fn();
const cookieGet = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/auth', () => ({
  SIGNUP_TICKET_COOKIE: 'fair_yoga_signup',
  peekSignupTicket: (...args: unknown[]) => peekSignupTicket(...args),
}));
vi.mock('@/lib/db', () => ({
  prisma: { account: { findUniqueOrThrow: async () => ({ email: 'signed-in@test.local' }) } },
}));

beforeEach(() => {
  getSession.mockReset();
  peekSignupTicket.mockReset();
  cookieGet.mockReset();
});

describe('ProfileSetupPage identity precedence', () => {
  it('uses the SESSION, not the ticket, when the browser carries both', async () => {
    const { default: ProfileSetupPage } = await import('./page');
    getSession.mockResolvedValue({ sessionId: 's1', accountId: 'a1', teacherId: null, studentId: 'st1' });
    cookieGet.mockReturnValue({ value: 'a-live-ticket' });
    peekSignupTicket.mockResolvedValue('someone-else@test.local');

    const tree = await ProfileSetupPage();
    const json = JSON.stringify(tree);

    // The route ignores the ticket while a session cookie exists, so a
    // ticket-mode form here would render another address and 401 on submit.
    expect(json).toContain('signed-in@test.local');
    expect(json).not.toContain('someone-else@test.local');
    expect(json).toContain('"mode":"session"');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project components "src/app/(public)/signup/profile/page.test.tsx"`
Expected: FAIL — the rendered tree carries `someone-else@test.local` and `"mode":"ticket"`.

- [ ] **Step 3: Flip the precedence**

In `src/app/(public)/signup/profile/page.tsx`, replace the identity block (the comment beginning "The ticket wins where both exist" and the `if (ticketEmail)` chain) with:

```ts
  // Session first, matching `POST /api/account/teacher-profile`: that route
  // will not read a ticket cookie while a session cookie is present, so a
  // ticket-mode form for a signed-in visitor would prefill another address
  // and 401 on submit.
  let identity: { email: string; mode: 'ticket' | 'session' } | null = null;
  if (session) {
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    identity = { email: account.email, mode: 'session' };
  } else {
    const token = (await cookies()).get(SIGNUP_TICKET_COOKIE)?.value;
    const ticketEmail = token ? await peekSignupTicket(prisma, token, 'teacher') : null;
    if (ticketEmail) identity = { email: ticketEmail, mode: 'ticket' };
  }
```

Update the page's docblock: its TICKET bullet now reads "the ordinary new signup, reached only when no session cookie is present", and the SESSION bullet moves first.

- [ ] **Step 4: Run and see it pass**

Run: `npx vitest run --project components "src/app/(public)/signup/profile/page.test.tsx"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/signup/profile/page.tsx" "src/app/(public)/signup/profile/page.test.tsx"
git commit -m "fix(signup): the profile page resolves identity the way the route does

The page picked the ticket over the session and said so in a comment that
cited the route's own order as its justification. That order changed in the
previous commit, and leaving this would render a ticket-mode form prefilled
with the ticket's address for a signed-in visitor — a form that looks correct
and 401s on submit, because the route no longer reads that cookie.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: student-profile adopts the resolver

**Files:**
- Modify: `src/app/api/account/student-profile/route.ts:36-108`
- Test: `tests/integration/student-profile-ticket.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveTicketOnlyProfileAuthorization` (Task 1).
- Produces: nothing new.

This task must change no behaviour except adding the stale-cookie clear. Its risk is not a failing test; it is a silent drop.

- [ ] **Step 1: Add the one new assertion, as a failing test**

Append to `tests/integration/student-profile-ticket.test.ts`, inside the existing "stale ticket cookie must not block the session path" describe:

```ts
  it('clears the stray ticket cookie it declined to honour', async () => {
    const email = `profile-session-clear-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Clear',
        lastName: 'Cookie',
        email,
        bio: 'Fixture for the stale-cookie clear',
        pageSlug: `profile-session-clear-${suffix}`,
        account: { create: { email } },
      },
    });
    const rawSession = await seedSession(prisma, teacher.accountId);
    const otherEmail = `profile-session-clear-other-${suffix}@test.local`;
    const liveTicket = await mintSignupTicket(prisma, otherEmail, 'student');

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: {
        Cookie: `fair_yoga_session=${rawSession}; fair_yoga_signup=${liveTicket}`,
        ...freshIp(),
      },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project integration tests/integration/student-profile-ticket.test.ts`
Expected: FAIL on the new test only — no `fair_yoga_signup=;` in the response.

- [ ] **Step 3: Swap the authorization block**

In `src/app/api/account/student-profile/route.ts`, replace from the `ticketToken` assignment through the `auth = { source: 'session', … }` assignment with:

```ts
  const outcome = await resolveTicketOnlyProfileAuthorization(
    prisma,
    request,
    'student',
    studentProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const authorization = outcome.auth;

  let auth: Authorization;
  if (authorization.source === 'ticket') {
    auth = {
      source: 'ticket',
      email: authorization.email,
      firstName: authorization.body.firstName,
      lastName: authorization.body.lastName,
    };
  } else {
    const session = authorization.session;
    if (session.studentId) {
      return respondError('Account already has a student profile', 409, 'ALREADY_STUDENT');
    }
    if (!session.teacherId) {
      return respondError('Account has no profile to copy from', 409, 'NO_PROFILE_SOURCE');
    }
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { id: session.teacherId },
      select: { firstName: true, lastName: true },
    });

    // A teacher may already exist in someone's CRM as an unclaimed contact
    // under this email — claiming that row keeps their history instead of
    // colliding with its unique email.
    const unclaimed = await prisma.student.findFirst({
      where: { email: authorization.email, claimedAt: null },
      select: { id: true },
    });

    // Scalar accountId, not a relation connect: Prisma splits nested
    // connects into two statements, and the claim/link CHECK constraint
    // requires both fields to change in one.
    if (unclaimed) {
      const student = await prisma.student.update({
        where: { id: unclaimed.id },
        data: { claimedAt: new Date(), accountId: session.accountId },
        select: { id: true },
      });
      const claimed = respondOk({ studentId: student.id }, 201);
      if (authorization.staleTicketCookie) clearSignupTicketCookie(claimed.headers);
      return claimed;
    }

    auth = {
      source: 'session',
      accountId: session.accountId,
      email: authorization.email,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
    };
  }
```

Then extend the response block's ticket branch exactly as Task 2 did for teacher-profile:

```ts
    } else if (authorization.staleTicketCookie) {
      clearSignupTicketCookie(response.headers);
    }
```

Drop the now-unused imports: `SIGNUP_TICKET_COOKIE`, `SESSION_COOKIE_NAME`, `peekSignupTicket`, `consumeSignupTicket`, `requireSession`, `isErrorResponse`, `parseBody`.

**Keep, verbatim:** the `ACCOUNT_EXISTS` vs `ALREADY_STUDENT` split in the `email` catch with its `log.warn`; the `if (!student.accountId) throw` guard; the `P2002` → `log.error` + throw; the long comment above the `try` block.

- [ ] **Step 4: Run the whole student suite**

Run: `npx vitest run --project integration tests/integration/student-profile-ticket.test.ts tests/integration/student-signup-verify.test.ts`
Expected: PASS, including the new clear-cookie test.

- [ ] **Step 5: Mutation check — the siblings must still bite**

These tests now exercise shared code, which is exactly where a shared fixture starts making siblings pass for a new reason. Apply the same inversion as Task 2 Step 7 to `ticketTokenFrom` and run:

Run: `npx vitest run --project integration tests/integration/student-profile-ticket.test.ts`
Expected: FAIL — the coexistence tests go red.

**Revert the mutation** and re-run to confirm green.

- [ ] **Step 6: Read the removed hunks**

```bash
git diff -- src/app/api/account/student-profile/route.ts
```

Read the **removed** lines specifically for: the `ACCOUNT_EXISTS` branch and its `log.warn`; the `if (!student.accountId) throw`; the `NO_PROFILE_SOURCE` check. Every one of these must appear in the added lines too. This step is here because extraction has dropped exactly this kind of distinction in this repo before (PR #261), green the whole way.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/account/student-profile/route.ts tests/integration/student-profile-ticket.test.ts
git commit -m "refactor(auth): student-profile takes its authorization from the shared resolver

Behaviour-neutral except one addition: a ticket cookie the session path
declined is now cleared rather than left to age out, matching teacher-profile.

The two routes no longer each carry their own copy of the precedence rule,
the peek-parse-consume ordering and the session-path account lookup, which is
the property that produced #428 — this route was fixed for it in a817142a and
its sibling was not.

Kept deliberately, since an extraction is where these go missing: the
ticket-path ACCOUNT_EXISTS vs session-path ALREADY_STUDENT split with its log
line, the accountId null guard, and NO_PROFILE_SOURCE.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The teacher signup destination survives the round trip

**Files:**
- Modify: `src/app/api/auth/teacher-signup/route.ts:42`
- Test: `tests/integration/teacher-signup-api.test.ts` (extend)

**Interfaces:**
- Consumes: `TEACHER_PROFILE_PATH` from `@/lib/schemas`.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/teacher-signup-api.test.ts`, in the `POST /api/auth/teacher-signup` describe:

```ts
  it('sends an existing account to the teacher profile form, not to its role default', async () => {
    // A student who wants to teach types their address into "Start teaching".
    // The link they get is an ordinary sign_in link — correct, since the
    // signup marker is what lets verification create an account — but it must
    // still land them where they were going.
    const email = `teacher-signup-existing-${suffix}@test.local`;
    await prisma.student.create({
      data: {
        firstName: 'Already',
        lastName: 'Here',
        email,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email } },
      },
    });

    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);

    const token = await prisma.magicLinkToken.findFirstOrThrow({
      where: { email },
      orderBy: { createdAt: 'desc' },
    });
    expect(token.purpose).toBe('sign_in');
    expect(token.redirectTo).toBe('/signup/profile');
  });

  it('carries the same destination for an address with no account', async () => {
    const email = `teacher-signup-new-dest-${suffix}@test.local`;
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);

    const token = await prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
    expect(token.purpose).toBe('teacher_signup');
    // The tether for both signup routes: the destination a signup names does
    // not depend on whether the address already has an account. A conditional
    // on either side turns this red.
    expect(token.redirectTo).toBe('/signup/profile');
  });
```

Add `email` to this file's `afterAll` cleanup if its cleanup enumerates addresses rather than matching on `suffix`.

- [ ] **Step 2: Run and watch the first fail**

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts`
Expected: FAIL on the existing-account test — `token.redirectTo` is `null`.

- [ ] **Step 3: Pass the destination unconditionally**

In `src/app/api/auth/teacher-signup/route.ts`, import `TEACHER_PROFILE_PATH` alongside `teacherSignupSchema` from `@/lib/schemas`, and change the delivery call:

```ts
    await deliverSignInLink(prisma, email, nonce, {
      // Unconditional, as `student-signup` has always passed its own
      // destination: the purpose decides whether an account may be created,
      // the redirect decides where the person lands, and dropping the second
      // for addresses that already have an account discarded the whole intent
      // of "start teaching". `/signup/profile` sorts arrivals on its own — a
      // teacher is sent to `/schedule`, a student gets the profile form.
      redirectTo: TEACHER_PROFILE_PATH,
      purpose,
    });
```

- [ ] **Step 4: Run and see both pass**

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Drive the flow end to end in the browser**

Per `.claude/skills/verify/`. With the dev server running:
1. Seed or reuse a student-only account.
2. Visit `/signup`, sign out first, submit that address.
3. Take the link from the dev log, open it.
4. Confirm you land on `/signup/profile` with the form in session mode, prefilled with that address, and that submitting creates the teacher on the existing account.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/auth/teacher-signup/route.ts tests/integration/teacher-signup-api.test.ts
git commit -m "fix(signup): a student who starts the teacher signup arrives at the form

teacher-signup dropped its redirect for addresses that already have an
account, so someone with a student account who typed it into 'Start teaching
on fair.yoga' was signed in and dropped on /bookings — the intent discarded
with no message and no way onward. student-signup has always passed its
destination unconditionally.

The purpose still decides whether verification may create an account; the
redirect only decides where the person lands, and the two were conflated.

The second test is the tether: it asserts the destination is the same for an
address with an account and one without, so a future conditional on either
side turns it red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The passkey door clears the ticket cookie

**Files:**
- Modify: `src/app/api/auth/passkey/authenticate/verify/route.ts:63`
- Modify: `tests/e2e/passkey.spec.ts`

**Interfaces:**
- Consumes: `clearSignupTicketCookie` from `@/lib/auth`.
- Produces: nothing.

**Why the e2e tier, not integration.** `tests/integration/passkey-api.test.ts`
reaches only this route's validation 400s — completing an authentication needs
a real assertion from an authenticator, and the one place that exists is
`tests/e2e/passkey.spec.ts`'s CDP virtual authenticator. The assertion goes
where the successful path actually runs, rather than into a tier that cannot
reach it.

- [ ] **Step 1: Write the failing assertion**

In `tests/e2e/passkey.spec.ts`, add `BASE_URL` to the existing `../helpers`
import. Then find the third sign-in in the passkey journey test — the block
that begins `await context.clearCookies();` and goes to `/login`. Seed a
stray ticket cookie into it and assert it does not survive:

```ts
    // Same passkey from /login, which passes no redirect: the role default
    // applies and the student lands on their bookings.
    await context.clearCookies();
    // A stray ticket from a signup abandoned earlier in this browser. The
    // passkey door mints a session; nothing should carry the ticket past it.
    await context.addCookies([
      { name: 'fair_yoga_signup', value: 'stale-abandoned-ticket', url: BASE_URL },
    ]);
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL('**/bookings', { timeout: 10_000 });

    const strayAfterSignIn = (await context.cookies()).find((c) => c.name === 'fair_yoga_signup');
    expect(strayAfterSignIn?.value ?? '').toBe('');
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx playwright test tests/e2e/passkey.spec.ts`
Expected: FAIL — the stray cookie still holds `stale-abandoned-ticket` after
the passkey sign-in.

- [ ] **Step 3: Clear it**

In `src/app/api/auth/passkey/authenticate/verify/route.ts`, add `clearSignupTicketCookie` to the `@/lib/auth` import and, immediately after `setSessionCookie(apiResponse.headers, sessionToken);`:

```ts
  // A browser that just received a session has no legitimate reason to keep
  // carrying a ticket cookie forward — the same reason `magic-link/verify`
  // and `claim` clear it in their session-issuing branches.
  clearSignupTicketCookie(apiResponse.headers);
```

- [ ] **Step 4: Run and see it pass**

Run: `npx playwright test tests/e2e/passkey.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/passkey/authenticate/verify/route.ts tests/e2e/passkey.spec.ts
git commit -m "fix(auth): the passkey door clears a stray signup-ticket cookie too

The third session-issuing door, and the one neither #399 nor #428's
predecessor enumerated. Hygiene rather than a fix now that the profile routes
refuse to read a ticket while a session cookie exists, but a cookie nothing
will honour should not survive the sign-in that made it meaningless.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Cancellation becomes visible (#421)

**Files:**
- Modify: `src/lib/auth/signup-ticket.ts` (add `signupTicketIsLive`)
- Modify: `src/lib/auth/signup-ticket.test.ts`
- Modify: `src/app/api/auth/magic-link/verify/route.ts`, `src/app/api/auth/magic-link/claim/route.ts`
- Modify: `src/app/(public)/verify/page.tsx`, `src/app/(public)/verify/page.test.tsx`

**Interfaces:**
- Produces: `signupTicketIsLive(db: PrismaClient, token: string): Promise<boolean>`; `verify` and `claim` responses gain an optional `signupCancelled?: boolean`.

- [ ] **Step 1: Write the failing unit test for `signupTicketIsLive`**

Append to `src/lib/auth/signup-ticket.test.ts`:

```ts
describe('signupTicketIsLive', () => {
  it('is true for an unexpired ticket of either family', async () => {
    const email = `live-ticket-${Date.now()}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'teacher');
    expect(await signupTicketIsLive(prisma, token)).toBe(true);
    await prisma.magicLinkToken.deleteMany({ where: { email } });
  });

  it('is false for an expired ticket', async () => {
    const email = `dead-ticket-${Date.now()}@test.local`;
    const token = await mintSignupTicket(prisma, email, 'student');
    await prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await signupTicketIsLive(prisma, token)).toBe(false);
    await prisma.magicLinkToken.deleteMany({ where: { email } });
  });

  it('is false for a token that is not a signup ticket at all', async () => {
    // A sign-in link is not a pending signup; reporting one as cancelled
    // would tell the user we discarded something we never held.
    const email = `not-a-ticket-${Date.now()}@test.local`;
    const token = await generateMagicLinkToken(prisma, email, { purpose: 'sign_in' });
    expect(await signupTicketIsLive(prisma, token)).toBe(false);
    await prisma.magicLinkToken.deleteMany({ where: { email } });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run --project unit src/lib/auth/signup-ticket.test.ts`
Expected: FAIL — `signupTicketIsLive` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/lib/auth/signup-ticket.ts`:

```ts
/**
 * Whether a token names a live signup ticket of either family, without
 * consuming it or caring which family it belongs to.
 *
 * Cookie presence is not enough for the caller that uses this: a cookie
 * naming a long-dead token would report a pending signup as cancelled when
 * there was none to cancel.
 */
export async function signupTicketIsLive(
  db: PrismaClient,
  token: string,
): Promise<boolean> {
  const row = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { expiresAt: true, purpose: true },
  });
  if (!row) return false;
  const isTicket = (Object.values(TICKET_PURPOSE) as MagicLinkPurpose[]).includes(row.purpose);
  return isTicket && row.expiresAt > new Date();
}
```

`TICKET_PURPOSE` is the existing `satisfies Record<SignupFamily, MagicLinkPurpose>` map, so a third family's purpose joins this predicate by construction rather than by someone remembering to widen a literal union here.

- [ ] **Step 4: Run and see it pass**

Run: `npx vitest run --project unit src/lib/auth/signup-ticket.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test for the flag**

Append to `tests/integration/signup-api.test.ts`. It already drives
`magic-link/verify`, and its existing tests establish the origin-nonce shape
this one reuses (`:168-178` — a token minted with `originBrowserHash:
hashNonce(nonce)` and a request presenting `fair_yoga_origin=${nonce}`):

```ts
  it('reports the cancellation when signing in drops a live signup ticket', async () => {
    const signupEmail = `cancelled-signup-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, signupEmail, 'teacher');

    // A different address, which already has an account, signs in on the
    // same browser.
    const signInEmail = `cancels-it-${suffix}@test.local`;
    await prisma.student.create({
      data: {
        firstName: 'Signs', lastName: 'In', email: signInEmail, incomeTier: 3,
        claimedAt: new Date(), account: { create: { email: signInEmail } },
      },
    });

    const nonce = `cancel-notice-nonce-${suffix}`;
    const raw = await generateMagicLinkToken(prisma, signInEmail, {
      purpose: 'sign_in',
      originBrowserHash: hashNonce(nonce),
    });

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_origin=${nonce}; fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({ token: raw }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).signupCancelled).toBe(true);
  });

  it('does not claim a cancellation when the ticket cookie names a dead token', async () => {
    const signInEmail = `no-false-cancel-${suffix}@test.local`;
    await prisma.student.create({
      data: {
        firstName: 'No', lastName: 'Notice', email: signInEmail, incomeTier: 3,
        claimedAt: new Date(), account: { create: { email: signInEmail } },
      },
    });

    const nonce = `no-cancel-nonce-${suffix}`;
    const raw = await generateMagicLinkToken(prisma, signInEmail, {
      purpose: 'sign_in',
      originBrowserHash: hashNonce(nonce),
    });

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A cookie naming a token that no longer exists. Cookie presence
        // alone would report a signup cancelled that was never pending.
        Cookie: `fair_yoga_origin=${nonce}; fair_yoga_signup=long-gone-token`,
        ...freshIp(),
      },
      body: JSON.stringify({ token: raw }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).signupCancelled).toBe(false);
  });
```

Add `hashNonce`, `generateMagicLinkToken` and `mintSignupTicket` to this
file's imports if they are not already there.

- [ ] **Step 6: Run and watch it fail**

Run: `npx vitest run --project integration tests/integration/signup-api.test.ts`
Expected: FAIL — `signupCancelled` is `undefined`.

- [ ] **Step 7: Report it from both doors**

In `src/app/api/auth/magic-link/verify/route.ts`, in the session-issuing branch, before building the response:

```ts
  const strayTicket = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const signupCancelled = strayTicket ? await signupTicketIsLive(prisma, strayTicket) : false;
```

and include it in the payload:

```ts
  const response = respondOk({ accountId: resolved.accountId, redirectTo, signupCancelled });
```

Apply the identical change to `claim/route.ts`'s session-issuing branch. Both already call `clearSignupTicketCookie` there; this only reports what that clear discarded.

- [ ] **Step 8: Run and see it pass**

Run: `npx vitest run --project integration tests/integration/signup-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Render it on the verify page**

In `src/app/(public)/verify/page.tsx`, capture `signupCancelled` from the verify response alongside `redirectTo`, hold it in state, and render one `StatusLine` in the success state:

```tsx
{signupCancelled && (
  <StatusLine>
    Your pending signup was cancelled because you signed in. You can start it
    again from the signup page.
  </StatusLine>
)}
```

Add a component test asserting the line renders when the response carries the flag and does not when it is absent, following the mocking already used in `src/app/(public)/verify/page.test.tsx`.

- [ ] **Step 10: Run the component test and commit**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`
Expected: PASS.

```bash
git add src/lib/auth/signup-ticket.ts src/lib/auth/signup-ticket.test.ts \
  src/app/api/auth/magic-link/verify/route.ts src/app/api/auth/magic-link/claim/route.ts \
  "src/app/(public)/verify/page.tsx" "src/app/(public)/verify/page.test.tsx" \
  tests/integration/signup-api.test.ts
git commit -m "feat(auth): say so when signing in cancels a pending signup (#421)

Consuming a sign-in link purges every other token for the address, a pending
signup ticket included. That is the intended outcome — the person is signed
in, and can restart the signup — but it happened silently.

verify and claim now report it, established by \`signupTicketIsLive\` rather
than by cookie presence, so a long-dead cookie cannot claim a signup was
cancelled when none was pending. The verify page already holds that response
and renders a status, so the notice costs no new state.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Record the census and close the issues

**Files:**
- Modify: `docs/technical-architecture.md`
- Modify: `CLAUDE.md` (only if the Data Model or auth sections state something this branch falsified)

**Interfaces:** none.

- [ ] **Step 1: Re-derive the census**

```bash
grep -rn "setSessionCookie(" src/app src/lib | grep -v "\.test\."
```

- [ ] **Step 2: Record it where it has an owner**

Add to `docs/technical-architecture.md`, in or beside its auth section:

```markdown
### Session-issuing doors

Every site that mints a session cookie also clears the signup-ticket cookie:
a browser holding a session has no use for a ticket, and the profile routes
will not read one while a session cookie is present (`ticketTokenFrom`,
`src/lib/auth/profile-authorization.ts`).

Re-derive the roster with:

    grep -rn "setSessionCookie(" src/app src/lib | grep -v "\.test\."

Five at the time of writing: `magic-link/verify`, `magic-link/claim`,
`passkey/authenticate/verify`, and the ticket paths of `teacher-profile` and
`student-profile`.
```

This lives here rather than in a comment because a census reaching past its own file has no owner — the person who invalidates it never sees it.

- [ ] **Step 3: Full verification**

Run: `npm run verify`
Expected: typecheck, lint and the whole suite green. Fix anything red before proceeding — do not report completion on a partial run.

- [ ] **Step 4: Commit and open the PR**

```bash
git add docs/technical-architecture.md CLAUDE.md
git commit -m "docs: record the session-issuing door census where it has an owner

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push -u origin 428-signup-ticket-session-precedence
```

Open the PR with `gh pr create`. The body should state: closes #428; closes #421 as working-as-intended with the rationale from the spec; names the third, unfiled defect and that it is fixed here. End with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 5: Comment on #421 before it closes**

Its three options deserve an answer, not just a close. Post the reasoning: option 2 is inert because `verify` and `claim` already clear the ticket cookie when they mint a session, so preserving the row hands nothing back to the browser that would have to present it; option 3 is what shipped.

---

## Notes for the executor

- **The mutation checks in Tasks 2 and 4 are not optional.** They are the only evidence that the new tests observe the guard rather than merely passing beside it. Revert each mutation immediately after reading the result.
- **Task 4's Step 6 is a reading step with no command output to check.** Do it anyway. Extraction in this repo has shipped green while dropping an error branch and a type pin.
- **If a step's expected failure does not occur,** stop. A test that passes before its implementation exists is testing something other than what it claims.
