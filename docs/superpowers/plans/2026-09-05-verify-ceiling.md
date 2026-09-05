# A ceiling on `/verify`'s verifying state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verification that never answers ends on a screen that names what
happened, offers a recovery that is safe whether or not the token was consumed,
and cannot afterwards be overwritten by a late response.

**Architecture:** One timer, armed at mount beside the existing appearance
timer, bounding the `verifying` **state** rather than either of the two
requests that can occupy it. `settle` cancels it; once it has fired, `settle`
is inert and the in-flight fetch is aborted — so the state has exactly one
exit and the first claim on that exit wins permanently.

**Tech Stack:** Next.js App Router client component, React hooks, vitest +
`@testing-library/react` with fake timers.

**Spec:** `docs/superpowers/specs/2026-09-05-verify-ceiling-design.md`

## Global Constraints

- **Test command:** `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"` — the path must be quoted, it contains `(public)`.
- **Never `git add -A` or `git add .`** — stage exact paths, quoted.
- **Copy is fixed by the spec and approved verbatim.** Label `Connection problem`; heading `We couldn't reach the server.`; body `Your link may have worked anyway — we just never got an answer. If it did, that link is spent now, so use a fresh one.`; button `Send a new link` → `/login`.
- **Threshold:** `VERIFY_CEILING_MS = 20_000`.
- **Log prefix:** every log line in this file begins `[verify]`.
- **Comment Discipline (CLAUDE.md):** no comment may carry a count, a roster, or a fact about another file. The 89–194ms measurements and the nginx figure belong to the spec; comments link to it rather than restating it.
- **Do not add abort-on-unmount.** Only the ceiling aborts. Cleanup-abort would change existing double-mount behaviour and is out of scope.
- **Task order is load-bearing:** Task 2 modifies code Task 1 creates.

---

### Task 1: The ceiling reaches a state that is not the expired-link screen

Delivers the whole user-visible fix: a stalled verification stops stranding
the reader. Task 2 hardens it against a late response.

