# /verify's session probe classifies its own non-ok statuses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session probe that answers a status other than 401 puts a
`[verify]`-prefixed line on the console carrying that status; a 401 stays
silent.

**Architecture:** One guard in `VerifyContent`'s probe `try`, immediately below
the `if (res.ok) { … return; }` block. A non-ok response does not throw, so the
`catch (probeErr)` below it never sees one — today a 503 and a 401 both fall out
of the `try` to `settle(() => setStatus('error'))` indistinguishably. The guard
draws the same silent/loud partition the verification's own classification draws
eight lines above, one status apart: 400 is the verification's ordinary answer,
401 is the probe's.

**Tech Stack:** Next.js App Router client component (`'use client'`), Vitest +
Testing Library (`components` project). `console.error`, not `@/lib/log` — that
is pino and server-only.

**Spec:** none. Bounded issue, one obvious approach; direction agreed at the
brainstorming gate. Background:

- The issue: `gh issue view 456`
- `docs/superpowers/specs/2026-09-05-verify-ceiling-design.md:32-36` — where this
  was first measured, as #446's *second* cause, and explicitly deferred
- `docs/superpowers/plans/2026-09-05-verify-catch-classification.md` — #452, the
  same shape one level up, whose partition this one mirrors

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **`console.error`, never `@/lib/log`.** `src/app/(public)/verify/page.tsx` is
  `'use client'`; `@/lib/log` is pino and server-only.
- **House logging shape:** `console.error('[prefix] message', { status: res.status })`
  — as at `src/components/students/student-directory.tsx:55` and
  `src/components/schedule/onboarding-skip-button.tsx:49`.
- **No change to what the reader sees.** Every screen this page can show is
  unchanged by this branch. Whether a probe 503 *should* produce a different
  screen from a spent link is out of scope and explicitly deferred by the issue.
