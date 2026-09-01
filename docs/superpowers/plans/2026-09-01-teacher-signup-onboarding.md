# Teacher Signup & Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a new teacher a way into fair.yoga — a public landing page, an email-only signup, a profile-setup step that creates their account, and an onboarding checklist that reaches all the way to sharing their page.

**Architecture:** Nothing is written to the database until someone proves they control the email address. `/signup` mints a marked `MagicLinkToken` and sends it. Verification exchanges that for a short-lived single-use *signup ticket* in an httpOnly cookie — **not** a session, because a session with no profile is both unrepresentable in `SessionUser` and a GDPR hazard. Submitting `/signup/profile` consumes the ticket and creates `Account`, `Teacher` and `Session` in one transaction. Separately, the landing page takes `/` and the teacher home moves to `/schedule`, and `POST /api/teachers` — the unauthenticated route this replaces — is deleted.

**Tech Stack:** Next.js 14+ App Router, TypeScript strict, Prisma + PostgreSQL, Zod, Vitest (unit / components / integration), Playwright (e2e), Tailwind v4 via `@theme` in `globals.css`.

**Spec:** `docs/superpowers/specs/2026-09-01-teacher-signup-onboarding-design.md`

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types.
- **Test-first.** Every task writes the failing test, sees it fail, implements, sees it pass.
- **This worktree cannot run `integration` or `e2e`** — both need the dev server on `:3000` and the shared dev database. Run `npm run verify` scoped to typecheck, lint, unit and components. Never pass `--project integration`; it hangs on `ECONNREFUSED`. CI is the signal for those two tiers.
- **Never kill or restart anything on `:3000`.** If a dev server is running it is the user's.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/(public)/page.tsx"`.
- **Never edit an applied migration**, comment-only edits included.
- **`@/lib/log` is pino and server-only.** It must not reach a `'use client'` component through any import chain. `import type` is safe.
- **Design tokens only** — teal `#1A5653`, cream `#F7F4EF`, sand-soft `#F0E9DC`, brown `#6B5B4E`, gold `#C4A96A`, danger `#B85C5C`. Typography is the six `type-*` classes. No shadows outside sheets/modals, no transitions, no gradients, never pure white.
- **Counts and rosters never go in a code comment.** Tether membership to the compiler (`satisfies Record<keyof T, true>`, exhaustive `switch` with a `never` default) or put it in `docs/`.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/lib/auth/signup-ticket.ts` | Mint, read, consume and clear the signup ticket cookie |
| `src/app/api/auth/teacher-signup/route.ts` | Unauthenticated: rate-limit, mint a marked token, mail it, uniform 200 |
| `src/app/api/account/teacher-profile/route.ts` | Create the `Teacher` — from a ticket (new signup) or a live session (existing account) |
| `src/app/api/teachers/slug-available/route.ts` | Advisory availability check for the page address |
| `src/app/(public)/page.tsx` | The landing page; redirects signed-in visitors to their home |
| `src/app/(public)/signup/page.tsx` | Email-only signup form |
| `src/app/(public)/signup/profile/page.tsx` | Profile setup — mounts the form below |
| `src/components/signup/signup-form.tsx` | Client: the email form and its sent state |
| `src/components/signup/profile-setup-form.tsx` | Client: name, page address with live check, skippable bio |
| `src/components/signup/page-address-field.tsx` | Client: the address input, derivation, and debounced availability |
| `src/lib/onboarding.ts` | Step definitions, done/skipped resolution, the `never`-default exhaustiveness tether |

**Modified**

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `OnboardingStep`, `MagicLinkPurpose`, `Teacher.skippedOnboarding`, `MagicLinkToken.purpose` |
| `src/lib/schemas.ts` | Extract `pageSlugField`; add `'signup'` to `RESERVED_SLUGS`; add `teacherProfileSchema` and `teacherSignupSchema`; **delete** `createTeacherSchema` |
| `src/lib/auth/magic-link.ts` | `generateMagicLinkToken` takes a `purpose`; `verifyMagicLinkToken` returns it |
| `src/app/api/auth/magic-link/verify/route.ts` | The signup branch; `'/'` → `'/schedule'` |
| `src/app/(teacher)/schedule/page.tsx` | Becomes the real teacher home (was a redirect) |
| `src/components/schedule/getting-started.tsx` | Five states, skip buttons, share completion |
| `src/app/api/account/onboarding/route.ts` | New: record a skip |
| **Deleted** | `src/app/api/teachers/route.ts`, `src/app/(teacher)/page.tsx` |

---

## Task 1: Schema, enums, and the shared page-address validator

Everything downstream types against these.

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/schemas.ts:157-172`
- Modify: `src/lib/schemas.test.ts:615-624`
- Create: `src/lib/onboarding.ts`
- Test: `src/lib/onboarding.test.ts`, `src/lib/schemas.test.ts`

**Interfaces:**
- Produces: `pageSlugField: z.ZodString`; `teacherProfileSchema` (`{firstName, lastName, bio, pageSlug}`); `teacherSignupSchema` (`{email}`); `OnboardingStep` and `MagicLinkPurpose` Prisma enums; `ONBOARDING_STEPS`, `resolveSteps(input): StepState[]`, `isOnboardingComplete(input): boolean`.

- [ ] **Step 1: Write the failing validator tests**

In `src/lib/schemas.test.ts`, add:

```ts
describe('pageSlugField', () => {
  it('accepts lowercase alphanumeric with hyphens', () => {
    expect(pageSlugField.parse('anna-devries')).toBe('anna-devries');
  });

  it('rejects uppercase and spaces', () => {
    expect(() => pageSlugField.parse('Anna DeVries')).toThrow();
  });

  // 'signup' is new here: a static /signup route shadows any teacher who
  // claimed it, because a static segment beats the [slug] dynamic one.
  it.each(['signup', 'login', 'schedule', 'api'])('rejects the reserved slug %s', (slug) => {
    expect(() => pageSlugField.parse(slug)).toThrow('This slug is reserved');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/schemas.test.ts -t 'pageSlugField'`
Expected: FAIL — `pageSlugField is not defined`.

