# Settled-state recovery for dropped router commits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every control whose success depends on a router action reach a truthful, usable state when that router action never commits — so no control freezes, shows a red error over a succeeded action, or permits a duplicate submission.

**Architecture:** One invariant, applied to seven components: *after a successful mutation a control never returns to idle; it goes to settled.* Where a retry is provably harmless (two components) a plain reset suffices instead. Escape controls (`Keep` / `Cancel`) stop carrying the pending flag, which is the only fix for a request that hangs rather than resolves.

**No shared abstraction over mutation flow** — measurement found four distinct control-flow shapes among just these seven components, and thirteen across the codebase. **One shared presentational component**, `SettledNotice` (Task 1): presentation is the axis on which the five settled states genuinely are the same, and a named component makes the invariant discoverable in a way the rejected ESLint rule could not.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript strict, Vitest + Testing Library (`components` project), Tailwind v4 tokens.

**Spec:** `docs/superpowers/specs/2026-08-11-dropped-refresh-recovery-design.md`

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types.
- **Settled confirmation styling is an existing idiom:** `type-caption text-teal`, as at `teacher-privacy-card.tsx:184`. Do not invent a new success treatment. From Task 2 onward, render it via `SettledNotice` (Task 1) rather than hand-rolling the markup.
- **Settled copy, verbatim:** "Marked unpaid" / "Accepted" / "Declined" / "Removed" / "Created".
- **The retry control is labelled "Refresh"** and calls `router.refresh()` (or re-issues the same `router.push` where the original success was a push). Never `location.reload()`.
- **Test project:** `components`. Run single files with `npx vitest run --project components <path>`.
- **`tests/setup/components.ts` already stubs `next/navigation`** — `routerRefresh` and `routerPush` are exported `vi.fn()`s, auto-cleared in a `beforeEach`. Never redeclare a router mock in a test file; import from `../../../tests/setup/components`.
- **Never start or restart the dev server on :3000.** The user runs it.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Every guard is mutation-tested**: break it, record the exact failure text in the ledger, restore, re-verify. A guard whose mutation was not observed failing does not count as done.
- **Do not write "does not close #N"** in any commit message or PR body. Write "**#N is unaffected**". GitHub's parser matches `close #N` and ignores the negation.

---

## Task order

**Task 1 must come first** — Tasks 2, 5, 6, 7 and 8 all import the component it creates. Task 2 is the reference implementation of the settled-state *wiring* that Tasks 5–8 follow. Tasks 3–8 are otherwise independent. Task 9 is paperwork and must be last, because it reconciles counts against the finished branch.

---

### Task 1: `SettledNotice` — the shared settled-state presentation

**Files:**
- Create: `src/components/ui/settled-notice.tsx`
- Create: `src/components/ui/settled-notice.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `SettledNotice`, imported by Tasks 2, 5, 6, 7, 8 as
  `import { SettledNotice } from '@/components/ui/settled-notice';`
  with this exact signature:
  ```ts
  interface SettledNoticeProps {
    label: string;
    actionLabel: string;
    onAction: () => void;
    size?: 'caption' | 'sm';
  }
  ```

**Why this exists.** Five components need the same settled presentation: a teal label, a middot, and a control that retries the navigation that did not commit. The spec rejected a shared *hook* on measurement — thirteen distinct control-flow shapes across the codebase, four among these seven files — but that measurement was about mutation flow. Presentation is the axis on which these five genuinely are the same. A named component also makes the invariant discoverable, which the ESLint rule considered in spec §6 could not do.

`size` exists because the two template forms sit beside an existing `text-sm text-teal` success line and must stay internally consistent, while the button-style components use `type-caption text-teal`.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/settled-notice.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettledNotice } from './settled-notice';

/**
 * #40. The settled state a control reaches once its mutation has committed but
 * the router action that should have replaced it did not. Five components share
 * it, so it is one component rather than five copies — and the name is how the
 * next person finds the invariant.
 */
describe('SettledNotice', () => {
  it('renders the label and an operable action', () => {
    const onAction = vi.fn();
    render(<SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={onAction} />);

    expect(screen.getByText('Marked unpaid')).toBeInTheDocument();

    const action = screen.getByRole('button', { name: 'Refresh' });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('uses the caption scale by default and the sm scale on request', () => {
    const { rerender } = render(
      <SettledNotice label="Removed" actionLabel="Refresh" onAction={() => {}} />,
    );
    expect(screen.getByText('Removed')).toHaveClass('type-caption');

    rerender(
      <SettledNotice label="Created" actionLabel="Go to recurring classes" onAction={() => {}} size="sm" />,
    );
    expect(screen.getByText('Created')).toHaveClass('text-sm');
  });

  // The action is never disabled: this component exists because something else
  // failed, so it must always be the way out.
  it('never renders a disabled action', () => {
    render(<SettledNotice label="Accepted" actionLabel="Refresh" onAction={() => {}} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components src/components/ui/settled-notice.test.tsx`
Expected: FAIL — `Failed to resolve import "./settled-notice"`.

- [ ] **Step 3: Implement the component**

Create `src/components/ui/settled-notice.tsx`. Match the conventions of
`src/components/ui/button.tsx`: named export, a props interface, a `Record`
keyed by the variant, and no client directive (this is presentational and holds
no state — the `onAction` closure comes from a `'use client'` parent).

