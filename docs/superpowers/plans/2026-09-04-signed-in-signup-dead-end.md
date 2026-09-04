# Signed-in signup dead end — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in browser that lands in the teacher signup flow is told why it cannot use a different address, and is given the one control that fixes it — and a magic link stops naming a destination the reader will be bounced from.

**Architecture:** Four changes, no change to what any route *permits*. `SignOutButton` learns an optional destination. `/signup` replaces its teacher redirect with an explanatory panel that mounts that button. `/signup/profile`'s session-mode form gains one sentence and the same button. `magic-link/verify` stops honouring a `/signup/profile` destination for an account that already teaches, using a fact it already computes one line earlier.

**Tech Stack:** Next.js 14 App Router (server components), TypeScript strict, Tailwind v4 `@theme` tokens in `src/app/globals.css`, vitest (`components` project = jsdom + testing-library; `integration` project = HTTP against the app on `:3000`), Prisma.

**Spec:** `docs/superpowers/specs/2026-09-04-signed-in-signup-dead-end-design.md`

**Issue:** #431 (both halves)

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types.
- **Task order is load-bearing.** Task 1 must land first — Tasks 2 and 3 both mount the prop it adds. Task 4 is independent of the other three and may be built in parallel with them, but is written last here because its integration tests take longest.
- **Comment Discipline (CLAUDE.md).** Where a comment's claim is falsified by an edit, **replace it with what is true now** — never annotate it with what it used to say. The before-and-after goes in the PR body. Two comments in this plan are falsified and both are rewritten in place: `signup/page.tsx`'s header docblock (Task 2) and `sign-out-button.tsx`'s "fall through to login" catch comment (Task 1).
- **Every guard is proven by breaking it.** Each task ends with an explicit mutation step: apply the mutation, run the named test, record the exact failure text, restore, re-run green. A pin that compiles but cannot fail certifies nothing.
- **Never restart the dev server on `:3000`.** If it is running it is the user's, hot-reloading their edits, and the `integration` project needs it live. Check first; start one only if genuinely absent.
- **Warm a route before judging a mutation.** `next dev` recompiles lazily and a first-request compile can blow a timeout that reads exactly like an assertion failure. After applying a mutation, curl the touched route once before scoring RED/GREEN.
- **Copy is fixed by the spec.** The two new strings are quoted verbatim in Tasks 2 and 3. Do not paraphrase them.
- **Design tokens only.** `type-label` / `type-display` / `type-body` / `type-caption`, `text-teal` / `text-ink`, `bg-teal` / `hover:bg-teal-hover` / `text-cream`, `rounded-pill`. No new colors, no shadows, no transitions.
- **Stage exact paths.** Never `git add -A` or `git add .`. Paths containing parentheses (`src/app/(public)/…`) must be quoted.

---

### Task 1: `SignOutButton` learns where to land

**Files:**
- Modify: `src/components/account/sign-out-button.tsx` (whole file, 44 lines)
- Test: `src/components/account/sign-out-button.test.tsx` (add one case)

**Interfaces:**
- Consumes: nothing.
- Produces: `SignOutButton({ redirectTo }: { redirectTo?: string })` — default `'/login'`. Tasks 2 and 3 both mount it as `<SignOutButton redirectTo="/signup" />`.

**Context the implementer needs:** this component is currently mounted at `src/app/(teacher)/settings/page.tsx:44` and `src/app/(student)/account/page.tsx:80`, both with no props. Both must keep landing on `/login`, which is what the default preserves. The `components` test project stubs `next/navigation` globally in `tests/setup/components.ts`, exporting `routerPush` and `routerRefresh` mocks that are cleared before each test — import them from `'../../../tests/setup/components'` as the existing test file already does.

- [ ] **Step 1: Write the failing test**

Append to the `describe('SignOutButton', …)` block in `src/components/account/sign-out-button.test.tsx`:

```tsx
  // #431. The signup flow mounts this button to open a door, and landing on
  // /login would be a second closed one: someone signing out in order to sign
  // UP wants the signup page.
  it('honours an explicit destination instead of the /login default', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton redirectTo="/signup" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
    expect(routerPush).not.toHaveBeenCalledWith('/login');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
```