- [ ] **Step 3: Extract the validator and add `'signup'`**

In `src/lib/schemas.ts`, replace lines 157-172. `RESERVED_SLUGS` gains `'signup'`; the slug rules move into one exported field that the client can also run, so the form cannot drift from what the server accepts.

```ts
// App routes the public teacher page must never shadow. A static segment
// beats the `[slug]` dynamic one, so anything listed here would silently
// hide a teacher who had claimed it.
const RESERVED_SLUGS = new Set([
  'login', 'verify', 'signup', 'bookings', 'settings', 'schedule', 'students',
  'inbox', 'class', 'studio-class', 'api', 'health', 'admin', 'account', 'updates',
]);

/**
 * The public page address, `fair.yoga/<pageSlug>`.
 *
 * Exported because the signup form runs it in the browser: one definition
 * means the field cannot accept something the route then rejects.
 */
export const pageSlugField = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
  .refine((s) => !RESERVED_SLUGS.has(s), 'This slug is reserved');

export const teacherSignupSchema = z.object({ email: emailField }).strict();

/**
 * Creates the teacher profile. No `email` field: it comes from the consumed
 * signup ticket or the live session, never from the body — the address must
 * be one the caller has proved they control.
 */
export const teacherProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  bio: z.string().max(250),
  pageSlug: pageSlugField,
}).strict();
```

Then update `updateTeacherSchema` to use `pageSlugField.optional()` in place of its inline copy.

- [ ] **Step 4: Fix the email-roster assertion**

`src/lib/schemas.test.ts:615-624` asserts which schemas carry an address. `createTeacherSchema` goes in Task 3, and `teacherProfileSchema` deliberately carries no email, so the roster drops by one. The count comes **out of the title** — the array below it is the tripwire, and a number in prose beside it is a second claim that rots on its own.

```ts
  it('covers exactly the schemas that carry an address', () => {
    expect([...emailBearing].sort()).toEqual([
      'createInvitationSchema',
      'createTeacherSchema',
      'magicLinkSendSchema',
      'passkeyAuthOptionsSchema',
      'studentSignupSchema',
      'teacherSignupSchema',
      'updateInvitationSchema',
    ]);
  });
```

(`createTeacherSchema` stays in this list for now — Task 3 removes it together with the schema itself, so the suite is never knowingly red between tasks.)

- [ ] **Step 5: Run the schema tests**

Run: `npx vitest run src/lib/schemas.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing onboarding-step tests**

Create `src/lib/onboarding.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSteps, isOnboardingComplete } from './onboarding';

const nothingDone = {
  bio: '', bankIban: null, roomCount: 0, classCount: 0, skipped: [],
};

describe('resolveSteps', () => {
  it('returns the four steps in order, none done', () => {
    const steps = resolveSteps(nothingDone);
    expect(steps.map((s) => s.key)).toEqual(['profile', 'bank', 'room', 'class']);
    expect(steps.every((s) => s.state === 'todo')).toBe(true);
  });

  it('marks profile done once a bio exists', () => {
    const [profile] = resolveSteps({ ...nothingDone, bio: 'Yoga since 2009.' });
    expect(profile.state).toBe('done');
  });

  it('marks an optional step skipped', () => {
    const [profile] = resolveSteps({ ...nothingDone, skipped: ['profile'] });
    expect(profile.state).toBe('skipped');
  });

  // Required steps carry no Skip control, and OnboardingStep has no member
  // for them — "skip a required step" is not expressible.
  it('reports which steps may be skipped', () => {
    const steps = resolveSteps(nothingDone);
    expect(steps.filter((s) => s.skippable).map((s) => s.key)).toEqual(['profile', 'bank']);
  });
});