```tsx
type SettledSize = 'caption' | 'sm';

interface SettledNoticeProps {
  /** What happened, in the past tense: "Marked unpaid", "Accepted", "Created". */
  label: string;
  /** The control's accessible name — "Refresh", or where the failed push was going. */
  actionLabel: string;
  onAction: () => void;
  size?: SettledSize;
}

const sizeClasses: Record<SettledSize, string> = {
  caption: 'type-caption',
  sm: 'text-sm',
};

/**
 * #40. The state a control reaches when its mutation committed but the
 * `router.refresh()` / `router.push()` that should have replaced it did not —
 * both return `void`, so the caller cannot know which happened.
 *
 * Re-offering the original action would be wrong twice over: it has already
 * succeeded, and on a non-idempotent endpoint the retry earns a 4xx in red over
 * an action that worked. Leaving the control disabled — the previous answer, and
 * review finding F7's — freezes it instead. This says what happened and offers
 * the repaint that failed.
 *
 * The action is deliberately never disabled. This component only renders
 * because something else did not work; it must always be the way out.
 */
export function SettledNotice({
  label,
  actionLabel,
  onAction,
  size = 'caption',
}: SettledNoticeProps) {
  const scale = sizeClasses[size];

  return (
    <span className="inline-flex items-center gap-2">
      <span className={`${scale} text-teal`}>{label}</span>
      <span aria-hidden="true" className={`${scale} text-teal`}>
        ·
      </span>
      <button type="button" onClick={onAction} className={`${scale} text-teal min-h-[44px] px-1`}>
        {actionLabel}
      </button>
    </span>
  );
}
```

The middot is `aria-hidden` because it is a visual separator; a screen reader
should hear "Marked unpaid" then the button, not a stray punctuation mark.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project components src/components/ui/settled-notice.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/settled-notice.tsx src/components/ui/settled-notice.test.tsx
git commit -m "feat: one settled state for five controls that outlive their refresh"
```

---

### Task 2: `MarkUnpaidButton` — settled state and a live escape

**Files:**
- Modify: `src/components/class/mark-unpaid-button.tsx`
- Create: `src/components/class/mark-unpaid-button.test.tsx`

**Interfaces:**
- Consumes: `SettledNotice` from Task 1.
- Produces: the settled-state *wiring* that Tasks 5–8 follow — `const [done, setDone] = useState(false)`, `setDone(true)` before the router call, an early `if (done) return <SettledNotice … />`, and an escape control that no longer carries the pending flag.

- [ ] **Step 1: Write the failing tests**

Create `src/components/class/mark-unpaid-button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkUnpaidButton } from './mark-unpaid-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * #40. The success path is a `router.refresh()`, which returns `void` — the
 * component cannot learn whether the commit landed. It used to bet that the
 * refresh would unmount it, leaving `busy` true forever when that bet lost:
 * both "Confirm unpaid" and its "Keep" escape disabled, on a money-correcting
 * action, while the row still read "✓ paid".
 *
 * The router mock in `tests/setup/components.ts` is a bare `vi.fn()`, so every
 * test here already runs in exactly that dropped-commit state.
 */
describe('MarkUnpaidButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function openConfirm() {
    render(<MarkUnpaidButton paymentId="pay-1" />);
    fireEvent.click(screen.getByRole('button', { name: /mark unpaid/i }));
  }

  it('POSTs to the unpaid endpoint and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/unpaid', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  // G1
  it('settles to "Marked unpaid" when the refresh commits nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(await screen.findByText('Marked unpaid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /updating/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm unpaid/i })).toBeNull();
  });

  // G1, second half: the settled state must not re-offer the action.
  it('cannot send a second POST once settled', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));
    await screen.findByText('Marked unpaid');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  // G2
  it('leaves Keep operable while the POST is in flight', async () => {
    let release!: (value: { ok: boolean }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    const keep = screen.getByRole('button', { name: /keep/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /updating/i })).toBeDisabled());
    expect(keep).toBeEnabled();

    fireEvent.click(keep);
    expect(screen.getByRole('button', { name: /mark unpaid/i })).toBeInTheDocument();

    release({ ok: true });
  });

  it('shows the server error and re-enables on a failed POST', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Cannot undo: current status is "pending". Must be "paid".' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(
      await screen.findByText('Cannot undo: current status is "pending". Must be "paid".'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm unpaid/i })).toBeEnabled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/class/mark-unpaid-button.test.tsx`

Expected: the G1 tests fail with `Unable to find an element with the text: Marked unpaid`; the G2 test fails because `Keep` is disabled — `expect(element).toBeEnabled()` receives a disabled `<button>`.

- [ ] **Step 3: Implement the settled state and free the escape**

In `src/components/class/mark-unpaid-button.tsx`, add `done` alongside the existing state (after line 20):

```tsx
  const [done, setDone] = useState(false);
```

Replace the body of `handleUnpaid`'s success branch so the whole function reads:

```tsx
  async function handleUnpaid() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/unpaid`, { method: 'POST' });
      if (res.ok) {
        // #40. The refresh below normally replaces this row (the payment moves
        // Received → Outstanding) and this component unmounts, so `done` is
        // never seen. When the commit is dropped it is the only thing standing
        // between the teacher and a dead button: the action HAS committed, so
        // re-offering it would earn a 409 ("current status is 'pending'") over
        // an action that worked. Say what happened instead, and offer the
        // repaint that failed.
        setDone(true);
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not update. Try again.'));
      setBusy(false);
    } catch {
      setError('Network error. Try again.');
      setBusy(false);
    }
  }
```

