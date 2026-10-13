# Sign-in Subject Names Its Expiry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every sign-in email's subject names its expiry to the second in the requester's timezone (`Sign in to fair.yoga · valid until 22:29:37 CEST`), so two sign-in emails never share a subject and Gmail never threads or trims them (#825).

**Architecture:** The token mint exposes its `expiresAt`; the renderer formats it in a zone passed down from the request. The three sign-in routes accept an optional, silently-dropped-if-unrecognised `timeZone` field; the zone is a *required* `string | undefined` parameter all the way down, so forgetting to forward it is a compile error. Clients detect the zone at submit time.

**Tech Stack:** Next.js 16 route handlers, zod, Prisma, vitest (unit / components / integration projects), `Intl.DateTimeFormat`.

**Spec:** `docs/superpowers/specs/2026-10-13-sign-in-subject-expiry-design.md`

## Global Constraints

- Subject format, exactly: `Sign in to fair.yoga · valid until HH:MM:SS ZONE`. The separator is ` · ` (U+00B7 with a space each side).
- Time formatting: `new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' })`. Measured on Node 24: Amsterdam → `22:29:37 CEST` / `22:29:37 CET`; New York → `16:29:37 GMT-4`; UTC → `20:29:37 UTC`.
- The fallback zone is `'UTC'`. A zone that is missing, or that `isValidTimeZone` (`src/lib/iana-timezone.ts`) refuses, renders in UTC.
- The time shown is the token row's stored `expiresAt`, not a second `Date.now()` reading.
- The email's heading (`<h1>`, first argument to `wrapEmail`) stays `Sign in to fair.yoga`. The body copy does not change.
- An unrecognised zone in a request never produces a 400; it is dropped (same semantics as `detectedTimezoneField`, `src/lib/schemas.ts`).
- The HTTP response of every sign-in route must not change shape, status or headers because of the zone (the no-oracle rule, `docs/superpowers/specs/2026-10-07-sign-in-oracles-design.md`).
- Comments follow CLAUDE.md *Comment Discipline*: no counts or member lists of call sites in docblocks.
- Node 24 is required for pnpm: prefix commands with the nvm v24 bin on `PATH`.

## Review Focus

1. **A zone string that `Intl` rejects reaching the renderer** (e.g. a test or a future caller passing `'Mars/Olympus'`): the email must still send, in UTC. A `RangeError` would make a sign-in silently never arrive. Pinned in Task 1's template tests.
2. **The strict schemas (`teacherSignupSchema`, `studentSignupSchema`) refusing the new key**: every signup from an updated client would 400. Pinned by Task 1's schema tests and integration test.
3. **A render-time zone read on the client**: during SSR it returns the server's zone (UTC in the container), and React keeps that value through hydration, so every subject would say UTC while looking correct. `detectTimeZone` must be called inside the submit handler. Task 2's call sites all sit in event handlers; the reviewer checks none is hoisted to component scope.
4. **An expiry near midnight in a far-off zone** (e.g. Kolkata, `01:59:37 GMT+5:30`): the subject shows no date. That is acceptable, because the link lives for 15 minutes, so no test is needed; noted here so a reviewer doesn't add a date.
5. **Existing component tests asserting an exact body with `toEqual`**: they break once `timeZone` joins the body. Update them to include the zone, not loosen them to `objectContaining`, so they still catch an unexpected extra key.

---

### Task 1: Server: the subject, the mint, the forwarding and the request schemas

Order: this task must land before Task 2. Task 2's clients send a key that the strict schemas only accept after this task.

**Files:**
- Modify: `src/lib/auth/magic-link.ts`: add `mintMagicLinkToken`; `generateMagicLinkToken` becomes its wrapper
- Modify: `src/lib/email-templates.ts`: `renderMagicLinkEmail(magicLink, expiresAt, timeZone)`
- Modify: `src/lib/email.ts`: `sendMagicLinkEmail(to, magicLink, expiresAt, timeZone)`
- Modify: `src/lib/auth/link-delivery.ts`: `opts` becomes required and carries `timeZone`
- Modify: `src/lib/schemas.ts`: move `detectedTimezoneField` above `magicLinkSendSchema`; add `timeZone` to the three sign-in schemas
- Modify: `src/app/api/auth/magic-link/send/route.ts`, `src/app/api/auth/teacher-signup/route.ts`, `src/app/api/auth/student-signup/route.ts`: forward `timeZone`
- Test: `src/lib/email-templates.test.ts`, `src/lib/email.test.ts`, `src/lib/auth/magic-link.test.ts`, `src/lib/auth/link-delivery.test.ts`, `src/lib/schemas.test.ts`
- Create: `tests/integration/sign-in-time-zone.test.ts`