describe('isOnboardingComplete', () => {
  it('is false while a required step is outstanding', () => {
    expect(isOnboardingComplete({ ...nothingDone, bio: 'x', skipped: ['bank'] })).toBe(false);
  });

  it('is true when every step is done or skipped and share is dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, roomCount: 1, classCount: 1, skipped: ['bank', 'share'],
    })).toBe(true);
  });

  // The share card is the last thing seen; until it is dismissed the
  // checklist has not retired.
  it('is false when every step is settled but share is not dismissed', () => {
    expect(isOnboardingComplete({
      bio: 'x', bankIban: null, roomCount: 1, classCount: 1, skipped: ['bank'],
    })).toBe(false);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run src/lib/onboarding.test.ts`
Expected: FAIL — cannot resolve `./onboarding`.

- [ ] **Step 8: Implement `src/lib/onboarding.ts`**

```ts
import type { OnboardingStep } from '@prisma/client';

/** Steps that gate retirement but carry no Skip control. */
export type RequiredStepKey = 'room' | 'class';
/** Every row rendered in the checklist. `share` is the completion card, not a row. */
export type StepKey = Extract<OnboardingStep, 'profile' | 'bank'> | RequiredStepKey;

export type StepState = 'done' | 'skipped' | 'todo';

export interface StepInput {
  bio: string;
  bankIban: string | null;
  roomCount: number;
  classCount: number;
  skipped: OnboardingStep[];
}

export interface ResolvedStep {
  key: StepKey;
  label: string;
  detail: string;
  href: string;
  state: StepState;
  /** Skippable steps are exactly those `OnboardingStep` can name. */
  skippable: boolean;
}

const ORDER: readonly StepKey[] = ['profile', 'bank', 'room', 'class'];

function isDone(key: StepKey, input: StepInput): boolean {
  switch (key) {
    case 'profile': return input.bio !== '';
    case 'bank': return input.bankIban !== null;
    case 'room': return input.roomCount > 0;
    case 'class': return input.classCount > 0;
    default: {
      // Adding a StepKey without a done-condition fails to compile here.
      const never: never = key;
      return never;
    }
  }
}

const COPY: Record<StepKey, { label: string; detail: string; href: string }> = {
  profile: {
    label: 'Complete your profile',
    detail: 'A sentence or two so students know who they’re booking',
    href: '/settings/profile',
  },
  bank: {
    label: 'Add your bank details',
    detail: 'Students see them when it’s time to pay — skip if you take cash',
    href: '/settings/profile',
  },
  room: {
    label: 'Add a room',
    detail: 'Where you teach, and what it costs you',
    href: '/settings/rooms/new',
  },
  class: {
    label: 'Create your first class',
    detail: 'Set your rates once — pricing does the rest',
    href: '/class/new',
  },
};

function skippableKey(key: StepKey): OnboardingStep | null {
  return key === 'profile' || key === 'bank' ? key : null;
}

export function resolveSteps(input: StepInput): ResolvedStep[] {
  return ORDER.map((key) => {
    const skippable = skippableKey(key);
    const state: StepState = isDone(key, input)
      ? 'done'
      : skippable && input.skipped.includes(skippable)
        ? 'skipped'
        : 'todo';
    return { key, ...COPY[key], state, skippable: skippable !== null };
  });
}

/** Retired: every step settled, and the share card dismissed. */
export function isOnboardingComplete(input: StepInput): boolean {
  const settled = resolveSteps(input).every((s) => s.state !== 'todo');
  return settled && input.skipped.includes('share');
}
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npx vitest run src/lib/onboarding.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 10: Add the schema changes**

In `prisma/schema.prisma`, beside the other enums:

```prisma
/// Steps a teacher may dismiss. Required steps (room, class) are absent
/// on purpose: "skip a required step" must not be expressible.
enum OnboardingStep {
  profile
  bank
  share
}

/// What a MagicLinkToken authorises. Delivery differs by member —
/// sign_in and teacher_signup are emailed, teacher_profile_pending is
/// issued at verification and held in an httpOnly cookie.
enum MagicLinkPurpose {
  sign_in
  teacher_signup
  teacher_profile_pending
}
```

On `model Teacher`, after `defaultReminder`:

```prisma
  skippedOnboarding  OnboardingStep[] @default([])
```

On `model MagicLinkToken`, after `redirectTo`:

```prisma
  purpose    MagicLinkPurpose @default(sign_in)
```

`@default(sign_in)` is what leaves every existing row and the whole student flow untouched.

- [ ] **Step 11: Generate the migration**

```bash
npx prisma migrate dev --name teacher_signup_onboarding
npx prisma validate
```

Expected: one new directory under `prisma/migrations/`, and `validate` clean. No hand-authored CHECK constraint is needed.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/schemas.ts src/lib/schemas.test.ts src/lib/onboarding.ts src/lib/onboarding.test.ts
git commit -m "feat(signup): onboarding and magic-link-purpose enums, shared page-address validator"
```

---

## Task 2: The routes

Testable over HTTP with no UI.

**Files:**
- Create: `src/lib/auth/signup-ticket.ts`, `src/app/api/auth/teacher-signup/route.ts`, `src/app/api/account/teacher-profile/route.ts`, `src/app/api/teachers/slug-available/route.ts`, `src/app/api/account/onboarding/route.ts`
- Modify: `src/lib/auth/magic-link.ts:35-54`, `src/lib/auth/index.ts`, `src/app/api/auth/magic-link/verify/route.ts`, `src/lib/rate-limit.ts:38-52`
- Test: `tests/integration/teacher-signup-api.test.ts`, `src/lib/auth/magic-link.test.ts`

**Interfaces:**
- Consumes: `pageSlugField`, `teacherSignupSchema`, `teacherProfileSchema` (Task 1).
- Produces: `mintSignupTicket(db, email): Promise<string>`, `consumeSignupTicket(db, token): Promise<string | null>` (returns the email, deletes the row), `peekSignupTicket(db, token): Promise<string | null>` (returns the email, leaves the row), `setSignupTicketCookie(headers, token)`, `clearSignupTicketCookie(headers)`, `SIGNUP_TICKET_COOKIE = 'fair_yoga_signup'`, and `hashToken` now exported from `magic-link.ts`.

- [ ] **Step 1: Write the failing token-purpose test**

In `src/lib/auth/magic-link.test.ts`:

```ts
it('round-trips the purpose it was minted with', async () => {
  const token = await generateMagicLinkToken(prisma, email, undefined, 'teacher_signup');
  const result = await verifyMagicLinkToken(prisma, token);
  expect(result?.purpose).toBe('teacher_signup');
});

it('defaults to sign_in when no purpose is given', async () => {
  const token = await generateMagicLinkToken(prisma, email);
  expect((await verifyMagicLinkToken(prisma, token))?.purpose).toBe('sign_in');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/auth/magic-link.test.ts -t 'purpose'`
Expected: FAIL — `purpose` is not on the returned object.

- [ ] **Step 3: Thread `purpose` through `magic-link.ts`**

`generateMagicLinkToken` takes a fourth parameter defaulting to `'sign_in'` and writes it; `verifyMagicLinkToken` returns it alongside `email` and `redirectTo`.

Its docblock at `magic-link.ts:13-33` currently counts live tokens per address — *"one address can hold six live tokens in a window, not three"* — from a census of the two minting routes. This task adds a third, falsifying it. **Replace the count with the invariant**, do not refresh it to a bigger number:

```
 * Each minting route rate-limits per address in its OWN bucket, so the live
 * token count for one address is bounded by the sum of the routes that mint
 * for it — not by any single route's limit. The TTL is 15 minutes,
 * `cleanupExpiredAuth` sweeps the remains daily, and `verifyMagicLinkToken`
 * deletes every sibling the moment one of them is used.
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/lib/auth/magic-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the ticket helpers**

Create `src/lib/auth/signup-ticket.ts`. The ticket is a `MagicLinkToken` with `purpose: 'teacher_profile_pending'` — same SHA-256 storage, same TTL, already swept by `cleanupExpiredAuth`. Only its delivery differs.

`generateMagicLinkToken` now needs both a purpose and a per-call TTL. Four
positional parameters is where the signature stops reading, so change it to
`(db, email, opts?: { redirectTo?: string; purpose?: MagicLinkPurpose; ttlMs?: number })`,
defaulting to `sign_in` and fifteen minutes. Two existing call sites
(`magic-link/send`, `student-signup`) and their tests move with it.

`hashToken` is module-private in `magic-link.ts:8` and `peekSignupTicket` needs
it — **export it**. It is a bare SHA-256 of the token; the security comes from
the token's 32 bytes of entropy, not from the function being unexported, and
`tests/helpers.ts:77` already carries an identical copy. Exporting it and having
the test helper import it removes that duplicate too.

```ts
import type { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken, verifyMagicLinkToken, hashToken } from './magic-link';

export const SIGNUP_TICKET_COOKIE = 'fair_yoga_signup';

/**
 * An hour, not the fifteen minutes every other token gets. This one sits
 * behind a FORM: no other flow asks someone to type four fields while a
 * token ages, and losing a name, an address that waited on an availability
 * check, and a bio is a bad first interaction with the product.
 */
const TICKET_TTL_MS = 60 * 60 * 1000;

export async function mintSignupTicket(db: PrismaClient, email: string): Promise<string> {
  return generateMagicLinkToken(db, email, {
    purpose: 'teacher_profile_pending',
    ttlMs: TICKET_TTL_MS,
  });
}

/** The address behind a live ticket, WITHOUT consuming it — the profile page
 *  reads this to prefill the form's re-send address. */
export async function peekSignupTicket(
  db: PrismaClient,
  token: string,
): Promise<string | null> {
  const row = await db.magicLinkToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, expiresAt: true, purpose: true },
  });
  if (!row || row.purpose !== 'teacher_profile_pending') return null;
  return row.expiresAt > new Date() ? row.email : null;
}

/**
 * Single-use: `verifyMagicLinkToken` deletes atomically, so two concurrent
 * submissions cannot both create a teacher for one ticket. Returns the
 * VERIFIED address — the profile route must never take an email from a body.
 */
export async function consumeSignupTicket(
  db: PrismaClient,
  token: string,
): Promise<string | null> {
  const result = await verifyMagicLinkToken(db, token);
  if (!result || result.purpose !== 'teacher_profile_pending') return null;
  return result.email;
}

export function setSignupTicketCookie(headers: Headers, token: string): void {
  let cookie = `${SIGNUP_TICKET_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TICKET_TTL_MS / 1000}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}

export function clearSignupTicketCookie(headers: Headers): void {
  headers.append('Set-Cookie', `${SIGNUP_TICKET_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
```

Re-export both from `src/lib/auth/index.ts`.

- [ ] **Step 6: Write the failing signup-route tests**

Create `tests/integration/teacher-signup-api.test.ts`. Every call carries `freshIp()` — these routes are IP rate-limited and shared addresses across calls have bitten before.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const freshEmail = `teacher-signup-${suffix}@test.local`;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: freshEmail } });
  await prisma.$disconnect();
});