Add the import:

```tsx
import { SettledNotice } from '@/components/ui/settled-notice';
```

Add the settled render **above** the `if (!confirming)` block:

```tsx
  if (done) {
    return (
      <SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={() => router.refresh()} />
    );
  }
```

Remove `disabled={busy}` from the `Keep` button (line 66), leaving:

```tsx
      {/*
        #40. Deliberately NOT disabled by `busy`. `Keep` is a pure client-side
        state reset that touches no network, and it is the only way out of this
        confirm cluster if the request hangs rather than resolving — a case the
        settled state above cannot reach, because there is no success path yet.
        It cannot cancel an in-flight request; if that request later succeeds,
        the settled state renders, which is the honest outcome.
      */}
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        Keep
      </button>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/class/mark-unpaid-button.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-test G1 and G2**

G1 — delete `setDone(true);` from the success branch (restoring the pre-fix behaviour exactly). Re-run. Record the failure text; expect `Unable to find an element with the text: Marked unpaid`. Restore and re-run to green.

G2 — re-add `disabled={busy}` to the `Keep` button. Re-run. Record the failure text; expect the `toBeEnabled()` assertion to report a disabled element. Restore and re-run to green.

Write both recorded failure texts into the ledger. A guard whose mutation was not observed failing is not done.

- [ ] **Step 6: Commit**

```bash
git add src/components/class/mark-unpaid-button.tsx src/components/class/mark-unpaid-button.test.tsx
git commit -m "fix: a dropped refresh no longer traps the mark-unpaid confirm"
```

---

### Task 3: `SignOutButton` — reset on an idempotent action

**Files:**
- Modify: `src/components/account/sign-out-button.tsx`
- Create: `src/components/account/sign-out-button.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the failing test**

Create `src/components/account/sign-out-button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignOutButton } from './sign-out-button';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

/**
 * #40. This was the only component in the codebase that reset its pending flag
 * on no path at all — not even failure. The session cookie is already cleared
 * server-side by the time the push runs, so a dropped commit left the user
 * looking at a stale authenticated shell with no working control to leave it.
 *
 * A plain reset is correct here rather than a settled state: DELETE
 * /api/auth/session is idempotent, so a second tap is harmless, and "success"
 * means being on another page — there is nothing to settle to.
 */
describe('SignOutButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('DELETEs the session, then pushes and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // G3
  it('re-enables when the push and refresh commit nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.getByRole('button')).toHaveTextContent('Sign out');
  });

  it('still leaves for the login page when the DELETE itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components src/components/account/sign-out-button.test.tsx`
Expected: the G3 test and the failure test both fail — `expect(element).toBeEnabled()` receives a disabled `<button>` still reading "Signing out...".

- [ ] **Step 3: Implement the reset**

Replace `handleSignOut` in `src/components/account/sign-out-button.tsx`:

```tsx
  async function handleSignOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/session', { method: 'DELETE' });
    } catch {
      // The cookie clear is what matters; a network hiccup here should
      // not trap someone in a signed-in state — fall through to login.
    } finally {
      // #40. Neither the push nor the refresh is guaranteed to commit on a
      // starved or offline device, and both return `void`, so this component
      // cannot learn whether they did. Resetting here means a dropped commit
      // leaves a tappable button rather than a stale authenticated shell with
      // no way out. DELETE /api/auth/session is idempotent, so a second tap
      // costs nothing.
      router.push('/login');
      router.refresh();
      setBusy(false);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project components src/components/account/sign-out-button.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-test G3**

Delete the single line `setBusy(false);` from the `finally` (leaving the router calls, so only the guard under test changes). Re-run. Record the failure text; expect `toBeEnabled()` to receive a disabled element. Restore and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/components/account/sign-out-button.tsx src/components/account/sign-out-button.test.tsx
git commit -m "fix: sign out re-enables when the navigation never commits"
```

---

### Task 4: `PasskeySignIn` — an explicit reset that must not clobber the error

**Files:**
- Modify: `src/components/booking/passkey-sign-in.tsx`
- Create: `src/components/booking/passkey-sign-in.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed later.

**Why this task is not a `finally`:** the pending flag is a tri-state union (`'idle' | 'working' | 'error'`, line 17) shared with the error state. A `finally { setState('idle') }` would erase the `'error'` the `catch` sets at line 53. G5 exists to prove that distinction is load-bearing rather than stylistic.

- [ ] **Step 1: Write the failing tests**

Create `src/components/booking/passkey-sign-in.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PasskeySignIn } from './passkey-sign-in';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

/**
 * #40. Sign-in is the gate to the whole app, and this button froze at
 * "Follow your device…" on a URL that did not change — so nothing on screen
 * suggested a reload and the user simply could not get in.
 *
 * The reset is explicit rather than a `finally` because `state` carries the
 * error too; see the last test, which fails against a `finally` version.
 */
