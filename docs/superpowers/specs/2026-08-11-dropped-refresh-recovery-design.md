# A control never returns to idle after it succeeds

**Issue:** #40 — "Next router drops refresh/nav commits under CPU starvation"
**Date:** 2026-08-11
**Status:** Proposed
**Related:** #98 (`2026-07-28-idempotent-toggle-endpoints-design.md`) — the server
half of the same phenomenon, and the source of six of this codebase's idempotent
endpoints; #121 (`2026-08-03-api-error-classification-design.md`) — the error-code
mechanism this design deliberately does not extend.

---

## 1. What the issue claimed, and what measurement found

The roadmap's standing instruction for this issue: *"Nothing yet says #40's half is
real either — it inherits the same evidence base [as the disproved #41], and the
artifacts it rests on have since expired. Re-measure before designing on it."*

| # | Claim | Verdict |
|---|---|---|
| 1 | `mark-unpaid-button.tsx` never re-enables on success | **Holds.** `setBusy(true)` `:24`, `router.refresh()` `:29`, reset only on the failure branches `:32`, `:36` |
| 2 | Test-side mitigation "PR forthcoming" | **Stale — it landed.** `d7c29c9`; `teacher-journey.spec.ts:248-253`, `:291-296`, `:432-437` |
| 3 | Next 16.2.10 / React 19.2.7 | **Still exact** in `package.json` and the installed tree |
| 4 | The flake is live | **No recurrence** in the 20 most recent CI runs. The two failures were `31213207079` (only `checks`, a job with no e2e in it) and `31242301225` (`checks` *and* `test` on a Prisma 7.9.1 dependabot bump) |
| 5 | Next drops refresh/nav commits under CPU starvation | **Unverified; artifacts expired.** Deliberately not re-measured — §2 |
| 6 | Proposed fix: `useTransition` | **Rejected — it relocates the flag rather than clearing it.** §6 |
| 7 | Scope: one component | **Wrong, and in two directions.** §3 |

Claim 7 is the substantive correction. The issue names one component. Three
censuses found a defect class spanning **9 components and 9 endpoints**, of which
the frozen button is the mildest instance. (Seven and seven when this was written;
the whole-branch review found two more the censuses had excluded by construction —
§3.)

---

## 2. Why the framework claim is not re-measured

Re-measuring costs a production build, CDP CPU throttling and repeated
probabilistic runs (the issue got 3 in 12), and would change none of our code —
the fix would be upstream in Next. **The design does not rest on it:**

1. **`router.refresh()` returns `void`.** Fire-and-forget: no promise, no callback.
   A component cannot learn whether the commit landed, so any design assuming it
   did is unfalsifiable from inside the component.
2. **This codebase already treats "the refresh never ran" as real.** #98's spec:
   *"The server commits. The response is lost or truncated — … `router.refresh()`
   never ran so the label still reads 'Archive', and the natural second click
   **un-archives**."* That design shipped.
3. **CPU starvation is not required.** A failed RSC fetch on poor mobile
   connectivity is byte-identical in effect, and CLAUDE.md's premise is that
   teachers use this on a phone between classes.

**A live artifact overstates this.** `teacher-journey.spec.ts:245-247` asserts the
unverified cause as fact — *"on starved CPUs (CI runners) the router can drop the
post-action refresh commit"*. The mitigation it justifies is correct for any
dropped repaint; only the causal attribution overreaches. Reworded in scope.

---

## 3. What was measured

### The censuses' blind spot, found by the whole-branch review

**Censuses 1 and 2 were scoped to `src/components/` and `src/lib/`, so `src/app/`
was excluded by construction.** Not overlooked — never in range. Two page
components live there with byte-for-byte the shape the exposure table below marks
**Exposed**, on two endpoints with no dedupe at all:
`src/app/(teacher)/class/new/page.tsx` and
`src/app/(teacher)/studio-class/new/page.tsx`. Because nothing under
`src/components/` or `src/lib/` calls their endpoints, `POST /api/classes` and
`POST /api/studio-classes` are absent from the 47-endpoint census too.

The numbers below are corrected to include them, and the correction is written
out rather than silently applied: a future reader needs to know that a census
scoped by directory answers only for that directory, which is how a defect class
named "9 components" was first measured as 7. Everything else in this section
stands as measured.

### Census 1 — components holding a pending flag across a mutation

Every non-test file under `src/components/` and `src/lib/` performing a mutating
`fetch` — see the scope note above for what that excluded. No `head`/`tail`
limits; all opened and read.

```
Files with a mutating fetch                      = 44
  (39 found by literal method regex + 5 whose method is a
   shorthand, a ternary, or on a continuation line)
```

The earlier count of 31 was scoped to `router.refresh()` and missed 13
push-only and local-state-only components.

### Census 2 — what a second identical request does

Every distinct endpoint those 44 call, with its route handler *and* service read,
assuming the first request already committed:

```
Distinct (method, route) pairs                   = 47   (+2 = 49)
  IDEMPOTENT                                     = 22
  CONFLICT (4xx "already in that state")         = 18
  DUPLICATE (succeeds, side effect happens twice)=  7   (+2 =  9)
                                                   ----
  22 + 18 + 9                                    = 49  ✓
```

The `+2` on both lines is the whole-branch review's correction: `POST
/api/classes` and `POST /api/studio-classes`, reached only from `src/app/` and
therefore outside the scope this census was run at. Both are DUPLICATE.

All six toggle endpoints #98 named are confirmed idempotent; a seventh of the same
shape that the spec did not name, `PATCH /api/invitations/[id]`, is idempotent too.

### The nine DUPLICATE endpoints

| Endpoint | What a second request does |
|---|---|
| `POST /api/class-templates` | Second template **and** a second `generateInstancesForTemplate` run — a full duplicate set of bookable `Class` rows |
| `POST /api/studio-class-templates` | Same shape; also double-counts studio income |
| `POST /api/classes` | A second bookable class, identical to the first. A bare `prisma.class.create` (`api/classes/route.ts:48-83`) with no dedupe; `Class`'s only unique constraint is `@@unique([templateId, date])`, and a manually created row's `templateId` is null since #146 — Postgres treats NULLs as distinct, so it never bites |
| `POST /api/studio-classes` | A second logged studio class, double-counting that week's income. Same shape, same reason: bare create (`api/studio-classes/route.ts:18-43`), `templateId` null since #148 |
| `POST /api/announcements` | Every student notified twice; a second row in the teacher's history |
| `POST /api/payments/[id]/remind` | The CAS gates on `status`, which a reminder does not change — a student is dunned twice for one debt |
| `POST /api/rooms` (private only) | The dedupe check runs only for public rooms — an indistinguishable twin |
| `POST /api/auth/magic-link/send` | A second live token; the older link silently stops matching |
| `POST /api/auth/student-signup` | A second welcome email |

**A claim of mine that did not survive checking, recorded because it was raised
prominently:** I proposed that a second walk-in click could add a second
registration and shift every student's price. It cannot. `POST /api/registrations`
is CONFLICT, guarded by both an in-transaction pre-check
(`api/registrations/route.ts:156-158`) and `@@unique([classId, studentId])`
(`schema.prisma:502`). Contact invitations (`@@unique([teacherId, email])`) and
room links (`@@unique([teacherId, roomId])`) are protected the same way.

### The exposure rule

Not every component on a DUPLICATE endpoint is reachable by this defect.

> **A success path built from local state is immune; only a success path that
> depends on a router action is exposed.**

`setStep('settings')` and `setOpen(false)` always apply. `router.push(…)` may not.

| Component | DUPLICATE endpoint | Success path | Exposed? |
|---|---|---|---|
| `settings/template-form.tsx` (create) | class-templates | `router.push` `:240` + `finally` `:267` | **Yes** |
| `settings/studio-template-form.tsx` (create) | studio-class-templates | `router.push` `:119` + `finally` `:124` | **Yes** |
| `app/(teacher)/class/new/page.tsx` | classes | `router.push` `:266` + `finally` `:269-271` | **Yes** — found by the whole-branch review, not the census |
| `app/(teacher)/studio-class/new/page.tsx` | studio-classes | `router.push` `:102` + `finally` `:105-107` | **Yes** — same |
| `settings/add-room-flow.tsx` | rooms | `setStep('settings')` `:195` | No — local |
| `class/send-announcement.tsx` | announcements | `setOpen(false)` `:41` | No — local |
| `booking/booking-sign-in.tsx` | magic-link, student-signup | terminal `'sent'` state `:40` | No — already settled |
| `class/send-reminder-button.tsx` | remind | parent callback `:81` | No — its double-dun risk is a missing cooldown, a different defect |

### Census 3 — the five components that strand a pending flag

| Component | Flag | Escape control | What the user sees when the refresh does not commit |
|---|---|---|---|
| `class/mark-unpaid-button.tsx` | `busy` `:20` | `Keep` `:62-69`, disabled `:65` | Trapped in the confirm state of a money-correcting action — **both** buttons dead — while the row still reads "✓ paid" |
| `booking/passkey-sign-in.tsx` | `state` `:17` | none | The gate to the whole app frozen at "Follow your device…", on a URL that did not change |
| `account/sign-out-button.tsx` | `busy` `:9` | none | Cookie already cleared server-side; a stale authenticated shell with no working control. **The only file with no reset on any path** |
| `student/pending-invitation-card.tsx` | `submitting` `:27` | `Cancel` `:73-79`, disabled `:76` | All four controls dead; neither answer can be given |
| `student/teacher-privacy-card.tsx` | `unlinking` `:69` | `Cancel` `:201-207`, disabled `:204` | The unlink cluster frozen; Save above it survives on its own `finally` `:106-107` |

---

## 4. Two failure modes

**Mode 1 — the request resolves, the router action does not commit.** The flag is
stranded (freeze), or reset over stale data (duplicate / false error). This is the
mode the issue describes.

**Mode 2 — the request never resolves.** `fetch` has no default timeout; on a dying
connection it can hang for minutes. No success-path fix reaches this mode, because
there is no success path yet. Only Rule 3 does.

---

## 5. Design — one invariant

> **After a successful mutation, a control never returns to idle. It goes to
> *settled*. The only exits are unmount (the router action committed) or an
> explicit user retry of the navigation.**

One rule, three defects. A settled control cannot freeze (settled is a live state
with an exit), cannot show a false error (it never re-offers the action), and
cannot double-submit (same reason).

**This pattern already exists in the repo.** `account/add-passkey.tsx:10` is
`'idle' | 'working' | 'done' | 'error'`, and `booking/booking-sign-in.tsx:22` is
`'idle' | 'sending' | 'sent' | 'error'`. Both are immune by construction. The work
is extending a local precedent, not importing an idea.

### Rule 1 — settled state, where the success path depends on the router

```tsx
if (res.ok) {
  setDone(true);
  router.refresh();   // if it commits, this subtree unmounts and `done` is never seen
  return;
}
```

```tsx
if (done) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="type-caption text-teal">Marked unpaid</span>
      <button type="button" onClick={() => router.refresh()} className="type-caption text-teal">
        Refresh
      </button>
    </span>
  );
}
```

`type-caption text-teal` for a settled confirmation is an existing idiom —
`teacher-privacy-card.tsx:184` already renders `<span className="type-caption
text-teal">Saved</span>`.

