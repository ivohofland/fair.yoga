# Student Signup Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /api/auth/student-signup` writes no rows; a `Student` and
`Account` are created only after the address is verified and the student
supplies a name on the booking page they return to.

**Architecture:** The teacher flow (#385) already mints a *ticket* — a
purpose-marked, single-use token in an HttpOnly cookie — at verification,
and spends it on a profile-creation route. This ports that machinery to
students, scoping the ticket per family so neither can act in the other, and
puts the name form on the booking page rather than on a dedicated screen.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/Postgres 16,
Zod, Vitest (projects: `unit`, `unit-sweeps`, `components`, `integration`),
Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-student-signup-verification-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types.
- Every task ends green: typecheck, lint, and the affected test projects pass.
  A task that changes a shared signature updates every caller in the same task.
- Schema changes go through `npx prisma migrate dev --name <description>`.
  Never `db push`, never hand-edit an applied migration (comments included).
- Comment discipline (CLAUDE.md): a comment annotates the code it sits on.
  No prose counts, no cross-file rosters, no correction history — that goes
  in the PR body.
- Stage exact paths. Never `git add -A` or `git add .`. Quote paths
  containing parentheses: `'src/app/(public)/…'`.
- Do not kill or restart the dev server on `:3000` — the `integration`
  project needs it live and it is the user's.
- The uniform `200` on `student-signup` is a non-enumeration contract. No
  change may make a response differ by whether the address has an account.

## Task order is load-bearing

Tasks 1-4 build the **receiving** end while `student-signup` still creates
rows the old way, so every intermediate commit leaves a working signup.
Task 5 flips the producer last. Reversing 5 with any of 2-4 leaves a state
where a new student can request a link that nothing downstream can honour.

---

### Task 1: Family-scoped signup tickets

Adds the two enum members and teaches the ticket helpers which family they
belong to. Behaviour for teachers is unchanged — every existing call site
passes `'teacher'`.

**Files:**
- Modify: `prisma/schema.prisma` (the `MagicLinkPurpose` enum, ~line 116)
- Create: `prisma/migrations/<generated>/migration.sql` (via the Prisma CLI)
- Modify: `src/lib/auth/signup-ticket.ts`
- Modify: `src/app/api/auth/magic-link/verify/route.ts` (the `mintSignupTicket` call)
- Modify: `src/app/api/account/teacher-profile/route.ts` (the `consumeSignupTicket` and `mintSignupTicket` calls)
- Modify: `src/app/(public)/signup/profile/page.tsx` (the `peekSignupTicket` call)
- Test: `src/lib/auth/signup-ticket.test.ts` (new)

**Interfaces:**
- Consumes: `generateMagicLinkToken`, `verifyMagicLinkToken`, `hashToken` from `./magic-link` (unchanged).
- Produces:
  - `export type SignupFamily = 'teacher' | 'student'`
  - `mintSignupTicket(db: PrismaClient, email: string, family: SignupFamily): Promise<string>`
  - `peekSignupTicket(db: PrismaClient, token: string, family: SignupFamily): Promise<string | null>`
  - `consumeSignupTicket(db: PrismaClient, token: string, family: SignupFamily): Promise<string | null>`
  - `SIGNUP_TICKET_COOKIE`, `setSignupTicketCookie`, `clearSignupTicketCookie` — unchanged.

- [ ] **Step 1: Add the enum members**

In `prisma/schema.prisma`, extend the enum:

```prisma
enum MagicLinkPurpose {
  sign_in
  teacher_signup
  teacher_profile_pending
  student_signup
  student_profile_pending
}
```

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name student_signup_purposes`

Expected: a new directory under `prisma/migrations/` whose `migration.sql`
contains two `ALTER TYPE "MagicLinkPurpose" ADD VALUE …` statements. Do not
hand-edit it. Postgres 16 allows `ADD VALUE` inside a transaction as long as
the value is not used in the same transaction, which it is not here.

- [ ] **Step 3: Write the failing test**

Create `src/lib/auth/signup-ticket.test.ts`. This file goes in the `unit`
project (parallel, real test database) — it does not sweep, so it must NOT
be added to `SERIAL_TESTS` in `vitest.config.ts`.

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket, peekSignupTicket, consumeSignupTicket } from './signup-ticket';

const db = new PrismaClient();
const email = 'ticket-family@example.com';

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

afterEach(async () => {
  await db.magicLinkToken.deleteMany({ where: { email: { endsWith: '@example.com' } } });
});

describe('signup ticket families', () => {
  it('peeks a ticket under its own family and refuses it under the other', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    expect(await peekSignupTicket(db, token, 'teacher')).toBeNull();
    expect(await peekSignupTicket(db, token, 'student')).toBe(email);
  });

  it('consumes a ticket under its own family', async () => {
    const token = await mintSignupTicket(db, email, 'teacher');
    expect(await consumeSignupTicket(db, token, 'teacher')).toBe(email);
    // Single-use: the row is gone, so a second attempt finds nothing.
    expect(await consumeSignupTicket(db, token, 'teacher')).toBeNull();
  });

  it('refuses a cross-family ticket at consume, and spends it doing so', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    expect(await consumeSignupTicket(db, token, 'teacher')).toBeNull();
    // `verifyMagicLinkToken` deletes before there is a purpose to compare,
    // so the wrong-family attempt destroys the ticket. Asserted rather than
    // merely noted: it is the behaviour a future "check first" refactor
    // would change, and that refactor would reopen the double-submit race
    // the atomic delete closes.
    expect(await peekSignupTicket(db, token, 'student')).toBeNull();
  });

  it('refuses a ticket whose row has expired', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    await db.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await peekSignupTicket(db, token, 'student')).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/signup-ticket.test.ts`

Expected: FAIL — `mintSignupTicket` takes two arguments, so TypeScript
rejects the three-argument calls.

- [ ] **Step 5: Add the family parameter**

In `src/lib/auth/signup-ticket.ts`, add the type and the compiler-tethered
purpose map above `mintSignupTicket`, and thread `family` through all three
functions:

```ts
import type { MagicLinkPurpose, PrismaClient } from '@prisma/client';

/** Which signup a ticket belongs to. The two families' tickets are
 *  interchangeable in shape and must not be interchangeable in effect: a
 *  ticket minted because someone clicked a link to book a class must not be
 *  able to create a public teacher page. */
export type SignupFamily = 'teacher' | 'student';

/** `satisfies` rather than a bare object: a third family cannot be added
 *  without a purpose for it. */
const TICKET_PURPOSE = {
  teacher: 'teacher_profile_pending',
  student: 'student_profile_pending',
} as const satisfies Record<SignupFamily, MagicLinkPurpose>;
```

`mintSignupTicket` passes `purpose: TICKET_PURPOSE[family]`. `peek` compares
`row.purpose !== TICKET_PURPOSE[family]`. `consume` compares
`result.purpose !== TICKET_PURPOSE[family]` and keeps its existing
`log.warn`, which now has a reachable case.

Update the `TICKET_TTL_MS` docblock: its justification ("no other flow asks
someone to type four fields while a token ages") describes the teacher form
only. State what is true now — the hour covers both, and the student form is
two fields, so it is generous there rather than load-bearing.

Update `consumeSignupTicket`'s docblock: the `log.warn` case is no longer
"unreachable through the normal signup flow" — a cross-family ticket reaches
it. State what is true now; the before-and-after belongs in the PR body.

- [ ] **Step 6: Update the three existing call sites**

Each passes `'teacher'`:

- `src/app/api/auth/magic-link/verify/route.ts` — `mintSignupTicket(prisma, email, 'teacher')`
- `src/app/api/account/teacher-profile/route.ts` — `consumeSignupTicket(prisma, ticketToken, 'teacher')` and, in the `SLUG_TAKEN` branch, `mintSignupTicket(prisma, auth.email, 'teacher')`
- `src/app/(public)/signup/profile/page.tsx` — `peekSignupTicket(prisma, token, 'teacher')`

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/auth/signup-ticket.test.ts`
Expected: PASS, 4 tests.

Run: `npx tsc --noEmit`
Expected: no errors — this proves no call site was missed.

- [ ] **Step 8: Prove the family guard bites**

Temporarily change `TICKET_PURPOSE.student` to `'teacher_profile_pending'`
(making both families share a purpose). Re-run the test file. Record the
exact failure text in the task report. Restore the correct value and re-run
to confirm green. A guard that cannot fail certifies nothing.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/auth/signup-ticket.ts src/lib/auth/signup-ticket.test.ts \
  src/app/api/auth/magic-link/verify/route.ts src/app/api/account/teacher-profile/route.ts \
  'src/app/(public)/signup/profile/page.tsx'
git commit -m "feat(auth): scope signup tickets to a family (#399)"
```

---

### Task 2: Verification mints a student ticket

Teaches `magic-link/verify` to answer a `student_signup` token with a ticket
and the booking redirect, and fixes the verify screen's teacher-only copy.
Nothing mints `student_signup` tokens yet, so this task's tests seed them
directly.

**Files:**
- Modify: `src/app/api/auth/magic-link/verify/route.ts:40-46`
- Modify: `src/app/(public)/verify/page.tsx:112-141`
- Test: `tests/integration/student-signup-verify.test.ts` (new)
- Test: `src/app/(public)/verify/page.test.tsx` (extend)

**Interfaces:**
- Consumes: `mintSignupTicket(db, email, family)` from Task 1.
- Produces: for a `student_signup` token with no account and a safe stored
  redirect, `POST /api/auth/magic-link/verify` answers `200` with
  `{ data: { redirectTo: <the stored redirect> } }`, **no `accountId`**, a
  `fair_yoga_signup` cookie, and a cleared origin nonce.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/student-signup-verify.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hashNonce } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp, hashToken } from '../helpers';