describe('PasskeySignIn', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    startAuthentication.mockReset();
    startAuthentication.mockResolvedValue({ id: 'cred-1' });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubHappyPath() {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { redirectTo: '/bookings' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('pushes the returned redirect and refreshes', async () => {
    stubHappyPath();
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/bookings'));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // G4
  it('returns to idle when the push and refresh commit nothing', async () => {
    stubHappyPath();
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled(),
    );
  });

  // G5 — the reset must not be a `finally`, or this error is erased.
  it('shows the fallback message when verification fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
      })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/use the email link instead/i)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('returns silently to idle when the user dismisses the OS prompt', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const dismissed = new Error('dismissed');
    dismissed.name = 'NotAllowedError';
    startAuthentication.mockRejectedValue(dismissed);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled(),
    );
    expect(screen.queryByText(/use the email link instead/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/booking/passkey-sign-in.test.tsx`
Expected: the G4 test fails — the button stays disabled reading "Follow your device…". The other three pass already.

- [ ] **Step 3: Implement the explicit reset**

In `src/components/booking/passkey-sign-in.tsx`, replace lines 46–47 with:

```tsx
      router.push(verified.data.redirectTo);
      router.refresh();
      // #40. Explicitly NOT a `finally`: `state` carries the error too, so a
      // blanket reset would erase the `'error'` the catch below sets and the
      // user would be told nothing when a verify fails. Reset here, on the
      // success path only. Sign-in is idempotent — a retry mints a fresh
      // challenge and succeeds again — so returning to idle is safe, and it
      // beats freezing the gate to the whole app when the push never commits.
      setState('idle');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/booking/passkey-sign-in.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-test G4 and G5**

G4 — delete the `setState('idle');` line. Re-run. Record the failure; expect the "returns to idle" test to find a disabled button. Restore.

G5 — this is the important one. Replace the explicit reset with a blanket reset, i.e. delete `setState('idle')` from the success path and wrap the whole `try`/`catch` with:

```tsx
    } finally {
      setState('idle');
    }
```

Re-run. The "shows the fallback message when verification fails" test **must** fail with `Unable to find an element with the text: /use the email link instead/i`. If it passes, the guard is not testing what it claims and must be rewritten before proceeding — a test asserting only the button label would pass against this mutation. Restore and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/components/booking/passkey-sign-in.tsx src/components/booking/passkey-sign-in.test.tsx
git commit -m "fix: passkey sign-in no longer freezes the gate on a dropped nav"
```

---

### Task 5: `PendingInvitationCard` — settled state, and correcting F7's test

**Files:**
- Modify: `src/components/student/pending-invitation-card.tsx`
- Modify: `src/components/student/pending-invitation-card.test.tsx:61-70`

**Interfaces:**
- Consumes: `SettledNotice` from Task 1; the settled-state wiring from Task 2.
- Produces: nothing consumed later.

**Read first:** spec §7. This file's non-reset is documented at lines 40–46 as the fix for review finding **F7**, and F7's conclusion is *kept* — a plain `finally` here is a regression, because the retry lands on a real 409 (`ALREADY_ANSWERED`). What changes is the alternative: a settled state avoids both the false error and the freeze. **The existing test at line 67 asserts the defect** (`expect(acceptButton).toBeDisabled()`), and must be corrected, not left.

- [ ] **Step 1: Rewrite F7's test to assert the settled state**

Replace the test at `src/components/student/pending-invitation-card.test.tsx:61-70` — comment and all — with:

```tsx
  // Review F7 found that `setSubmitting(false)` in a `finally` fired right
  // after the success branch called `router.refresh()`, before that refresh had
  // repainted the page and dropped this card. A second click in that window
  // reached the server for an invitation that was already answered, surfacing a
  // red "already answered" over an action that had, in fact, succeeded.
  //
  // F7's conclusion stands and is still pinned below: a second click must not
  // reach the server. #40 changed only its remedy. F7 left `submitting` true
  // forever, which froze all four controls when the refresh never committed —
  // a student could give neither answer. The card now settles instead, which
  // blocks the second POST *and* leaves the student somewhere they can act.
  it('settles after a successful accept, and cannot send a second POST', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));

    expect(await screen.findByText(/^Accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('settles to "Declined" after a successful decline', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));

    expect(await screen.findByText(/^Declined/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline invitation/i })).toBeNull();
  });

  // G6, second half — Mode 2. If the POST hangs rather than resolving, the
  // settled state never renders, and Cancel is the only way out.
  it('leaves Cancel operable while the decline is in flight', async () => {
    let release!: (value: { ok: boolean }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));

    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /declining/i })).toBeDisabled());
    expect(cancel).toBeEnabled();

    release({ ok: true });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/student/pending-invitation-card.test.tsx`
Expected: the two settled tests fail with `Unable to find an element with the text: /^Accepted/` and `/^Declined/`; the Cancel test fails with a disabled element passed to `toBeEnabled()`.

- [ ] **Step 3: Implement the settled state and free Cancel**

In `src/components/student/pending-invitation-card.tsx`, add after line 28:

```tsx
  const [done, setDone] = useState<'accept' | 'decline' | null>(null);