describe('POST /api/auth/teacher-signup', () => {
  it('creates no rows and mints a marked token', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.findUnique({ where: { email: freshEmail } })).toBeNull();
    expect(await prisma.teacher.findUnique({ where: { email: freshEmail } })).toBeNull();

    const token = await prisma.magicLinkToken.findFirst({ where: { email: freshEmail } });
    expect(token?.purpose).toBe('teacher_signup');
  });

  // Losing the email is the only failure mode with no other recovery:
  // magic-link/send looks up Teacher-then-Student and an unfinished signup
  // has neither, so re-running /signup IS the recovery path.
  it('is re-runnable for an address it has already seen', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a body carrying anything but an email', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/teacher-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email: freshEmail, pageSlug: 'sneaky' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 7: Implement `POST /api/auth/teacher-signup`**

Reuses the existing `'teacher-signup'` rate-limit prefix, so `IpRateLimitPrefix`, `PREFIX_CAPACITIES` and the five `rate-limit.test.ts` call sites are all untouched. Add one new per-email prefix `'teacher-signup:email'` to `RateLimitPrefix` and `PREFIX_CAPACITIES`.

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Throttled before parsing: each accepted request can send a real email,
  // so an unthrottled endpoint is an email-bombing vector.
  const ip = clientIp(request);
  const ipCheck = checkIpRateLimit('teacher-signup', ip, 5, 60 * 60 * 1000, 'teacher-signup');
  if (!ipCheck.allowed) return respondRateLimited(ipCheck);

  const parsed = await parseBody(request, teacherSignupSchema);
  if ('error' in parsed) return parsed.error;
  const { email } = parsed.data;

  const emailCheck = checkRateLimit(rateLimitKey('teacher-signup:email', email), 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) return respondRateLimited(emailCheck);

  // An address that already has an account gets an ORDINARY sign-in link.
  // The signup marker is what lets verification create an account, so
  // handing it to a stranger's address would let them push a real user down
  // the signup path.
  const existing = await prisma.account.findUnique({ where: { email } });
  const purpose = existing ? 'sign_in' : 'teacher_signup';
  const token = await generateMagicLinkToken(
    prisma, email, existing ? undefined : '/signup/profile', purpose,
  );

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendMagicLinkEmail(email, `${baseUrl}/verify?token=${token}`);

  // Uniform 200 whatever the address turned out to be — same
  // non-enumeration contract as `student-signup`.
  return respondOk({ message: 'Check your inbox for a link.' });
});
```

- [ ] **Step 8: Add the verify branch**

In `src/app/api/auth/magic-link/verify/route.ts`, before `resolveOrClaimAccount`'s null check:

```ts
  const resolved = await resolveOrClaimAccount(prisma, email);

  // A signup token whose address still has no account: hand back a ticket,
  // NOT a session. `validateSession` deletes any session whose account has
  // no live profile, and `SessionUser` cannot represent one — so the
  // account is created later, together with the teacher profile.
  if (!resolved && purpose === 'teacher_signup') {
    const ticket = await mintSignupTicket(prisma, email);
    const response = respondOk({ redirectTo: '/signup/profile' });
    setSignupTicketCookie(response.headers, ticket);
    return response;
  }

  if (!resolved) {
    return respondError('Account not found', 400);
  }