import crypto from 'crypto';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const freshEmail = `student-verify-fresh-${suffix}@test.local`;
const crmEmail = `student-verify-crm-${suffix}@test.local`;
const REDIRECT = '/some-teacher/book/some-class-id';

let crmStudentId: string;

/** A `student_signup` token bound to `nonce`, minted the way
 *  `POST /api/auth/student-signup` will mint one in Task 5. Seeded here
 *  because the route hashes the raw token and persists nothing else, so a
 *  token minted through the UI cannot be recovered. */
async function seedSignupToken(email: string, nonce: string, redirectTo: string | null) {
  const raw = crypto.randomBytes(32).toString('hex');
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashToken(raw),
      email,
      purpose: 'student_signup',
      redirectTo,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: hashNonce(nonce),
    },
  });
  return raw;
}

beforeAll(async () => {
  await prisma.$connect();
  const crm = await prisma.student.create({
    data: { firstName: 'CRM', lastName: 'Contact', email: crmEmail },
  });
  crmStudentId = crm.id;
});

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.session.deleteMany({ where: { account: { email: { contains: suffix } } } });
  await prisma.student.deleteMany({ where: { id: crmStudentId } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

async function verify(token: string, nonce: string) {
  return fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_origin=${nonce}`,
      ...freshIp(),
    },
    body: JSON.stringify({ token }),
  });
}

describe('POST /api/auth/magic-link/verify — student_signup tokens', () => {
  it('hands back a ticket and the booking redirect, with no session', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(freshEmail, nonce, REDIRECT);

    const res = await verify(token, nonce);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.redirectTo).toBe(REDIRECT);
    // No session: the client reads the absence of accountId as "not signed in".
    expect(body.data.accountId).toBeUndefined();
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_signup=');

    // The invariant: verification alone still creates nothing.
    expect(await prisma.student.findUnique({ where: { email: freshEmail } })).toBeNull();
    expect(await prisma.account.findUnique({ where: { email: freshEmail } })).toBeNull();
  });

  it('refuses a token whose redirect is absent rather than minting a homeless ticket', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(`student-verify-noredir-${suffix}@test.local`, nonce, null);

    const res = await verify(token, nonce);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');
  });

  it('refuses a token whose redirect is absolute rather than minting a homeless ticket', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(
      `student-verify-abs-${suffix}@test.local`,
      nonce,
      'https://evil.example/steal',
    );

    const res = await verify(token, nonce);
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');
  });

  it('claims an unclaimed CRM row and signs in instead, keeping the contact name', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await seedSignupToken(crmEmail, nonce, REDIRECT);

    const res = await verify(token, nonce);
    expect(res.status).toBe(200);
    const body = await res.json();
    // A session, not a ticket: resolveOrClaimAccount claimed the row.
    expect(body.data.accountId).toBeTruthy();
    expect(body.data.redirectTo).toBe(REDIRECT);
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_signup=');

    const claimed = await prisma.student.findUniqueOrThrow({ where: { id: crmStudentId } });
    expect(claimed.firstName).toBe('CRM');
    expect(claimed.claimedAt).not.toBeNull();
  });
});
```

`hashNonce` takes a plain `string` (`src/lib/auth/origin-nonce.ts`) and
delegates to `hashToken`, so no cast is needed and `hashToken` from
`../helpers` would work equally — `tests/e2e/teacher-signup.spec.ts` uses
that spelling. Either is fine; do not introduce a cast.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/integration/student-signup-verify.test.ts`

Expected: FAIL — the first case gets `400 Invalid or expired magic link`
(actually `Account not found`), because `verify` has no `student_signup`
branch.

- [ ] **Step 3: Add the branch to the verify route**

Replace the existing `teacher_signup` block in
`src/app/api/auth/magic-link/verify/route.ts` with a destination-first form:

```ts
// Destination first, mint second. The teacher ticket has a page that always
// exists; the student ticket's home is a redirect the caller supplied, so
// "mint a ticket" and "have somewhere to spend it" are two facts that can
// come apart. Computing the destination before minting means a token whose
// redirect is missing or unsafe falls through to the 400 below rather than
// producing a credential with no page to spend it on.
const signupTicket =
  purpose === 'teacher_signup'
    ? { family: 'teacher' as const, dest: '/signup/profile' }
    : purpose === 'student_signup' && tokenRedirect && isSafeRelativePath(tokenRedirect)
      ? { family: 'student' as const, dest: tokenRedirect }
      : null;

// A signup token whose address still has no account: hand back a ticket,
// NOT a session. `validateSession` deletes any session whose account has no
// live profile, and `SessionUser` cannot represent one — so the account is
// created later, together with the profile.
if (!resolved && signupTicket) {
  const ticket = await mintSignupTicket(prisma, email, signupTicket.family);
  const response = respondOk({ redirectTo: signupTicket.dest });
  setSignupTicketCookie(response.headers, ticket);
  clearOriginNonceCookie(response.headers);
  return response;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/student-signup-verify.test.ts`
Expected: PASS, 4 tests.

Then confirm the teacher path is untouched:
Run: `npx vitest run --project integration tests/integration/signup-api.test.ts`
Expected: PASS (unchanged at this point in the branch).

- [ ] **Step 5: Fix the verify screen's headline**

In `src/app/(public)/verify/page.tsx`, add a headline function beside
`destinationCopy`, keyed on the same value:

```ts
/** The signup branch of `verify/route.ts` serves both families, and they are
 *  going to different places. Keyed on the destination, like
 *  `destinationCopy` above, so the two lines cannot disagree. */
function newSignupHeadline(dest: string): string {
  return dest === '/signup/profile' ? "Let's set up your page." : "Let's finish your booking.";
}
```

In `SuccessState`, replace the literal `"Let's set up your page."` with
`newSignupHeadline(dest)`. Update the `SuccessState` docblock's
`isNewSignup` paragraph: it names `teacher_signup` as the one purpose that
hands back a ticket. State what is true now — both signup purposes do.

- [ ] **Step 6: Extend the verify page component test**

In `src/app/(public)/verify/page.test.tsx`, add a case asserting the success
state for a booking destination renders "Let's finish your booking." and not
"Let's set up your page." Follow the file's existing rendering and fetch-stub
pattern.

- [ ] **Step 7: Run the component tests**

Run: `npx vitest run --project components 'src/app/(public)/verify/page.test.tsx'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/auth/magic-link/verify/route.ts 'src/app/(public)/verify/page.tsx' \
  'src/app/(public)/verify/page.test.tsx' tests/integration/student-signup-verify.test.ts
git commit -m "feat(auth): answer a student_signup token with a ticket and the booking redirect (#399)"
```

---

### Task 3: `student-profile` accepts a ticket

Gives the profile route a second authorization, mirroring `teacher-profile`.
The session path is unchanged.

**Files:**
- Modify: `src/lib/schemas.ts` (add `studentProfileSchema`)
- Modify: `src/app/api/account/student-profile/route.ts`
- Test: `tests/integration/student-profile-ticket.test.ts` (new)

**Interfaces:**
- Consumes: `SIGNUP_TICKET_COOKIE`, `consumeSignupTicket(db, token, 'student')`,
  `clearSignupTicketCookie`, `createSession`, `setSessionCookie` from `@/lib/auth`.
- Produces: `POST /api/account/student-profile` with a live student ticket
  and body `{ firstName, lastName }` answers `201`
  `{ data: { studentId } }`, sets a session cookie and clears the ticket
  cookie. Without a ticket it behaves exactly as before.

- [ ] **Step 1: Add the body schema**

In `src/lib/schemas.ts`, beside `teacherProfileSchema`:

```ts
export const studentProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
}).strict();
```

Required, not optional: it is parsed only on the ticket path, which is the
only path that has a body.

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/student-profile-ticket.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket } from '@/lib/auth';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.session.deleteMany({ where: { account: { email: { contains: suffix } } } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

function post(ticket: string | null, body: unknown) {
  return fetch(`${BASE_URL}/api/account/student-profile`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ticket ? { Cookie: `fair_yoga_signup=${ticket}` } : {}),
      ...freshIp(),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/account/student-profile — ticket authorization', () => {
  it('creates the student and account, claimed and with no tier chosen yet', async () => {
    const email = `profile-ticket-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    const res = await post(ticket, { firstName: 'Anna', lastName: 'Smith' });
    expect(res.status).toBe(201);
    const cookies = res.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('fair_yoga_session=');
    // The spent ticket is cleared, not left naming a dead token.
    expect(cookies).toContain('fair_yoga_signup=;');

    const student = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(student.firstName).toBe('Anna');
    expect(student.lastName).toBe('Smith');
    expect(student.accountId).not.toBeNull();

    // The two census columns. `claimedAt` null would drop this student into
    // `bypassesPrivacy`, handing their teacher every field they never shared.
    expect(student.claimedAt).not.toBeNull();
    // A stamped `tierSelectedAt` would suppress the tier picker forever, so
    // they would be billed at the default without ever having chosen.
    expect(student.tierSelectedAt).toBeNull();
    expect(student.incomeTier).toBe(3);
  });

  it('takes the address from the ticket, never from the body', async () => {
    const email = `profile-ticket-addr-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    // A body key the strict schema does not know is refused outright.
    const res = await post(ticket, {
      firstName: 'Mallory',
      lastName: 'Body',
      email: `profile-ticket-evil-${suffix}@test.local`,
    });
    expect(res.status).toBe(400);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });

  it('rejects a malformed body without spending the ticket', async () => {
    const email = `profile-ticket-retry-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');

    expect((await post(ticket, { firstName: '', lastName: '' })).status).toBe(400);

    // The same ticket still works: a typo must not cost a single-use ticket.
    const ok = await post(ticket, { firstName: 'Second', lastName: 'Try' });
    expect(ok.status).toBe(201);
    await prisma.student.findUniqueOrThrow({ where: { email } });
  });

  it('refuses a teacher-family ticket', async () => {
    const email = `profile-ticket-wrongfam-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'teacher');

    // No ticket the student route accepts, and no session either.
    const res = await post(ticket, { firstName: 'Wrong', lastName: 'Family' });
    expect(res.status).toBe(401);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses an expired ticket', async () => {
    const email = `profile-ticket-expired-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');
    await prisma.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await post(ticket, { firstName: 'Too', lastName: 'Late' });
    expect(res.status).toBe(401);
    expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/integration/student-profile-ticket.test.ts`

Expected: FAIL — every case gets `401` (the route requires a session), and
the first case's `201` assertion fails.

- [ ] **Step 4: Add the ticket authorization**

In `src/app/api/account/student-profile/route.ts`, before `requireSession`:

```ts
const ticketToken = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;

// The cookie is READ here, not consumed, so the body is still validated
// before a single-use ticket is spent — `teacher-profile`'s ordering, for
// its reason: losing a ticket to a typo is a bad first interaction.
// Conditional because the session path has no body at all: `JoinAsStudent`
// POSTs without one, and `parseBody` opens with `request.json()`, which
// throws on an empty body.
let names: { firstName: string; lastName: string } | null = null;
if (ticketToken) {
  const parsed = await parseBody(request, studentProfileSchema);
  if ('error' in parsed) return parsed.error;
  names = parsed.data;
}

const ticketEmail = ticketToken
  ? await consumeSignupTicket(prisma, ticketToken, 'student')
  : null;
```

Then the discriminated union, mirroring `teacher-profile`:

```ts
type Authorization =
  | { source: 'ticket'; email: string; firstName: string; lastName: string }
  | { source: 'session'; accountId: string; email: string; firstName: string; lastName: string };
```

Under `ticket` (`ticketEmail && names`), the names come from the body and the
account is created alongside the student
(`account: { create: { email: auth.email } }`). Under `session`, keep every
existing check — `ALREADY_STUDENT`, `NO_PROFILE_SOURCE`, the unclaimed-row
claim — and keep copying the names off the `Teacher`.

The `create` sets exactly `firstName`, `lastName`, `email`,
`incomeTier: DEFAULT_INCOME_TIER`, `claimedAt: new Date()`, and the account
link. Nothing else — `tierSelectedAt` stays unset so the tier picker fires
on the first booking.

On a ticket-authorized `201`, mint a session, set the session cookie, and
clear the ticket cookie. Keep the existing two-key P2002 handling for both
paths.

Update the route's header docblock: it currently says profile attachment
happens "only here — from an authenticated session, never from an
unauthenticated signup route", which stops being the whole truth. State the
two authorizations, as `teacher-profile`'s docblock does.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/student-profile-ticket.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify the session path is untouched**

Run: `npx vitest run --project integration`
Expected: PASS — in particular whatever currently covers `JoinAsStudent`'s
body-less POST. If no integration case covers it, exercise it by hand
against `:3000` with a session cookie and no body, and record that the
response is not `400 Invalid JSON`.

- [ ] **Step 7: Prove the census assertions bite**

One at a time, apply each mutation, re-run
`tests/integration/student-profile-ticket.test.ts`, record the exact failure
text, and restore:

1. Drop `claimedAt: new Date()` from the ticket-path create. Expected: the
   request fails before the assertion — this create sets `accountId`, so
   `Student_claim_link_check` (`CHECK (("claimedAt" IS NULL) = ("accountId"
   IS NULL))`) rejects the insert and the route answers 500. Record that
   text. The assertion is kept anyway: it pins the intent, and the
   constraint only bites because this create happens to write `accountId`.
2. Add `tierSelectedAt: new Date()` to the ticket-path create. Expected: the
   `tierSelectedAt` assertion fails.
3. Move the `parseBody` call after `consumeSignupTicket`. Expected: the
   "rejects a malformed body without spending the ticket" retry fails.

Warm the route first (one request after each mutation) before judging a
failure — `next dev` recompiles lazily and a first-request timeout reads
exactly like an assertion failure.

- [ ] **Step 8: Commit**

```bash
git add src/lib/schemas.ts src/app/api/account/student-profile/route.ts \
  tests/integration/student-profile-ticket.test.ts
git commit -m "feat(auth): let a student ticket authorize profile creation (#399)"
```

---

### Task 4: The booking page's ticket branch

Adds the fourth rendering branch and the name form it shows. Nothing routes
a student here yet — Task 5 does — so this task's coverage is the component
test plus a hand-seeded e2e.

**Files:**
- Create: `src/components/booking/booking-name-step.tsx`
- Create: `src/components/booking/booking-name-step.test.tsx`
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx`

**Interfaces:**
- Consumes: `peekSignupTicket(prisma, token, 'student')` (Task 1);
  `POST /api/account/student-profile` with `{ firstName, lastName }` (Task 3).
- Produces: `BookingNameStep({ email, redirect }: { email: string; redirect: string })`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/booking/booking-name-step.test.tsx`. The `components`
project mocks `next/navigation` (`tests/setup/components.ts`) but does NOT
mock `fetch` — each test that clicks stubs it itself.

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { BookingNameStep } from './booking-name-step';

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anna' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Smith' } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
}

describe('BookingNameStep', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the two names and nothing else', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/account/student-profile');
    // The address comes from the ticket the server verified, never from here.
    expect(JSON.parse(init.body)).toEqual({ firstName: 'Anna', lastName: 'Smith' });
    // The response set the session cookie; the refresh is what moves this
    // branch to BookingFlow. Without it the student sits on a dead form.
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('offers a fresh link when the ticket has expired, rather than an error', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByText(/emailed you a fresh link/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/student-signup');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      email: 'anna@example.com',
      redirect: '/t/book/c1',
    });
  });

  it('surfaces a failure without disabling the button forever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<BookingNameStep email="anna@example.com" redirect="/t/book/c1" />);

    fillAndSubmit();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Continue/i })).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components src/components/booking/booking-name-step.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the component**

Create `src/components/booking/booking-name-step.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readErrorMessage } from '@/lib/client-errors';

interface BookingNameStepProps {
  /** The verified address, from the signup ticket. Display only: the route
   *  takes the email from the ticket it consumes, never from us. */
  email: string;
  /** This booking page — where a re-sent link must come back to. */
  redirect: string;
}

/**
 * `expired` and `expired-stuck` are the same event told honestly two ways:
 * the ticket aged out mid-typing, and the replacement link either went out
 * or did not. Saying "we've emailed you a fresh link" when that request
 * failed is worse than saying nothing.
 */
type Status = 'idle' | 'submitting' | 'expired' | 'expired-stuck';

/**
 * The name step of student signup (#399): the profile the ticket authorises.
 *
 * No `localStorage` draft, unlike `ProfileSetupForm`. That form persists one
 * because it is four fields including a bio and an availability-checked page
 * address; two name fields do not earn the shared-browser hazard that
 * machinery exists to manage.
 */
export function BookingNameStep({ email, redirect }: BookingNameStepProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError('');

    let res: Response;
    try {
      res = await fetch('/api/account/student-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
        }),
      });
    } catch {
      setStatus('idle');
      setError('Network error. Please try again.');
      return;
    }

    if (res.ok) {
      // This response set the session cookie, so the refreshed server render
      // moves this branch to BookingFlow. `status` stays 'submitting' under
      // a navigation already in flight; the timer is the same guard
      // JoinAsStudent uses so a failed round-trip leaves no dead button.
      router.refresh();
      setTimeout(() => setStatus('idle'), 4000);
      return;
    }

    if (res.status === 401) {
      // The ticket aged out while they were typing. Not an error — a
      // re-send, with both names left exactly where they are.
      const resent = await fetch('/api/auth/student-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirect }),
      })
        .then((r) => r.ok)
        .catch(() => false);
      setStatus(resent ? 'expired' : 'expired-stuck');
      return;
    }

    setStatus('idle');
    setError(await readErrorMessage(res, 'Something went wrong. Please try again.'));
  }

  return (
    <div>
      <h2 className="type-subtitle mb-1">One last thing</h2>
      <p className="type-body mb-4 max-w-[420px]">
        We&apos;ve confirmed <span className="text-ink">{email}</span>. Your
        teacher sees your first name and last initial on their class list &mdash;
        you can share more, or change this, in your account later.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-[420px]">
        <Input
          label="First name"
          value={firstName}
          onChange={(e) => { setFirstName(e.target.value); if (error) setError(''); }}
          required
        />
        <Input
          label="Last name"
          value={lastName}
          onChange={(e) => { setLastName(e.target.value); if (error) setError(''); }}
          required
        />
        <Button type="submit" disabled={status === 'submitting'} className="w-full">
          {status === 'submitting' ? 'One moment...' : 'Continue'}
        </Button>

        {status === 'expired' && (
          <p role="status" className="type-caption">
            That took a while &mdash; we&apos;ve emailed you a fresh link. Your
            details are still here.
          </p>
        )}
        {status === 'expired-stuck' && (
          <p role="status" className="type-caption">
            That took a while and the link expired &mdash; and we couldn&apos;t
            send a fresh one just now. Your details are still here; try again in
            a moment.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
```

Check the copy against `docs/design-brief.md` before committing — the
typography classes above (`type-subtitle`, `type-body`, `type-caption`) and
the danger-text treatment mirror `BookingSignIn`, which sits in the same
slot on the same page.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project components src/components/booking/booking-name-step.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Add the branch to the booking page**

In `src/app/(public)/[slug]/book/[classId]/page.tsx`:

```ts
// Only when there is no session at all: a signed-in viewer takes one of
// the two branches above, so an ordinary anonymous render must not pay for
// a lookup neither of them needs.
const ticketToken = session ? undefined : (await cookies()).get(SIGNUP_TICKET_COOKIE)?.value;
const ticketEmail = ticketToken
  ? await peekSignupTicket(prisma, ticketToken, 'student')
  : null;
```

`peek`, not `consume` — the profile route is the only thing that spends the
ticket, so reloading this page costs nothing. Same choice
`/signup/profile` makes.

Insert the branch between `guestTeacher` and `BookingSignIn`:

```tsx
) : ticketEmail ? (
  <BookingNameStep email={ticketEmail} redirect={`/${slug}/book/${cls.id}`} />
) : (
  <BookingSignIn redirect={`/${slug}/book/${cls.id}`} />
)}
```

- [ ] **Step 6: Add an e2e for the branch**

In `tests/e2e/booking.spec.ts`, add a test that mints a student ticket
directly (`mintSignupTicket(prisma, email, 'student')`), sets it as the
`fair_yoga_signup` cookie on the browser context, opens the booking page,
fills the two names, submits, and asserts the tier picker appears — then
asserts the created row has `claimedAt` set and `tierSelectedAt` null.
Follow `tests/e2e/teacher-signup.spec.ts` for the cookie-seeding shape and
clean up in `afterAll` the way that file does.

- [ ] **Step 7: Run the e2e**

Run: `npx playwright test tests/e2e/booking.spec.ts`
Expected: PASS. If working in a worktree, skip this and note that CI is the
signal for this tier.

- [ ] **Step 8: Commit**

```bash
git add src/components/booking/booking-name-step.tsx src/components/booking/booking-name-step.test.tsx \
  'src/app/(public)/[slug]/book/[classId]/page.tsx' tests/e2e/booking.spec.ts
git commit -m "feat(booking): collect the name on the booking page after verification (#399)"
```

---

### Task 5: `student-signup` creates nothing

Flips the producer. After this task the invariant holds end to end.

**Files:**
- Modify: `src/lib/schemas.ts` (`studentSignupSchema`, ~line 128)
- Modify: `src/app/api/auth/student-signup/route.ts`
- Modify: `src/components/booking/booking-sign-in.tsx:19-104`
- Modify: `src/components/booking/booking-sign-in.test.tsx`
- Modify: `tests/integration/signup-api.test.ts`
- Modify: `tests/integration/auth-email-case.test.ts:20,64`
- Modify: `tests/integration/magic-link-origin-binding.test.ts:10`
- Modify: `tests/e2e/magic-link-handoff.spec.ts:287-288`
- Modify: `tests/e2e/booking.spec.ts` (add the full-path spec)
- Modify: `src/lib/student-visibility.ts` (the unclaimed-`Student` docblock's create-site census)
- Modify: `prisma/schema.prisma` (the comment above `Student.accountId`)
- Modify: `docs/data-model.md` (StudentPrivacy section, ~89 and ~105)

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: `POST /api/auth/student-signup` accepts `{ email, redirect? }`
  only, writes no rows, and answers a uniform `200`.

- [ ] **Step 1: Write the failing integration test**

In `tests/integration/signup-api.test.ts`, invert the first case and add the
purpose cases:

```ts
it('creates nothing for a fresh email — the link is all that is minted', async () => {
  const email = `signup-fresh-${suffix}@test.local`;
  const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freshIp() },
    body: JSON.stringify({ email, redirect: '/t/book/c1' }),
  });
  expect(res.status).toBe(200);

  expect(await prisma.student.findUnique({ where: { email } })).toBeNull();
  expect(await prisma.account.findUnique({ where: { email } })).toBeNull();

  const token = await prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
  expect(token.purpose).toBe('student_signup');
  expect(token.redirectTo).toBe('/t/book/c1');
});