```

Replace the success branch inside `respond` (lines 39–49) with:

```tsx
      if (res.ok) {
        // #40, superseding review F7. F7 was right that a `finally` reset is
        // wrong here — the answer has committed, so a second click earns a 409
        // (`ALREADY_ANSWERED`) in red over an action that worked. Its remedy
        // was to leave `submitting` true, which froze all four controls when
        // the refresh never committed: a student could give neither answer.
        // Settling blocks the second POST the same way and still leaves them
        // somewhere they can act.
        setDone(response);
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not respond. Try again.'));
      setSubmitting(false);
```

Add the settled render immediately before the existing `return (` of the component body:

```tsx
  if (done) {
    return (
      <section className="bg-sand-soft border border-border rounded-card p-5">
        <h3 className="type-label text-ink font-semibold mb-2">{teacherName}</h3>
        <SettledNotice
          label={done === 'accept' ? 'Accepted' : 'Declined'}
          actionLabel="Refresh"
          onAction={() => router.refresh()}
        />
      </section>
    );
  }
```

Add the import:

```tsx
import { SettledNotice } from '@/components/ui/settled-notice';
```

Remove `disabled={submitting}` from the `Cancel` button (line 76), adding above it:

```tsx
            {/*
              #40. Not disabled by `submitting`: a pure client-side reset, and
              the only way out of this confirm if the POST hangs rather than
              resolving — a case the settled state cannot reach.
            */}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/student/pending-invitation-card.test.tsx`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Mutation-test G6**

Restore F7's documented non-reset: delete `setDone(response);`, leaving `router.refresh(); return;`. Re-run. Record the failure; expect `Unable to find an element with the text: /^Accepted/`. Then separately re-add `disabled={submitting}` to `Cancel` and confirm the in-flight test fails. Restore both and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/components/student/pending-invitation-card.tsx src/components/student/pending-invitation-card.test.tsx
git commit -m "fix: an answered invitation settles instead of freezing all four controls"
```

---

### Task 6: `TeacherPrivacyCard` — settled unlink, and correcting F7's second test

**Files:**
- Modify: `src/components/student/teacher-privacy-card.tsx`
- Modify: `src/components/student/teacher-privacy-card.test.tsx:165-185`

**Interfaces:**
- Consumes: `SettledNotice` from Task 1; the settled-state wiring from Task 2.
- Produces: nothing consumed later.

**Scope note:** only `handleUnlink` changes. `handleSave` (lines 77–108) already resets in a `finally` at 106–107 and stays mounted after a successful save — it is correct and must not be touched. Touching one arm of a two-arm component is exactly the partial edit this project has shipped before; keep the diff to the unlink arm.

- [ ] **Step 1: Rewrite F7's test to assert the settled state**

Replace the test at `src/components/student/teacher-privacy-card.test.tsx:175-185` and its preceding comment with:

```tsx
    // Review F7 found that `setUnlinking(false)` in a `finally` fired right
    // after a successful DELETE, before `router.refresh()` had repainted the
    // page and dropped this card — so a second click reached the server for a
    // link that was already gone and showed "not found" over a success.
    //
    // F7's conclusion stands and is still pinned: a second click must not reach
    // the server. #40 changed only the remedy, because F7's left `unlinking`
    // true forever and froze the confirm cluster when the refresh never
    // committed.
    it('settles after a successful unlink, and cannot send a second DELETE', async () => {
      stubFetch();
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));

      expect(await screen.findByText(/^Removed/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^remove teacher$/i })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // G7, second half — Mode 2.
    it('leaves Cancel operable while the DELETE is in flight', async () => {
      let release!: (value: { ok: boolean }) => void;
      fetchMock.mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderCard();
      fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
      fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));

      const cancel = screen.getByRole('button', { name: /^cancel$/i });
      await waitFor(() => expect(screen.getByRole('button', { name: /removing/i })).toBeDisabled());
      expect(cancel).toBeEnabled();

      release({ ok: true });
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/student/teacher-privacy-card.test.tsx`
Expected: failure with `Unable to find an element with the text: /^Removed/`, and a disabled element passed to `toBeEnabled()`.

- [ ] **Step 3: Implement the settled state and free Cancel**

In `src/components/student/teacher-privacy-card.tsx`, add beside `unlinking` (line 69):

```tsx
  const [unlinked, setUnlinked] = useState(false);
```

Rewrite the docblock at lines 122–127 and the success branch, so `handleUnlink`'s success reads:

```tsx
      if (res.ok) {
        setUnlinked(true);
        router.refresh();
        return;
      }
```

with the docblock paragraph replaced by:

```
   * `unlinking` is deliberately not reset on success (review F7): the DELETE
   * has committed, so a second click would earn a 404 ("Teacher link not
   * found") in red over an action that worked. F7's own remedy — leaving the
   * flag true — froze this cluster whenever the refresh did not commit, so
   * #40 replaced it with `unlinked`: the card settles, which blocks the second
   * DELETE the same way and still leaves the student a control that works.
```

Replace the confirm cluster's buttons (lines 197–208) so the settled state renders in their place:

```tsx
            {unlinked ? (
              <SettledNotice
                label="Removed"
                actionLabel="Refresh"
                onAction={() => router.refresh()}
              />
            ) : (
              <div className="flex items-center gap-3">
                <Button variant="destructive" onClick={handleUnlink} disabled={unlinking}>
                  {unlinking ? 'Removing...' : 'Remove teacher'}
                </Button>
                {/*
                  #40. Not disabled by `unlinking`: a pure client-side reset,
                  and the only way out if the DELETE hangs rather than
                  resolving — a case the settled state cannot reach.
                */}
                <Button variant="secondary" onClick={() => setConfirmingUnlink(false)}>
                  Cancel
                </Button>
              </div>
            )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/student/teacher-privacy-card.test.tsx`
Expected: PASS, all tests in the file — including the untouched `handleSave` tests.

- [ ] **Step 5: Mutation-test G7**

Delete `setUnlinked(true);` (restoring F7's behaviour). Re-run; record the failure text. Restore. Then add `disabled={unlinking}` back to `Cancel`; confirm the in-flight test fails; restore. Re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/components/student/teacher-privacy-card.tsx src/components/student/teacher-privacy-card.test.tsx
git commit -m "fix: a completed unlink settles instead of freezing its confirm"
```

---

### Task 7: `TemplateForm` create mode — the duplicate-schedule guard

**Files:**
- Modify: `src/components/settings/template-form.tsx`
- Modify: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes: `SettledNotice` from Task 1; the settled-state wiring from Task 2.
- Produces: nothing consumed later.

**Why this is the highest-value task in the branch:** `POST /api/class-templates` is a DUPLICATE endpoint — a second request creates a second template *and* re-runs `generateInstancesForTemplate`, materialising a full duplicate set of bookable `Class` rows. On create the form resets in a `finally` (line 267) and pushes (line 240). If that push does not commit, the form sits fully populated and re-enabled, looking exactly like a click that never landed — and the natural second click duplicates the teacher's entire recurring schedule, phantom copies included, bookable by students.

**Edit mode is out of scope.** It sets a success string and refreshes while staying mounted, which is correct. Only the `create` arm changes.

**Test-file convention:** this file stubs `fetch` for every test because the form fetches its room list on mount. The first call is that room fetch; the submit is the last, which is why existing assertions read `mock.calls.at(-1)`. Follow it.

- [ ] **Step 1: Write the failing test**

Add to `src/components/settings/template-form.test.tsx`, inside the existing `describe`:

```tsx
  /**
   * #40. POST /api/class-templates is not idempotent: a second request creates
   * a second template AND regenerates a second set of bookable classes. On
   * create this form pushed and reset `submitting` in a `finally`, so a push
   * that never committed left a populated, re-enabled form — and the obvious
   * second click duplicated the teacher's whole recurring schedule.
   *
   * The assertion is on the fetch count, not on rendered text: a partial fix
   * that only changes a label would satisfy a text assertion while still
   * allowing the second POST.
   */
  // G8
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/recurring'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to recurring classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
  });
```

Add `routerPush` to the file's imports:

```tsx
import { routerPush } from '../../../tests/setup/components';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`
Expected: FAIL — `expect(received).toBeNull()` receives the still-rendered Create button, because the `finally` re-enabled it.

- [ ] **Step 3: Implement the settled state**

In `src/components/settings/template-form.tsx`, add beside `submitting` (line 129):

```tsx
  const [created, setCreated] = useState(false);
```

Guard the handler's entry, immediately inside `handleSubmit` before `setSubmitting(true)`:

```tsx
    // #40. A settled create must not be re-submittable, including by pressing
    // Enter in a still-mounted field — the button is gone, the form is not.
    if (created) return;
```

Replace the create branch (line 239–241):

```tsx
      if (mode === 'create') {
        // #40. POST /api/class-templates is not idempotent: a second request
        // creates a second template and regenerates a second set of bookable
        // classes. The push below normally unmounts this form; when it does not
        // commit, `created` is what stops a populated, re-enabled form inviting
        // the click that duplicates the teacher's whole schedule.
        setCreated(true);
        router.push('/settings/recurring');
      } else {
```

Replace the submit button (lines 432–434) with:

```tsx
      {created ? (
        <SettledNotice
          label="Created"
          actionLabel="Go to recurring classes"
          size="sm"
          onAction={() => router.push('/settings/recurring')}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`
Expected: PASS, all tests — the edit-mode tests must be untouched and still green.

- [ ] **Step 5: Mutation-test G8**

Delete `setCreated(true);` from the create branch, restoring the pre-fix behaviour. Re-run. Record the failure text; the fetch-count assertion must be the thing that fails, proving the guard detects a *second POST* and not merely a changed label. Restore and re-run to green.

Then run a second mutation: keep `setCreated(true)` but restore the old unconditional submit button (so the label changes but the button remains). The test must still fail. If it passes, the guard is text-shaped rather than behaviour-shaped and must be rewritten.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix: a dropped create push can no longer duplicate a recurring schedule"
```

---

### Task 8: `StudioTemplateForm` create mode

**Files:**
- Modify: `src/components/settings/studio-template-form.tsx`
- Modify: `src/components/settings/studio-template-form.test.tsx`

**Interfaces:**
- Consumes: `SettledNotice` from Task 1; the settled-state wiring from Task 2; the same structure as Task 7.
- Produces: nothing consumed later.

`POST /api/studio-class-templates` has the identical shape and the identical defect: a duplicate template plus a duplicate generated window, double-counting the teacher's studio income projection. Splitting the two families is how they drift — the reason #98 widened from four endpoints to six.

- [ ] **Step 1: Write the failing test**

Add to `src/components/settings/studio-template-form.test.tsx`, inside the existing `describe`, and add `routerPush` to its imports from `'../../../tests/setup/components'`:

```tsx
  /**
   * #40, the studio twin of the class-template guard. POST
   * /api/studio-class-templates is not idempotent: a second request creates a
   * second template and a second generated window, double-counting studio
   * income. Asserted on the fetch count, not on rendered text.
   */
  // G9
  it('cannot submit twice when the create push commits nothing', async () => {
    stubFetch();
    render(<StudioTemplateForm mode="create" />);

    const button = await screen.findByRole('button', { name: /create/i });
    fireEvent.click(button);

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/studio-classes'));

    const callsAfterFirstSubmit = fetchMock.mock.calls.length;
    expect(screen.queryByRole('button', { name: /^create$/i })).toBeNull();
    expect(screen.getByText(/^Created/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to studio classes/i }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstSubmit);
  });
```

If the existing file's render helper differs from `render(<StudioTemplateForm mode="create" />)`, use that helper instead — read the file's other create-mode test first and match it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project components src/components/settings/studio-template-form.test.tsx`
Expected: FAIL — the Create button is still rendered.

- [ ] **Step 3: Implement the settled state**

In `src/components/settings/studio-template-form.tsx`, add beside `submitting` (line 73):

```tsx
  const [created, setCreated] = useState(false);
```

Immediately inside `handleSubmit`, before `setSubmitting(true)`:

```tsx
    // #40. A settled create must not be re-submittable, including via Enter in
    // a still-mounted field.
    if (created) return;
```

Replace the create branch (lines 118–120):

```tsx
      if (mode === 'create') {
        // #40. POST /api/studio-class-templates is not idempotent: a second
        // request creates a second template and a second generated window.
        setCreated(true);
        router.push('/settings/studio-classes');
      } else {
```

Replace the submit button (lines 183–185) with:

```tsx
      {created ? (
        <SettledNotice
          label="Created"
          actionLabel="Go to studio classes"
          size="sm"
          onAction={() => router.push('/settings/studio-classes')}
        />
      ) : (
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/settings/studio-template-form.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Mutation-test G9**

Delete `setCreated(true);`. Re-run; the fetch-count assertion must fail. Record the text. Restore and re-run to green.

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/studio-template-form.tsx src/components/settings/studio-template-form.test.tsx
git commit -m "fix: the studio create push gets the same duplicate guard as its twin"
```

---

### Task 9: Correct the artifacts, run the full gate, file the follow-ups

**Files:**
- Modify: `tests/e2e/teacher-journey.spec.ts:244-247`
- Create: two GitHub issues via `--body-file`

**Interfaces:**
- Consumes: the finished branch (this task reconciles counts against it).
- Produces: the PR body's evidence.

- [ ] **Step 1: Correct the causal overreach in the e2e comment**

`teacher-journey.spec.ts:245-247` states the unverified cause as settled fact. The mitigation is correct for any dropped repaint; only the attribution overreaches. Replace lines 244–247 with:

```ts
    // Wait for the transition POST, then reload and assert the
    // server-rendered truth: the router can drop a post-action refresh
    // commit, so the state change lands and the client repaint does not.
    // CPU starvation on CI runners was the suspected cause (#40); that
    // remains unverified and its trace artifacts have expired. The reload
    // is correct regardless of which cause drops the commit.
```

- [ ] **Step 1b: Amend the spec, which Task 1 falsified**

Spec §6's first rejected design reads "A single shared hook for all 44 call sites" and concludes "The artifact this design ships is therefore a stated invariant with a test per instance, not an abstraction." Task 1 ships a presentational abstraction, so that last clause is now wrong.

Edit `docs/superpowers/specs/2026-08-11-dropped-refresh-recovery-design.md` so the conclusion reads:

```
**Even across just the seven in scope there are four shapes.** The artifact this
design ships is therefore a stated invariant with a test per instance, plus one
shared *presentational* component (`SettledNotice`) — the axis on which the five
settled states genuinely are identical. It holds no state, performs no fetch and
makes no routing decision, so none of the measurement above bears on it.
```

A claim corrected in the plan and left standing in the spec is the failure mode this project keeps hitting; both artifacts must agree.

- [ ] **Step 2: Run the full gate**

Run: `npm run verify`

This needs the app already running on :3000 — the user runs it; do not start or restart it. Without it you get a wall of `ECONNREFUSED`, which means the server is down, not that the branch is broken.

Record the exact test totals per project. Green `verify` is a strong signal but **not** a substitute for CI: CI additionally runs `prisma validate`, a migration-drift check, `npm run build`, and Playwright. This branch touches no schema and adds no server imports, but the build check still matters — `@/lib/log` is pino and server-only, and none of the seven components may pull it in transitively.

- [ ] **Step 3: Reconcile the test count arithmetically**

Compute and record: previous `components` project total, plus tests added per file in Tasks 1–8, equals the new total. State it as arithmetic a reviewer can re-derive.

**Measured baseline on this branch's base commit (`e99ecd3`), read off the runner:**

```
components project:  32 files, 159 tests
unit + components:   78 files, 776 passed + 2 todo = 778
```

**Count tests, not files.** `32` is the file count and `159` is the test count; conflating them is the exact error this project's process warns about. The reconciliation is against **159**, e.g. `159 + 3 (settled-notice) + 5 (mark-unpaid) + 3 (sign-out) + 4 (passkey) + 2 net (invitation: 3 added, 1 replaced) + 1 net (privacy: 2 added, 1 replaced) + 1 (template) + 1 (studio) = 179`. Two of the eight files *replace* an existing test rather than adding one — count them net, and say so. Do not assert a number you have not read off the runner.

- [ ] **Step 4: File the duplicate-endpoint issue**

Write the body to the scratchpad first — **never** pass prose to `gh` with `--body "…"`, because backticks inside a double-quoted zsh string are still command substitution and it fails silently, publishing mangled text.

```bash
gh issue create --title "Seven endpoints duplicate their side effect on a retried request" --body-file /private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/90e2370f-761d-4fba-90c1-0510805eadcb/scratchpad/issue-duplicates.md
```

The body must carry the measurement from spec §3, not a restatement of the symptom: the arithmetic (47 distinct endpoints = 22 idempotent + 18 conflict + 7 duplicate), the seven endpoints with the real-world consequence of each, the verified negatives (registrations, contact invitations and room links are protected by unique constraints — name them), the note that Rule 1 closed the two *reachable* paths but the endpoints stay duplicable by any other double-submit, and the product question that gates the design: **may a teacher deliberately send two identical announcements?** If yes, deduplication must key on intent, not content. Include `send-reminder-button`'s missing cooldown and `POST /api/rooms`'s public-only dedupe check. Add `edit-room-form.tsx`'s two sequential PUTs (a mid-chain failure leaves the server half-updated) as an **Update** section in this same issue rather than a third issue.

- [ ] **Step 5: File the conflict-copy issue**

```bash
gh issue create --title "Conflict responses show developer strings to users" --body-file /private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/90e2370f-761d-4fba-90c1-0510805eadcb/scratchpad/issue-conflict-copy.md
```

Body: 18 of 47 endpoints return CONFLICT, and `readErrorMessage` (`src/lib/client-errors.ts:10`) passes the server's message through verbatim. Quote the worst example exactly: `Invalid transition: cannot move from "open" to "open". Valid transitions from "open": [in_progress, cancelled]`. Note that only 4 of the 18 pass a machine-readable code today, which is what a client would need to distinguish "already done" from a real conflict — cross-reference #121's classification design.

- [ ] **Step 6: Commit and open the PR**

```bash
git add tests/e2e/teacher-journey.spec.ts
git commit -m "test: the flake comment claimed a cause the evidence no longer supports"
```

PR body requirements: state which inherited claims were checked and which held (spec §1 — three of the issue's seven claims were wrong or stale, including its proposed remedy); show the arithmetic behind every number; correct your own error about walk-in duplication explicitly; name by path the files this branch touched; and say which suites ran. `npm run verify` runs all three vitest projects, so a green run **is** the whole integration suite — state that with the arithmetic that proves it rather than as a reassurance. In the scope section write "**#40 is unaffected and stays open for its framework half**" — never "does not close #40".

- [ ] **Step 7: Update the roadmap (never commit it)**

`docs/backlog-roadmap.md` is untracked and stays that way. Record what was actually learned, not a restatement: that the issue's premise held for its one named file but undercounted the surface by four; that its proposed remedy (`useTransition`) does not work; that the framework claim was deliberately not re-measured and why; and the ratio — **one issue in, two out**, both live defects, justified by the review finding an under-explored area (nobody had asked what a *second* request does). Re-check the open count against `gh issue list`.

---

## Self-review

**Spec coverage.** §5 Rule 1 → Tasks 2, 5, 6, 7, 8, with the presentation shared via Task 1. Rule 2 → Tasks 3, 4. Rule 3 → Tasks 2, 5, 6. §7 F7 correction → Tasks 5, 6 (both comment and test). §8 filed follow-ups → Task 9 Steps 4–5. §8 e2e comment → Task 9 Step 1. §9 guards G1–G9 → the mutation step of each task (G1/G2 in 2, G3 in 3, G4/G5 in 4, G6 in 5, G7 in 6, G8 in 7, G9 in 8). §10 acceptance items 1–4 are the tests; 5 the mutation steps; 6 Task 9 Steps 2–3; 7 Task 9 Steps 4–5.

**One deliberate departure from the spec, recorded so a reviewer does not read it as a violation.** Spec §6 rejects a shared abstraction; Task 1 adds one. The rejection was measured against *mutation flow* — thirteen control-flow shapes across the codebase, four among these seven files — and Task 1 abstracts only *presentation*, the axis on which the five settled states genuinely are identical. It holds no state, performs no fetch, and makes no routing decision. The spec's measurement does not contradict it, but the spec's prose does, so the spec is amended in Task 9 alongside the other artifact corrections.

**Placeholders.** None: every code step carries the actual code, every run step the actual command and expected output. Task 8 Step 1 contains one conditional instruction (match the file's existing render helper) — a read-then-match instruction with a named fallback, not a TBD.

**Type consistency.** `done` is `boolean` in Task 2, `unlinked` is `boolean` in Task 6, and `done` is `'accept' | 'decline' | null` in Task 5 — deliberately, because that card must render which answer was given. `created` is `boolean` in Tasks 7 and 8. `SettledNotice`'s props are fixed by Task 1 (`label`, `actionLabel`, `onAction`, `size?`) and used unchanged thereafter — `size="sm"` only in Tasks 7 and 8. `routerRefresh` / `routerPush` are imported from `tests/setup/components` throughout and never redeclared.

**Known risk to watch during execution.** Tasks 7 and 8 edit one arm of a two-arm handler. A subagent that "tidies" the edit arm has exceeded scope — the edit arm stays mounted after save and is correct as it is.