Copy: **"Marked unpaid" / "Accepted" / "Declined" / "Removed" / "Created"**, each
beside a control that retries the navigation the action expected.

### Rule 2 — where a retry is provably harmless, a plain reset is enough

`sign-out-button.tsx` (`DELETE /api/auth/session` — IDEMPOTENT) and
`passkey-sign-in.tsx` (re-running the ceremony mints a fresh challenge and succeeds).
Neither can produce a false error or a duplicate, and neither has a settled state to
show — success means *being somewhere else*.

**`passkey-sign-in.tsx` must not use `finally`.** Its flag is a tri-state union
(`:17`), so `finally { setState('idle') }` would erase the `'error'` the `catch`
sets at `:53`. The reset goes on the success path explicitly. *The rule is "reset on
success"; `finally` is only the vehicle where it does not clobber.* Census 1 found
**four** files where the pending flag and the error state are the same variable
(`add-passkey`, `booking-sign-in`, `join-as-student`, `passkey-sign-in`) — all four
already avoid `finally` for this reason.

### Rule 3 — an escape control never carries the pending flag

`Keep` / `Cancel` / `Cancel` in the three confirm-style components are pure
client-side state resets touching no network. **This rule exists for Mode 2 and is
not redundant with Rule 1**: if the request hangs, `done` is never set and Rule 1
never fires, so the un-disabled escape is the only way out of the confirm state. A
`Keep` tapped mid-flight cannot cancel the in-flight request; if that request later
succeeds, the component renders the settled state, which is the honest outcome.