**Files:**
- Modify: `src/app/(public)/verify/page.tsx`
- Test: `src/app/(public)/verify/page.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, for Task 2:
  - `export const VERIFY_CEILING_MS = 20_000`
  - `Status` union gains the member `'timeout'`
  - `useVerifyingRail(enabled: boolean, onApplyThrew: () => void, onCeiling: () => void)` — unchanged return type `{ railVisible: boolean; settle: (apply: () => void) => void }`
  - `ceilingTimer: useRef<ReturnType<typeof setTimeout> | null>` inside the hook
  - `function TimedOutState(): React.JSX.Element` — no props

- [ ] **Step 1: Write the failing tests**

Add to `page.test.tsx`. First extend the import on the line that currently
reads `import VerifyPage, { RAIL_APPEARS_AFTER_MS, RAIL_STAYS_FOR_MS, RAIL_HEADING } from './page';`:

```tsx
import VerifyPage, {
  RAIL_APPEARS_AFTER_MS,
  RAIL_STAYS_FOR_MS,
  RAIL_HEADING,
  VERIFY_CEILING_MS,
} from './page';
```

Then add these cases inside the existing `describe('the verifying rail', …)`
block, after the `'paints nothing while the search params are still suspended'`
case:

```tsx
    /**
     * The far end of the same lifetime the two cases above bound the near end
     * of. Grouped here because they share the ceiling's clock, not because
     * they share a mechanism with the flash cases.
     *
     * `console.error` is silenced rather than allowed through: the ceiling
     * logs on every case here, and an unstubbed spy would print that line
     * once per test. `vi.restoreAllMocks()` in `afterEach` puts it back.
     */
    function silenceErrors(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    /**
     * The relationship the ceiling's correctness rests on, made executable.
     *
     * A held outcome runs from the stay timer, not from `settle`, so a ceiling
     * inside the rail's own window could fire with an outcome already parked
     * behind it — and nothing in Task 2's one-way exit covers that path,
     * because it does not go through `settle`. Prose in three docblocks would
     * not survive someone shortening the ceiling; this does.
     */
    it('is armed beyond the rail\'s own window', () => {
      expect(VERIFY_CEILING_MS).toBeGreaterThan(
        RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS,
      );
    });

    /**
     * #446's acceptance criterion: a slow-but-working sign-in still completes.
     * The response lands well past the rail's window — the reader has been
     * watching the interstitial for seconds — but inside the ceiling, and the
     * ordinary success path runs untouched.
     */
    it('signs in a verification that answers slowly but inside the ceiling', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS - 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();

      deferred.resolve();
      await advance(1);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
    });

    /**
     * The ceiling's own case, and the half that makes it worth building: the
     * screen it reaches must be distinguishable from a spent link.
     *
     * The absence assertion cannot rot silently — 'Verification failed' is
     * asserted PRESENT by three other cases in this file, so a rename breaks
     * them loudly rather than quietly passing here.
     */
    it('gives up on a verification that never answers, without blaming the link', async () => {
      vi.useFakeTimers();
      silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS - 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();

      await advance(1);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText('Verification failed')).not.toBeInTheDocument();
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute(
        'href',
        '/login',
      );
    });

    /** A verification that answered must not be given up on afterwards. The
     *  ceiling is cancelled by `settle`, not merely ignored by it. */
    it('does not give up on a verification that already answered', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(signedIn));
      render(<VerifyPage />);

      await advance(10);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
    });

    /**
     * #446's fourth question, pinned: the session probe is covered by the same
     * ceiling, because what is bounded is the STATE, not the verify request.
     *
     * The verify POST fails immediately; the probe behind it never answers.
     * A ceiling armed inside the fetch's `.then`, or scoped to the first
     * request, leaves this reader stranded exactly as before.
     */
    it('gives up when the session probe is the request that never answers', async () => {
      vi.useFakeTimers();
      silenceErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false })
          .mockReturnValue(new Promise(() => {})),
      );
      render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS + 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
    });

    /**
     * Leaving before the ceiling fires takes the ceiling with it — the same
     * rule the held-outcome case above applies to the stay timer.
     *
     * Without the clear it fires on an unmounted page: a give-up logged for a
     * reader who is no longer there, and once Task 2 lands, an abort of a
     * request belonging to a page that no longer exists.
     */
    it('drops the ceiling when the page is left before it fires', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      const { unmount } = render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS + 1);
      unmount();

      // Named rather than `not.toHaveBeenCalled()`: this spy catches every
      // console.error in the process, so a bare assertion would also fail on
      // an unrelated React warning and report it as this defect.
      await advance(VERIFY_CEILING_MS);
      expect(errors).not.toHaveBeenCalledWith(
        '[verify] no answer within the ceiling; giving up',
      );
    });

    /** Nothing about this is diagnosable after the fact otherwise (#446). */
    it('logs the give-up with the prefix the rest of the file uses', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(errors).toHaveBeenCalledWith(
        '[verify] no answer within the ceiling; giving up',
      );
    });
```

Then extend the existing no-token case so it covers the new timer. Replace its
final block — the three lines after the comment beginning `// Past both
constants:` — with:

```tsx
      // Past all three constants: no timer of any kind may be armed for a
      // verification that was never sent, and the ceiling would otherwise
      // turn a reader's own bad link into a connection problem.
      await advance(RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS + VERIFY_CEILING_MS);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`

Expected: FAIL. The import of `VERIFY_CEILING_MS` resolves to `undefined`, so
the new cases fail at their first `advance(…)` or comparison; the file may
report a transform-level error rather than assertion failures. Either is a
valid RED — record the actual output.

- [ ] **Step 3: Add the constant**

In `page.tsx`, immediately after the `RAIL_STAYS_FOR_MS` declaration and
before `RAIL_HEADING`:

```tsx
/**
 * How long the whole verification may take before this page stops waiting.
 *
 * The far end of the lifetime `RAIL_APPEARS_AFTER_MS` and `RAIL_STAYS_FOR_MS`
 * bound the near end of. It is armed against the `verifying` STATE, not
 * against either request that can occupy it — so it covers the session probe
 * behind a failed verification as well as the verification itself, with one
 * threshold instead of two.
 *
 * Must exceed `RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS`, and a test asserts
 * it: a held outcome runs from the stay timer rather than from `settle`, so a
 * ceiling inside the rail's own window could fire with an outcome already
 * parked behind it, where nothing guards it.
 *
 * Deliberately provisional. This is not measured against a real network, and
 * cannot be — so it is sized to make being WRONG cheap rather than to be
 * right. A ceiling that fires on a verification which would still have
 * succeeded costs that reader one re-sent email, which is what
 * `TimedOutState` offers and why its copy refuses to say the link failed.
 * Revise it against latency seen on a deployed instance; if the copy ever
 * stops making an early fire survivable, revise the copy first.
 *
 * Reasoning and arithmetic:
 * docs/superpowers/specs/2026-09-05-verify-ceiling-design.md
 */