it('mints an ordinary sign_in link when no redirect was supplied', async () => {
  const email = `signup-noredir-${suffix}@test.local`;
  const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freshIp() },
    body: JSON.stringify({ email }),
  });
  expect(res.status).toBe(200);
  // A ticket is never minted without somewhere to spend it, so a request
  // with no destination gets a link that cannot produce one.
  const token = await prisma.magicLinkToken.findFirstOrThrow({ where: { email } });
  expect(token.purpose).toBe('sign_in');
});

it('mints an ordinary sign_in link for an address that already has an account', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freshIp() },
    body: JSON.stringify({ email: takenEmail, redirect: '/t/book/c1' }),
  });
  expect(res.status).toBe(200);
  const token = await prisma.magicLinkToken.findFirstOrThrow({
    where: { email: takenEmail }, orderBy: { createdAt: 'desc' },
  });
  // The signup marker is what lets verification create an account; handing
  // it to an address that already has one would push a real user down the
  // signup path.
  expect(token.purpose).toBe('sign_in');
});

it('refuses a body that still carries the old name fields', async () => {
  const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freshIp() },
    body: JSON.stringify({
      firstName: 'Stale', lastName: 'Client',
      email: `signup-stale-${suffix}@test.local`, redirect: '/t/book/c1',
    }),
  });
  expect(res.status).toBe(400);
});
```

Keep the existing "does not attach a profile to an existing account",
"…teacher-only account", "…unclaimed CRM email" and race cases, updating
their bodies to drop `firstName`/`lastName`. The concurrent-signup case
("answers both halves… identically") no longer races a create — rewrite it
to assert both halves answer `200` and that neither wrote a row, or delete
it and say so in the report if nothing is left for it to assert.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/integration/signup-api.test.ts`
Expected: FAIL — a `Student` row exists for the fresh email, and the strict
body case returns `200` rather than `400`.