### Per-file plan

| File | Rule | Settled copy | Test |
|---|---|---|---|
| `class/mark-unpaid-button.tsx` | 1 + 3 | "Marked unpaid" | **new** |
| `student/pending-invitation-card.tsx` | 1 + 3 | "Accepted" / "Declined" | exists |
| `student/teacher-privacy-card.tsx` | 1 + 3 | "Removed" | exists |
| `settings/template-form.tsx` (create only) | 1 | "Created" + link to recurring classes | check |
| `settings/studio-template-form.tsx` (create only) | 1 | "Created" + link to studio classes | check |
| `account/sign-out-button.tsx` | 2 (`finally`) | — | **new** |
| `booking/passkey-sign-in.tsx` | 2 (explicit, not `finally`) | — | **new** |
| `app/(teacher)/class/new/page.tsx` | 1 | "Created" + link to the class | exists |
| `app/(teacher)/studio-class/new/page.tsx` | 1 | "Created" + link to the studio class | exists |

The two template forms are **mode-branched**: only the `create` arm pushes and is
exposed. The `edit` arm already sets a success string and refreshes, and stays
mounted — leave it. Touching only one arm of a shared handler is the kind of
partial edit this project has shipped before; the plan must state it per arm.

The last two rows are the whole-branch review's addition. Their settled flag is
the created row's **id**, not a boolean: both navigate to the new record's own
page, so the id is kept either way and a boolean beside it would be a second
piece of state saying the same thing. `studio-class/new` also carries the
re-submit guard, pinned by a synthetic `fireEvent.submit`; `class/new` does not,
because it has no `<form>` and its handler's only caller is the button settling
removes — a guard there would have no reachable entry point, and this branch does
not ship guards that cannot fail.