The existing first case — `'DELETEs the session, then pushes and refreshes'`, which asserts `routerPush` was called with `'/login'` — is the other half of this pin and is left exactly as it is. Together they cover both the default and the override.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run --project components src/components/account/sign-out-button.test.tsx`

Expected: the new case FAILS. `SignOutButton` takes no props today, so `redirectTo` is ignored and `routerPush` is called with `'/login'` — the failure is on `expect(routerPush).toHaveBeenCalledWith('/signup')`. TypeScript will also reject the prop; that is part of the red.

- [ ] **Step 3: Implement**

Replace the top of `src/components/account/sign-out-button.tsx` — the import block, the docblock and the signature — with:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SignOutButtonProps {
  /**
   * Where the browser lands once the session is gone. `/login` is right for
   * Settings and the account page, which is why it is the default. The signup
   * flow passes `/signup` (#431): someone signing out in order to sign UP
   * wants the signup page, and `/login` would be a second closed door in a
   * flow this control exists to open.
   */
  redirectTo?: string;
}

/** Ends the session and sends the browser to `redirectTo`. */
export function SignOutButton({ redirectTo = '/login' }: SignOutButtonProps) {
```

In `handleSignOut`, change the `catch` comment and the push. The catch block today reads:

```tsx
    } catch {
      // The cookie clear is what matters; a network hiccup here should
      // not trap someone in a signed-in state — fall through to login.
    } finally {
```

"fall through to login" is falsified by this change — the destination is no longer always `/login`. Replaced (not annotated) with:

```tsx
    } catch {
      // The cookie clear is what matters; a network hiccup here should
      // not trap someone in a signed-in state — leave anyway.
    } finally {
```

and in the `finally` block:

```tsx
      router.push(redirectTo);
```

The `finally` block's #40 comment names no path and is left untouched: its reasoning — that neither the push nor the refresh is guaranteed to commit, so `busy` resets regardless — is independent of where the button goes.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project components src/components/account/sign-out-button.test.tsx`

Expected: PASS, 4 cases.

- [ ] **Step 5: Prove both guards bite**

Two mutations, applied one at a time, each restored before the next.

*Mutation A — the default is load-bearing.* Change the signature to `{ redirectTo = '/signup' }`. Run the file. Expected: the FIRST case fails on `expect(routerPush).toHaveBeenCalledWith('/login')`. Record the exact message. Restore, re-run green.

*Mutation B — the prop is actually read.* Change `router.push(redirectTo)` back to `router.push('/login')`. Run the file. Expected: the NEW case fails on `expect(routerPush).toHaveBeenCalledWith('/signup')`. Record the exact message. Restore, re-run green.

Both messages go in the task report.

- [ ] **Step 6: Commit**

```bash
git add src/components/account/sign-out-button.tsx src/components/account/sign-out-button.test.tsx
git commit -m "feat(auth): the sign-out button learns where to land"
```

---

### Task 2: `/signup` says no to a teacher instead of moving them

**Files:**
- Create: `src/components/signup/already-teaching-panel.tsx`
- Create: `src/components/signup/already-teaching-panel.test.tsx`
- Create: `src/app/(public)/signup/page.test.tsx`
- Modify: `src/app/(public)/signup/page.tsx` (whole file, 35 lines)

**Interfaces:**
- Consumes: `SignOutButton({ redirectTo })` from Task 1.
- Produces: `AlreadyTeachingPanel({ email }: { email: string })`. Nothing later in this plan consumes it; the spec notes it exists so `/signup/profile` could mount it later without a redesign.

**Context the implementer needs:**

`src/app/(public)/signup/page.tsx:23-24` currently reads:

```tsx
  if (session?.teacherId) redirect('/schedule');
  if (session) redirect('/signup/profile');
```

Only the first line changes. `SessionUser` (`src/lib/types.ts:32`) is a discriminated union carrying `sessionId`, `accountId`, `teacherId` and `studentId` — **no email** — so the panel's copy needs an account lookup. The sibling page already does exactly this at `src/app/(public)/signup/profile/page.tsx:42`; mirror it rather than inventing a helper.