- [ ] **Step 3: Narrow the schema**

In `src/lib/schemas.ts`:

```ts
export const studentSignupSchema = z.object({
  email: emailField,
  redirect: relativePath.optional(),
}).strict();
```

`.strict()` matches `teacherSignupSchema` and makes a stale caller still
sending names fail loudly rather than having them silently ignored.

- [ ] **Step 4: Strip the route**

In `src/app/api/auth/student-signup/route.ts`:

- Delete both existence reads, the whole `prisma.student.create` block, and
  its `catch`. The P2002 commentary goes with it — it exists only because of
  the create. Remove the now-unused `Prisma` and `isUniqueConflictOn`
  imports.
- Replace with one lookup and the purpose decision:

```ts
// An address that already has an account gets an ORDINARY sign-in link: the
// signup marker is what lets verification create one, so handing it to a
// stranger's address would push a real user down the signup path.
//
// And no marker without a redirect either. The marked link's only outcome is
// a ticket, and this family's ticket is spent on the booking page the
// redirect names — so minting one for a request that named no page would
// hand back a credential with nowhere to go. The `Student` table is not
// consulted: an unclaimed CRM row is claimed at verification, which is an
// ordinary sign-in, so it never needed a branch here.
const existing = await prisma.account.findUnique({ where: { email } });
const purpose = !existing && redirect ? 'student_signup' : 'sign_in';
```