---

## 6. Rejected designs, with the measurement that rejected each

**A single shared hook for all 44 call sites.** Census 1 found **13 distinct
post-success control-flow shapes** among them: `refresh` only (9), local + `refresh`
(10), `push` only (5), `push` + `refresh` (3), local only (9), mode-branched (2),
and one each of `setTimeout` fallback, optimistic-before-fetch, parent-callback,
multi-step wizard, split-by-component, split-by-action. Twelve outliers resist any
single signature — `passkey-sign-in` and `add-passkey` chain two POSTs around a
native OS ceremony where `NotAllowedError` must silently return to idle and
`InvalidStateError` must be treated as **success**; `send-reminder-button` routes
both its success and error sinks to parent props and deliberately wraps only its
body-read in `finally`; `add-room-flow` is a three-step wizard with three flags and
three error strings. A hook configurable enough for these is harder to review than
the nine edits it would replace. **Even across just the nine in scope there are
five shapes** — `refresh` only (three of them), `push` + `refresh`, the chained
ceremony, mode-branched (two), and `push` only (the two create pages). The
artifact this
design ships is therefore a stated invariant with a test per instance, plus one
shared *presentational* component (`SettledNotice`) — the axis on which the
settled states genuinely are identical. It holds no state, performs no fetch and
makes no routing decision, so none of the measurement above bears on it.

**An ESLint rule against the regression.** Evaluated and not viable: the defect is
"a control re-enables when its success path depended on a router action", which
`no-restricted-syntax` selectors cannot express. Banning `router.refresh()` outright
would hit 30+ legitimate call sites. Shipping a rule that cannot detect the defect
would be a guard that cannot fail — the thing this project's roadmap repeatedly
warns about. The regression guard is the test suite and the named invariant.

**`useTransition`** (the issue's own proposal). `isPending` clears when the
transition *commits* — precisely the commit the issue says is dropped — so under the
reported symptom the flag stays true and the control stays frozen. The same defect
with a different variable name. It also appears nowhere in `src/`.

**Error codes so the client can recognise "already done".** `readErrorMessage`
(`client-errors.ts:10`) reads only `error.message` and discards codes, and only 4 of
the 18 CONFLICT endpoints pass a code today. This would widen the branch into API
routes, services and integration tests to reach the same user-visible outcome Rule 1
reaches client-side. Filed instead — §8.

**Server-side idempotency keys.** The genuinely universal fix, and out of scope
here: it needs a schema change, `withErrorHandler` middleware and client plumbing,
and it turns on a product question this spec cannot answer alone — *may a teacher
deliberately send two identical announcements?* If yes, deduplication must key on
intent, not content. Filed — §8.

---

## 7. This overturns review finding F7, deliberately and only halfway

`pending-invitation-card.tsx:40-46` and `teacher-privacy-card.tsx:122-127` document
their non-reset as the fix for review finding **F7**:

> *"a `finally` reset here would leave a moment where a second click reaches the
> server on an invitation that already has its answer, surfacing 'already answered'
> in red over an action that in fact succeeded."*

**F7 was right, and this design keeps its conclusion.** Census 2 confirms both
retries land on CONFLICT — `ALREADY_ANSWERED` (409) and "Teacher link not found"
(404) — so a plain `finally` on these two files is a regression, which is why Rule 2
is not applied to them. What F7 got wrong was its alternative: it accepted "frozen
forever" as the price of avoiding a false error, when a third state avoids both.

Both comments are rewritten to carry the corrected reasoning, not deleted — the
hazard they name is real and the next reader needs to know why the code does not
simply reset. **F7's existing test expectations must be re-checked, not assumed:**
any assertion that a control *stays* disabled after success now asserts the defect.

---

## 8. Scope

**In scope:** the nine components in §5, their tests, the two F7 comments, and the
causal overreach at `teacher-journey.spec.ts:245-247`.

**Filed, not fixed** (each a live defect or a real design question, recorded with
its measurement):

1. **The 9 DUPLICATE endpoints and the idempotency-key question.** Rule 1 removes
   the *reachable* path to four of them; the endpoints stay duplicable by any other
   double-submit. Includes `send-reminder-button`'s missing cooldown (double
   dunning) and `POST /api/rooms`'s public-only dedupe check.