Visual reference: `AlreadySignedInState` in `src/app/(public)/verify/page.tsx:245`. That is the same message in a different flow and the two should not look like different products — `type-label` in teal, `type-display` headline, `type-body` explanation, one full-width teal pill link, then fineprint.

Two testing facts that will otherwise cost an hour:

1. **A server component test asserts on PROPS, not on rendered copy.** `await SignupPage()` returns a React element tree that is not rendered — `JSON.stringify(tree)` sees `<AlreadyTeachingPanel email="…" />` as its props, never the strings inside the panel. That is why the panel's copy is tested separately, with testing-library, in its own file.
2. **The page test's `next/navigation` mock must export `useRouter` as well as `redirect`.** A file-level `vi.mock` replaces the project-wide one in `tests/setup/components.ts`, and the import chain `page → already-teaching-panel → sign-out-button → next/navigation` needs `useRouter` to resolve even though it is never called here.

- [ ] **Step 1: Write the failing page test**

Create `src/app/(public)/signup/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  // The panel's sign-out control reaches this module through the import
  // chain. Never called — these tests build the element tree and never
  // render it — but the binding has to resolve.
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    account: { findUniqueOrThrow: async () => ({ email: 'signed-in@test.local' }) },
  },
}));

beforeEach(() => {
  getSession.mockReset();
});

const TEACHER_SESSION = {
  sessionId: 's1',
  accountId: 'a1',
  teacherId: 't1',
  studentId: null,
  defaultTimezone: 'Europe/Amsterdam',
};
const STUDENT_SESSION = {
  sessionId: 's2',
  accountId: 'a2',
  teacherId: null,
  studentId: 'st1',
};

describe('SignupPage', () => {
  it('answers a signed-in teacher in words rather than moving them somewhere silent', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(TEACHER_SESSION);

    // The absence of a throw IS the assertion — before #431 this line ended
    // the test with REDIRECT:/schedule, and nothing was ever said.
    const tree = await SignupPage();

    expect(JSON.stringify(tree)).toContain('signed-in@test.local');
  });

  it('still sends a signed-in student straight to the profile form', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(STUDENT_SESSION);

    // Unchanged by #431, and the reason is in the page docblock: submitting
    // the email form as a signed-in student mails an ordinary sign-in link
    // that lands back where they started and never creates a teacher.
    await expect(SignupPage()).rejects.toThrow('REDIRECT:/signup/profile');
  });

  it('renders the email form for a browser with no session', async () => {
    const { default: SignupPage } = await import('./page');
    getSession.mockResolvedValue(null);

    const tree = await SignupPage();

    expect(JSON.stringify(tree)).toContain('Start teaching on fair.yoga');
  });
});
```

- [ ] **Step 2: Write the failing panel test**

Create `src/components/signup/already-teaching-panel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AlreadyTeachingPanel } from './already-teaching-panel';
import { routerPush } from '../../../tests/setup/components';

describe('AlreadyTeachingPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the address the browser is signed in as, and why that settles it', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    expect(screen.getByText('ivo@example.com')).toBeInTheDocument();
    expect(screen.getByText(/already has a teacher page/)).toBeInTheDocument();
  });

  it('offers the schedule as the way on', () => {
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    expect(screen.getByRole('link', { name: /Go to your schedule/ })).toHaveAttribute(
      'href',
      '/schedule',
    );
  });

  it('signs out back to /signup, the page the reader was trying to use', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<AlreadyTeachingPanel email="ivo@example.com" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
    expect(routerPush).not.toHaveBeenCalledWith('/login');
  });
});
```

- [ ] **Step 3: Run both test files and watch them fail**

Run: `npx vitest run --project components "src/app/(public)/signup/page.test.tsx" src/components/signup/already-teaching-panel.test.tsx`

Expected: the panel file fails to resolve `./already-teaching-panel` (module not found). The page file's first case fails with `REDIRECT:/schedule` thrown from `SignupPage()`; its other two cases already pass, which is correct — they pin behaviour this change must not disturb.

- [ ] **Step 4: Create the panel**

Create `src/components/signup/already-teaching-panel.tsx`:

```tsx
import Link from 'next/link';
import { SignOutButton } from '@/components/account/sign-out-button';

/**
 * What `/signup` tells a teacher, instead of moving them (#431).
 *
 * The refusal is the same one the redirect made — a teacher is still not
 * offered a second signup form. What changes is that it happens on the page
 * they asked for, in words, with both ways out: their schedule, and the
 * sign-out that makes a different address reachable.
 */
export function AlreadyTeachingPanel({ email }: { email: string }) {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-teal mb-[10px]">Already teaching</p>
      <h1 className="type-display mb-4">You already have a page.</h1>
      <p className="type-body max-w-[360px] mb-6">
        You&apos;re signed in as <span className="text-ink">{email}</span>, and
        that address already has a teacher page.
      </p>
      <Link
        href="/schedule"
        className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
      >
        Go to your schedule
      </Link>
      <p className="mt-6 type-caption leading-[1.55]">
        Setting up a page for a different address?
      </p>
      <div className="mt-2">
        <SignOutButton redirectTo="/signup" />
      </div>
    </div>
  );
}
```

The control sits on its own line rather than inline in the sentence: `type-label` (14px, medium) inside `type-caption` (13px, regular) would be a visible size step mid-sentence, and the button already says "Sign out" — putting the words in the prose too would say it twice.

- [ ] **Step 5: Rewire the page**

Replace `src/app/(public)/signup/page.tsx` in full:

```tsx
import { redirect } from 'next/navigation';
import { AlreadyTeachingPanel } from '@/components/signup/already-teaching-panel';
import { SignupForm } from '@/components/signup/signup-form';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';

/**
 * Step one of teacher signup (#385): an address, and nothing else. The
 * profile is asked for at `/signup/profile`, after the link is clicked —
 * so an abandoned signup leaves a token that expires, never a half-built
 * teacher.
 *
 * Neither signed-in branch below is about tidiness — each closes a door that
 * otherwise leads nowhere.
 *
 * A teacher who is already signed in is not offered a second signup, and is
 * told so here rather than moved somewhere that would not say it (#431). The
 * only address this form could usefully take is one they are not signed in
 * as, so the panel names the address they ARE signed in as and offers the
 * sign-out that makes another one reachable.
 *
 * A signed-in account WITHOUT a teacher profile (a student, since
 * `SessionUser` makes a profile-less session unrepresentable) is sent
 * straight to the profile form: submitting this form would find their address
 * already has an `Account` and mail them an ordinary sign-in link, which
 * lands back where they started and never creates a teacher. They need no
 * email round trip — their live session is already one of the two
 * authorizations the profile route accepts.
 */
export default async function SignupPage() {
  const session = await getSession();
  if (session?.teacherId) {
    // `SessionUser` carries ids and no address, so the panel's copy needs the
    // same lookup `/signup/profile` makes for its own session-mode identity.
    const account = await prisma.account.findUniqueOrThrow({
      where: { id: session.accountId },
      select: { email: true },
    });
    return <AlreadyTeachingPanel email={account.email} />;
  }
  if (session) redirect('/signup/profile');

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      <SignupForm
        title="Start teaching on fair.yoga"
        intro="One email address, no password. We'll send you a link — clicking it brings you back here to set up your page."
        sentMessage="We sent you a link. Clicking it brings you back here to set up your teacher page."
      />
    </div>
  );
}
```

Note what changed in the docblock and why: the old text described the two redirects **as a pair** ("A teacher who is already signed in is sent home rather than offered a second signup"). Half that pair no longer exists, so the paragraph is replaced with what is true now. The student half's reasoning is unchanged and carried over verbatim. Nothing in the new text records what the old text said — that belongs in the PR body.

- [ ] **Step 6: Run both test files and watch them pass**

Run: `npx vitest run --project components "src/app/(public)/signup/page.test.tsx" src/components/signup/already-teaching-panel.test.tsx`

Expected: PASS, 6 cases across 2 files.

- [ ] **Step 7: Prove the guards bite**

Three mutations, one at a time, each restored before the next.

