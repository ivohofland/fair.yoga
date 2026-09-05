# /verify's failed-verification classification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A rejection reaching `/verify`'s outer verification `.catch` that is *not* the expected 400 logs a `[verify]`-prefixed line; the 400 stays silent (#452).

**Architecture:** The `.catch` currently cannot tell a spent link from a backend fault, because `if (!res.ok) throw new Error(...)` destroys `res.status` one line earlier. A typed sentinel — `VerifyResponseError`, carrying the status — makes the rejection's *type* the classification. Nothing else in the effect moves.

**Tech Stack:** Next.js App Router client component (this repo is on 16.2.10), TypeScript strict, Vitest + Testing Library (`components` project).

**Spec:** None — brainstormed as a bounded change (single file + its test, one obvious approach once the mechanism was chosen). The design decision #452 deferred was settled at the brainstorming gate: *any* 400 is silent, and the status travels on a sentinel error.

**What this document is.** A record of the plan as issued, not a maintained
specification. Its fenced code blocks reproduce the instructions given to each
task at the time and are deliberately NOT re-synced against later edits — the
shipped files are authoritative for what the code says, and `git log` for how
it got there. The prose is the design record and is kept true. That split is
why Task 1's Step 5 message still describes a four-failure state that later
grew to five, while a claim about how the code *behaves* was corrected
wherever it appeared.

## Global Constraints