```

and change the fallback on the line below to `const fallback = resolved.teacherId ? '/schedule' : '/bookings';`

- [ ] **Step 9: Write the failing profile-route tests**

Append to `tests/integration/teacher-signup-api.test.ts`:

```ts
describe('POST /api/account/teacher-profile', () => {
  it('rejects a caller with neither ticket nor session', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({
        firstName: 'No', lastName: 'Auth', bio: '', pageSlug: `no-auth-${suffix}`,
      }),
    });
    expect(res.status).toBe(401);
    expect(await prisma.teacher.findUnique({ where: { pageSlug: `no-auth-${suffix}` } })).toBeNull();
  });

  it('creates account, teacher and session from a ticket', async () => {
    const ticket = await mintSignupTicket(prisma, ticketEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'Anna', lastName: 'de Vries', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('set-cookie')).toContain('fair_yoga_session=');

    const teacher = await prisma.teacher.findUnique({ where: { pageSlug: ticketSlug } });
    expect(teacher?.email).toBe(ticketEmail);
    // The address comes from the ticket, never the body.
    expect(teacher?.bio).toBe('');
  });

  it('refuses a spent ticket', async () => {
    const ticket = await mintSignupTicket(prisma, spentEmail);
    const body = JSON.stringify({
      firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent-${suffix}`,
    });
    const headers = {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_signup=${ticket}`,
      ...freshIp(),
    };
    await fetch(`${BASE_URL}/api/account/teacher-profile`, { method: 'POST', headers, body });
    const second = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST', headers,
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: `spent2-${suffix}`,
      }),
    });
    expect(second.status).toBe(401);
  });

  it('answers SLUG_TAKEN for an address someone already holds', async () => {
    const ticket = await mintSignupTicket(prisma, clashEmail);
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_signup=${ticket}`,
        ...freshIp(),
      },
      body: JSON.stringify({
        firstName: 'A', lastName: 'B', bio: '', pageSlug: ticketSlug,
      }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('SLUG_TAKEN');
  });
});
```

Declare `ticketEmail`, `spentEmail`, `clashEmail`, `ticketSlug` beside `freshEmail`, and extend `afterAll` to tear all of them down.

- [ ] **Step 10: Implement `POST /api/account/teacher-profile`**

Two authorizations, one route: the ticket (new signup) or a live session (an existing account adding the teacher hat — the mirror of `student-profile`'s "join as a student").

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  const ticketToken = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const ticketEmail = ticketToken ? await consumeSignupTicket(prisma, ticketToken) : null;

  let accountId: string | null = null;
  let email: string;

  if (ticketEmail) {
    email = ticketEmail;
  } else {
    const session = await requireSession(request);
    if (isErrorResponse(session)) return session;
    if (session.teacherId) {
      return respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER');
    }
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    accountId = session.accountId;
    email = account.email;
  }

  const parsed = await parseBody(request, teacherProfileSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, bio, pageSlug } = parsed.data;

  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName, lastName, email, bio, pageSlug,
        defaultCurrency: 'EUR',
        defaultTimezone: 'Europe/Amsterdam',
        // A ticket has no account yet; a session has one already.
        ...(accountId ? { accountId } : { account: { create: { email } } }),
      },
    });

    const response = respondOk({ teacherId: teacher.id }, 201);
    if (ticketEmail) {
      const sessionToken = await createSession(prisma, teacher.accountId);
      setSessionCookie(response.headers, sessionToken);
      clearSignupTicketCookie(response.headers);
    }
    return response;
  } catch (err) {
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError('Page address already in use', 409, 'SLUG_TAKEN');
    }
    if (isUniqueConflictOn(err, ['email']) || isUniqueConflictOn(err, ['accountId'])) {
      return respondError('Account already has a teacher profile', 409, 'ALREADY_TEACHER');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher profile create hit a unique constraint that is neither the slug, the email nor the account key',
      );
      throw new Error('teacher profile create: unrecognised unique constraint');
    }
    throw err;
  }
});
```

Note the pre-checks are deliberately absent: the unique keys are the guard, and answering with a specific code is safe here for the reason `student-profile/route.ts:70-75` records — the address is one the caller has proved they control, so no foreign row can be the one that collided.

- [ ] **Step 11: Implement `GET /api/teachers/slug-available`**

```ts
export const GET = withErrorHandler(async (request: NextRequest) => {
  const ip = clientIp(request);
  const check = checkIpRateLimit('slug-available', ip, 60, 60 * 60 * 1000, 'slug-available');
  if (!check.allowed) return respondRateLimited(check);

  const slug = request.nextUrl.searchParams.get('slug') ?? '';

  // Reserved and malformed values are answered without a database read —
  // `pageSlugField` is the same validator the form runs in the browser.
  const parsed = pageSlugField.safeParse(slug);
  if (!parsed.success) return respondOk({ available: false });

  // Discloses nothing `(public)/[slug]/page.tsx:40` does not already: it
  // calls notFound() for an unknown slug, so anyone can probe this by
  // visiting the URL. Rate-limited only so it is not CHEAPER than probing.
  // Emphatically unlike email, where the uniform 200s exist to prevent
  // exactly this.
  const taken = await prisma.teacher.findUnique({ where: { pageSlug: slug }, select: { id: true } });
  return respondOk({ available: taken === null });
});
```

Add `'slug-available'` to `RateLimitPrefix`, `PREFIX_CAPACITIES` and `IpRateLimitPrefix`.

- [ ] **Step 12: Implement `POST /api/account/onboarding`**

Records a skip. Body `{ step: OnboardingStep }`, authenticated as a teacher, appends to `skippedOnboarding` idempotently.

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, onboardingSkipSchema);
  if ('error' in parsed) return parsed.error;

  // `push` on a Postgres scalar list, guarded by a NOT-contains filter:
  // a double-tap must not store the member twice.
  await prisma.teacher.updateMany({
    where: { id: session.teacherId, NOT: { skippedOnboarding: { has: parsed.data.step } } },
    data: { skippedOnboarding: { push: parsed.data.step } },
  });

  return respondOk({ ok: true });
});
```

with `onboardingSkipSchema = z.object({ step: z.enum(['profile', 'bank', 'share']) }).strict()` in `schemas.ts`.

- [ ] **Step 13: Verify what can run here**

Run: `npm run verify` (typecheck, lint, unit, components — **not** `--project integration`)
Expected: PASS. The integration file added in this task runs in CI.