*Mutation A — the silent bounce is what this replaced.* Put `redirect('/schedule');` back as the first line of the `if (session?.teacherId)` block. Run the page test. Expected: the first case fails with `REDIRECT:/schedule` thrown out of `SignupPage()`. Record it. Restore, re-run green.

*Mutation B — the student redirect is still pinned.* Delete `if (session) redirect('/signup/profile');`. Run the page test. Expected: the second case fails — `rejects.toThrow` gets a resolved promise instead. Record it. Restore, re-run green.

*Mutation C — the sign-out destination is not decorative.* Change the panel's mount to `<SignOutButton />`. Run the panel test. Expected: the third case fails on `expect(routerPush).toHaveBeenCalledWith('/signup')`, having been called with `'/login'`. Record it. Restore, re-run green.

- [ ] **Step 8: See it in the running app**

The RSC-cache subtlety in the spec (Change 3) cannot be observed by any component test, because a server component rendered directly has no router. Check it against the live app on `:3000` — the `verify` skill (`.claude/skills/verify/`) carries the recipe for signing in without email.

1. Sign in as a teacher, then navigate to `/signup`. Expect the panel, naming that account's address.
2. Click **Sign out**. Expect to end up on `/signup` showing the **email form**, not the panel — `router.refresh()` invalidating the cached payload is what makes this work, since the push is to the route the browser is already on.
3. Sign in as a student-only account and navigate to `/signup`. Expect `/signup/profile` in session mode.

Record what you saw for each of the three. If step 2 shows the panel again, stop and report it — that is the failure mode the spec named, and it is a finding about the mechanism, not something to paper over with a hard navigation without saying so.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(public)/signup/page.tsx" "src/app/(public)/signup/page.test.tsx" src/components/signup/already-teaching-panel.tsx src/components/signup/already-teaching-panel.test.tsx
git commit -m "feat(signup): the signup page tells a teacher why, and offers the way out"
```

---

### Task 3: session mode explains the address it is using

**Files:**
- Modify: `src/components/signup/profile-setup-form.tsx:339-345` (the intro paragraph)
- Test: `src/components/signup/profile-setup-form.test.tsx` (add two cases)

**Interfaces:**
- Consumes: `SignOutButton({ redirectTo })` from Task 1.
- Produces: nothing.

**Context the implementer needs:** the form takes `mode: 'ticket' | 'session'` (`ProfileSetupMode`, exported from the same file). Session mode means a signed-in student adding a teacher hat; ticket mode means a new address that clicked its own link. The intro paragraph today is:

```tsx
      <h1 className="type-display mb-5">Set up your teacher page</h1>
      <p className="type-body max-w-[420px] mb-8">
        {mode === 'session' ? 'Adding a teacher page to ' : "You're signing up as "}
        <span className="text-ink">{email}</span>. Your name and a page address
        are all we need &mdash; the bio can wait.
      </p>
```

It already *names* the address; what it never says is that being signed in is why that address is fixed. Ticket mode gains nothing here — there the address came from a link the reader requested themselves, and there is no session to sign out of.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('ProfileSetupForm', …)` block in `src/components/signup/profile-setup-form.test.tsx`, next to the two existing mode-naming cases:

```tsx
  // #431. Naming the address is not the same as explaining it. The signed-in
  // student who wanted a DIFFERENT address has exactly one thing to do, and
  // until now this page neither named it nor offered it.
  it('session mode explains the address is the session\'s, and offers the sign-out that changes it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<ProfileSetupForm email="anna@example.com" mode="session" />);

    expect(screen.getByText(/That's the address you're signed in with/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
  });

  it('ticket mode offers no sign-out — there is no session behind that address', () => {
    render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

    expect(screen.queryByText(/That's the address you're signed in with/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
```

Add `routerPush` to the file's imports:

```tsx
import { routerPush } from '../../../tests/setup/components';
```

The second case is the one with teeth: an unconditional block passes the first and fails only this one.

- [ ] **Step 2: Run the test file and watch it fail**

Run: `npx vitest run --project components src/components/signup/profile-setup-form.test.tsx`

Expected: the first new case fails on `getByText(/That's the address you're signed in with/)` — "Unable to find an element with the text". The second new case passes already, which is correct: it pins the absence this change must preserve.