**Interfaces:**
- Produces:
  - `mintMagicLinkToken(db: PrismaClient, email: string, opts?: { redirectTo?: string; purpose?: MagicLinkPurpose; ttlMs?: number; originBrowserHash?: string }): Promise<{ token: string; expiresAt: Date }>`
  - `renderMagicLinkEmail(magicLink: string, expiresAt: Date, timeZone: string | undefined): RenderedEmail`
  - `sendMagicLinkEmail(to: string, magicLink: BoundSignInLink, expiresAt: Date, timeZone: string | undefined): Promise<void>`
  - `deliverSignInLink(db, email, nonce, opts: { timeZone: string | undefined; redirectTo?: string; purpose?: MagicLinkPurpose }): Promise<void>`
  - `deliverSignInLinkIfRegistered(db, email, nonce, opts: { timeZone: string | undefined; redirectTo?: string }): FireAndForget`
  - Request bodies of `POST /api/auth/magic-link/send`, `/api/auth/teacher-signup` and `/api/auth/student-signup` accept an optional `timeZone: string`.

- [ ] **Step 1: Write the failing template tests**

In `src/lib/email-templates.test.ts`, replace the existing `'magic-link email carries the link and the expiry note'` test, and add the new ones beside it:

```ts
  const SUMMER_EXPIRY = new Date('2026-10-13T20:29:37Z');

  it('magic-link email carries the link and the expiry note', () => {
    const { html } = renderMagicLinkEmail('https://example.test/verify?token=abc', SUMMER_EXPIRY, 'Europe/Amsterdam');
    expect(html).toContain('https://example.test/verify?token=abc');
    expect(html).toContain('expires in 15 minutes');
  });

  it('magic-link subject names the expiry, to the second, in the requester zone', () => {
    const { subject } = renderMagicLinkEmail('https://x', SUMMER_EXPIRY, 'Europe/Amsterdam');
    expect(subject).toBe('Sign in to fair.yoga · valid until 22:29:37 CEST');
  });

  it('magic-link subject follows the zone across a DST change', () => {
    const { subject } = renderMagicLinkEmail('https://x', new Date('2026-12-13T21:29:37Z'), 'Europe/Amsterdam');
    expect(subject).toBe('Sign in to fair.yoga · valid until 22:29:37 CET');
  });

  it('magic-link subject reads UTC, labelled, without a zone', () => {
    const { subject } = renderMagicLinkEmail('https://x', SUMMER_EXPIRY, undefined);
    expect(subject).toBe('Sign in to fair.yoga · valid until 20:29:37 UTC');
  });

  it('magic-link subject reads UTC for a zone Intl does not know, rather than throwing', () => {
    const { subject } = renderMagicLinkEmail('https://x', SUMMER_EXPIRY, 'Mars/Olympus_Mons');
    expect(subject).toBe('Sign in to fair.yoga · valid until 20:29:37 UTC');
  });

  it('two magic-link emails a second apart never share a subject (#825)', () => {
    const later = new Date(SUMMER_EXPIRY.getTime() + 1000);
    expect(renderMagicLinkEmail('https://x', SUMMER_EXPIRY, 'Europe/Amsterdam').subject).not.toBe(
      renderMagicLinkEmail('https://x', later, 'Europe/Amsterdam').subject,
    );
  });

  it('magic-link heading stays plain: the expiry is for the inbox list only', () => {
    const { html } = renderMagicLinkEmail('https://x', SUMMER_EXPIRY, 'Europe/Amsterdam');
    expect(html).not.toContain('valid until');
  });
```

Also update the two other existing call sites in that file (the `Unsubscribe` assertions near the footer tests, and the `&x=1` link-escaping test) to pass `SUMMER_EXPIRY, 'UTC'` as the extra arguments. Move `SUMMER_EXPIRY` to file scope if those tests live in a different `describe`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
Expected: FAIL. The subject is still `Sign in to fair.yoga`, and the typecheck rejects the extra arguments once it runs.

- [ ] **Step 3: Implement `renderMagicLinkEmail`**