export const VERIFY_CEILING_MS = 20_000;
```

- [ ] **Step 4: Add the timeout status and its screen**

Change the `Status` type at the top of the file:

```tsx
type Status = 'verifying' | 'success' | 'error' | 'already-signed-in' | 'handoff' | 'timeout';
```

Add this component directly after `ErrorState`:

```tsx
/**
 * The one screen here that cannot say whether the link worked.
 *
 * The request was abandoned, not answered: the token may be spent or
 * untouched, and a session may or may not exist. `ErrorState`'s "this link
 * can't be used" would be a guess presented as a finding, and it is wrong
 * exactly when the reader's sign-in did land. So this names the uncertainty
 * instead, and offers the one recovery that is safe under both readings —
 * asking for a fresh link costs an email round trip and is correct whether or
 * not the old one was consumed. Retrying the same token is not: it is
 * single-use, and nothing on this side can tell whether it was already spent.
 */
function TimedOutState() {
  return (
    <div className="flex-1 flex flex-col justify-center py-4">
      <p className="type-label text-danger mb-[10px]">Connection problem</p>
      <h1 className="type-display mb-4">
        We couldn&apos;t reach
        <br />
        the server.
      </h1>
      <p className="type-body max-w-[360px] mb-6">
        Your link may have worked anyway &mdash; we just never got an answer.
        If it did, that link is spent now, so use a fresh one.
      </p>
      <Link
        href="/login"
        className="inline-flex items-center justify-center w-full text-center bg-teal text-cream hover:bg-teal-hover rounded-pill px-6 min-h-12 font-semibold text-base no-underline"
      >
        Send a new link
      </Link>
      <StatusLine variant="error">
        If this keeps happening, write to{' '}
        <a href="mailto:hello@fair.yoga" className="text-teal">
          hello@fair.yoga
        </a>{' '}
        &mdash; a real person will read it.
      </StatusLine>
    </div>
  );
}
```

- [ ] **Step 5: Arm the ceiling in the hook**

In `useVerifyingRail`, add the third parameter:

```tsx
function useVerifyingRail(
  enabled: boolean,
  onApplyThrew: () => void,
  onCeiling: () => void,
): {
  railVisible: boolean;
  settle: (apply: () => void) => void;
} {
```

Add a ref beside `stayTimer`:

```tsx
  const ceilingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
```

Extend the existing ref-refresh effect to carry the new callback for the same
reason the old one is there — `settle` must keep one identity for the life of
the mount:

```tsx
  const recover = useRef(onApplyThrew);
  const giveUp = useRef(onCeiling);
  useEffect(() => {
    recover.current = onApplyThrew;
    giveUp.current = onCeiling;
  });
```

In the arming effect, add the ceiling timer after the appearance timer and
clear it in the cleanup:

```tsx
  useEffect(() => {
    if (!enabled) return;
    appearTimer.current = setTimeout(() => {
      owed.current = true;
      setRailVisible(true);
      stayTimer.current = setTimeout(() => {
        owed.current = false;
        const held = waiting.current;
        waiting.current = null;
        if (held) run(held);
      }, RAIL_STAYS_FOR_MS);
    }, RAIL_APPEARS_AFTER_MS);

    // Armed here rather than from the fetch, because what it bounds is this
    // state and not one request: the exit through `.catch` sends a second one.
    ceilingTimer.current = setTimeout(() => {
      console.error('[verify] no answer within the ceiling; giving up');
      giveUp.current();
    }, VERIFY_CEILING_MS);

    return () => {
      if (appearTimer.current) clearTimeout(appearTimer.current);
      if (stayTimer.current) clearTimeout(stayTimer.current);
      if (ceilingTimer.current) clearTimeout(ceilingTimer.current);
      waiting.current = null;
      // Cleared with the timer that would otherwise have cleared it. Leaving
      // it set would strand a later `settle`: it would park a callback for a
      // stay timer that no longer exists, and the reader would hold on the
      // rail with nothing coming.
      owed.current = false;
    };
  }, [enabled, run]);
```

In `settle`, cancel the ceiling alongside the appearance timer — the
verification has answered, so the state's exit is claimed:

```tsx
  const settle = useCallback((apply: () => void) => {
    // Cancelled rather than merely ignored: an outcome is on its way to the
    // screen, and the rail must not appear from behind it.
    if (appearTimer.current) {
      clearTimeout(appearTimer.current);
      appearTimer.current = null;
    }
    // Same reason, other end. This verification answered, so the ceiling has
    // nothing left to bound — including across the hold below, which can
    // still be running when it would otherwise fire.
    if (ceilingTimer.current) {
      clearTimeout(ceilingTimer.current);
      ceilingTimer.current = null;
    }
    if (!owed.current) {
      run(apply);
      return;
    }
```

Leave the rest of `settle` unchanged.

- [ ] **Step 6: Wire the page to the hook and render the state**

In `VerifyContent`, pass the third argument:

```tsx
  const { railVisible, settle } = useVerifyingRail(
    Boolean(token),
    () => setStatus('error'),
    () => setStatus('timeout'),
  );
```

Add the render branch immediately after the `error` branch:

```tsx
  if (status === 'error') return <ErrorState />;
  if (status === 'timeout') return <TimedOutState />;
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`
Expected: PASS, every case in the file.

- [ ] **Step 8: Prove each new guard bites**

Apply each mutation, run the command from Step 7, record the exact failing
test name and assertion text, then restore and re-run to confirm green. A
mutation that leaves the suite green is a finding — report it rather than
moving on.

| # | Mutation | Must break |
|---|---|---|
| 1 | `VERIFY_CEILING_MS = 500` | `is armed beyond the rail's own window` |
| 2 | Delete the `ceilingTimer` block in the arming effect | `gives up on a verification that never answers…`, `…probe is the request that never answers`, `logs the give-up…` |
| 3 | Route the ceiling to `setStatus('error')` instead of `'timeout'` | `gives up on a verification that never answers, without blaming the link` |
| 4 | Delete the `ceilingTimer` clear inside `settle` | `does not give up on a verification that already answered` |
| 5 | Arm the ceiling inside the fetch's `.then` instead of the effect | `gives up when the session probe is the request that never answers` |
| 6 | Move the `ceilingTimer` block above the effect's `if (!enabled) return;` | `shows the failure on the first render given …` (both rows) |
| 7 | Drop `if (ceilingTimer.current) clearTimeout(…)` from the effect cleanup | `drops the ceiling when the page is left before it fires` |
| 8 | Change the log string | `logs the give-up with the prefix the rest of the file uses` |

- [ ] **Step 9: Commit**

```bash
git add "src/app/(public)/verify/page.tsx" "src/app/(public)/verify/page.test.tsx"
git commit -m "feat(auth): a verification that never answers stops stranding the reader (#446)"
```

---

### Task 2: The exit is one-way

Task 1 leaves one hole: a response that arrives *after* the ceiling still
reaches `settle`. On the `.catch` side it would replace an honest "we couldn't
reach the server" with a false "this link can't be used"; on the success side
its callback schedules `router.push`, which is not cleared on unmount and would
pull a reader off whatever page they moved on to. Unreachable before Task 1,
because a stranded reader had no control to move on with.

**Files:**
- Modify: `src/app/(public)/verify/page.tsx`
- Test: `src/app/(public)/verify/page.test.tsx`

**Interfaces:**
- Consumes from Task 1: `VERIFY_CEILING_MS`, `Status`'s `'timeout'` member, `ceilingTimer`, the third `useVerifyingRail` parameter, `TimedOutState`.
- Produces: nothing later tasks depend on — this is the final task.

- [ ] **Step 1: Write the failing tests**

Add to `page.test.tsx`, after the cases added in Task 1:

```tsx
    /**
     * The one-way exit, on the branch where getting it wrong is worst.
     *
     * A success landing after the ceiling would apply the success state AND
     * schedule its redirect — and that redirect's timer is not cleared on
     * unmount, so it fires wherever the reader has got to by then. Before this
     * page had a button on the give-up screen there was nowhere for them to
     * have got to, which is why the hazard arrives with the fix.
     */
    it('refuses an outcome that arrives after it has given up', async () => {
      vi.useFakeTimers();
      silenceErrors();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();

      deferred.resolve();
      await advance(RAIL_STAYS_FOR_MS + 900);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText("You're signed in.")).not.toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
    });

    /**
     * The same rule on the failing branch: a late rejection must not turn the
     * give-up screen into the spent-link screen, which would tell the reader
     * something this page cannot know.
     */
    it('refuses a late failure too, rather than blaming the link', async () => {
      vi.useFakeTimers();
      silenceErrors();
      let rejectVerify!: (value: unknown) => void;
      const pending = new Promise((r) => {
        rejectVerify = r;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: false }),
      );
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();

      rejectVerify({ ok: false });
      await advance(RAIL_STAYS_FOR_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText('Verification failed')).not.toBeInTheDocument();
    });

    /**
     * Hygiene rather than correctness — the refusals above are what keep a
     * late answer off the screen. But a page saying it could not reach the
     * server while still holding an open request to that server is asserting
     * something it has not acted on, and the aborted signal is a positive
     * observable where the cases above can only assert absence.
     */
    it('abandons the request it has stopped waiting for', async () => {
      vi.useFakeTimers();
      silenceErrors();
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      render(<VerifyPage />);

      const { signal } = fetchMock.mock.calls[0][1] as { signal: AbortSignal };
      expect(signal.aborted).toBe(false);

      await advance(VERIFY_CEILING_MS);
      expect(signal.aborted).toBe(true);
    });

    /** An abandoned verification must not go on to probe the session: the
     *  answer is one nothing may act on, and its failure would log a fault
     *  that did not happen. */
    it('does not probe the session for a verification it abandoned', async () => {
      vi.useFakeTimers();
      silenceErrors();
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      await advance(RAIL_STAYS_FOR_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`

Expected: FAIL — four cases. `refuses an outcome that arrives after it has
given up` fails on `You're signed in.` being present; `refuses a late failure
too` fails on `Verification failed` being present; `abandons the request…`
fails with "Cannot read properties of undefined (reading 'aborted')" — the
POST's options object exists, so destructuring `{ signal }` from it succeeds
and yields `undefined`, and the first `expect` is what throws;
`does not probe the session…` is expected to PASS already, because nothing
rejects the verify promise in it — keep it, it becomes load-bearing once the
abort exists and it is what mutation 4 in Step 6 breaks.

- [ ] **Step 3: Make the exit one-way in the hook**

Add a ref beside `owed`:

```tsx
  /** True once the ceiling has taken this state's one exit. */
  const givenUp = useRef(false);
```

Set it in the ceiling callback, before the callback that changes the screen:

```tsx
    ceilingTimer.current = setTimeout(() => {
      givenUp.current = true;
      console.error('[verify] no answer within the ceiling; giving up');
      giveUp.current();
    }, VERIFY_CEILING_MS);
```

Clear it in the effect's cleanup, beside `owed`, so a re-armed effect does not
inherit a decision from the run before it:

```tsx
      waiting.current = null;
      // Cleared with the timer that would otherwise have cleared it. Leaving
      // it set would strand a later `settle`: it would park a callback for a
      // stay timer that no longer exists, and the reader would hold on the
      // rail with nothing coming.
      owed.current = false;
      givenUp.current = false;
```

Guard `settle` — this must be the first statement in the callback, before the
timer clears:

```tsx
  const settle = useCallback((apply: () => void) => {
    // This state's one exit is already taken, and taking it back is worse than
    // doing nothing. On the failing branch it would replace an honest "we
    // couldn't reach the server" with a claim about the link that nothing here
    // can support; on the succeeding one it would run a callback that
    // schedules `router.push`, and that timer survives unmount — so it would
    // pull a reader off whatever page they had already moved on to.
    if (givenUp.current) return;
```

- [ ] **Step 4: Abort the request the page has stopped waiting for**

In `VerifyContent`, add a ref beside the other state, above the hook call:

```tsx
  const inFlight = useRef<AbortController | null>(null);
```

Change the hook call's third argument:

```tsx
  const { railVisible, settle } = useVerifyingRail(
    Boolean(token),
    () => setStatus('error'),
    () => {
      inFlight.current?.abort();
      setStatus('timeout');
    },
  );
```

In the verification effect, create the controller and pass its signal to both
fetches, and short-circuit the `.catch` when it is the abort that brought us
there:

```tsx
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    inFlight.current = controller;
    fetch('/api/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    })
```

and in the `.catch`, as its first statement:

```tsx
      .catch(async () => {
        // The ceiling abandoned this request; the screen already says so.
        // Probing now would spend a round trip on an answer nothing may act
        // on, and its failure would log a fault that did not happen.
        if (controller.signal.aborted) return;
```

and on the probe itself:

```tsx
          const res = await fetch('/api/auth/session', {
            signal: controller.signal,
          });
```

Leave the rest of the effect, including its dependency array, unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`
Expected: PASS, every case in the file.

- [ ] **Step 6: Prove each new guard bites**

Same procedure as Task 1 Step 8 — apply, run, record the exact failure,
restore, re-run green.

| # | Mutation | Must break |
|---|---|---|
| 1 | Delete `if (givenUp.current) return;` from `settle` | `refuses an outcome that arrives after it has given up`, `refuses a late failure too…` |
| 2 | Delete `givenUp.current = true` from the ceiling callback | the same two cases |
| 3 | Delete `inFlight.current?.abort()` | `abandons the request it has stopped waiting for` |
| 4 | Delete `if (controller.signal.aborted) return;` from the `.catch` | `does not probe the session for a verification it abandoned` |
| 5 | Delete `givenUp.current = false` from the effect cleanup | nothing in this file — **expected**. It guards a re-arm this suite does not exercise; record it as a known-uncovered line rather than adding a test that fakes a token change, and report it in the task summary. |

- [ ] **Step 7: Run the checks that do not need a live app**

This is a worktree — integration and e2e are hard-wired to the dev server on
`:3000` and the shared dev database, and have neither here. Run the tiers that
work, and let CI be the signal for the rest:

```bash
npm run typecheck
npm run lint
npx vitest run --project unit --project components
```

Expected: all green. Record the case counts from the vitest output for the PR
body.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(public)/verify/page.tsx" "src/app/(public)/verify/page.test.tsx"
git commit -m "fix(auth): a late answer cannot take back the give-up screen (#446)"
```

---

## After both tasks

Not steps for a task implementer — for whoever is running the plan.

- [ ] Whole-branch review on the most capable model, one fix wave, one scoped re-review (2 tasks, so this applies).
- [ ] Correct #446's acceptance criterion 2 on the issue itself. It requires a threshold "measured against a deployed instance"; there is none, and the spec replaces the criterion rather than satisfying it. Post via `gh issue comment 446 --body-file <path>` — never `--body "…"`, backticks in a double-quoted zsh string fail silently.
- [ ] Push and open the PR. Cite the CI run for the integration and e2e tiers, not a local `verify`; name the local tiers by their case counts.