- [ ] **Step 3: Implement**

Add the import at the top of `src/components/signup/profile-setup-form.tsx`, beside the existing component imports:

```tsx
import { SignOutButton } from '@/components/account/sign-out-button';
```

Replace the intro paragraph block with:

```tsx
      <h1 className="type-display mb-5">Set up your teacher page</h1>
      <p className={`type-body max-w-[420px] ${mode === 'session' ? 'mb-3' : 'mb-8'}`}>
        {mode === 'session' ? 'Adding a teacher page to ' : "You're signing up as "}
        <span className="text-ink">{email}</span>. Your name and a page address
        are all we need &mdash; the bio can wait.
      </p>
      {/* Session mode arrives here by redirect from `/signup`, before any
          address was typed — so the address above is the session's, not one
          the reader chose, and this is where that is said. Ticket mode needs
          none of it: that address came from a link the reader requested. */}
      {mode === 'session' && (
        <div className="max-w-[420px] mb-8">
          <p className="type-caption leading-[1.55]">
            That&apos;s the address you&apos;re signed in with. Setting up a page
            for a different one?
          </p>
          <div className="mt-2">
            <SignOutButton redirectTo="/signup" />
          </div>
        </div>
      )}
```

- [ ] **Step 4: Run the test file and watch it pass**

Run: `npx vitest run --project components src/components/signup/profile-setup-form.test.tsx`

Expected: PASS, 13 cases (11 existing + 2 new).

- [ ] **Step 5: Prove both guards bite**

*Mutation A — the block is reachable.* Delete the whole `{mode === 'session' && (…)}` block. Run the file. Expected: the first new case fails on the `getByText` for "That's the address you're signed in with". Record it. Restore, re-run green.

*Mutation B — the condition is doing work.* Change `{mode === 'session' && (` to render unconditionally (drop the guard, keeping the block). Run the file. Expected: the SECOND new case fails — `queryByText(…)` returns an element where `null` was expected. Record it. Restore, re-run green.

Mutation B is the one that matters. A ticket-mode reader shown a sign-out control has no session to end, and the control would either do nothing visible or bounce them out of a signup they are mid-way through.

- [ ] **Step 6: Commit**

```bash
git add src/components/signup/profile-setup-form.tsx src/components/signup/profile-setup-form.test.tsx
git commit -m "feat(signup): session mode says whose address that is, and how to change it"
```

---

### Task 4: the verify destination stops naming a page that bounces

**Files:**
- Modify: `src/app/api/auth/magic-link/verify/route.ts:21` (import) and `:86-88` (the destination)
- Test: `tests/integration/teacher-signup-api.test.ts` (add one `describe` with two cases, plus its fixtures)

**Interfaces:**
- Consumes: nothing from Tasks 1–3. This task is independent of them.
- Produces: nothing.

**Context the implementer needs.** The route today, at `src/app/api/auth/magic-link/verify/route.ts:86-88`:

```ts
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;
```

Line 86 computes the exact fact needed and line 88 discards it. `src/app/api/auth/teacher-signup/route.ts:47` sends `redirectTo: TEACHER_PROFILE_PATH` on **every** signup attempt including addresses that already have an account — that is deliberate and #430 fixed a bug by making it so. It is not what changes here. What changes is that verification, which is the only moment a *teacher profile*'s existence is knowable, stops honouring that one destination for an account that already teaches. `/signup/profile:38` would bounce such a browser to `/schedule` anyway, and `destinationCopy` (`src/app/(public)/verify/page.tsx:113`) reads the path, so today the reader is told "Taking you to set up your page now" and then sent to their schedule.

**The mutation this must survive** — and the reason both directions are tested — is the one-directional guard:

```ts
// WRONG: breaks an existing STUDENT using the teacher signup form
tokenRedirect === TEACHER_PROFILE_PATH ? fallback : tokenRedirect
```

That satisfies the teacher case and silently destroys the second-hat flow, where a student-only account must still reach `/signup/profile`.

Integration tests need the app live on `:3000`. Fixture patterns to copy from this same file: teacher creation with a nested account at line 346, student creation with a nested account at line 251, and the verify POST shape (origin-nonce cookie plus `freshIp()`) at line 310.