- Pass `purpose` to `deliverSignInLink` alongside `redirectTo: redirect`.
- Keep the uniform `200`, `ensureOriginNonce`, and the `try`/`catch` that
  keeps a delivery failure from discarding the nonce cookie.
- Rewrite the route's header docblock. It currently says the route "creates
  the account (claimedAt set — the student registered themselves)". State
  what is true now, in `teacher-signup`'s shape.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/signup-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Drop the name fields from the sign-in form**

In `src/components/booking/booking-sign-in.tsx`, remove the `firstName` and
`lastName` state, the `mode === 'new'` block containing their `Input`s, and
their keys from the `student-signup` request body. Update the `new`-mode
intro copy — "We create your account and send you a sign-in link" is no
longer true; nothing is created at that point.

Keep the `'First time here?'` heading and the `'Send me the link'` button
label: `booking.spec.ts`, `passkey.spec.ts` and `account-hybrid.spec.ts`
assert them.

- [ ] **Step 7: Update the component test**

In `src/components/booking/booking-sign-in.test.tsx`, drop the two name
fills from `fillAndSubmitNew`. Add a case asserting the name inputs are
absent and that the posted body is exactly `{ email, redirect }`.

Run: `npx vitest run --project components src/components/booking/booking-sign-in.test.tsx`
Expected: PASS.