- **Comment Discipline (CLAUDE.md).** No comment added here may assert a fact
  about another module. A *conditional* about another module ("a session route
  that stopped answering 401 would …") is safe, because nothing in another file
  can make it false; an assertion ("`requireSession` answers 401") is not, and
  must not be written.
- **This is a worktree.** `--project integration` and e2e cannot run here — both
  are hard-wired to a dev server on `:3000` and the shared dev DB, and this
  worktree has neither. Run typecheck, lint, unit and components locally; CI is
  the signal for the other two tiers.
- **Never `git add -A` or `git add .`.** Stage exact paths, and quote the ones
  containing parentheses: `'src/app/(public)/verify/page.tsx'`.

---

## What was measured before this plan was written

Recorded here because the plan argues from it, and because two of these
findings changed the design.

| Claim | Verdict |
|---|---|
| The probe's non-ok path falls through unlogged | **Holds.** `page.tsx:697-724` — `if (res.ok) { … return; }`, then out of the `try` with no throw, straight to `settle(() => setStatus('error'))`. |
| 401 is the ordinary "no session" answer | **Holds.** `requireSession` (`src/lib/api-utils.ts:25,27`) is the only thing on `GET /api/auth/session` that produces one, for no-token and for expired-session. |
| The "everything else" bucket is reachable, not hypothetical | **Holds.** `classifyApiError` (`src/lib/api-errors.ts:50`) yields `409 \| 500 \| 503`, reaching the client through `withErrorHandler`. The issue's 503 narrative is a real path. |
| House shape at the two cited lines | **Holds**, both exact. |
| `docs/…/2026-09-05-verify-ceiling-design.md:32-36` defers this | **Holds.** |
| No client error transport anywhere in `src/` | **Holds.** No Sentry, no `window.onerror`, no `onunhandledrejection`. These lines are for a developer with devtools open. |

**Two things the issue did not anticipate, both of which change the work:**

1. **The shared probe mock is statusless, and there are four of them.**
   `page.test.tsx` mocks a sessionless probe as `{ ok: false }` — no `status` —
   at `:494`, `:532`, `:844` and `:937`. Under the new guard `undefined !== 401`
   is true, so every one of them would log. Only `:937` (`noSession`) breaks
   tests, and it breaks two of them: `:959`'s `toHaveBeenCalledTimes(1)` becomes
   2, and `:1008`'s `not.toHaveBeenCalled()` becomes 1 call. The other three
   merely emit unasserted noise — this file installs no global console guard.
   All four are corrected: a mock claiming a shape the route never returns is
   the defect, and leaving three behind means the next reader cannot tell which
   statusless mock was deliberate.

2. **Correcting `noSession` makes two existing tests pin the 401 silence as a
   side effect — which is not a substitute for pinning it directly.** Once
   `noSession` is `{ ok: false, status: 401 }`:
   - `:939 logs a server fault rather than blaming the link` — a 500
     verification and a 401 probe, asserting `toHaveBeenCalledTimes(1)`. A guard
     that logged the 401 makes it 2.
   - `:999 stays silent for the spent link that is the ordinary case` — a 400
     verification and a 401 probe, asserting `not.toHaveBeenCalled()`. A guard
     that logged the 401 makes it 1.

   Both go red under the M2 mutation in Task 2, and that is worth having. But
   neither *names* the probe's rule, and both hold it by a call count that
   someone adding an unrelated console line to this page would loosen for
   entirely good reasons — taking the 401 pin with it, silently. Nor are the two
   rules the same rule: `:999`'s own docblock says its subject is that "a spent
   link produces no console output at all", and it coincides with the probe's
   401 only because that fixture happens to route through a sessionless probe.
   Move the verification off 400 someday and the 401 pin rides along wherever
   `:999`'s fixture goes.

   So the silent branch gets its own test (Task 1, Step 4), and it does **not**
   reuse `:999`'s fixture:
   - the 401 is written **inline**, not through `noSession`, making it the one
     test in the file that names the rule in its own body and the one that
     survives an edit to the shared helper;
   - the verification beside it is **500, not 400** — deliberately loud — so the
     case asserts the fault line is *present* before asserting the probe line is
     *absent*. That first assertion is what stops this from passing by observing
     nothing at all, which is the vacuity `:999` has to apologise for in its own
     docblock;
   - the absence is **argument-matched**, not a bare `not.toHaveBeenCalled()`.
     `:993-997` already sets out the house rule for choosing between the two
     forms: argument-matched is for asserting one specific line is absent among
     others that legitimately fire, which is exactly this case.

   The `noSession` coupling is safe in both directions: deleting the
   `status: 401` from it later turns it back into `undefined !== 401`, which
   fails `:939` and `:999` loudly rather than quietly weakening them. A one-line
   note on `noSession` itself explains that coupling — the right home for it,
   since the mock is the shared thing. It is deliberately **not** duplicated
   into the two test docblocks: with a dedicated test owning the rule, those
   paragraphs would be prose restating what a tether already holds.

**And one gap found while checking placement, folded in:** whether the guard
sits above or below the `if (res.ok)` block is load-bearing and currently
unpinned. Placed above, an *ok* probe would log too. Nothing in the file would
catch that — `:1062`, the one existing test with an ok probe and a watched
console, asserts only `toHaveBeenCalledWith` and never a call count. This is the
same class of defect as the abort guard's unpinned position, fixed one commit
before this branch (`4d9a4041`, #452). Task 1 pins it with a call count.

---

## File Structure

**Modify: `src/app/(public)/verify/page.tsx`** — one guard inserted in
`VerifyContent`'s probe `try`, between the close of `if (res.ok) { … }` (line
711) and `} catch (probeErr) {` (line 712). Nothing else in this file changes.

**Modify: `src/app/(public)/verify/page.test.tsx`** — four mock corrections;
three new cases in the `classifying a failed verification` block (a two-case
`it.each` for the loud branch and one for the silent branch); one call-count
assertion added to an existing test to pin the guard's position. No existing
docblock is rewritten: every rule this branch adds is held by a test that names
it.

No new files. No new exports. No change to any route.

---

### Task 1: The tests, and the honest mocks

Tests-first, committed on their own, following this branch's immediate
predecessor (`7203b0ec` then `7791db4a`, #452): the test commit lands red and
the fix commit turns it green.

**Files:**
- Test: `src/app/(public)/verify/page.test.tsx` — modify `:494`, `:532`, `:844`,
  `:937`; add an assertion at `:1077`; add a new `it.each` before the
  `logs the verification and the probe separately when both fail` test

**Interfaces:**
- Consumes: nothing from an earlier task — this is the first.
- Produces: `PROBE_STATUS_LINE`, a `const` in the `classifying a failed
  verification` describe block holding the exact string
  `'[verify] the session probe answered unexpectedly'`. Task 2's implementation
  must emit precisely this string. It sits beside the existing
  `FAULT_LINE` const at `:926`.

- [ ] **Step 1: Give all four sessionless probe mocks the status they answer with**

Four edits, each adding `status: 401` to a mock that today claims a shape
`/api/auth/session` never returns.

At `:494`, inside the `it.each` for the rail-hold cases:

```tsx
      {
        name: 'the failure state',
        probe: { ok: false, status: 401 },
        shown: 'Verification failed',
      },
```

At `:532`, in `does not delay an error that lands inside the threshold`:

```tsx
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 400 })
          .mockResolvedValueOnce({ ok: false, status: 401 }),
```

At `:844`, in `a late rejection after the ceiling is aborted before it can blame the link`:

```tsx
        vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: false, status: 401 }),
```

At `:937`, the shared helper — the one that changes test outcomes. Replace both
the docblock and the value:

```tsx
    /** The probe behind a failed verification, answering "no session". Sends
     *  every case below to the error screen except where stated.
     *
     *  The 401 is not decoration: it is what `/api/auth/session` answers a
     *  request carrying no usable session, and the probe's classification
     *  treats it as the ordinary case. Drop it and `res.status` is
     *  `undefined` here, which the classification reads as a fault — so the
     *  two call-count assertions in this block fail rather than quietly
     *  passing on a mock that lies. */
    const noSession = { ok: false, status: 401 };
```

- [ ] **Step 2: Pin the guard's position with a call count**

In `logs the fault behind a mis-shaped success the probe then masks` (`:1062`),
add one assertion after the existing `toHaveBeenCalledWith` at `:1077`:

```tsx
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(TypeError));
      // Holds WHERE the probe's classification sits, which nothing else here
      // does. This is the only case in the file with an ok probe and a watched
      // console: move the classification above the `if (res.ok)` block and this
      // ok response is classified too, making it two lines instead of one.
      // Every other case in this block answers the probe not-ok and stays green
      // under that move.
      expect(errors).toHaveBeenCalledTimes(1);
```

- [ ] **Step 3: Name the string the implementation must emit**

Beside `FAULT_LINE` at `:926`, inside `describe('classifying a failed verification', …)`:

```tsx
    const FAULT_LINE = '[verify] the verification request failed';
    /** The probe's own status line. Distinct from the probe's THROW line
     *  (`'…the session probe failed after a failed verification'`, asserted at
     *  the bottom of this block) because the two are distinguishable causes: a
     *  probe that answered badly and one that never answered. */
    const PROBE_STATUS_LINE = '[verify] the session probe answered unexpectedly';
```

- [ ] **Step 4: Write the failing tests**

Insert immediately before the `logs the verification and the probe separately
when both fail` test (`:1093`), so the block reads verification cases → probe
cases → both together.

```tsx
    /**
     * #456. The probe's own half of the partition, and the case it exists for.
     *
     * A non-ok probe does not throw, so the `catch (probeErr)` below it never
     * runs: before this, a 503 and a 401 were indistinguishable, both falling
     * past `if (res.ok)` to the error screen with no line of any kind. The
     * reader is then told their link failed — possibly while signed in, and
     * on the strength of an answer nothing read.
     *
     * Both cases pair the probe with a 400 verification, the one silent case
     * above, so `toHaveBeenCalledTimes(1)` names the probe's line specifically
     * rather than counting two classifications together.
     *
     * 404 is here for the reason `logs a 4xx that is not the expected 400`
     * exists one level up: it is the only case that can tell this rule apart
     * from `status >= 500`, which the 503 alone would pass.
     */
    it.each([
      { status: 503, why: 'a backend fault' },
      { status: 404, why: 'a 4xx that is not the silent 401' },
    ])('logs a probe answering $status — $why', async ({ status }) => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 400 })
          .mockResolvedValueOnce({ ok: false, status }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(PROBE_STATUS_LINE, { status });
      expect(errors).toHaveBeenCalledTimes(1);
    });

    /**
     * The silent branch, and the only test in this file that names 401 in its
     * own body.
     *
     * Three deliberate choices separate it from `stays silent for the spent
     * link that is the ordinary case`, which pins a different rule that today
     * shares a fixture with this one:
     *
     * - The 401 is written inline rather than taken from `noSession`. The
     *   shared helper carries it too, which is why `logs a server fault` and
     *   the spent-link case above both go red if the probe's 401 is ever
     *   classified as a fault — but both hold it by a call count, and a call
     *   count is what someone loosens when an unrelated line is added to this
     *   page. This case survives that, and survives an edit to the helper.
     * - The verification beside it is 500, not 400 — loud on purpose. The
     *   fault line is asserted PRESENT before the probe line is asserted
     *   absent, so this cannot pass by observing nothing at all: the spy is
     *   live and the `.catch` demonstrably ran. That is the vacuity the
     *   spent-link case has to disclaim in its own docblock, and this case
     *   does not inherit it.
     * - The absence is argument-matched. Per the rule set out under `stays
     *   silent for the spent link`, the bare form claims no console output at
     *   all while the argument-matched form names one line among others that
     *   legitimately fire. A legitimate line fires here, so this is the
     *   correct form rather than merely the safer one.
     *
     * It remains vacuous with respect to the guard's EXISTENCE — delete the
     * classification entirely and this still passes. Only mutation M2 in Task 2
     * (`401` → `418`) turns it red, which is why that mutation is not optional.
     */
    it('stays silent for the 401 that is the probe being told "no session"', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 500 })
          .mockResolvedValueOnce({ ok: false, status: 401 }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 500 }));
      expect(errors).not.toHaveBeenCalledWith(PROBE_STATUS_LINE, expect.anything());
    });
```

- [ ] **Step 5: Run the tests and record the failure**

Run:

```bash
npx vitest run --project components 'src/app/(public)/verify/page.test.tsx'
```

Expected: the two `it.each` cases FAIL, everything else in the file PASSES —
including the new 401 case, which is vacuous until mutation M2 and is expected
to be green here. Record the exact failure text in the ledger; it should be
`AssertionError: expected "error" to be called with arguments: [ '[verify] the session probe answered unexpectedly', { status: 503 } ]` with
`Number of calls: 0`, **not** a call-count mismatch and not a rendering error.
A different failure — or a third failing case — means a mock correction in
Step 1 was wrong, not that the guard is missing.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(public)/verify/page.test.tsx'
git commit -m "$(cat <<'EOF'
test(verify): pin that a probe answering anything but 401 is a fault (#456)

The two it.each cases fail here and pass in the commit that follows; the
rest of this file passes in both states, the new 401 case included — it is
vacuous with respect to the guard existing, and only the 401-to-418
mutation recorded in the plan turns it red.

Four probe mocks claimed `{ ok: false }` with no status, a shape
/api/auth/session never returns. Corrected to 401 at :494, :532, :844 and
:937. Only the shared `noSession` at :937 changes an outcome, and it gives
`logs a server fault` and `stays silent for the spent link` a second rule
each: both now fail if the probe's 401 is classified as a fault. That is a
free pin, not the load-bearing one — both hold it by a call count, which is
what gets loosened when an unrelated line is added to this page. The
dedicated 401 case writes the status inline for that reason, and pairs it
with a LOUD verification so it asserts a line present before asserting one
absent.

`logs the fault behind a mis-shaped success` gains a call count. It is the
only case here with an ok probe and a watched console, which makes it the
only one that can hold WHERE the classification sits.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The classification

**Task order is load-bearing.** Task 1 must land first — its two failing cases
are the RED that this task turns GREEN, and its `noSession` correction is what
makes the M2 mutation below observable. Run out of order, M2 proves nothing.

**Files:**
- Modify: `src/app/(public)/verify/page.tsx:711-712` — insert between the close
  of `if (res.ok) { … }` and `} catch (probeErr) {`

**No test file changes.** Every assertion this task needs was written in Task 1.
Deliberately so: with the dedicated 401 case owning the silent rule, extending
`:939`'s and `:999`'s docblocks to describe the second rule their call counts
happen to hold would be prose restating what a tether already holds — the
failure CLAUDE.md's Comment Discipline is about. The coupling those two tests
now have to the probe's classification is documented once, on `noSession`
itself, which is the shared thing they both read.

**Interfaces:**
- Consumes: `PROBE_STATUS_LINE` from Task 1 — the implementation must emit
  exactly `'[verify] the session probe answered unexpectedly'`, and the payload
  must be exactly `{ status: res.status }` (the loud cases assert the object
  literally, not with `objectContaining`). Task 1's silent case asserts the same
  string is *absent* with `expect.anything()` as the payload matcher, so an
  implementation that emitted this line under a different message string would
  pass the silent case while failing the loud ones.
- Produces: nothing later tasks consume. This is the last task.

- [ ] **Step 1: Write the guard**

In `src/app/(public)/verify/page.tsx`, the probe's `try` currently ends:

```tsx
            return;
          }
        } catch (probeErr) {
```

Insert the guard between the `}` closing `if (res.ok)` and the `} catch`:

```tsx
            return;
          }

          // The probe asked whether this reader has a session, and 401 is that
          // question answered "no" — the ordinary case behind a spent link,
          // and the commonest path through here. Anything else means the probe
          // could not answer at all, and the fall-through below is about to
          // tell the reader their link failed on the strength of a response
          // nobody read.
          //
          // Below the ok check on purpose, not merely by convention: an ok
          // probe is not an unexpected answer, and classifying one would put a
          // fault line under the reader who is about to be told, correctly,
          // that they are already signed in. Held by the call count in `logs
          // the fault behind a mis-shaped success the probe then masks`.
          //
          // No abort guard, where the `catch` below has one: an abort makes
          // `fetch` reject, so it cannot arrive here as a non-ok response at
          // all. A ceiling firing after this response landed does not make the
          // status less real, and `settle` already refuses the screen.
          if (res.status !== 401) {
            console.error('[verify] the session probe answered unexpectedly', {
              status: res.status,
            });
          }
        } catch (probeErr) {
```

- [ ] **Step 2: Run the tests to verify they pass**

Run:

```bash
npx vitest run --project components 'src/app/(public)/verify/page.test.tsx'
```

Expected: PASS, whole file, including the two `it.each` cases that failed in
Task 1.

- [ ] **Step 3: Prove the guard bites — mutation M1, the loud branch**

Delete the whole `if (res.status !== 401) { … }` block written in Step 1,
leaving the comment. Re-run the command from Step 2.

Expected: `logs a probe answering 503 — a backend fault` and `logs a probe
answering 404 — a 4xx that is not the silent 401` both FAIL; everything else
passes. Record the exact assertion text.

Restore the block. Re-run and confirm the file is green again before continuing.

- [ ] **Step 4: Prove the guard bites — mutation M2, the silent branch**

This is the mutation the issue asks for by name, and the one that turns Task 1's
docblock claim into evidence. Change the guard's comparand to a status the
session route cannot produce:

```tsx
          if (res.status !== 418) {
```

`418` rather than a status in the route's own range: a comparand the code under
test can actually produce could make the mutation pass for the wrong reason.

Re-run the command from Step 2.

Expected: **exactly three failures, all of them silence cases** —

- `stays silent for the 401 that is the probe being told "no session"`: the
  dedicated case, and the one that matters — `expected "error" not to be called
  with arguments: [ '[verify] the session probe answered unexpectedly',
  Anything ]`
- `logs a server fault rather than blaming the link`: `expected "error" to be
  called 1 times, but got 2 times` (the 401 probe now logs beside the 500
  verification)
- `stays silent for the spent link that is the ordinary case`: `expected "error"
  to not be called at all, but actual calls were: …` (the 401 probe logs where
  nothing should)

The second and third are the free pins `noSession` gives us; the first is the
one the branch relies on. The two `it.each` cases stay GREEN — 503 and 404 are
both `!== 418` as well, so they cannot distinguish this mutation, which is why a
silence can only ever be proven by mutating its exemption.

Record the exact text of all three failures. Restore `401`, re-run, confirm
green.

- [ ] **Step 5: Run the full local suite**

Integration and e2e cannot run from a worktree — both need a dev server on
`:3000` and the shared dev DB. Run the tiers that can:

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit --project components
```

Expected: all three clean. Record the vitest totals; CI is the signal for
integration and e2e.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(public)/verify/page.tsx'
git commit -m "$(cat <<'EOF'
fix(verify): the session probe's own non-ok statuses are now classified (#456)

A non-ok probe does not throw, so `catch (probeErr)` never saw one: a 503
and a 401 both fell past `if (res.ok)` to the error screen, indistinguishable
and unlogged. A reader whose session was fine was told their link failed,
and nothing recorded why.

401 stays silent — it is the probe's question answered "no", and the
commonest path here. Everything else gets a line carrying the status, in
the same shape student-directory.tsx:55 uses.

Nothing the reader sees changes. Whether a probe 503 should produce a
different screen from a spent link is a UX question the issue leaves open.

Both branches were mutation-tested before this commit landed; the exact
failures are recorded in
docs/superpowers/plans/2026-09-05-verify-probe-classification.md.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Prove every guard bites — the mutation ledger

Both mutations are steps in Task 2 above; this is the summary a reviewer reads.
Neither is optional, and each records its exact failure text before restoring.

| # | Mutation | Must go RED | Must stay GREEN | Proves |
|---|---|---|---|---|
| M1 | Delete the `if (res.status !== 401) { … }` block | the two new `it.each` cases | everything else, the new 401 case included | the loud branch is real, not vacuous |
| M2 | `res.status !== 401` → `res.status !== 418` | `stays silent for the 401 …`; `logs a server fault rather than blaming the link`; `stays silent for the spent link …` | the two new `it.each` cases | the 401 exemption is load-bearing, and all three silence assertions genuinely hold it |

M2 is the one that matters most. The issue is explicit that a green tick is not
evidence for a silence, and the new 401 case is honest about staying green under
M1 — a silence can only ever be proven by mutating its exemption, never by
deleting the code around it. `418` rather than a status the session route can
produce, so the mutation cannot pass for the wrong reason.

M1 and M2 fail disjoint sets of tests, which is itself worth noticing: the loud
cases cannot see M2 and the silence cases cannot see M1. Neither mutation alone
would tell you the classification works.

**A third mutation is deliberately not run.** Moving the guard above the
`if (res.ok)` block would be the natural M3, and Task 1 Step 2 adds the
assertion that catches it — but that assertion is written and verified as part
of Task 1, where its RED state is the guard not existing at all. Re-running it
as a mutation in Task 2 would re-measure the same thing.

---

## Self-review

**Coverage against the issue's acceptance criteria:**

| Criterion | Where |
|---|---|
| Non-401 probe logs a `[verify]` line with the status | Task 2 Step 1; Task 1 Step 4 asserts it |
| 401 stays silent | Task 2 Step 1's `!== 401`; pinned by the dedicated case in Task 1 Step 4, and twice more by `:939` and `:999` once Task 1 Step 1 lands |
| No change to what the reader sees | No JSX touched; every new test asserts the screen it expected before |
| A component test per branch | **Met.** Loud branch: two `it.each` cases (503 and 404). Silent branch: its own case, with the 401 inline rather than through `noSession`, a loud verification beside it so it asserts presence before absence, and an argument-matched absence. |
| Mutate to prove it bites | M1 and M2, Task 2 Steps 3-4 |
| Vacuity documented rather than left to a green tick | The 401 case's docblock states outright that it survives M1 and only M2 turns it red |

**Placeholder scan:** none — every step carries the literal code.

**Type consistency:** `PROBE_STATUS_LINE` is defined in Task 1 Step 3 and
consumed three times in Task 1 Step 4 (twice asserting presence, once absence);
Task 2 Step 1 emits the same literal. The payload is `{ status: res.status }` in
the implementation and `{ status }` in the loud cases, matched exactly rather
than through `objectContaining` — a substituted payload fails. `FAULT_LINE` is
pre-existing at `:926` and is reused unchanged by the new silent case.

**Line numbers** in this plan are against `origin/main` at `821c28c5`. Task 1's
edits shift Task 2's targets; Task 2 names its insertion point by surrounding
code, not by line, for that reason.