In `src/lib/email-templates.ts`, import `isValidTimeZone` from `./iana-timezone` and change the function:

```ts
/**
 * The sign-in email. Its subject names the link's expiry to the second, in
 * the zone the requesting browser reported: Gmail threads mail by subject and
 * trims repeated content inside a thread, so a constant subject hid a second
 * email's Sign in button behind `•••` (#825). A zone that is missing or that
 * `isValidTimeZone` refuses renders in UTC, labelled, so the subject is never a
 * silent guess and never throws.
 */
export function renderMagicLinkEmail(
  magicLink: string,
  expiresAt: Date,
  timeZone: string | undefined,
): RenderedEmail {
  const zone = timeZone !== undefined && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const until = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(expiresAt);
  return {
    subject: `Sign in to fair.yoga · valid until ${until}`,
    ...wrapEmail(
      'Sign in to fair.yoga',
      // …blocks unchanged…
```

Keep the block list and footer exactly as they are.

- [ ] **Step 4: Run the template tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing mint test**

In `src/lib/auth/magic-link.test.ts`, import `mintMagicLinkToken` alongside the existing imports and add:

```ts
describe('mintMagicLinkToken', () => {
  it('returns the expiry it stored, so an email can name it exactly', async () => {
    const email = `mint-expiry-${Date.now()}@example.com`;
    const { token, expiresAt } = await mintMagicLinkToken(db, email);
    const row = await db.magicLinkToken.findUnique({ where: { tokenHash: hashToken(token) } });
    expect(row?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });
});
```

Use whatever name the file already uses for its `PrismaClient` (it may be `db` or `prisma`), and import `hashToken` if it isn't imported already.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/auth/magic-link.test.ts -t mintMagicLinkToken`
Expected: FAIL. `mintMagicLinkToken` is not exported.

- [ ] **Step 7: Implement `mintMagicLinkToken`**

In `src/lib/auth/magic-link.ts`, rename the body of `generateMagicLinkToken` to `mintMagicLinkToken`, return `{ token: rawToken, expiresAt }`, move the existing docblock onto `mintMagicLinkToken`, changing "returning the RAW token" to "returning the RAW token and the expiry it stored", and add:

```ts
/** `mintMagicLinkToken`'s token alone, for callers that never show the expiry. */
export async function generateMagicLinkToken(
  db: PrismaClient,
  email: string,
  opts?: Parameters<typeof mintMagicLinkToken>[2],
): Promise<string> {
  return (await mintMagicLinkToken(db, email, opts)).token;
}
```

`src/lib/auth/index.ts` re-exports this module with `export *`, so `mintMagicLinkToken` reaches `@/lib/auth` with no edit there.

- [ ] **Step 8: Run the mint test to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/auth/magic-link.test.ts`
Expected: PASS, the existing tests included.

- [ ] **Step 9: Write the failing delivery tests**

In `src/lib/auth/link-delivery.test.ts`:
- Every existing `deliverSignInLink(db, email, nonce)` call gains `{ timeZone: undefined }` as the fourth argument. The `redirectTo`/`purpose` call adds `timeZone: undefined` to its object.
- Every existing `deliverSignInLinkIfRegistered(db, email, nonce)` call gains `{ timeZone: undefined }`.
- Add to the `deliverSignInLink` describe:

```ts
  it('emails the stored expiry in the zone the request reported', async () => {
    const email = `delivery-zone-${Date.now()}@example.com`;
    await deliverSignInLink(db, email, 'nonce-zone' as BrowserNonce, { timeZone: 'Europe/Amsterdam' });

    const row = await db.magicLinkToken.findFirst({ where: { email } });
    const [, , expiresAt, timeZone] = vi.mocked(sendMagicLinkEmail).mock.calls[0]!;
    expect(expiresAt.getTime()).toBe(row!.expiresAt.getTime());
    expect(timeZone).toBe('Europe/Amsterdam');
  });
```

- In the `'emails once for a registered %s address'` test, pass `{ timeZone: 'Asia/Kolkata' }` and add after the existing recipient assertion:

```ts
    expect(vi.mocked(sendMagicLinkEmail).mock.calls[0]![3]).toBe('Asia/Kolkata');
```

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/auth/link-delivery.test.ts`
Expected: FAIL. The mock is called with two arguments, so `expiresAt` is undefined.