- [ ] **Step 8: Update the remaining callers of the old body shape**

- `tests/integration/auth-email-case.test.ts:20,64` — drop
  `firstName`/`lastName`. The case at 20 seeds a student for a
  case-sensitivity assertion; if it relied on the route creating that row,
  seed it with Prisma instead and say so in the report.
- `tests/integration/magic-link-origin-binding.test.ts:10` — its `body`
  factory becomes `(e: string) => ({ email: e })`.
- `tests/e2e/magic-link-handoff.spec.ts:287-288` — remove the two name fills
  from the booking-form signup step.

- [ ] **Step 9: Add the full-path e2e**

In `tests/e2e/booking.spec.ts`, add a spec covering the whole flow: open the
booking page signed out, fill only the email, submit; seed a
`student_signup` token for that address bound to the browser's origin nonce
(the pattern in `tests/e2e/teacher-signup.spec.ts`, with
`purpose: 'student_signup'` and `redirectTo` set to the booking path); open
`/verify?token=…`; land back on the booking page; fill the two names;
submit; pick a tier; book. Assert the created `Student` has `claimedAt` set,
and that after booking `tierSelectedAt` is set and a `TeacherStudent` link
exists.

- [ ] **Step 10: Correct the three cross-file claims this task falsifies**

`51ef9c1f` argues the unclaimed-`Student` privacy bypass is unreachable from
a census of `prisma.student.create` sites: exactly two, both setting
`claimedAt` in the creating statement. Step 4 deletes one of them. The
argument survives — one remaining site, still setting `claimedAt` — but the
census does not, and it is written in three places. Correct each by
replacement, stating what is true after this branch; the before-and-after
goes in the PR body, not beside the code.