- [ ] **Step 14: Commit**

```bash
git add src/lib/auth/signup-ticket.ts src/lib/auth/magic-link.ts src/lib/auth/magic-link.test.ts src/lib/auth/index.ts src/lib/rate-limit.ts src/lib/schemas.ts "src/app/api/auth/teacher-signup/route.ts" "src/app/api/auth/magic-link/verify/route.ts" "src/app/api/account/teacher-profile/route.ts" "src/app/api/account/onboarding/route.ts" "src/app/api/teachers/slug-available/route.ts" tests/integration/teacher-signup-api.test.ts
git commit -m "feat(signup): email-only signup, a signup ticket at verify, and an authenticated profile route"
```

---

## Task 3: Delete `POST /api/teachers`

After Task 2, so the two ported test blocks move onto live replacements rather than being deleted and rewritten.

**Files:**
- Delete: `src/app/api/teachers/route.ts`
- Modify: `src/lib/schemas.ts` (remove `createTeacherSchema`), `src/lib/schemas.test.ts`, `src/lib/unique-conflict.ts:25`, `src/lib/format.ts:201`, `docs/technical-architecture.md:32`
- Modify: `tests/integration/signup-api.test.ts`, `tests/integration/teachers-api.test.ts:159`

- [ ] **Step 1: Port the IP-degradation test**

`tests/integration/signup-api.test.ts:63`'s block includes a case that omits both `x-forwarded-for` and `x-real-ip`, proving `checkIpRateLimit` degrades to a shared bucket rather than skipping. That is coverage of the limiter, not of this route. Move it to `tests/integration/teacher-signup-api.test.ts`, retargeted at `POST /api/auth/teacher-signup`. Delete the rest of the block.

- [ ] **Step 2: Port the #161 race test**

`tests/integration/teachers-api.test.ts:159` — "keeps its conflict codes apart under a race (#161)". The new route reopens the same `SLUG_TAKEN` window, so move the block to `tests/integration/teacher-signup-api.test.ts`, firing two concurrent `POST /api/account/teacher-profile` calls with two distinct tickets and the same `pageSlug`, and asserting one 201 and one 409 carrying `SLUG_TAKEN` — not a code-less 409.

- [ ] **Step 3: Run the ported tests and watch them fail**

Run (in CI, or locally only if a dev server on `:3000` already exists): `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts`
Expected: FAIL — the ported blocks still reference the old route.

- [ ] **Step 4: Delete the route and its schema**

```bash
git rm src/app/api/teachers/route.ts
```

The file holds `POST` and nothing else; `src/app/api/teachers/[id]/route.ts` keeps `GET` and `PUT` and is untouched. Then remove `createTeacherSchema` from `src/lib/schemas.ts` and drop it from the roster array in `src/lib/schemas.test.ts`.

- [ ] **Step 5: Correct the two comments that named it**

- `src/lib/unique-conflict.ts:25` says `/api/teachers` creates `Teacher` and `Account` together. Retarget at `api/account/teacher-profile`.
- `src/lib/format.ts:201` says `POST /api/teachers` hardcodes `Europe/Amsterdam`. Retarget likewise.

Both are **replaced**, not annotated — no "this previously read". The before-and-after goes in the PR body.

- [ ] **Step 6: Rewrite `docs/technical-architecture.md:32`**

A live reference doc, so it must state what is true now. Rewrite its `POST /api/teachers` clauses against `POST /api/auth/teacher-signup`, keeping the `freshIp()` rationale and the IP-degradation note, which both still hold.

- [ ] **Step 7: Sweep for anything the deletion invalidated**

```bash
grep -rn "api/teachers\b" src/ tests/ docs/*.md CLAUDE.md
grep -rn "createTeacherSchema" src/ tests/
```

Give every hit a verdict. Expected legitimate survivors: `docs/implementation-plan.md:97` (`api/teachers/*` still covers the `[id]` route) and the dated files under `docs/superpowers/specs/` — those are design records of work as it was done, and rewriting them would falsify history rather than correct a claim.

- [ ] **Step 8: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -u src/lib/schemas.ts src/lib/schemas.test.ts src/lib/unique-conflict.ts src/lib/format.ts docs/technical-architecture.md tests/integration/signup-api.test.ts tests/integration/teachers-api.test.ts tests/integration/teacher-signup-api.test.ts "src/app/api/teachers/route.ts"
git commit -m "feat(signup): delete the unauthenticated POST /api/teachers, porting its two surviving contracts"
```

---

## Task 4: The root swap

Before Task 5, so the landing page is written into a `/` that is already free.

**Files:**
- Move: `src/app/(teacher)/page.tsx` → `src/app/(teacher)/schedule/page.tsx`
- Modify: 19 files carrying a `/`-means-teacher-home reference (21 sites), 5 e2e files (7 sites)
- Create: `src/lib/student-guard.ts`

- [ ] **Step 1: Move the home page**

```bash
git mv "src/app/(teacher)/page.tsx" "src/app/(teacher)/schedule/page.tsx.new"
git rm "src/app/(teacher)/schedule/page.tsx"
git mv "src/app/(teacher)/schedule/page.tsx.new" "src/app/(teacher)/schedule/page.tsx"
```

Rename the component `TeacherHome` → `SchedulePage`. Its comment at the top ("The Schedule tab is the home base") stays true.

- [ ] **Step 2: Collapse the eight duplicated student guards**

Eight files read exactly `redirect(session?.teacherId ? '/' : '/login')` — `(student)/layout.tsx:14`, `updates/page.tsx:15`, `bookings/page.tsx:23`, `account/page.tsx:20`, `account/privacy/page.tsx:27`, `account/data/page.tsx:11`, `account/notifications/page.tsx:12`, `account/tier/page.tsx:13`. Identical text in eight files is the shape `solve-issue` §4 warns about, so while every one of them is being touched, collapse them into `src/lib/student-guard.ts`:

```ts
import { redirect } from 'next/navigation';
import type { SessionUser } from '@/lib/types';

/**
 * Where a session without a student profile belongs. A signed-in teacher
 * goes to their own home rather than a sign-in form they cannot use.
 */