- [ ] **Step 1: Write the failing tests**

Add two fixture addresses beside the existing ones at the top of `tests/integration/teacher-signup-api.test.ts`:

```ts
// #431: the teacher-signup destination against an account that already
// exists — one of each kind, because the guard has two directions and only
// one of them is the bug.
const destTeacherEmail = `teacher-signup-dest-teacher-${suffix}@test.local`;
const destTeacherSlug = `dest-teacher-${suffix}`;
const destStudentEmail = `teacher-signup-dest-student-${suffix}@test.local`;
```

Then add a new top-level `describe` block at the end of the file:

```ts
/**
 * #431. `teacher-signup` names `/signup/profile` on every attempt, existing
 * accounts included — correct, and deliberate since #430. Whether that page
 * is usable depends on a TEACHER PROFILE, which only verification can see.
 */
describe('POST /api/auth/magic-link/verify — teacher-signup destination for an existing account', () => {
  it('sends an account that already teaches to its schedule, not to a page it would be bounced from', async () => {
    await prisma.teacher.create({
      data: {
        firstName: 'Existing',
        lastName: 'Teacher',
        email: destTeacherEmail,
        bio: '',
        pageSlug: destTeacherSlug,
        account: { create: { email: destTeacherEmail } },
      },
    });
    const nonce = `teacher-signup-dest-teacher-nonce-${suffix}`;
    const token = await generateMagicLinkToken(prisma, destTeacherEmail, {
      purpose: 'sign_in',
      redirectTo: '/signup/profile',
      originBrowserHash: hashNonce(nonce),
    });

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_origin=${nonce}`,
        ...freshIp(),
      },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    // `/signup/profile` would redirect straight to `/schedule` on arrival,
    // and `/verify`'s copy reads this path — so naming it here promises
    // something false out loud and then costs a hop.
    expect(body.data.redirectTo).toBe('/schedule');
  });

  it('still sends an account with no teacher profile to the profile form', async () => {
    await prisma.student.create({
      data: {
        firstName: 'Second',
        lastName: 'Hat',
        email: destStudentEmail,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: destStudentEmail } },
      },
    });
    const nonce = `teacher-signup-dest-student-nonce-${suffix}`;
    const token = await generateMagicLinkToken(prisma, destStudentEmail, {
      purpose: 'sign_in',
      redirectTo: '/signup/profile',
      originBrowserHash: hashNonce(nonce),
    });

    const res = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_origin=${nonce}`,
        ...freshIp(),
      },
      body: JSON.stringify({ token }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    // The second-hat flow: a student becoming a teacher too. This is what a
    // guard written as `dest === TEACHER_PROFILE_PATH ? fallback : dest`
    // would destroy while the case above still passed.
    expect(body.data.redirectTo).toBe('/signup/profile');
  });
});
```

- [ ] **Step 2: Run the tests and watch the first one fail**

Confirm the dev server is live on `:3000` first — do not restart it if it is. Warm the route once:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/auth/magic-link/verify \
  -H 'Content-Type: application/json' -d '{"token":"warm"}'
```

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts -t 'teacher-signup destination for an existing account'`

Expected: the first case FAILS — `expected '/signup/profile' to be '/schedule'`. The second case PASSES, pinning the direction that must not move.

- [ ] **Step 3: Implement**

In `src/app/api/auth/magic-link/verify/route.ts`, extend the schemas import at line 21:

```ts
import { magicLinkVerifySchema, isSafeRelativePath, TEACHER_PROFILE_PATH } from '@/lib/schemas';
```

Replace lines 86-88:

```ts
  // Prefer the destination stored with the token (booking flow), but only
  // relative paths — everything else falls back to the role default;
  // dual-role accounts default to the teacher home.
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  // One destination is refused rather than merely defaulted (#431): the
  // teacher profile form, for an account that already teaches. That page's
  // own first line sends such a browser to `/schedule`, and `/verify`'s copy
  // reads this path — so honouring it here promises a page the reader is
  // about to be bounced from, out loud, and costs a hop saying it.
  //
  // Scoped to this one path. Every other destination a token can carry is
  // usable by whoever receives it, and `teacher-signup/route.ts` is right to
  // send this one unconditionally: whether the ADDRESS has an account is not
  // the question, and whether it has a TEACHER PROFILE is knowable only
  // here. The condition is `resolved.teacherId`, never the path alone —
  // a student-only account keeps this destination, which is the second-hat
  // flow.
  const bouncedTeacherForm =
    tokenRedirect === TEACHER_PROFILE_PATH && resolved.teacherId !== null;
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) && !bouncedTeacherForm
      ? tokenRedirect
      : fallback;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts -t 'teacher-signup destination for an existing account'`

Expected: PASS, 2 cases.

Then run the whole file, because this route is verified from many of its other cases:

Run: `npx vitest run --project integration tests/integration/teacher-signup-api.test.ts`

Expected: all green. Any pre-existing case turning red is a finding about this change, not a test to adjust — report it rather than editing it.

- [ ] **Step 5: Prove both directions bite**

*Mutation A — the guard is what moved the teacher.* Change `bouncedTeacherForm` to `const bouncedTeacherForm = false;`. Warm the route, run the two cases. Expected: the teacher case fails, `expected '/signup/profile' to be '/schedule'`. Record it. Restore, re-run green.

*Mutation B — the direction that a one-sided guard destroys.* Replace the condition with `const bouncedTeacherForm = tokenRedirect === TEACHER_PROFILE_PATH;` — dropping the `resolved.teacherId` half. Warm the route, run the two cases. Expected: the teacher case still PASSES and the student case FAILS, `expected '/bookings' to be '/signup/profile'`. Record both halves of that result — a mutation that only half the suite notices is the whole reason the second case exists. Restore, re-run green.

- [ ] **Step 6: Sweep for what this invalidated**

This change alters what a destination *means* for one class of reader, so a name-keyed grep is not enough — the sweep is reading, not matching.

```bash
grep -rn "signup/profile\|TEACHER_PROFILE_PATH" src docs --include='*.ts' --include='*.tsx' --include='*.md'
```

Give every hit a verdict and expect legitimate survivors. Specifically check that these three still state something true, and report each by name:

- `src/app/api/auth/teacher-signup/route.ts:42-47` — its "unconditional, because the two settings answer different questions" comment. It should survive: this change is about a teacher profile, not about whether the address has an account.
- `src/app/(public)/verify/page.tsx:113-118` — `destinationCopy`. Unmodified by design; confirm its docblock does not claim the `/signup/profile` branch fires for readers it no longer fires for.
- `src/app/(public)/signup/profile/page.tsx:8-35` — the three-ways-to-arrive docblock. Its TICKET and SESSION branches are untouched; confirm nothing in it claims an existing teacher reaches that page by email.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/auth/magic-link/verify/route.ts tests/integration/teacher-signup-api.test.ts
git commit -m "fix(auth): a link stops naming a page the reader would be bounced from"
```

---

## Closing out

- [ ] **Whole-branch review.** Four tasks, so the whole-branch review applies: one review on the most capable model, one fix wave, one scoped re-review. Its job is what per-task reviewers structurally cannot see — in this branch, that the `/signup` docblock (Task 2) and the `verify` route comment (Task 4) do not now contradict each other about who reaches `/signup/profile`, and that Task 1's default and Tasks 2–3's overrides tell one consistent story.

- [ ] **`npm run verify` before pushing.** Needs the app live on `:3000`. Green `verify` runs every vitest project, so it is the whole integration suite — say so in the PR body with the arithmetic. It is not a CI substitute: CI also runs `prisma validate`, a migration-drift check, `npm run build` and Playwright.

- [ ] **PR body.** Record: the premise correction (#431 says the signed-in student loses "the address they typed" — both `/signup` redirects fire on GET, before any form renders, so nothing is typed, and session mode already named the address); what the two rewritten comments used to say (`signup/page.tsx`'s paired-redirect paragraph, `sign-out-button.tsx`'s "fall through to login"); which `integration` files this branch touched, by path (`tests/integration/teacher-signup-api.test.ts`, and nothing else); and that **#430 is unaffected**.