- `src/lib/student-visibility.ts` — the unclaimed-`Student` docblock. It
  names `api/auth/student-signup/route.ts`'s `POST` handler as one of the
  two creating sites. After this branch the sole create is
  `api/account/student-profile/route.ts`'s, and it sets `claimedAt` under
  both of its authorizations. Do not add a sentence about what the comment
  used to say.
- `prisma/schema.prisma` — the comment above `Student.accountId`: "Both
  remaining create sites set this and `claimedAt` in one statement."
- `docs/data-model.md` (StudentPrivacy section, around lines 89 and 105) —
  "those two sites" and "both remaining create sites set `claimedAt`".

Then re-derive rather than trusting this list:

```bash
grep -rn "student.create" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
grep -rn "two sites\|both remaining create sites\|create sites" src docs prisma --include='*.ts' --include='*.md' --include='*.prisma'
```

Every hit gets a verdict in the task report. Expect legitimate survivors —
a hit about `Teacher` or `Account` creates is not this claim.

- [ ] **Step 11: Prove the "no rows" assertion bites**

Restore the deleted `prisma.student.create` block temporarily (a minimal
version is enough), re-run `tests/integration/signup-api.test.ts`, record
the exact failure text, then remove it again and re-run to confirm green.

- [ ] **Step 12: Full verification**