export function redirectNonStudent(session: SessionUser | null): never {
  redirect(session?.teacherId ? '/schedule' : '/login');
}
```

- [ ] **Step 3: Convert the remaining sites**

`(public)/verify/page.tsx:115` and `:262`; `api/auth/magic-link/verify/route.ts` (done in Task 2); `api/auth/passkey/authenticate/verify/route.ts:56` — one word, `'/'` → `'/schedule'`, and no signup branch, since a first-time teacher has no passkey; `(teacher)/class/[id]/page.tsx:73`; `(teacher)/class/[id]/edit/page.tsx:23`; `(teacher)/studio-class/[id]/page.tsx:37`; `(teacher)/studio-class/[id]/edit/page.tsx:24`; `components/layout/tab-bar.tsx:8` and `:14`; `components/layout/page-header.tsx:17`; `(student)/account/page.tsx:49`; `app/not-found.tsx:9`; `lib/session.ts:17`.

`page-header.tsx:17`'s `backHref = '/'` default is the one place a missed site would be **visible** — everywhere else the new `/` bounces a signed-in teacher onward, so a miss costs one hop and breaks nothing.

- [ ] **Step 4: Update the seven e2e sites**

`a11y.spec.ts:184`, `studio.spec.ts:198` and `:497`, `recurring.spec.ts:157` and `:189`, `teacher-journey.spec.ts:300`, `visual.spec.ts:367` — `page.goto('/')` → `page.goto('/schedule')`.

- [ ] **Step 5: Re-derive the sweep**

```bash
grep -rn "redirect('/')\|: '/'\|href=\"/\"" src/ | grep -v "'/api"
```

Every remaining hit gets a verdict. Legitimate survivors exist — `not-found.tsx`'s link to `/` is fine once `/` is the landing page.

- [ ] **Step 6: Update the two docs that record the old arrangement**

`CLAUDE.md`'s *Information Architecture* section ("the Schedule tab at `/` is the home base (`/schedule` redirects there)") and `docs/information-architecture.md`. State the new arrangement; do not annotate the old one.

- [ ] **Step 7: Verify**

Run: `npm run verify`
Expected: PASS. `visual.spec.ts`'s `schedule-*.png` snapshots should not move — the same content at a new URL — but this worktree cannot run Playwright to prove it. CI is the signal.

- [ ] **Step 8: Commit**

```bash
git commit -m "refactor(routing): the teacher home moves to /schedule, freeing / for the landing page"
```

---

## Task 5: The pages

**Files:**
- Create: `src/app/(public)/page.tsx`, `src/app/(public)/signup/page.tsx`, `src/app/(public)/signup/profile/page.tsx`, `src/components/signup/signup-form.tsx`, `src/components/signup/profile-setup-form.tsx`, `src/components/signup/page-address-field.tsx`
- Modify: `src/app/(public)/login/page.tsx`
- Test: `src/components/signup/page-address-field.test.tsx`

- [ ] **Step 1: Write the failing derivation test**

```tsx
describe('slugFromName', () => {
  it('lowercases and hyphenates', () => {
    expect(slugFromName('Anna', 'de Vries')).toBe('anna-devries');
  });

  it('strips punctuation', () => {
    expect(slugFromName("Siobhán", "O'Malley")).toBe('siobhan-omalley');
  });

  // CLAUDE.md commits to international from day one. A name that derives
  // to nothing must leave the field empty for the teacher to fill — never
  // block, never emit a placeholder.
  it('returns empty for a name with no Latin characters', () => {
    expect(slugFromName('小林', '綾')).toBe('');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/components/signup/page-address-field.test.tsx`
Expected: FAIL — `slugFromName` not exported.

- [ ] **Step 3: Implement `slugFromName` and the address field**

```ts
export function slugFromName(firstName: string, lastName: string): string {
  return `${firstName}-${lastName}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents (escaped, not literal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
```

The field debounces ~400ms, calls `GET /api/teachers/slug-available`, and shows `✓ Available` or `✕ That address is taken`. It runs `pageSlugField` in the browser first, so reserved and malformed values are reported with no request at all. The check is **advisory** — the 409 on submit is the guard, because there is always a gap between the check and the submit.

- [ ] **Step 4: Build the landing page**

`src/app/(public)/page.tsx` — a server component. Reads the session and redirects a teacher to `/schedule`, a student to `/bookings`; otherwise renders. Deliberately plain: the wordmark, one sentence on what fair.yoga is, and two actions. `implementation-plan.md` 7.10 is the copy-and-design pass and is filed separately.

```tsx
export default async function LandingPage() {
  const session = await getSession();
  if (session?.teacherId) redirect('/schedule');
  if (session?.studentId) redirect('/bookings');
  // ... wordmark, one-sentence pitch, [Start teaching] → /signup, [Sign in] → /login
}
```

- [ ] **Step 5: Build `/signup` and `/signup/profile`**

`/signup` posts `{ email }` to `/api/auth/teacher-signup` and swaps to a "check your inbox" state — modelled on `booking-sign-in.tsx:46-56`, which is the established shape for this.

`/signup/profile` is a server component. It reads the ticket cookie and calls
`peekSignupTicket`:

- **Live ticket** → mount `ProfileSetupForm` with `email` as a prop: first name,
  last name, the address field (derived live from the two name fields), and a
  bio with a live `n/250` count that is explicitly skippable. On success it
  navigates to `/schedule`.
- **No ticket, or expired** → render the email-entry prompt inline instead of a
  dead end. Same component as `/signup`, different copy: "Enter your email and
  we'll send a fresh link."

The form holds `email` in state so it can recover on its own. On a **401 at
submit** — the ticket aged out while they were typing — it must NOT clear the
fields. It POSTs `{ email }` to `/api/auth/teacher-signup`, keeps every value,
and shows inline:

```tsx
{status === 'expired' && (
  <p role="status" className="type-caption">
    That took a while — we&apos;ve emailed you a fresh link.
    Your details are still here.
  </p>
)}
```

Clicking the new link on the **same** browser returns to a form still holding
those values. On a different device the form starts clean, which is the accepted
cost of not persisting a half-typed profile server-side.

- [ ] **Step 6: Add the signup link to `/login`**

Below the passkey block in `src/app/(public)/login/page.tsx`, mirroring the existing `mode` toggle button's styling:

```tsx
<p className="mt-6 type-caption">
  New here?{' '}
  <Link href="/signup" className="text-teal">Start teaching on fair.yoga</Link>
</p>
```

- [ ] **Step 7: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)/page.tsx" "src/app/(public)/signup" "src/app/(public)/login/page.tsx" src/components/signup
git commit -m "feat(signup): the landing page, the signup form, and profile setup"
```

---

## Task 6: The checklist

**Files:**
- Modify: `src/components/schedule/getting-started.tsx`, `src/app/(teacher)/schedule/page.tsx`
- Create: `src/components/schedule/onboarding-skip-button.tsx`
- Test: `src/components/schedule/getting-started.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Cover: four rows in the order profile → bank → room → class; Skip buttons on exactly the first two; the share card appearing once every step is settled; nothing rendered once `share` is skipped.

- [ ] **Step 2: Run and watch fail**

Run: `npx vitest run --project components src/components/schedule/getting-started.test.tsx`

- [ ] **Step 3: Rework the component**

Each row changes from a whole-row `<Link>` to a container holding a link **and a sibling button** — a `<button>` inside an `<a>` is invalid nested interactive content and a real screen-reader defect. The skip button carries a per-step accessible label:

```tsx
<button
  type="button"
  aria-label={`Skip ${step.label.toLowerCase()}`}
  onClick={() => skip(step.key)}
  className="type-label text-brown-light px-3 min-h-11 shrink-0"
>
  Skip
</button>
```

The share completion state reuses `components/class/share-booking-link.tsx` — it already handles the native share sheet, the clipboard, and the visible-URL fallback for when the clipboard is blocked. It does not grow a second copy button.

- [ ] **Step 4: Rewire the page**

In `src/app/(teacher)/schedule/page.tsx`, select `bio`, `bankIban` and `skippedOnboarding` alongside the existing counts, and gate on `!isOnboardingComplete(input)` in place of `roomCount === 0 || classCount === 0`.

**Delete** the comment at the old `(teacher)/page.tsx:63-67` explaining why the gate could not include bank details. The constraint it describes no longer exists — correct a claim by replacing it, not by annotating it.

- [ ] **Step 5: Update the three docs describing the old flow**

`docs/teacher-screens.md` 1.3, `docs/information-architecture.md:232-236`, `docs/product-concept.md:24`. Record what is built and why Profile is now the bio (it is the one part of setup that is genuinely optional) and why Share is a completion state rather than a row (nothing in the schema can record that a page was shared).

- [ ] **Step 6: Verify**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/schedule "src/app/(teacher)/schedule/page.tsx" docs/teacher-screens.md docs/information-architecture.md docs/product-concept.md
git commit -m "feat(onboarding): five-state checklist with skippable steps and a share completion card"
```

---

## Proving each guard bites

Per `solve-issue` §3, after Task 6 and before the PR. Break it, record the **exact** error text, restore, re-verify. Curl each touched route once after applying a mutation before reading the verdict — `next dev` compiles lazily, and a first-request timeout reads exactly like an assertion failure.

| Guard | Mutation | Must fail with |
|---|---|---|
| The signup marker | Mint the token as `sign_in` in `teacher-signup/route.ts` | Verify answers 400 "Account not found"; no `Account` row |
| Ticket single-use | Make `consumeSignupTicket` read without deleting | The spent-ticket test's second call returns 201 instead of 401 |
| Ticket TTL | Set `TICKET_TTL_MS` to 15 minutes and back-date a ticket to 20 minutes old | Submit 401s, and the form is asserted to still hold every typed field |
| `peekSignupTicket` does not consume | Call it, then `consumeSignupTicket` with the same token | The consume must still succeed — a peek that deleted would 401 every real signup |
| Ticket purpose | Mint the ticket as `sign_in` | `consumeSignupTicket` returns null; route answers 401 |
| `SLUG_TAKEN` | Catch `['email']` before `['pageSlug']` | The race test sees `ALREADY_TEACHER` where it expects `SLUG_TAKEN` |
| Reserved slug | Submit `signup` as a page address | Rejected in the browser by `pageSlugField` **and** by the route, independently — disable the client check to confirm the server one alone bites |
| Address never from the body | Add `email` to `teacherProfileSchema` and send a foreign one | `.strict()` rejects it; with `.strict()` removed, assert the created teacher still carries the ticket's address |
| Required steps unskippable | `POST /api/account/onboarding { step: 'room' }` | Fails to typecheck (`OnboardingStep` has no `room`) **and** 400s at the route |

The last row is the compiler tether working as designed: the enum names only the skippable steps, so skipping a required one is not expressible.

---

## Self-review

**Spec coverage.** Decision 1 → Tasks 1–2 (marker, ticket, no session). Decision 2 → Task 4. Decision 3 → Tasks 1, 5 (address required, bio skippable). Decision 4 → Tasks 1, 6 (skip control, retirement rule). Decision 5 → Tasks 2, 5 (advisory live check, no suggestions, degrade-not-block). Decision 6 → Task 3 (deletion, ported tests, invalidation sweep). Data model → Task 1. Comments to correct → Tasks 2, 3, 6. Every acceptance criterion maps to a task.

**Type consistency.** `resolveSteps`/`isOnboardingComplete` take the same `StepInput` in Tasks 1 and 6. `mintSignupTicket`/`consumeSignupTicket`/`setSignupTicketCookie`/`clearSignupTicketCookie` are defined in Task 2 Step 5 and used in Steps 8 and 10 under those exact names. `pageSlugField` is defined in Task 1 and consumed in Tasks 2 and 5. `SIGNUP_TICKET_COOKIE` is `'fair_yoga_signup'` in the helper, the route, and the tests.

**Known gap, deliberate.** Task 5's landing page ships one sentence of copy. `implementation-plan.md` 7.10 is the design pass and is filed as its own issue — see the spec's *Not doing*.