- [ ] **Step 11: Implement the forwarding**

`src/lib/email.ts`:

```ts
export async function sendMagicLinkEmail(
  to: string,
  magicLink: BoundSignInLink,
  expiresAt: Date,
  timeZone: string | undefined,
): Promise<void> {
  const result = await sendEmail({
    to,
    audience: 'platform',
    content: renderMagicLinkEmail(magicLink, expiresAt, timeZone),
    unsubscribe: null,
  });
  // …rest unchanged…
```

`src/lib/auth/link-delivery.ts`:
- `deliverSignInLink`'s `opts` becomes required: `opts: { timeZone: string | undefined; redirectTo?: string; purpose?: MagicLinkPurpose }`. Mint with `const { token, expiresAt } = await mintMagicLinkToken(db, email, { … })` (same options as today) and call `sendMagicLinkEmail(email, link, expiresAt, opts.timeZone)`.
- `deliverSignInLinkIfRegistered`'s `opts` becomes required: `opts: { timeZone: string | undefined; redirectTo?: string }`. It forwards `{ redirectTo: opts.redirectTo, timeZone: opts.timeZone }`.
- Add one sentence to `deliverSignInLink`'s docblock: `opts.timeZone` is the zone the requester's browser reported, or `undefined`; it is a required key so a caller that has one cannot drop it by omission.

In `src/lib/email.test.ts`, the `'magic link'` wrapper entry becomes:

```ts
    send: () => sendMagicLinkEmail('a@test.local', LINK, WHEN, 'UTC'),
    rendered: () => renderMagicLinkEmail(LINK, WHEN, 'UTC'),
```

Check `LINK`'s type still satisfies `BoundSignInLink` as it did before. Only the arity changes.