Run: `npm run verify`
Expected: green across every vitest project. If anything earlier is red, run
`npx vitest run --project integration` directly — `npm test` chains with
`&&`, so a red unit test means the integration tier reports *nothing*, not
zero failures.

Run: `npx playwright test`
Expected: PASS. In a worktree, skip and note CI as the signal.

- [ ] **Step 13: Commit**

```bash
git add src/lib/student-visibility.ts prisma/schema.prisma docs/data-model.md \
  src/lib/schemas.ts src/app/api/auth/student-signup/route.ts \
  src/components/booking/booking-sign-in.tsx src/components/booking/booking-sign-in.test.tsx \
  tests/integration/signup-api.test.ts tests/integration/auth-email-case.test.ts \
  tests/integration/magic-link-origin-binding.test.ts \
  tests/e2e/magic-link-handoff.spec.ts tests/e2e/booking.spec.ts
git commit -m "feat(auth): create no student rows before the address is verified (#399)"
```

---

## After the tasks

- Whole-branch review on the most capable model, one fix wave, one scoped
  re-review. This plan has five tasks, so the review exists to catch what
  per-task reviewers structurally cannot: the family argument threaded
  consistently across Tasks 1-4, and the `student-signup` docblock in Task 5
  agreeing with the `verify` docblock in Task 2.
- Sweep for what was invalidated, not only what was edited: grep for
  `firstName` and `lastName` near `student-signup`, and for
  `teacher_profile_pending`, giving every hit a verdict.
- PR body records the four premise corrections, the arithmetic behind the
  test-surface table, what each rewritten docblock used to say, and which
  `integration` files this branch touched by path.