2. **The 18 CONFLICT endpoints' raw messages.** They reach users verbatim through
   `readErrorMessage`. A teacher retrying a publish currently sees `Invalid
   transition: cannot move from "open" to "open". Valid transitions from "open":
   [in_progress, cancelled]`.

**Out of scope, and deliberately not filed:** re-measuring the Next claim (§2, and
no reproduction exists to file upstream); the 33 `finally`-resetting components on
IDEMPOTENT endpoints (correct as they stand); `join-as-student.tsx`'s
`setTimeout(…, 4000)` (it resets, so it does not freeze — taste, not a defect,
visible from here but not worsened by here); `edit-room-form.tsx`'s two sequential
PUTs leaving a half-updated server on a mid-chain failure (a real but pre-existing
and unrelated defect — **filed under item 1's issue as an Update, not a new issue**).

**Issue #40 is unaffected by this branch's merge and stays open for its framework
half** — phrased this way deliberately: GitHub's auto-close parser matches `close #N`
and does not read a negation in front of it.

---

## 9. Guards, and the mutation that proves each bites

**The `components` vitest project already runs every one of these in the exact
failure mode #40 describes.** `tests/setup/components.ts:21` stubs
`useRouter().refresh` as a bare `vi.fn()` — a no-op that commits nothing, which is
what a dropped commit looks like from inside a component. These components have been
sitting frozen in their own test runs all along with nothing asserting on the
aftermath. No CPU throttling, no production build, no Playwright.

Each guard is broken, its exact failure text recorded, then restored and re-verified.

| # | Guard | Mutation that must make it fail |
|---|---|---|
| G1 | `mark-unpaid` shows "Marked unpaid" after a success that does not commit | Delete `setDone(true)` — the pre-fix behaviour restored verbatim |
| G2 | `Keep` is enabled while the POST is in flight | Re-add `disabled={busy}` to `Keep` |
| G3 | `sign-out` re-enables after push+refresh do not commit | Delete the single line `setBusy(false);` from the `finally`. **Not "delete the `finally`"** (whole-branch review F6): the `finally` is what this fix *adds*, and it carries the two router calls as well — removing the block would change more than the guard under test |
| G4 | `passkey-sign-in` returns to "Sign in with a passkey" after a non-committing success | Delete the success-path `setState('idle')` |
| **G5** | **A failed passkey verify still shows its error** | **Replace G4's explicit reset with `finally { setState('idle') }`** — the clobbering bug Rule 2 warns about. Exists to prove the `finally`-vs-explicit distinction is load-bearing, not stylistic |
| G6 | Both invitation answers reach a terminal state; `Cancel` stays live in flight | Restore the documented F7 non-reset |
| G7 | Unlink reaches a terminal state; `Cancel` stays live in flight | Restore the documented F7 non-reset |
| **G8** | **`template-form` in create mode does not re-enable Create after a push that does not commit** | **Three mutations, all run.** (a) Delete `setCreated(true)` from the create arm — the pre-fix behaviour, and the live duplicate-schedule defect; observed `expected <button …(2)></button> to be null`. (b) Keep `setCreated(true)` but restore the unconditional submit button, so only the label changes; observed as a failed `getByRole` lookup for "Go to recurring classes". (c) Rewire *only* the `SettledNotice`'s `onAction` to a `fetch`; observed `expected 3 to be 2` (mount room fetch + create POST, then the second request). **(c) is the only one of the three that reaches the fetch-count assertion** — (a) and (b) both trip a DOM-presence assertion first |
| G9 | `studio-template-form` create mode, same | The same three, same order. (c) observed `expected 2 to be 1` — this form has no mount fetch, so its create POST is call one |
| **G10** | **`class/new/page` does not re-enable after push that does not commit** | **Three mutations, all run.** (a) Delete `setCreatedId(json.data.id)` — the pre-fix behaviour where settled state never renders; observed `AssertionError: expected <button …(2)></button> to be null`. (b) Restore the unconditional submit button, so only the label changes to "Created"; observed as a failed `getByRole` lookup for "Go to the class". (c) Rewire *only* the `SettledNotice`'s `onAction` to a `fetch`; observed `expected 3 to be 2` at `class/new/page.test.tsx:172` (mount room fetch + create POST = 2; the mis-wired retry makes 3). **(c) is the only one that reaches the fetch-count assertion** — (a) and (b) trip a DOM-presence assertion first |
| **G11** | **`studio-class/new/page` does not re-enable after push that does not commit, and re-submit is blocked** | **Settlement: the same three mutations as G10**, with (c) observed `expected 2 to be 1` at `studio-class/new/page.test.tsx:145` (create POST + the retry — no mount fetch). **Re-submit guard**: Delete `if (createdId) return;` (keeping `setCreatedId`); observed `expected 2 to be 1` at synthetic-submit test `:158` |

The two new pages exercise the same settlement mutations (a/b/c) as the template forms, with observed fetch-count differences: `class/new` fetches `/api/teacher-rooms` on mount, so (c) observed `expected 3 to be 2`; `studio-class/new` has no mount fetch, so it observed `expected 2 to be 1`. The studio page also carries a re-submit guard, pinned by synthetic submit, which `class/new` deliberately omits — that page has no `<form>` element and `handleSubmit`'s only caller is the button settling replaces, so the guard would have no reachable entry point. Adding it would ship the exact defect these guards exist to prevent: a guard no mutation can reach.

In-flight assertions (G2, G6, G7) use a deferred fetch mock — a promise the test
resolves — so "while in flight" is a controlled state, not a race.

**A verification that could not have failed is not a verification.** Two specific
traps here:

- **G5** must assert on the *error message being present*, driven through the
  `verifyRes.ok === false` branch. A test checking only the button label would pass
  against the clobbering mutation too.
- **G8/G11** must assert that no second POST is possible, not merely that a label
  changed. The realistic regression is a second `fetch` reaching
  `/api/class-templates`, so the assertion is on the fetch mock's call count after a
  second click — not on rendered text, which a partial fix would satisfy. **And the
  fetch-count assertion needs mutation (c) to be exercised at all**: mutations (a)
  and (b) both remove or restore a control, so they fail on a DOM-presence
  assertion several lines earlier and never reach it. A guard is only proven by a
  mutation that reaches it.
- **The fix here is `created` plus the button ternary — not a removed `finally`.**
  `finally { setSubmitting(false) }` was never taken out of either form and still
  runs on the create arm — it is the `finally` closing `handleSubmit` in
  `template-form.tsx` and the one closing `handleSubmit` in
  `studio-template-form.tsx`. (Cited by enclosing function, not by line: this
  entry first read `template-form.tsx:278-280` / `studio-template-form.tsx:134-136`,
  correct at `4b3f763` and pushed down to `:296` / `:145` by later commits on this
  same branch — inside one branch, a line citation rotted.) "Restore the `finally`"
  is therefore a no-op
  mutation: it changes nothing, the suite stays green, and a maintainer running it
  would conclude this branch's highest-value guard is decorative. It is the
  false-negative this section exists to prevent, and it stood in this table until
  the whole-branch review (F3) caught it.

---

## 10. Acceptance

1. All nine components reach a usable, truthful state when the router commits
   nothing — proven against the existing no-op router double.
2. No component shows a red error for an action that succeeded.
3. No component permits a second mutating request after a successful one, in either
   template form or either create page.
4. Every escape control in the three confirm-style components is operable while its
   action is in flight.
5. G1–G11 each observed failing against their mutation, failure text recorded in the
   plan, then restored and re-verified.
6. `npm run verify` green — typecheck, lint, all three vitest projects — with the new
   component-test count reconciled arithmetically against the previous total.
7. The two filed issues exist, each carrying the measurement from §3 rather than a
   restatement of the symptom.