- **The reader sees no change.** Every existing screen, timing and transition stays exactly as it is. This is a diagnosability fix (#452's third acceptance criterion).
- **Log prefix is `[verify]`**, matching every `console.error` already in this file — re-derive with `grep -n "console.error('\[verify\]" "src/app/(public)/verify/page.tsx"`.
- **An error argument is positional, not wrapped** — `console.error('[verify] …', err)`, matching this file's two existing error sites. (Its `'unhandled status'` line passes an object, but that argument is a payload, not an error.)
- **`'Verification failed'` is on-screen copy** (`page.tsx:211`), asserted by five `it` declarations, six executed cases. The sentinel's message must not reuse that string.
- **TypeScript strict, no `any`.** The `.catch` parameter types as `unknown`.
- **In this worktree, `--project integration` and e2e cannot run** — they need the dev server on `:3000` and the shared dev DB. Scope local verification to typecheck, lint, `unit`, `unit-sweeps` and `components`; CI is the signal for the other tiers.

## Background the implementer needs

**The failure space, and why the sentinel's type covers it completely.**
`if (!res.ok) throw` runs *before* `return res.json()`. So:

| Rejection reaching the `.catch` | Implies | Where the status is |
|---|---|---|
| `VerifyResponseError` | the server answered non-ok | on the error |
| `SyntaxError` from `res.json()` | the server answered **2xx** with an unreadable body | determined: 2xx |
| `TypeError` from `json.data.…` | the server answered **2xx** with a mis-shaped body | determined: 2xx |
| anything else (e.g. `TypeError: Failed to fetch`) | no response arrived at all | none exists |
| `AbortError` from our own ceiling | we abandoned it | returns at the existing guard, never classified |

So among rejections that reach the classification, the only silent case is `VerifyResponseError` with `status === 400`; an abort returns before it.

**400, where #452 says 4xx.** The issue's acceptance criterion is written against "the expected 4xx". This plan silences only **400**, deliberately: the route has no other reachable 4xx (no rate limiter, no auth requirement, no 404 path; a 409 from `withErrorHandler`'s fallback is the one other 4xx that can arrive, and it is a fault that should log), so the two are the same set today — and where they ever diverge, a new 4xx appearing on this route should log rather than be silently absorbed by a band that was widened before the case existed. Narrower is the honest reading of the same intent.

**Which 400s that silences.** `magic-link/verify/route.ts` can answer 400 four ways: `parseBody`'s `'Invalid JSON'` and its zod message (`api-utils.ts:59, 67`), `'Invalid or expired magic link'` (route:42), and `'Account not found'` (route:79). All four go silent. That is the accepted trade — distinguishing them client-side would mean parsing a human-readable server message, which is not a contract this codebase has. The route has **no rate limiter** (`send` and `claim` import `checkRateLimit`, this route does not), so no 429 reaches here. Above 4xx, `withErrorHandler` can answer 409, 500 or 503 (`api-errors.ts:50`) — all logged.

**The masking case this also fixes, which #452 does not name.** When the success path throws (a 2xx whose `json.data` is undefined), verification had already set a session cookie — so the session probe in the `.catch` answers `ok`, and the reader is shown **"Already signed in"**. A genuine backend fault, rendered as a benign screen, with nothing logged anywhere on the client. Task 1's `logs the fault behind a mis-shaped success the probe then masks` pins this.

## File Structure

- `src/app/(public)/verify/page.tsx` — the only source change. Adds one module-scope class near the `Status` type; changes one `throw`; adds one guarded `console.error` in the `.catch`; rewrites one comment whose claim this change falsifies, and extends the abort guard's comment to say why it must precede the classification.
- `src/app/(public)/verify/page.test.tsx` — six new cases in a new `describe` block, plus a correction to five existing mocks, and an assertion added to a pre-existing ceiling case.

No new files. No other file in the repo makes a claim this change falsifies — verified by
`grep -rn "expired or already-used\|already-used link\|Verification failed\|no kind of fault" src docs .github`.
Outside those two files it also matches this plan document throughout, and one other file: `docs/superpowers/plans/2026-09-05-verify-ceiling.md`, #446's **archived** plan. That is a record of what was decided then, not a live claim; editing it would falsify the record. Leave it.

---

### Task 1: Pin the classification, and make the existing mocks say which case they are

**Files:**
- Modify: `src/app/(public)/verify/page.test.tsx` — five existing mocks; one new `describe` block appended before the file's final `})` (currently line 900).

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the six assertions Task 2 must satisfy. Task 2 adds `class VerifyResponseError extends Error { constructor(readonly status: number) }` to `page.tsx`; it is **not exported** and these tests never import it — they assert only on `console.error` arguments and on the DOM.

**Why this task comes first:** five of the six cases must be seen to fail before the implementation exists. The sixth, `stays silent for the spent link that is the ordinary case`, *passes vacuously* beforehand, because nothing logs at all yet — Task 2 owns its mutation proof. Step 3 records that explicitly rather than letting a green tick be mistaken for evidence.

- [ ] **Step 1: Correct the five verify-POST mocks that carry no status**

Seven lines in this file mock a non-ok response; eight occurrences in total. Five are the **verify POST** and become the classified rejection — they must say `status: 400` or they will exercise the fault branch instead of the spent-link branch they are written to mean. Three are the **session probe**, which is never classified — leave those exactly as they are.

| Line | Which fetch | Action |
|---|---|---|
| 90 | verify POST | add `status: 400` |
| 494 (`probe: { ok: false }`) | session probe | **leave** |
| 514 (`rejectVerify({ ok: false })`) | verify POST | add `status: 400` |
| 532 first `mockResolvedValueOnce` | verify POST | add `status: 400` |
| 532 second `mockResolvedValueOnce` | session probe | **leave** |
| 724 | verify POST | add `status: 400` |
| 844 (`.mockResolvedValue({ ok: false })`) | session probe | **leave** |
| 851 (`rejectVerify({ ok: false })`) | verify POST | add `status: 400` |

Line 851 is inert — that case aborts before the classification runs — but it is still the verify POST, and a mock that says `400` states which case it means.

Each edit is `{ ok: false }` → `{ ok: false, status: 400 }`. At line 532 only the **first** of the two, which reads afterwards:

```tsx
        vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce({ ok: false }),
```

- [ ] **Step 2: Append the new describe block**

Insert immediately after the `describe('the verifying rail', …)` block closes (currently line 899 `});`) and before the file's final `});`:

```tsx
  /**
   * #452. The outer `.catch` used to treat every rejection as a spent link:
   * a 5xx, an unreadable body, a mis-shaped one and a network failure all
   * arrived indistinguishable from an expired link, and none of them put a
   * line of their own on the console. Where they landed on screen varied —
   * the error screen usually, but "Already signed in" when the session probe
   * behind them answered ok, which is the last case below.
   *
   * The 400 is the one silent case, and it is the commonest event on this
   * page — a link clicked twice. Everything else is a fault, and the last
   * case here is the one that most needed a line: the reader is shown a
   * perfectly ordinary screen while something genuine is broken.
   */
  describe('classifying a failed verification', () => {
    const FAULT_LINE = '[verify] the verification request failed';

    /** Silenced rather than allowed through: these cases log by design, and
     *  an unstubbed spy prints each line once per test. Restored by
     *  `vi.restoreAllMocks()` in `afterEach`. */
    function watchErrors(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    /** The probe behind a failed verification, answering "no session". Sends
     *  every case below to the error screen except where stated. */
    const noSession = { ok: false };

    it('logs a server fault rather than blaming the link', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      // Two matchers over the same call: `objectContaining` alone is duck-typed,
      // and would accept a bare `{ status: 500 }` in place of the real error.
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(Error));
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 500 }));
    });

    /**
     * The boundary this design narrows on purpose. #452's wording says to
     * silence "the expected 4xx"; this file silences 400 alone, because the
     * route has no other reachable 4xx today and a new one appearing here
     * should read as a fault rather than something a band absorbed before the
     * case existed. Nothing else in this block can tell those two rules
     * apart — an implementation silencing all of 4xx passes every other case.
     */
    it('logs a 4xx that is not the expected 400', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 404 }));
    });

    /**
     * The deliberate silence, and the reason this fix is a classification
     * rather than an unconditional log: a spent link is the commonest
     * ordinary event on this page, and logging it would bury the cases above
     * and below in noise.
     *
     * This assertion cannot fail against an implementation that logs nothing
     * at all, which is what the file did before #452 — its evidence is the
     * mutation recorded in Task 2 Step 5, not this run.
     */
    it('stays silent for the spent link that is the ordinary case', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).not.toHaveBeenCalled();
    });

    /** A 2xx the body of which will not parse. Reaches the `.catch` from
     *  `res.json()`, which the throw above it means can only ever run on an
     *  ok response — so no status needs carrying for this one. */
    it('logs a success whose body cannot be read', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          })
          .mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(SyntaxError));
    });

    /** No response at all. The rejection carries no status because none
     *  exists, and `instanceof` is what tells it from the 400. */
    it('logs a verification that never reached the server', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(TypeError));
    });

    /**
     * The case with no symptom, which is why it is the one worth having.
     *
     * A 2xx whose body is mis-shaped throws on `json.data`, and by then the
     * server has already set a session cookie — so the probe in the `.catch`
     * answers ok and the reader is shown "Already signed in". Nothing is
     * wrong on screen and something is genuinely broken. Both halves are
     * asserted: the screen is unchanged (#452 is not a UX change) and the
     * fault now has a line.
     */
    it('logs the fault behind a mis-shaped success the probe then masks', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { teacherId: 't-1', studentId: null } }),
          }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Already signed in')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(TypeError));
    });
  });
```

- [ ] **Step 3: Run the new block and record which cases fail**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx" -t "classifying a failed verification"`

Expected, against unmodified `page.tsx`:
- `logs a server fault rather than blaming the link` — **FAIL**, `console.error` never called with `FAULT_LINE`.
- `logs a 4xx that is not the expected 400` — **FAIL**, same reason.
- `logs a success whose body cannot be read` — **FAIL**, same reason.
- `logs a verification that never reached the server` — **FAIL**, same reason.
- `logs the fault behind a mis-shaped success the probe then masks` — **FAIL** on the `toHaveBeenCalledWith`; its `findByText('Already signed in')` **passes**, which is the proof that the masking is real today.
- `stays silent for the spent link that is the ordinary case` — **PASS**, vacuously. Expected. Record it as vacuous in the commit message; Task 2 Step 5 supplies its real evidence.

Paste the actual failure text into the task ledger. Every case that logs must fail, and only `stays silent` may pass — if any other case passes, stop and report rather than proceeding.

- [ ] **Step 4: Run the whole file to confirm the mock corrections broke nothing**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`

Expected: the failures from Step 3 and **nothing else**. Every pre-existing case still passes — adding `status: 400` to a mock is inert until Task 2 reads it.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/verify/page.test.tsx"
git commit -m "$(cat <<'EOF'
test(verify): pin which failed verifications are faults and which are spent links (#452)

Four cases fail against the current file: a 500, an unreadable 2xx body, a
network failure, and a mis-shaped 2xx that the session probe masks behind
"Already signed in". The fifth — a 400 staying silent — passes vacuously
here, because nothing logs at all yet; its evidence is the mutation in the
implementing commit, not this run.

Five existing mocks gain `status: 400`. They are the verify POST, whose
status the next commit classifies; without it they would exercise the fault
branch rather than the spent-link case they are written to mean. The three
session-probe mocks are untouched — that response is never classified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Carry the status on the rejection, and log everything that is not a 400

**Files:**
- Modify: `src/app/(public)/verify/page.tsx` — add the class after the type aliases (currently line 11); change the throw (currently line 608); add the guarded log in the `.catch` (currently after line 649); rewrite the comment at 675-679.

**Interfaces:**
- Consumes: Task 1's six assertions.
- Produces: `class VerifyResponseError extends Error { constructor(readonly status: number) }` — module-scope in `page.tsx`, **not exported**, no other module refers to it.

**Line numbers below are as the file stands now.** Step 1 inserts ~18 lines near the top, so everything Steps 2-4 name shifts down by that much once Step 1 lands. Locate each edit by the quoted code, not by the number.

**Already verified, so don't re-derive it:** `expect.objectContaining({ status: 500 })` matches a `readonly` constructor parameter property on an `Error` subclass, and `instanceof` holds under this repo's ES2017 target. Both were run against a throwaway spec before this plan was written.

- [ ] **Step 1: Add the sentinel**

Insert after the type aliases near the top of `page.tsx` (after `type RailStep = …`, currently line 11):

```tsx
/**
 * A verify POST that answered, and what it answered with.
 *
 * The status has to survive the rejection because the outer `.catch` is the
 * only place that can act on it, and the `!res.ok` throw is where it would
 * otherwise be discarded. Carried on the error rather than in a variable
 * beside the chain, so there is no write-then-read ordering for a later edit
 * to get wrong — a rejection that IS one of these came from a response, and
 * one that is not never got an answer worth a status.
 *
 * `message` deliberately avoids the words "Verification failed": that string
 * is on-screen copy in `ErrorState` below, and a diagnostic line sharing a
 * grep with UI copy invites one to be changed for the other's reasons.
 */
class VerifyResponseError extends Error {
  constructor(readonly status: number) {
    super(`verify POST answered ${status}`);
  }
}
```

The `readonly` parameter property matches `UpdateClassRefusal` (`src/services/class-lifecycle.ts:1140`), the house shape for a payload-carrying `Error`.

- [ ] **Step 2: Throw the sentinel instead of a bare Error**

At the first `.then` (currently line 608), replace:

```tsx
        if (!res.ok) throw new Error('Verification failed');
```

with:

```tsx
        if (!res.ok) throw new VerifyResponseError(res.status);
```

- [ ] **Step 3: Classify in the `.catch`**

Bind the rejection and add the guarded log. The parameter is currently absent; the abort guard and everything after it are unchanged. Insert the new block between the abort guard (currently line 649) and the "A stale link is often re-clicked…" comment:

```tsx
      .catch(async (err: unknown) => {
        // The ceiling abandoned this request; the screen already says so.
        // Probing now would attempt a fetch that's already doomed, for an
        // answer nothing may act on — skip it outright rather than let it
        // fail through the probe's own guard.
        if (controller.signal.aborted) return;

        // A 400 is the answer this page is built to expect — the link is
        // expired or already used, the commonest ordinary event here and no
        // kind of fault. It is the one silent case; every other rejection is
        // a fault and gets a line. Those carrying no status at all either
        // never reached a response, or came from a 2xx: the throw above runs
        // before `res.json()`, so nothing that got as far as parsing a body
        // had a failing status to carry.
        if (!(err instanceof VerifyResponseError && err.status === 400)) {
          console.error('[verify] the verification request failed', err);
        }
```

- [ ] **Step 4: Replace the comment this change falsifies**

The probe's own `catch` (currently 675-679) ends by asserting the outer rejection is never a fault. That is now true only of the 400. Replace the claim rather than annotating it — the before-and-after belongs in the PR body:

```tsx
          // Reaching here means the probe itself misbehaved — the request
          // failed, or a 200 carried something that is not the shape this
          // reads. Its own line, separate from the classification above: that
          // one is about the verification, this one about the probe sent to
          // recover from it, and a reader who hits both wants to see both.
          console.error('[verify] the session probe failed after a failed verification', err);
```

- [ ] **Step 5: Prove the guard bites — mutate, record, restore**

The `stays silent` case passed vacuously in Task 1. This is its evidence.

1. Change `err.status === 400` to `err.status === 999` in `page.tsx`.
2. Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx" -t "stays silent"`
3. Expected: **FAIL** — `expect(errors).not.toHaveBeenCalled()` reports a call with `[verify] the verification request failed`. Copy the exact assertion text into the ledger.
4. Restore `=== 400`.
5. Re-run the same command. Expected: **PASS**.

`999` is chosen because no HTTP status the route can produce is in that range — a mutation to another real status (`403`, say) would be a plausible value and a weaker signal.

Then mutate the other direction, because a guard can be blind to the realistic regression while surviving the convenient one:

6. Change `!(err instanceof VerifyResponseError && err.status === 400)` to `!(err instanceof Error)` — the shape a future edit would most plausibly reach for, and one that silences every case.
7. Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx" -t "classifying a failed verification"`
8. Expected: **5 FAIL** (every logging case), 1 pass (`stays silent`). Record the count.
9. Restore, re-run, expect all 6 green.

Then the mutation that the boundary case exists for — the wrong implementation a reader of #452's own wording would most plausibly write, since the issue says "the expected 4xx" and this file silences 400 alone:

10. Change `err.status === 400` to `err.status >= 400 && err.status < 500`.
11. Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx" -t "classifying a failed verification"`
12. Expected: **exactly 1 FAIL** — `logs a 4xx that is not the expected 400`, and nothing else. That is the whole point of that case: under this mutation every other case in the block still passes. Record the exact assertion text, restore, and re-run for 6 green.

- [ ] **Step 6: Run the full file, then the runnable tiers**

Run: `npx vitest run --project components "src/app/(public)/verify/page.test.tsx"`
Expected: every case green, including the pre-existing cases asserting on the `'Verification failed'` screen text — the sentinel's message never reaches the DOM.

Then: `npx tsc --noEmit && npm run lint`
Expected: clean. If lint objects to the parameter property, convert to an explicit field assignment (`readonly status: number;` + `this.status = status;`) rather than dropping the type.

Then: `npx vitest run --project unit --project unit-sweeps --project components`
Expected: green. **Do not** pass `--project integration` from this worktree — it needs the dev server on `:3000` and hangs on `ECONNREFUSED`. CI is the signal for that tier and for e2e.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/verify/page.tsx"
git commit -m "$(cat <<'EOF'
fix(verify): a failed verification that is not a spent link now logs (#452)

`if (!res.ok) throw new Error(...)` destroyed `res.status` one line before
the only handler that could act on it, so a 5xx, an unreadable body, a
mis-shaped one and a network failure all arrived indistinguishable from the
expected 400, none of them putting a line of their own on the console — and
where the session probe behind them also answered non-ok, with no
client-side line at all.

`VerifyResponseError` carries the status on the rejection, so the type of
what reaches the `.catch` is the classification: a 400 is silent, everything
else logs. A rejection carrying no status either never reached a response, or
came from a 2xx — the throw runs before `res.json()` — so nothing is lost by
not carrying one.

Also covers a case #452 does not name: a 2xx whose body is mis-shaped throws
after the server has set a session cookie, so the probe answers ok and the
reader sees "Already signed in" — a genuine fault behind an ordinary screen.

The comment at the probe's catch said the rejection that brought us there was
"an expired or already-used link ... no kind of fault". True of the 400 only,
now that the rest are classified; replaced with what is true.

No change to what the reader sees.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## After both tasks

Two tasks, so §5's whole-branch review applies: one review on the most capable model over the full branch diff, one fix wave, one scoped re-review. The cross-task blindness it exists to catch is real here — Task 1's reviewer sees assertions with no implementation, Task 2's sees an implementation whose tests were written before it, and neither is placed to judge whether the six cases actually pin the branches they name.

Then push, open the PR, and run `/pr-review-toolkit:review-pr`. Skip the type-design reviewer's usual scope question by giving it the real one: `VerifyResponseError` **is** the subject of this PR, so it belongs in the review.