- [ ] **Step 12: Run the delivery and email tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/auth/link-delivery.test.ts src/lib/email.test.ts`
Expected: PASS.

- [ ] **Step 13: Write the failing schema tests**

In `src/lib/schemas.test.ts`, add:

```ts
describe('sign-in request timeZone (#825)', () => {
  const schemas = {
    magicLinkSendSchema,
    teacherSignupSchema,
    studentSignupSchema,
  } as const;

  it.each(Object.keys(schemas) as (keyof typeof schemas)[])('%s keeps a zone the server knows', (name) => {
    const parsed = schemas[name].safeParse({ email: 'a@b.test', timeZone: 'Europe/Amsterdam' });
    expect(parsed.success && parsed.data.timeZone).toBe('Europe/Amsterdam');
  });

  it.each(Object.keys(schemas) as (keyof typeof schemas)[])('%s modernises a renamed zone', (name) => {
    const parsed = schemas[name].safeParse({ email: 'a@b.test', timeZone: 'Europe/Kiev' });
    expect(parsed.success && parsed.data.timeZone).toBe('Europe/Kyiv');
  });

  it.each(Object.keys(schemas) as (keyof typeof schemas)[])('%s drops an unknown zone instead of refusing', (name) => {
    const parsed = schemas[name].safeParse({ email: 'a@b.test', timeZone: 'Mars/Olympus_Mons' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.timeZone).toBeUndefined();
  });

  it.each(Object.keys(schemas) as (keyof typeof schemas)[])('%s accepts a body without a zone', (name) => {
    expect(schemas[name].safeParse({ email: 'a@b.test' }).success).toBe(true);
  });
});
```

Import `teacherSignupSchema` and `studentSignupSchema` if the file does not already.

- [ ] **Step 14: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts -t "sign-in request timeZone"`
Expected: FAIL. The strict schemas refuse `timeZone`, and `magicLinkSendSchema` strips it.

- [ ] **Step 15: Implement the schema field**

In `src/lib/schemas.ts`:
- Move the `detectedTimezoneField` declaration and its comment from below `teacherSignupSchema` to just above `magicLinkSendSchema`. A `const` referenced before its declaration throws at module load.
- Rewrite its comment's first line so it describes what the field is now: the zone a browser detected (#258, #825), a correctness input on signup and a display input on sign-in requests, not a preference. Keep the rest of the paragraph, which explains why an unrecognised zone degrades instead of 400ing.
- Add `timeZone: detectedTimezoneField.optional(),` to `magicLinkSendSchema`, `studentSignupSchema` and `teacherSignupSchema`. `teacherSignupSchema` becomes `z.object({ email: emailField, timeZone: detectedTimezoneField.optional() }).strict()`.

- [ ] **Step 16: Forward the zone in the three routes**

- `magic-link/send/route.ts`: destructure `timeZone` from `parsed.data`; call `deliverSignInLinkIfRegistered(prisma, email, nonce, { redirectTo: redirect, timeZone })`.
- `teacher-signup/route.ts`: `const { email, timeZone } = parsed.data;`; add `timeZone` to the `deliverSignInLink` options object.
- `student-signup/route.ts`: destructure `timeZone` from `emailParsed.data`; call `deliverSignInLink(prisma, email, nonce, { redirectTo: redirect, purpose, timeZone })`.

- [ ] **Step 17: Prove the compile-time tether bites**

Temporarily delete `timeZone` from the options object in `teacher-signup/route.ts`. Run `pnpm exec tsc --noEmit -p .` and record the exact error text (expected: a TS2345 or TS2741 naming the missing `timeZone` property). Restore the line, re-run `tsc`, and confirm it is clean. Put the recorded error text in the task report.

- [ ] **Step 18: Run the schema and unit tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/schemas.test.ts src/lib/auth src/lib/email-templates.test.ts src/lib/email.test.ts`
Expected: PASS.

- [ ] **Step 19: Write the integration test**

Create `tests/integration/sign-in-time-zone.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

// The email is invisible to this tier, so this pins only that each sign-in
// door accepts the new key, a recognised zone or not, without refusing.
const ROUTES = ['/api/auth/magic-link/send', '/api/auth/teacher-signup', '/api/auth/student-signup'] as const;

describe('sign-in requests carry the browser zone (#825)', () => {
  it.each(ROUTES.flatMap((route) => [
    [route, 'Europe/Amsterdam'],
    [route, 'Mars/Olympus_Mons'],
  ] as const))('%s answers 200 with timeZone %s', async (route, timeZone) => {
    const email = `tz-${uniqueSuffix()}@test.local`;
    const res = await fetch(`${BASE_URL}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ email, timeZone }),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 20: Run it against the worktree's app**

Run: `pnpm run worktree:up` (once), then `pnpm exec vitest run --project integration tests/integration/sign-in-time-zone.test.ts`
Expected: PASS, 6 tests. Then prove it bites: remove `timeZone` from `teacherSignupSchema`, warm the route with a `curl -s -o /dev/null` POST to it, re-run, and record that the teacher-signup cases fail with 400. Restore and re-run green.

- [ ] **Step 21: Typecheck, lint, commit**

Run: `pnpm exec tsc --noEmit -p . && pnpm run lint`
Expected: clean.

```bash
git add src/lib/auth/magic-link.ts src/lib/auth/magic-link.test.ts \
  src/lib/email-templates.ts src/lib/email-templates.test.ts src/lib/email.ts src/lib/email.test.ts \
  src/lib/auth/link-delivery.ts src/lib/auth/link-delivery.test.ts \
  src/lib/schemas.ts src/lib/schemas.test.ts \
  src/app/api/auth/magic-link/send/route.ts src/app/api/auth/teacher-signup/route.ts src/app/api/auth/student-signup/route.ts \
  tests/integration/sign-in-time-zone.test.ts
git commit -m "feat: the sign-in subject names its expiry in the requester's zone (#825)"
```


---

### Task 2: Client: every sign-in request sends the browser zone

**Files:**
- Create: `src/lib/detect-time-zone.ts`
- Modify: `src/components/signup/profile-setup-form.tsx`: import `detectTimeZone` instead of defining it; send it on the ticket re-send
- Modify: `src/app/(public)/login/page.tsx`, `src/components/booking/booking-sign-in.tsx` (both branches), `src/components/booking/booking-name-step.tsx` (the re-send), `src/components/signup/signup-form.tsx`, `src/components/account/account-security.tsx`, `src/components/settings/resume-payments-form.tsx`
- Test: each of those files' existing `*.test.tsx` beside it

**Interfaces:**
- Consumes: the `timeZone` key from Task 1.
- Produces: `detectTimeZone(): string | undefined` in `src/lib/detect-time-zone.ts`, client-safe (no server imports).

Re-derive the call sites before starting:
`grep -rnE "auth/(magic-link/send|teacher-signup|student-signup)'" src --include='*.tsx' | grep -v '\.test\.'`. Every hit gets `timeZone: detectTimeZone()` in its JSON body. `JSON.stringify` drops an `undefined` value, so a browser that can't report a zone sends the old body.

- [ ] **Step 1: Write the failing component tests**

In each form's test file, find the test(s) that parse the request body and assert it with `toEqual`. Add `timeZone` to the expected object as the zone the test environment reports:

```ts
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
// …
expect(body).toEqual({ email: 'anna@example.com', timeZone: BROWSER_ZONE });
```

Keep `toEqual`; do not loosen it to `objectContaining`. Where a form's test file has no body assertion for the sign-in request at all (check `account-security.test.tsx`, `resume-payments-form.test.tsx`, `booking-name-step.test.tsx`, `profile-setup-form.test.tsx`), add one test that submits the form down that path and asserts `JSON.parse(init.body).timeZone` equals `BROWSER_ZONE`, using the file's existing fetch mock.

`booking-sign-in.tsx` has two branches (`mode === 'new'` posts to `student-signup`, otherwise `magic-link/send`): assert both.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project components src/components/signup src/components/booking src/components/account src/components/settings/resume-payments-form.test.tsx "src/app/(public)/login"`
Expected: FAIL on every updated assertion. The bodies lack `timeZone`.

- [ ] **Step 3: Create the shared helper**

Create `src/lib/detect-time-zone.ts` by moving `detectTimeZone` and its whole docblock out of `profile-setup-form.tsx`, with `export` added. Adjust the docblock's opening so it speaks for any caller: call it in an event handler, never during render, because a render-time read is the server's zone (UTC in the container), and React keeps that server value through hydration. Keep the `eslint-disable-next-line no-restricted-syntax` comment and its reason on the `catch`.

In `profile-setup-form.tsx`, import it from `@/lib/detect-time-zone` and delete the local copy. Leave its existing use in the profile POST body as it is.

- [ ] **Step 4: Send the zone from every call site**

In each call site's `JSON.stringify({...})`, add `timeZone: detectTimeZone()`, inside the handler that already builds the body:

- `login/page.tsx`: `JSON.stringify({ email, ...(redirect ? { redirect } : {}), timeZone: detectTimeZone() })`
- `booking-sign-in.tsx`, both branches: `JSON.stringify({ email, redirect, timeZone: detectTimeZone() })`
- `booking-name-step.tsx`, the re-send: `JSON.stringify({ email, redirect, timeZone: detectTimeZone() })`
- `signup-form.tsx`: `JSON.stringify({ email, timeZone: detectTimeZone() })`
- `profile-setup-form.tsx`, the ticket re-send: `JSON.stringify({ email, timeZone: detectTimeZone() })`
- `account-security.tsx`: `JSON.stringify({ email, redirect: redirectPath, timeZone: detectTimeZone() })`
- `resume-payments-form.tsx`: `JSON.stringify({ email, redirect: RESUME_PATH, timeZone: detectTimeZone() })`

Then re-run the grep from the top of this task and confirm that every hit's body now contains `timeZone`.

- [ ] **Step 5: Run the component tests to verify they pass**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 6: Full verification, then commit**

Run: `pnpm exec tsc --noEmit -p . && pnpm run lint && pnpm run build`
(`build` catches a server-only import leaking into a client bundle; the helper must import nothing server-side.)
Expected: clean.

```bash
git add src/lib/detect-time-zone.ts "src/components/signup/profile-setup-form.tsx" "src/components/signup/profile-setup-form.test.tsx" \
  "src/app/(public)/login/page.tsx" "src/app/(public)/login/page.test.tsx" \
  src/components/booking/booking-sign-in.tsx src/components/booking/booking-sign-in.test.tsx \
  src/components/booking/booking-name-step.tsx src/components/booking/booking-name-step.test.tsx \
  src/components/signup/signup-form.tsx src/components/signup/signup-form.test.tsx \
  src/components/account/account-security.tsx src/components/account/account-security.test.tsx \
  src/components/settings/resume-payments-form.tsx src/components/settings/resume-payments-form.test.tsx
git commit -m "feat: every sign-in request sends the browser's zone (#825)"
```

(Stage only the test files that changed.)

---

## After both tasks

- `pnpm run verify` in the worktree (against its own app, via `INTEGRATION_BASE_URL`), green.
- By hand, on the PR: request two sign-in links in a row to a Gmail address and confirm that they land as two conversations, each showing its Sign in button.
