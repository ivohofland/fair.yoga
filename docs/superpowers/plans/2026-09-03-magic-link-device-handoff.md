# Magic Link Device Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A magic link opened on a browser that did not request it stops consuming the token and instead shows a 6-digit code, which the user carries back to the browser that started the flow — closing both an interception hole and an availability bug where a JS-executing mail scanner burns links before the user clicks.

**Architecture:** Every door that emails a sign-in link first binds an httpOnly per-browser nonce (`fair_yoga_origin`) and records its hash on the token row. At verify, a matching nonce consumes the token as today; a missing or mismatched one consumes nothing and stamps a 6-digit code on the row instead. A new claim endpoint trades (nonce + code) for a session on the requesting browser. Minting, binding, URL construction and sending collapse into one function so a future door cannot email a link without binding a nonce.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (unit/components/integration projects), Playwright (e2e), `@oslojs/crypto` for SHA-256, Node `crypto` for randomness.

**Spec:** `docs/superpowers/specs/2026-09-03-magic-link-device-handoff-design.md`

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types. The compiler is the first line of defence.
- **Test-first.** Every step below is written test → fail → implement → pass → commit. No exceptions.
- **Task order is load-bearing.** 1 → 2 → 3 → 4 → 5 → 6. Task 2 consumes Task 1's nonce module; Task 3 consumes Task 2's column binding; Task 4 consumes Task 3's code stamping; Task 5 consumes Task 4's endpoint. Do not parallelise.
- **Cookie flags** match the two existing cookies exactly: `HttpOnly; SameSite=Lax; Path=/`, plus `; Secure` **only** when `process.env.NODE_ENV === 'production'` (`src/lib/auth/session.ts:142-148`). Local dev is plain HTTP; a hard-coded `Secure` breaks it.
- **Cookie name:** `fair_yoga_origin`. Follows `fair_yoga_session` (`session.ts:7`) and `fair_yoga_signup` (`signup-ticket.ts:5`).
- **Code format:** exactly 6 decimal digits, zero-padded, generated with `crypto.randomInt(0, 1_000_000)` (unbiased — never `Math.random()` or `% 1000000`).
- **Attempt budget:** `HANDOFF_MAX_ATTEMPTS = 5`.
- **Never edit an applied migration**, comments included — the checksum changes while `prisma migrate status` compares names, so nothing catches it until the next `prisma migrate dev` demands a reset.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `'src/app/(public)/verify/page.tsx'`.
- **Comment Discipline (CLAUDE.md).** A comment annotates the code it sits on. No counts, no rosters, no claims about other files in a docblock. Corrections replace, never annotate — no "this previously said".
- **Worktree constraint.** Integration and e2e cannot run locally here (both need the dev server on `:3000` and the shared dev DB). Run `npm run typecheck`, `npm run lint`, and `npx vitest run --project unit --project components`. CI is the signal for the integration and e2e tiers; the PR body cites the CI run for those, not a local `verify`.
- **Never kill or restart the dev server on `:3000`.** If one is running it is the user's.

---

### Task 1: Schema columns and the origin-nonce primitive

**Files:**
- Modify: `prisma/schema.prisma:1015-1023` (the `MagicLinkToken` model)
- Create: `prisma/migrations/<timestamp>_magic_link_origin_handoff/migration.sql` (generated)
- Create: `src/lib/auth/origin-nonce.ts`
- Create: `src/lib/auth/origin-nonce.test.ts`

**Interfaces:**
- Consumes: `hashToken` from `src/lib/auth/magic-link.ts:8` (existing, unchanged).
- Produces:
  - `ORIGIN_NONCE_COOKIE: 'fair_yoga_origin'`
  - `readOriginNonce(request: NextRequest): string | null`
  - `ensureOriginNonce(request: NextRequest, headers: Headers): string` — returns the existing nonce, or mints one and appends its `Set-Cookie` to `headers`
  - `clearOriginNonceCookie(headers: Headers): void`
  - `hashNonce(nonce: string): string`
  - Columns `originBrowserHash`, `handoffCode`, `handoffAttempts` on `MagicLinkToken`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/origin-nonce.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ORIGIN_NONCE_COOKIE,
  readOriginNonce,
  ensureOriginNonce,
  hashNonce,
} from './origin-nonce';

function requestWithCookie(value?: string): NextRequest {
  const headers = new Headers();
  if (value !== undefined) headers.set('cookie', `${ORIGIN_NONCE_COOKIE}=${value}`);
  return new NextRequest('http://localhost:3000/api/auth/magic-link/send', { headers });
}

describe('origin nonce', () => {
  it('reads nothing from a request with no cookie', () => {
    expect(readOriginNonce(requestWithCookie())).toBeNull();
  });

  it('reads back the nonce it was given', () => {
    expect(readOriginNonce(requestWithCookie('abc123'))).toBe('abc123');
  });

  it('mints a 64-hex nonce and sets a cookie when the browser has none', () => {
    const headers = new Headers();
    const nonce = ensureOriginNonce(requestWithCookie(), headers);

    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const cookie = headers.get('Set-Cookie');
    expect(cookie).toContain(`${ORIGIN_NONCE_COOKIE}=${nonce}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('reuses an existing nonce and sets no cookie — the nonce is per-browser, not per-request', () => {
    const headers = new Headers();
    const nonce = ensureOriginNonce(requestWithCookie('existing-nonce'), headers);

    expect(nonce).toBe('existing-nonce');
    expect(headers.get('Set-Cookie')).toBeNull();
  });

  it('omits Secure outside production, so local http dev works', () => {
    const headers = new Headers();
    ensureOriginNonce(requestWithCookie(), headers);
    expect(headers.get('Set-Cookie')).not.toContain('Secure');
  });

  it('hashes to 64 lowercase hex, and never returns the raw value', () => {
    const hash = hashNonce('some-nonce');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe('some-nonce');
    expect(hashNonce('some-nonce')).toBe(hash);
    expect(hashNonce('other-nonce')).not.toBe(hash);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/origin-nonce.test.ts`
Expected: FAIL — `Failed to resolve import "./origin-nonce"`.

- [ ] **Step 3: Add the schema columns**

In `prisma/schema.prisma`, replace the `MagicLinkToken` model body with:

```prisma
model MagicLinkToken {
  id         String           @id @default(uuid())
  tokenHash  String           @unique
  email      String
  redirectTo String?
  purpose    MagicLinkPurpose @default(sign_in)
  expiresAt  DateTime
  createdAt  DateTime         @default(now())

  originBrowserHash String?
  handoffCode       String?
  handoffAttempts   Int     @default(0)

  @@index([originBrowserHash])
}
```

Two decisions are baked in here, both deliberate:

**The index is required, not decorative.** The claim endpoint's only lookup key is `originBrowserHash`, and without it every claim attempt is a sequential scan of a table whose only bound is a daily sweep.

**`handoffCode` is stored in plain text, and that is correct.** The instinct in this table is to hash — `tokenHash` and `originBrowserHash` both do. It would be false comfort here: a 6-digit space is 10⁶, so a database reader inverts a hash of it instantly. Worse, hashing makes the column *unreadable*, and §6 of the spec requires the same code to be returned on a repeated open — otherwise anyone holding the link could churn the code out from under a user mid-typing. **The credential is the pair (nonce ∧ code)**, and the nonce is the half carrying the security: 32 random bytes, hashed. Do not add a comment claiming this column is protected.

- [ ] **Step 4: Generate and apply the migration**

Run: `npx prisma migrate dev --name magic_link_origin_handoff`
Expected: a new directory under `prisma/migrations/`, and `prisma generate` runs. All three columns are nullable or defaulted, so no backfill is needed — a null `originBrowserHash` means "minted before this change" and behaves as a mismatch, which is the safe direction.

- [ ] **Step 5: Write the implementation**

Create `src/lib/auth/origin-nonce.ts`:

```ts
import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { hashToken } from './magic-link';

/** Names the browser that asked for a sign-in link. Sibling of
 *  `fair_yoga_session` and `fair_yoga_signup`; same flags. */
export const ORIGIN_NONCE_COOKIE = 'fair_yoga_origin';

/** A year: this identifies a browser across many sign-ins, not one ceremony.
 *  A short life would push returning users into the handoff branch for no
 *  security gain, since the nonce is worthless without a live token. */
const NONCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Same SHA-256 the token column uses. Only the hash is ever persisted, so a
 *  database read yields no usable nonce. */
export function hashNonce(nonce: string): string {
  return hashToken(nonce);
}

export function readOriginNonce(request: NextRequest): string | null {
  return request.cookies.get(ORIGIN_NONCE_COOKIE)?.value ?? null;
}

/**
 * Returns this browser's nonce, minting one and appending its `Set-Cookie` to
 * `headers` if it has none.
 *
 * Callers must invoke this for EVERY accepted request, before deciding whether
 * an account exists. The doors that use it answer a uniform 200 either way so
 * an anonymous caller cannot learn whether an address is registered; setting
 * the cookie only on the has-an-account branch would put that same fact back
 * into `Set-Cookie`.
 */
export function ensureOriginNonce(request: NextRequest, headers: Headers): string {
  const existing = readOriginNonce(request);
  if (existing) return existing;

  const nonce = crypto.randomBytes(32).toString('hex');
  let cookie = `${ORIGIN_NONCE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${NONCE_MAX_AGE_SECONDS}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
  return nonce;
}

export function clearOriginNonceCookie(headers: Headers): void {
  let cookie = `${ORIGIN_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}
```

`src/lib/auth/index.ts` is `export * from './...'` for each module, so add one line: `export * from './origin-nonce';`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/auth/origin-nonce.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Prove the Secure guard bites**

Temporarily change `process.env.NODE_ENV === 'production'` to `true` in `origin-nonce.ts`, re-run.
Expected: FAIL on "omits Secure outside production" with `expected 'fair_yoga_origin=...; Secure' not to contain 'Secure'`.
**Record the exact message, then restore the line and re-run to confirm green.** A guard that cannot fail certifies nothing.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/auth/origin-nonce.ts src/lib/auth/origin-nonce.test.ts src/lib/auth/index.ts
git commit -m "feat(auth): add the per-browser origin nonce and its token columns"
```

---

### Task 2: One delivery door, so a link cannot be emailed unbound

**Files:**
- Create: `src/lib/auth/link-delivery.ts`
- Create: `src/lib/auth/link-delivery.test.ts`
- Modify: `src/lib/email.ts:27-42` (`sendMagicLinkEmail`'s second parameter type)
- Modify: `src/app/api/auth/magic-link/send/route.ts:44-52`
- Modify: `src/app/api/auth/teacher-signup/route.ts:36-48`
- Modify: `src/app/api/auth/student-signup/route.ts:107-112`
- Modify: `src/lib/auth/index.ts`

**Interfaces:**
- Consumes: `ensureOriginNonce`, `hashNonce` (Task 1); `generateMagicLinkToken` (`magic-link.ts:34`, unchanged).
- Produces:
  - `type BoundSignInLink` — a branded string only `deliverSignInLink` can construct
  - `deliverSignInLink(db: PrismaClient, email: string, nonce: string, opts?: { redirectTo?: string; purpose?: MagicLinkPurpose }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/link-delivery.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { deliverSignInLink } from './link-delivery';
import { hashNonce } from './origin-nonce';

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  return { ...actual, sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined) };
});
import { sendMagicLinkEmail } from '@/lib/email';

const db = new PrismaClient();

describe('deliverSignInLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds the token to the nonce that asked for it', async () => {
    const email = `delivery-bind-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-abc');

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.originBrowserHash).toBe(hashNonce('nonce-abc'));
    expect(row?.handoffCode).toBeNull();
    expect(row?.handoffAttempts).toBe(0);
  });

  it('emails a /verify URL carrying the raw token, which is never persisted', async () => {
    const email = `delivery-url-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-def');

    expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
    const [to, link] = vi.mocked(sendMagicLinkEmail).mock.calls[0];
    expect(to).toBe(email);
    expect(link).toMatch(/\/verify\?token=[0-9a-f]{64}$/);

    const raw = new URL(link).searchParams.get('token')!;
    expect(await db.magicLinkToken.findFirst({ where: { tokenHash: raw } })).toBeNull();
  });

  it('carries redirectTo and purpose onto the row', async () => {
    const email = `delivery-opts-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-ghi', {
      redirectTo: '/studio/book/42',
      purpose: 'teacher_signup',
    });

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.redirectTo).toBe('/studio/book/42');
    expect(row?.purpose).toBe('teacher_signup');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/link-delivery.test.ts`
Expected: FAIL — `Failed to resolve import "./link-delivery"`.

- [ ] **Step 3: Write the delivery module**

Create `src/lib/auth/link-delivery.ts`:

```ts
import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import { sendMagicLinkEmail } from '@/lib/email';

declare const boundLinkBrand: unique symbol;

/**
 * A `/verify` URL whose token is bound to the browser that requested it.
 *
 * `sendMagicLinkEmail` accepts only this type, and only `deliverSignInLink`
 * below constructs one. That is what makes binding unforgettable: a new route
 * cannot email a sign-in link by assembling the URL itself, because a plain
 * `string` will not typecheck at the send call.
 */
export type BoundSignInLink = string & { readonly [boundLinkBrand]: true };

/**
 * Mints a link token bound to `nonce`, and emails it.
 *
 * The only path from an address to a sign-in email. Callers obtain `nonce`
 * from `ensureOriginNonce`, which they must call for every accepted request
 * regardless of whether an account exists.
 */
export async function deliverSignInLink(
  db: PrismaClient,
  email: string,
  nonce: string,
  opts?: { redirectTo?: string; purpose?: MagicLinkPurpose },
): Promise<void> {
  const token = await generateMagicLinkToken(db, email, {
    redirectTo: opts?.redirectTo,
    purpose: opts?.purpose,
    originBrowserHash: hashNonce(nonce),
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const link = `${baseUrl}/verify?token=${token}` as BoundSignInLink;
  await sendMagicLinkEmail(email, link);
}
```

- [ ] **Step 4: Teach `generateMagicLinkToken` the new column**

In `src/lib/auth/magic-link.ts`, extend the options object at `:37` and the `create` data at `:43-51`:

```ts
  opts?: {
    redirectTo?: string;
    purpose?: MagicLinkPurpose;
    ttlMs?: number;
    originBrowserHash?: string;
  },
```

```ts
  await db.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      redirectTo: opts?.redirectTo ?? null,
      purpose: opts?.purpose ?? 'sign_in',
      originBrowserHash: opts?.originBrowserHash ?? null,
      expiresAt,
    },
  });
```

Leave the rest of that function and its docblock untouched. It stays the pure minting primitive; `signup-ticket.ts:16` keeps calling it with no `originBrowserHash`, which is correct — a ticket is handed to a device already present and has no requesting browser.

- [ ] **Step 5: Narrow `sendMagicLinkEmail`'s parameter to the branded type**

In `src/lib/email.ts`, change only the signature at `:27-30`:

```ts
import type { BoundSignInLink } from '@/lib/auth/link-delivery';

export async function sendMagicLinkEmail(
  to: string,
  magicLink: BoundSignInLink
): Promise<void> {
```

`import type` erases at compile time, so this creates no runtime import cycle and does not pull server-only code into a client bundle. The body is unchanged, including the production dry-run guard at `:36-38` and the `[DEV]` log at `:39` — the log line stays exactly as it is, because no code exists until a link is opened without a nonce.

- [ ] **Step 6: Rewire all three doors**

`src/app/api/auth/magic-link/send/route.ts` — replace lines 44-52:

```ts
  // The nonce is established for EVERY accepted request, before the user
  // lookup below. This route answers a uniform 200 either way so an anonymous
  // caller cannot learn whether an address is registered; setting the cookie
  // only inside `if (user)` would put that same fact back into `Set-Cookie`.
  const response = respondOk({ message: 'If an account exists, a magic link has been sent.' });
  const nonce = ensureOriginNonce(request, response.headers);

  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const user = teacher ?? (await prisma.student.findUnique({ where: { email } }));

  if (user) {
    await deliverSignInLink(prisma, email, nonce, { redirectTo: redirect });
  }

  return response;
```

(the existing `teacher`/`user` lookup at `:41-42` moves below the response construction; delete the old copy so the lookup is not run twice.)

`src/app/api/auth/teacher-signup/route.ts` — replace lines 36-48:

```ts
  const response = respondOk({ message: 'Check your inbox for a link.' });
  const nonce = ensureOriginNonce(request, response.headers);

  await deliverSignInLink(prisma, email, nonce, {
    redirectTo: existing ? undefined : '/signup/profile',
    purpose,
  });

  return response;
```

Leave `:29-35` — the `existing` lookup and the `purpose` downgrade — exactly as they are.

`src/app/api/auth/student-signup/route.ts` — replace lines 107-112:

```ts
  const response = respondOk({ message: 'Check your inbox for a sign-in link.' });
  const nonce = ensureOriginNonce(request, response.headers);
  await deliverSignInLink(prisma, email, nonce, { redirectTo: redirect });
  return response;
```

Add to each file's imports: `import { ensureOriginNonce, deliverSignInLink } from '@/lib/auth';` and drop the now-unused `generateMagicLinkToken` / `sendMagicLinkEmail` imports.

Add `export * from './link-delivery';` to `src/lib/auth/index.ts`.

- [ ] **Step 7: Write the per-door integration test**

Create `tests/integration/magic-link-origin-binding.test.ts`. One case **per door** — an aggregate "some door binds a nonce" test would pass with two doors broken:

```ts
import { describe, it, expect } from 'vitest';
import { freshIp } from '../helpers';

const DOORS = [
  { name: 'magic-link/send', path: '/api/auth/magic-link/send', body: (e: string) => ({ email: e }) },
  { name: 'teacher-signup', path: '/api/auth/teacher-signup', body: (e: string) => ({ email: e }) },
  {
    name: 'student-signup',
    path: '/api/auth/student-signup',
    body: (e: string) => ({ firstName: 'Test', lastName: 'Student', email: e }),
  },
] as const;

describe('every door that emails a link binds an origin nonce', () => {
  for (const door of DOORS) {
    it(`${door.name} sets fair_yoga_origin for an address with no account`, async () => {
      const email = `nobody-${Date.now()}-${door.name.replace(/\W/g, '')}@example.com`;
      const res = await fetch(`http://localhost:3000${door.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': freshIp() },
        body: JSON.stringify(door.body(email)),
      });

      expect(res.status).toBe(200);
      // Unconditional: an unknown address must be indistinguishable from a
      // known one, in the cookie as well as the body.
      expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_origin=');
    });
  }
});
```

- [ ] **Step 8: Run the unit tests and the typecheck**

Run: `npx vitest run --project unit src/lib/auth/link-delivery.test.ts`
Expected: PASS, 3 tests.

Run: `npm run typecheck`
Expected: clean.

(The integration file cannot run in this worktree — no dev server, no shared DB. CI runs it.)

- [ ] **Step 9: Prove the tether bites**

In `src/app/api/auth/magic-link/send/route.ts`, temporarily add, right before the `return response`:

```ts
await sendMagicLinkEmail(email, `${process.env.NEXT_PUBLIC_APP_URL}/verify?token=deadbeef`);
```

Run: `npm run typecheck`
Expected: FAIL with `Argument of type 'string' is not assignable to parameter of type 'BoundSignInLink'`.
**Record the exact message, then delete the line and re-run to confirm clean.** This is the guard that makes "three doors" durable without a prose roster: a fourth door physically cannot email an unbound link.

- [ ] **Step 10: Prove the unconditional-cookie guard bites**

Move `ensureOriginNonce` inside the `if (user)` block in `send/route.ts`. The integration test for that door would go red on CI. Since it cannot run here, instead assert the shape locally: confirm by reading that `ensureOriginNonce` sits above the `teacher`/`user` lookup in all three routes, and note in the commit body that the per-door assertion is a CI signal. **Restore immediately.**

- [ ] **Step 11: Commit**

```bash
git add src/lib/auth/link-delivery.ts src/lib/auth/link-delivery.test.ts src/lib/auth/magic-link.ts src/lib/auth/index.ts src/lib/email.ts src/app/api/auth/magic-link/send/route.ts src/app/api/auth/teacher-signup/route.ts src/app/api/auth/student-signup/route.ts tests/integration/magic-link-origin-binding.test.ts
git commit -m "feat(auth): bind every emailed sign-in link to the browser that asked"
```

---

### Task 3: The handoff decision at verify

**Files:**
- Create: `src/lib/auth/handoff.ts`
- Create: `src/lib/auth/handoff.test.ts`
- Modify: `src/lib/auth/magic-link.ts` (extract the consume half; public signature unchanged)
- Modify: `src/app/api/auth/magic-link/verify/route.ts:14-55`
- Modify: `src/lib/auth/index.ts`

**Interfaces:**
- Consumes: `hashNonce`, `readOriginNonce` (Task 1); `hashToken` (`magic-link.ts:8`).
- Produces:
  - `type HandoffOutcome = { kind: 'verified'; email: string; redirectTo: string | null; purpose: MagicLinkPurpose } | { kind: 'handoff'; code: string } | { kind: 'invalid' }`
  - `verifyWithHandoff(db: PrismaClient, token: string, nonce: string | null): Promise<HandoffOutcome>`
  - `consumeTokenRow(db, row): Promise<boolean>` (internal to `magic-link.ts`, re-used by Task 4)

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/handoff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken } from './magic-link';
import { hashNonce } from './origin-nonce';
import { verifyWithHandoff } from './handoff';

const db = new PrismaClient();

async function mint(email: string, nonce: string | null) {
  return generateMagicLinkToken(db, email, {
    originBrowserHash: nonce ? hashNonce(nonce) : undefined,
  });
}

describe('verifyWithHandoff', () => {
  it('signs in directly when the nonce matches', async () => {
    const email = `handoff-match-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-1');

    const out = await verifyWithHandoff(db, token, 'nonce-1');

    expect(out).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('returns a 6-digit code and CONSUMES NOTHING when the nonce is absent', async () => {
    const email = `handoff-absent-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-2');

    const out = await verifyWithHandoff(db, token, null);

    expect(out.kind).toBe('handoff');
    if (out.kind !== 'handoff') throw new Error('unreachable');
    expect(out.code).toMatch(/^\d{6}$/);

    // The scanner case: the row must survive so the human can still sign in.
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row).not.toBeNull();
    expect(row?.handoffCode).not.toBeNull();
  });

  it('returns a code when the nonce belongs to a different browser', async () => {
    const email = `handoff-other-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-3');

    const out = await verifyWithHandoff(db, token, 'a-different-browser');

    expect(out.kind).toBe('handoff');
    expect(await db.magicLinkToken.findFirst({ where: { email } })).not.toBeNull();
  });

  it('reuses one code across repeated opens, so an attacker cannot churn it', async () => {
    const email = `handoff-stable-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-4');

    const first = await verifyWithHandoff(db, token, null);
    const second = await verifyWithHandoff(db, token, null);

    expect(first).toEqual(second);
  });

  it('lets the real browser still sign in after a stranger stamped a code', async () => {
    const email = `handoff-nopoison-${Date.now()}@example.com`;
    const token = await mint(email, 'nonce-5');

    await verifyWithHandoff(db, token, null); // stranger opens it
    const out = await verifyWithHandoff(db, token, 'nonce-5'); // owner taps it

    expect(out.kind).toBe('verified');
  });

  it('is invalid for an expired token, and does not stamp a code', async () => {
    const email = `handoff-expired-${Date.now()}@example.com`;
    const token = await generateMagicLinkToken(db, email, { ttlMs: -1000 });

    expect(await verifyWithHandoff(db, token, null)).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffCode ?? null).toBeNull();
  });

  it('is invalid for a token that does not exist', async () => {
    expect(await verifyWithHandoff(db, 'not-a-real-token', null)).toEqual({ kind: 'invalid' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: FAIL — `Failed to resolve import "./handoff"`.

- [ ] **Step 3: Extract the consume half of `verifyMagicLinkToken`**

In `src/lib/auth/magic-link.ts`, add an exported helper and have `verifyMagicLinkToken` call it. **The public signature and behaviour of `verifyMagicLinkToken` do not change** — `consumeSignupTicket` (`signup-ticket.ts:52`) depends on it exactly as it is.

```ts
/**
 * The atomic single-use delete plus the sibling purge, shared by the two paths
 * that consume a token: a same-browser verify, and a code claim.
 *
 * Returns false when another concurrent caller won the delete.
 */
export async function consumeTokenRow(
  db: PrismaClient,
  row: { id: string; email: string; expiresAt: Date },
): Promise<boolean> {
  const deleted = await db.magicLinkToken.deleteMany({ where: { id: row.id } });
  if (deleted.count === 0) return false;
  if (row.expiresAt <= new Date()) return false;

  await db.magicLinkToken.deleteMany({ where: { email: row.email } });
  return true;
}
```

Move the three existing comment blocks at `:81-96` onto this function verbatim — they explain the sibling purge, the load-bearing placement after the expiry check, and why the delete is unindexed. They still annotate the code they sit on. Then `verifyMagicLinkToken`'s body becomes:

```ts
  const record = await db.magicLinkToken.findUnique({ where: { tokenHash } });
  if (!record) return null;
  if (!(await consumeTokenRow(db, record))) return null;
  return { email: record.email, redirectTo: record.redirectTo, purpose: record.purpose };
```

- [ ] **Step 4: Write the handoff module**

Create `src/lib/auth/handoff.ts`:

```ts
import crypto from 'crypto';
import type { PrismaClient, MagicLinkPurpose } from '@prisma/client';
import { hashToken, consumeTokenRow } from './magic-link';
import { hashNonce } from './origin-nonce';

export type HandoffOutcome =
  | { kind: 'verified'; email: string; redirectTo: string | null; purpose: MagicLinkPurpose }
  | { kind: 'handoff'; code: string }
  | { kind: 'invalid' };

/** `randomInt` is rejection-sampled, so every code is equally likely.
 *  `randomBytes(n) % 1_000_000` would not be. */
function generateHandoffCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Decides what a link-open does, given the browser that opened it.
 *
 * A matching nonce consumes the token, exactly as before. Anything else —
 * no cookie, or another browser's — consumes NOTHING and stamps a code the
 * user carries back. That branch is what a mail scanner reaches, which is why
 * it must leave the row spendable.
 *
 * Deliberately not routed through `verifyMagicLinkToken`: that function
 * deletes before it checks anything, so a peek has to come first. Its other
 * caller redeems a ticket on a device already holding it and must never reach
 * this decision — see the plan's Task 3 and the spec's §3.
 */
export async function verifyWithHandoff(
  db: PrismaClient,
  token: string,
  nonce: string | null,
): Promise<HandoffOutcome> {
  const row = await db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!row) return { kind: 'invalid' };
  if (row.expiresAt <= new Date()) return { kind: 'invalid' };

  const sameBrowser = nonce !== null && row.originBrowserHash === hashNonce(nonce);

  if (sameBrowser) {
    if (!(await consumeTokenRow(db, row))) return { kind: 'invalid' };
    return {
      kind: 'verified',
      email: row.email,
      redirectTo: row.redirectTo,
      purpose: row.purpose,
    };
  }

  // Stamped once and reused. Regenerating per open would let anyone holding
  // the link invalidate a code the owner is mid-way through typing — which is
  // also why this column is readable rather than hashed.
  if (row.handoffCode) return { kind: 'handoff', code: row.handoffCode };

  const code = generateHandoffCode();
  await db.magicLinkToken.update({
    where: { id: row.id },
    data: { handoffCode: code },
  });
  return { kind: 'handoff', code };
}
```

- [ ] **Step 5: Rewire the verify route**

`src/app/api/auth/magic-link/verify/route.ts` — replace `:19-24`:

```ts
  const outcome = await verifyWithHandoff(prisma, token, readOriginNonce(request));

  if (outcome.kind === 'invalid') {
    return respondError('Invalid or expired magic link', 400);
  }

  if (outcome.kind === 'handoff') {
    // Nothing was consumed. The client shows the code; the browser that
    // requested the link trades it for a session at /claim.
    return respondOk({ handoffCode: outcome.code });
  }

  const { email, redirectTo: tokenRedirect, purpose } = outcome;
```

Everything from `:26` (`resolveOrClaimAccount`) onward is unchanged, including the `teacher_signup` ticket branch.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts src/lib/auth/magic-link.test.ts`
Expected: PASS. `magic-link.test.ts` must pass **unedited** — that is the tether proving `verifyMagicLinkToken` kept its contract.

- [ ] **Step 7: Prove the signup-ticket path is untouched**

Run: `npm run typecheck` and confirm `src/lib/auth/signup-ticket.ts` was not modified: `git diff --stat src/lib/auth/signup-ticket.ts` must be empty.

Then the mutation: temporarily change `signup-ticket.ts:52` to `const result = await verifyWithHandoff(db, token, null);` and adapt the shape enough to compile.
Expected: `magic-link.test.ts`'s purpose round-trip and the ticket tests break, because a ticket redemption now returns a handoff instead of an email.
**Record the failure, restore the line, re-run to confirm green.** This is the guard against the sharpest trap in the change.

- [ ] **Step 8: Prove the no-consume guard bites**

In `handoff.ts`, temporarily make the handoff branch call `consumeTokenRow(db, row)` before returning.
Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: FAIL on "returns a 6-digit code and CONSUMES NOTHING" with `expected null not to be null`.
**Record it, restore, re-run.** This is Defect B's regression guard — the whole availability argument rests on this branch leaving the row spendable.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/handoff.ts src/lib/auth/handoff.test.ts src/lib/auth/magic-link.ts src/lib/auth/index.ts prisma/schema.prisma prisma/migrations src/app/api/auth/magic-link/verify/route.ts
git commit -m "feat(auth): show a handoff code instead of burning a link opened elsewhere"
```

---

### Task 4: The claim endpoint

**Files:**
- Create: `src/app/api/auth/magic-link/claim/route.ts`
- Create: `tests/integration/magic-link-claim.test.ts`
- Modify: `src/lib/auth/handoff.ts` (add `claimWithCode`)
- Modify: `src/lib/auth/handoff.test.ts`
- Modify: `src/lib/rate-limit.ts:37-58`
- Modify: `src/lib/schemas.ts:135-137`

**Interfaces:**
- Consumes: `HandoffOutcome`, `consumeTokenRow`, `hashNonce`, `readOriginNonce`, `createSession`, `setSessionCookie`, `resolveOrClaimAccount`, `mintSignupTicket`, `setSignupTicketCookie`, `isSafeRelativePath`.
- Produces: `claimWithCode(db: PrismaClient, nonce: string | null, code: string): Promise<HandoffOutcome>`; `magicLinkClaimSchema`; rate-limit prefix `'magic-link:claim'`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/auth/handoff.test.ts`:

```ts
import { claimWithCode, HANDOFF_MAX_ATTEMPTS } from './handoff';

describe('claimWithCode', () => {
  async function stampedToken(email: string, nonce: string) {
    const token = await mint(email, nonce);
    const out = await verifyWithHandoff(db, token, null);
    if (out.kind !== 'handoff') throw new Error('expected a handoff');
    return out.code;
  }

  it('signs in the browser that requested the link', async () => {
    const email = `claim-ok-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c1');

    const out = await claimWithCode(db, 'nonce-c1', code);

    expect(out).toEqual({ kind: 'verified', email, redirectTo: null, purpose: 'sign_in' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('refuses a correct code presented by a browser that did not ask', async () => {
    const email = `claim-wrongbrowser-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c2');

    expect(await claimWithCode(db, 'someone-elses-browser', code)).toEqual({ kind: 'invalid' });
    // The real browser can still finish.
    expect((await claimWithCode(db, 'nonce-c2', code)).kind).toBe('verified');
  });

  it('refuses a wrong code and counts the attempt', async () => {
    const email = `claim-wrongcode-${Date.now()}@example.com`;
    await stampedToken(email, 'nonce-c3');

    expect(await claimWithCode(db, 'nonce-c3', '000000')).toEqual({ kind: 'invalid' });
    const row = await db.magicLinkToken.findFirst({ where: { email } });
    expect(row?.handoffAttempts).toBe(1);
  });

  it('destroys the token once the attempt budget is spent', async () => {
    const email = `claim-budget-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c4');

    for (let i = 0; i < HANDOFF_MAX_ATTEMPTS; i++) {
      await claimWithCode(db, 'nonce-c4', '000000');
    }

    // Even the correct code is dead now.
    expect(await claimWithCode(db, 'nonce-c4', code)).toEqual({ kind: 'invalid' });
    expect(await db.magicLinkToken.findFirst({ where: { email } })).toBeNull();
  });

  it('is invalid when the browser has no nonce at all', async () => {
    const email = `claim-nononce-${Date.now()}@example.com`;
    const code = await stampedToken(email, 'nonce-c5');
    expect(await claimWithCode(db, null, code)).toEqual({ kind: 'invalid' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: FAIL — `claimWithCode is not exported`.

- [ ] **Step 3: Implement `claimWithCode`**

Append to `src/lib/auth/handoff.ts`:

```ts
/** A 6-digit code is 10⁶, brute-forceable inside the token's fifteen minutes.
 *  This budget is the guard that does not depend on the nonce staying secret. */
export const HANDOFF_MAX_ATTEMPTS = 5;

/**
 * Trades a code for the token it was stamped on, for the browser that
 * requested the link.
 *
 * Looks up by nonce rather than by code, so a wrong guess still finds the row
 * whose budget it must spend. Looking up by both would leave the attempt
 * counter unreachable and the budget unenforceable.
 */
export async function claimWithCode(
  db: PrismaClient,
  nonce: string | null,
  code: string,
): Promise<HandoffOutcome> {
  if (nonce === null) return { kind: 'invalid' };

  const row = await db.magicLinkToken.findFirst({
    where: { originBrowserHash: hashNonce(nonce), handoffCode: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) return { kind: 'invalid' };

  if (row.handoffAttempts >= HANDOFF_MAX_ATTEMPTS) {
    await db.magicLinkToken.deleteMany({ where: { id: row.id } });
    return { kind: 'invalid' };
  }

  if (row.handoffCode !== code) {
    const spent = row.handoffAttempts + 1;
    await db.magicLinkToken.update({
      where: { id: row.id },
      data: { handoffAttempts: spent },
    });
    if (spent >= HANDOFF_MAX_ATTEMPTS) {
      await db.magicLinkToken.deleteMany({ where: { id: row.id } });
    }
    return { kind: 'invalid' };
  }

  if (!(await consumeTokenRow(db, row))) return { kind: 'invalid' };
  return { kind: 'verified', email: row.email, redirectTo: row.redirectTo, purpose: row.purpose };
}
```

- [ ] **Step 4: Register the rate-limit partition**

In `src/lib/rate-limit.ts`, add `| 'magic-link:claim'` to the `RateLimitPrefix` union at `:37-46`, and `'magic-link:claim': 2_000,` to `PREFIX_CAPACITIES` at `:48-58`. The `satisfies Record<RateLimitPrefix, number>` at `:58` makes omitting either half a compile error — that is the existing tether; do not work around it.

- [ ] **Step 5: Add the request schema**

In `src/lib/schemas.ts`, after `magicLinkVerifySchema` at `:135-137`:

```ts
export const magicLinkClaimSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the six-digit code'),
});
```

- [ ] **Step 6: Write the route**

Create `src/app/api/auth/magic-link/claim/route.ts`:

```ts
import { NextRequest } from 'next/server';
import {
  claimWithCode,
  readOriginNonce,
  createSession,
  setSessionCookie,
  resolveOrClaimAccount,
  mintSignupTicket,
  setSignupTicketCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { magicLinkClaimSchema, isSafeRelativePath } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, RateLimitResult } from '@/lib/rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 30;

function tooManyRequests(result: RateLimitResult) {
  const retry = result.retryAfterSeconds;
  return respondError(
    `Too many attempts. Try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}.`,
    429,
  );
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const ipCheck = checkIpRateLimit(
    'magic-link:claim', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'magic-link/claim',
  );
  if (!ipCheck.allowed) return tooManyRequests(ipCheck);

  const parsed = await parseBody(request, magicLinkClaimSchema);
  if ('error' in parsed) return parsed.error;

  const outcome = await claimWithCode(prisma, readOriginNonce(request), parsed.data.code);
  if (outcome.kind !== 'verified') {
    // One message for a wrong code, an unknown code and a spent budget: the
    // three are indistinguishable to a caller by design.
    return respondError('That code did not work. Ask for a new link.', 400);
  }

  const { email, redirectTo: tokenRedirect, purpose } = outcome;
  const resolved = await resolveOrClaimAccount(prisma, email);

  if (!resolved && purpose === 'teacher_signup') {
    const ticket = await mintSignupTicket(prisma, email);
    const response = respondOk({ redirectTo: '/signup/profile' });
    setSignupTicketCookie(response.headers, ticket);
    return response;
  }

  if (!resolved) return respondError('Account not found', 400);

  const sessionToken = await createSession(prisma, resolved.accountId);
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;

  const response = respondOk({ accountId: resolved.accountId, redirectTo });
  setSessionCookie(response.headers, sessionToken);
  return response;
});
```

- [ ] **Step 7: Write the integration test**

Create `tests/integration/magic-link-claim.test.ts` covering, over HTTP against `:3000`: request a link with a cookie jar, open `/verify` **without** the cookie to get a code, then POST `/claim` **with** the cookie and assert a `fair_yoga_session` cookie comes back and the `redirect` is preserved. Reuse `freshIp()` from `tests/helpers.ts` so each request has its own `x-forwarded-for`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: PASS, 12 tests (7 from Task 3 + 5 here).

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 9: Prove the budget bites**

Delete the `handoffAttempts` increment in `claimWithCode`.
Run: `npx vitest run --project unit src/lib/auth/handoff.test.ts`
Expected: FAIL on "refuses a wrong code and counts the attempt" (`expected 0 to be 1`) and on "destroys the token once the attempt budget is spent".
**Record both, restore, re-run.**

Then the second mutation: change the lookup to key on `handoffCode` as well as `originBrowserHash`.
Expected: the budget test fails, because a wrong guess no longer finds a row to charge.
**Record, restore, re-run.**

- [ ] **Step 10: Commit**

```bash
git add src/app/api/auth/magic-link/claim/route.ts src/lib/auth/handoff.ts src/lib/auth/handoff.test.ts src/lib/rate-limit.ts src/lib/schemas.ts tests/integration/magic-link-claim.test.ts
git commit -m "feat(auth): trade a handoff code for a session on the requesting browser"
```

---

### Task 5: The shared code panel, the code display, and the false copy

**Files:**
- Create: `src/components/auth/handoff-code-entry.tsx`
- Create: `src/components/auth/handoff-code-entry.test.tsx`
- Modify: `src/app/(public)/verify/page.tsx:80-92`, `:164-205`, `:240-280`
- Modify: `src/app/(public)/login/page.tsx:30-45`
- Modify: `src/components/booking/booking-sign-in.tsx:45-60`
- Modify: `src/components/signup/signup-form.tsx:55-70`
- Modify: `src/components/signup/profile-setup-form.tsx` (the `expired` status panel)

**Interfaces:**
- Consumes: `POST /api/auth/magic-link/claim` (Task 4).
- Produces: `<HandoffCodeEntry />` — a self-contained form posting to `/claim` and navigating to the returned `redirectTo`. Props: `{ className?: string }`. No props carry state; the cookie does.

- [ ] **Step 1: Write the failing component test**

Create `src/components/auth/handoff-code-entry.test.tsx`. Cover: it renders the explanatory line and a 6-digit input; submitting posts the code to `/api/auth/magic-link/claim`; a 400 renders the server's message without clearing what was typed; a success navigates to the returned `redirectTo`. Follow the existing mock-`fetch` pattern in `src/components/signup/signup-form.test.tsx:40`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project components src/components/auth/handoff-code-entry.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Build the shared component**

Create `src/components/auth/handoff-code-entry.tsx`. Requirements, all load-bearing:

- `inputMode="numeric"`, `autoComplete="one-time-code"`, `maxLength={6}`, `pattern="\d{6}"`.
- Copy: *"Opened it somewhere else? That device will show you a code — enter it here."* **Do not write "a different device."** Gmail and Outlook on iOS open links in an in-app webview with its own cookie jar, so a genuinely same-phone tap can legitimately land in the handoff branch; wording that asserts a different *device* would be false for those users.
- On success, `window.location.assign(redirectTo)` — a full navigation, not `router.push`, because the session cookie was just set and server components must re-render against it.
- Tokens only, per the design system: `type-body` / `type-label` for text, `cursor: pointer` comes from global CSS, no shadows, no transitions.

- [ ] **Step 4: Mount it in all four panels**

Add `<HandoffCodeEntry />` beneath the existing "Check your inbox" text in each of:
`src/app/(public)/login/page.tsx:35`, `src/components/booking/booking-sign-in.tsx:49`, `src/components/signup/signup-form.tsx:59`, and the `expired` panel of `src/components/signup/profile-setup-form.tsx`.

Each panel keeps its own surrounding sentence — the booking one says the link "brings you straight back here" (`booking-sign-in.tsx:51`) and that stays. Only the code block is shared, so the copy cannot drift between the sign-in and signup halves.

The `profile-setup-form.tsx` panel gets one extra line, because its stakes differ: say the draft is kept. The user is deciding whether to abandon the tab, and the answer is no.

- [ ] **Step 5: Render the code on `/verify`, and delete the false copy**

In `src/app/(public)/verify/page.tsx`:

- Add a `handoff` state rendering the 6-digit code large, the instruction *"Enter this where you started"*, and a **"Sign in here instead"** link to `/login` — the escape hatch for a lost original tab and for the in-app-webview case.
- `:85-87` currently reads *"We're confirming it's still valid and that it was meant for this device."* **Replace** it with wording true of the check that now happens. Do not annotate it; per Comment Discipline the correction replaces, and the before-and-after goes in the PR body.
- `:180` currently offers *"It was opened on a device that wasn't expecting it"* as a reason a link failed. That is no longer a failure mode — it is now a handoff — so **remove the bullet** rather than reword it.
- Extend the `useEffect` at `:243-249` to branch on `handoffCode` in the response.

- [ ] **Step 6: Run the component tests**

Run: `npx vitest run --project components`
Expected: PASS, including the pre-existing `signup-form.test.tsx` and `profile-setup-form.test.tsx` unedited.

- [ ] **Step 7: Prove the copy claim is gone**

Run: `grep -rn "meant for this device\|wasn't expecting it" 'src/app/(public)/verify/page.tsx'`
Expected: no output. If either string survives, the defect this task exists to fix is still shipping.

- [ ] **Step 8: Commit**

```bash
git add src/components/auth/handoff-code-entry.tsx src/components/auth/handoff-code-entry.test.tsx 'src/app/(public)/verify/page.tsx' 'src/app/(public)/login/page.tsx' src/components/booking/booking-sign-in.tsx src/components/signup/signup-form.tsx src/components/signup/profile-setup-form.tsx
git commit -m "feat(auth): carry the handoff code across all four inbox panels"
```

---

### Task 6: The 2×2 e2e matrix, and the docs that were already wrong

**Files:**
- Modify: `tests/e2e/auth.spec.ts:13-24` (the token helper) and its 7 real-token navigations
- Modify: `tests/e2e/booking.spec.ts`, `tests/e2e/teacher-signup.spec.ts` (their `/verify?token=` navigations)
- Create: `tests/e2e/magic-link-handoff.spec.ts`
- Modify: `docs/technical-architecture.md:326-333`, `:574`, `:617`
- Modify: `README.md:30`
- Modify: `.claude/skills/verify/SKILL.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `createMagicLinkToken(email, nonce)` — the e2e helper now mints a token *and* its originating browser.

- [ ] **Step 1: Teach the e2e helper to mint a browser too**

In `tests/e2e/auth.spec.ts`, replace `createMagicLinkToken` at `:13-24`:

```ts
import { createHash } from 'crypto';

/** Mints a token AND the browser that "requested" it, so a test can choose
 *  which branch it is exercising. Pass the same nonce to `context.addCookies`
 *  for a same-browser open; pass a different one for a handoff. */
async function createMagicLinkToken(email: string, nonce: string): Promise<string> {
  const rawToken = generateToken();
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      email,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: createHash('sha256').update(nonce).digest('hex'),
    },
  });
  return rawToken;
}

async function asOriginBrowser(context: BrowserContext, nonce: string) {
  await context.addCookies([
    { name: 'fair_yoga_origin', value: nonce, domain: 'localhost', path: '/' },
  ]);
}
```

Update the 6 call sites to pass a nonce, and call `asOriginBrowser` before each of the 7 real-token navigations so the existing tests keep asserting **same-browser** behaviour.

**No bypass environment variable.** An env-var auth bypass is exactly the shape that leaks to production, and `src/lib/email.ts:36-38` shows this codebase already paying attention to that risk. Making tests convenient is not worth a second, more dangerous one.

- [ ] **Step 2: Run the existing e2e specs**

Cannot run in this worktree — no dev server, no shared DB. Run `npm run typecheck` to confirm the specs compile, and note in the commit body that CI is the signal.

- [ ] **Step 3: Write the 2×2 matrix**

Create `tests/e2e/magic-link-handoff.spec.ts` with one end-to-end case per cell, each using **two browser contexts** — one holding the nonce, one not:

| | Sign-in | Signup |
|---|---|---|
| **Teacher** | `/login` → same-browser, and handoff | `/signup` → handoff lands the ticket on the requesting browser |
| **Student** | booking page, returning mode | booking page, new mode → handoff **preserves the class `redirect`** |

The student-signup cell must assert the `redirect` survives: it is the only path where a token's `redirectTo` and a second browser interact, and losing it drops a student on `/bookings` instead of the class they were booking.

Add one scanner-regression case: open `/verify?token=` in a context with **no** nonce, assert a code is shown, then assert the original context can still claim it. That is Defect B, and nothing tested it before.

- [ ] **Step 4: Correct the two documentation defects**

`docs/technical-architecture.md:326-333` calls the flow "a signed token (oslo/crypto)". Nothing is signed — generation is `crypto.randomBytes` and oslo supplies only the SHA-256. Rewrite it to describe a random token whose hash is stored, and add the handoff.

`MAGIC_LINK_SECRET` is read nowhere in the code. Remove it from `README.md:30`, `docs/technical-architecture.md:574` and `:617`. Re-derive before and after:

```bash
grep -rn "MAGIC_LINK_SECRET" . --include="*.md" --include="*.ts" --include="*.tsx" --include="*.env*"
```

Expected after: no hits outside git history.

- [ ] **Step 5: Add the local handoff recipe to the verify skill**

In `.claude/skills/verify/SKILL.md`, record that opening the `[DEV]` link from the server log **in a private window** exercises the handoff branch, because that window carries no `fair_yoga_origin` cookie — and that pasting it back into the same browser is still a one-tap same-browser sign-in, so the ordinary dev loop is unchanged.

- [ ] **Step 6: Run everything runnable here**

```bash
npm run typecheck
npm run lint
npx vitest run --project unit --project components
```

Expected: all green. Do **not** run `--project integration` from this worktree; it hangs on `ECONNREFUSED`.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/auth.spec.ts tests/e2e/booking.spec.ts tests/e2e/teacher-signup.spec.ts tests/e2e/magic-link-handoff.spec.ts docs/technical-architecture.md README.md .claude/skills/verify/SKILL.md
git commit -m "test(auth): cover the handoff across both roles and both flows"
```

---

## After the tasks

- **Whole-branch review** on the most capable model, then one fix wave, then one scoped re-review. This plan has 6 tasks, so it qualifies: task reviewers see only their own diff, and the cross-task risks here are real — the `verifyMagicLinkToken` contract (Tasks 3-4), the branded-type tether (Tasks 2, 6), and copy consistency across four panels (Task 5).
- **Push and open the PR**, then `/pr-review-toolkit:review-pr <N>`. Include type-design in that review: `HandoffOutcome` and `BoundSignInLink` are the PR's subject, not incidental props interfaces.
- **PR body** must record: the two live defects found under #214 and that all seven of its claims held; what `verify/page.tsx:85-87` and `:180` used to say; the door and panel censuses with their re-derivation commands; and that the integration and e2e tiers are certified by **the CI run**, not a local `verify`, because this branch was built in a worktree. Write "**#214 is answered**" — never the auto-close phrasing.
- **File the one spin-out** the spec named as out of scope (§11): `verifyMagicLinkToken`'s sibling purge (`magic-link.ts:97`) deletes **every** row for an address, including a live `teacher_profile_pending` signup ticket — so signing in cancels an in-flight signup. File it as a *decision* ("should a sign-in link cancel an in-flight signup?") with the options laid out, not as work: it is a leaf needing a product call first, and this branch made it visible rather than worse. One issue in, one leaf filed out is the healthy ratio; resist filing anything else the PR review turns up unless it is a defect a user will actually hit.
