# The verifying rail's life gets a floor (#435, #254)

## What was measured, and what the issue got wrong

#435 reports a screen flashing on the signup path and says the login path was
given a timer that the signup path never got.

**That half is wrong.** `/verify` is one page for both paths. The
`setTimeout(…, 900)` that holds the success state sits above the
login/signup branch — `isNewSignup` changes only the *copy* — so no token
type can miss it. Six variants driven through the running dev server, with
real tokens bound to a real origin nonce:

| Variant | "Checking your link" | success state |
|---|---|---|
| A · existing teacher, `sign_in` | 194ms | 993ms |
| B · no account yet, `teacher_signup` → ticket | 173ms | 972ms |
| C · student-only account, `sign_in` → `/signup/profile` | 152ms | 970ms |
| D · existing teacher, `sign_in` → `/signup/profile` (bounced) | 146ms | 1003ms |
| E · signup, same tab, driven from `/signup`'s own form | 89ms | 968ms |
| F · login, same tab, driven from `/login`'s own form | 90ms | 977ms |

The success hold is within 35ms across all six. The login and signup paths
are the same code and behave the same.

**The symptom is real, and it is on both paths.** The screen that flashes is
`VerifyingState` — "One moment / Checking your link" — visible for 89–194ms.
It is the heaviest screen in the flow (label, display heading, body
paragraph, a three-row rail, status line, fineprint) and the only one whose
duration nothing bounds.

**And it is worse than a client-side flash.** `curl` on `/verify?token=…`
returns HTML containing "Checking your link", so the rail is painted before
any JavaScript runs — before hydration, before the verification request is
even sent.

**Which of the two render sites produces that HTML depends on how the page
is served, and both had to change.** Measured rather than assumed, after a
first attempt got it backwards:

- Under `next dev` the page is rendered per request, `useSearchParams`
  resolves, and `VerifyContent` produces the HTML. Restoring
  `fallback={<VerifyingState />}` while the fall-through stayed gated left
  the served HTML rail-free; gating the fallback while the fall-through
  painted unconditionally brought the rail straight back.
- A built deployment serves the route **prerendered** — `└ ○ /verify`,
  "prerendered as static content", in the route table of CI run
  33910078862 — where a `useSearchParams` bailout takes the nearest Suspense
  boundary with it and the **fallback** is the first paint.

So the fallback is the production first-paint and the fall-through is the dev
one. Neither change is redundant.

This is #254, already open with the fuller write-up. #435 is the same defect
seen from the signup side.

**#254 was never implemented**, though #435 assumes something like it was. No
commit, branch or PR has ever referenced it, and `git log -S 'VerifyingState'`
returns exactly one commit — `fba8d7d0`, which introduced the component — so
the number of references to it has never changed and it has never been gated.

What *was* implemented is `92478ca4`, "the success flash carries only what a
second can hold": the 900ms hold and the content-stripping, both on
`SuccessState`. That is what #435 means by "the fix we already did on another
path" — another **screen**, not another auth path. The observation in the
issue is correct; only its attribution to signup-versus-login is not.

## The approach, and why the obvious one is wrong

#254 proposed suppressing the rail below a ~300ms threshold. **A threshold
alone moves the cliff rather than removing it**: a verification settling at
330ms renders the rail for the 30ms between the two events — the same
flicker, now reproducible only on connections near the boundary.

A screen's lifetime has two ends, and nothing can know at render time whether
a fetch will answer in 90ms or 3s. Gating the *start* can therefore never
bound the lifetime away from zero. Only controlling the *stop* can — a
minimum hold once the thing is on screen. The threshold is an optimization
layered on top of that hold, never a substitute for it.

**So: two constants.** Do not render the rail before `RAIL_APPEARS_AFTER_MS`
(300); once rendered, hold it `RAIL_STAYS_FOR_MS` (600) before letting any
outcome take the screen.

300 is #254's figure, kept deliberately. The measured fast path is 89–194ms,
so localhost never reaches it. A real deployment's round trip may well land
between 200 and 400ms, which means some real sign-ins *will* see the rail and
pay the hold — accepted, because that is the connection the rail was written
for, and the alternative is a longer bare-wordmark window on exactly the
sign-ins that most need acknowledgement.

| Verification settles at | Rail visible | Flicker |
|---|---|---|
| 90ms | never | none |
| 299ms | never | none |
| 301ms | 300 → 900ms (600ms) | none |
| 2000ms | 300 → 2000ms | none |

No input produces a rail visible for less than `RAIL_STAYS_FOR_MS`. What
survives at the threshold is a *latency* step — settle at 299ms and the
outcome shows at 299ms, settle at 301ms and it shows at 900ms — which is
followed by the existing 900ms success hold either way and reads as nothing.

Neither constant taxes the fast path: below the threshold nothing is held,
because nothing was shown.

### Rejected

- **Threshold only** (#254 as written) — the cliff above.
- **Minimum hold only, no threshold** — one constant, no cliff at all, but
  every sign-in pays ~600ms of interstitial before the 900ms success hold.
  Trading real speed for the appearance of thoroughness.
- **Delete the rail entirely** — zero timers and cannot flicker, but a
  genuinely slow verification then shows a bare wordmark, which is exactly
  when an emailed link most needs to look alive. #254 rejected this too.
- **Strip the rail's content, as `92478ca4` did for the success state** — a
  90ms screen is unreadable at any weight; it trades two heavy layout shifts
  for two light ones instead of removing one.
- **Verify during SSR and `redirect()`, so no interstitial exists at all** —
  the clean architecture, but consuming a single-use token on a GET means
  mail scanners and link prefetchers spend the link before the human clicks
  it. Out of scope; the client-side POST is deliberate.

## Task 1 — the gate, and both render sites

**File:** `src/app/(public)/verify/page.tsx`

Add two module constants and a local hook that owns the rail's visibility.
The hook is local to this file because it has exactly one consumer, and
keeping it here keeps its comment annotating the code it sits on.

**The hook's contract.** It returns whether to render the rail, and a
`settle` function. Every path out of `verifying` — success, error,
already-signed-in, handoff — applies its state through `settle` rather than
calling `setStatus` directly, so no outcome can land on screen while the rail
is mid-flash.

**Implement it without reading the clock.** Rather than recording an
appearance timestamp and computing a remainder, arm the minimum-hold timer at
the moment the rail appears, and have `settle` either run immediately or hand
its callback to that timer:

- on mount (only when a token is present): arm the appearance timer
- appearance timer fires: the rail is now held; show it; arm the stay timer
- stay timer fires: the rail is no longer held; run a stashed callback if one
  is waiting
- `settle(apply)`: cancel the appearance timer; if the rail is not held,
  `apply()` now; otherwise stash `apply` for the stay timer
- unmount: clear every timer and drop any stashed callback

This has no dependence on `Date.now`, so it behaves identically under
vitest's fake timers and Playwright's `page.clock`.

**Both render sites change, or the flash returns through the other:**

1. The `status === 'verifying'` fall-through renders the rail only when the
   hook says it is visible, and nothing otherwise.
2. The `<Suspense fallback>` renders nothing. This is the site that produces
   the server-rendered HTML, and it runs before any verification has started
   — it cannot know how long anything will take, so it must not paint a
   screen that may be replaced on the next frame.

"Nothing" is genuinely nothing: the `(public)` layout renders the wordmark
above `{children}`, so it already carries the screen on its own, and both
`VerifyingState` and `SuccessState` centre themselves in the remaining space
— so the outcome appears in place rather than jumping.

**The no-token case must not be delayed.** The initial status is already
`error` when the URL carries no token; the appearance timer must not arm at
all in that case, and `settle` is never reached.

**Comment the constants for what they are.** #254 warns that a threshold
reads as an artificial slowdown to the next person and gets deleted. The
comment must say the pair exists to *hide* the rail on the fast path and to
*bound* its life on the slow one — and that the threshold alone would move
the cliff rather than remove it, which is why both numbers are load-bearing.

### Tests — `src/app/(public)/verify/page.test.tsx`

The file already exists (241 lines) and already mocks `next/navigation`
locally, including `useSearchParams`. It already drives the 900ms hold with
`vi.useFakeTimers()` and `advanceTimersByTimeAsync`. Extend it; no change to
`tests/setup/components.ts` is needed.

The existing eleven cases resolve their mocked fetch immediately, so under
the new gate the rail never appears and they should pass unedited. **If any
of them needs editing, stop and report it** — that would mean the fast path
changed, which is exactly what must not happen.

New cases:

1. **Fast path shows no rail at all.** Fetch resolves immediately; the rail's
   heading is absent from the first render through to the success heading.
2. **Once shown, the rail keeps the screen for its minimum.** A fetch
   resolved by hand: advance past the threshold, assert the rail; resolve;
   advance a single millisecond and assert the outcome is *still not*
   showing and the rail *is*; advance to the end of the hold and assert the
   outcome. This is the anti-flicker assertion — the one the whole change
   exists for.
3. **The redirect beat starts when the success state becomes visible**, not
   when the fetch settled — the 900ms is measured from the outcome taking the
   screen. Guards against the two timers being composed so that the hold eats
   the reading time.
4. **The error branch does not inherit the threshold on the fast path** — an
   immediately-failing verification renders the error state without the
   clock being advanced to the threshold at all.

### Prove both constants bite

Per guard, break it, record the exact failure text, restore, re-verify:

- Render the rail unconditionally in the fall-through → case 1 fails.
- Set the minimum hold to zero → case 2 fails.
- Have `settle` apply immediately regardless of the hold → case 2 fails.

A change that leaves all three green has not been tested.

## Task 2 — pin the server-rendered half, and sweep the stale claims

Task 1's component tests cannot cover the `Suspense` fallback: the local
`next/navigation` mock returns search params synchronously, so the boundary
never suspends and the fallback never renders in jsdom. The fallback is the
site that produces the SSR HTML, so it needs its own pin.

**The pin.** An integration case that requests `/verify?token=…` over HTTP
and asserts the returned HTML does **not** contain the rail's heading. This
is currently RED — `curl` on that URL returns HTML containing "Checking your
link" exactly once today — so it is a real assertion, not a tautology.
Place it with the other magic-link integration cases; give it its own
`freshIp()` per `tests/helpers.ts`.

**The sweep.** `grep` for what this change invalidates, and give every hit a
verdict:

- `grep -rn "Checking your link" src tests docs` — today this returns only
  the component itself, so any new hit is this branch's own doing.
- `docs/information-architecture.md` and `docs/design-brief.md` — check
  whether either describes the verify interstitial as a screen the reader
  sees; a description that survives as a *name* while ceasing to be *true*
  is the kind a keyword grep cannot catch, so read the surrounding prose,
  not just the match.
- The e2e suite: `tests/e2e/auth.spec.ts` waits on post-redirect URLs and on
  the error / already-signed-in copy; `tests/e2e/booking.spec.ts` installs
  `page.clock` before navigating and asserts on the success state. Neither
  asserts on the verifying state, so both should pass unedited — confirm
  rather than assume, and say so.

**Stale claims in #254 to correct when the issue is closed** — its
implementation notes were written before the test file existed:

- "The natural home is a **new** `src/app/(public)/verify/page.test.tsx`" —
  it exists, and had 11 cases before this branch.
- "the shared `next/navigation` mock in `tests/setup/components.ts` stubs
  `useRouter` only … the first `src/app` page test will have to extend that
  mock" — it did not; the verify test file mocks `next/navigation` locally,
  and the shared setup is untouched.
- Its line references (`line 249`, `line 276`, `line 281`, `lines 79–104`)
  predate several commits and no longer point where they say.

Still true, and worth saying so: no test asserts on the verifying state
today, so this change cannot break an existing assertion.

## Verification

`npm run verify` — typecheck, lint, and every vitest project, with the app
live on `:3000`. State the arithmetic behind the suite count in the PR body.
Warm `/verify` with a bare request after the edit before scoring any
mutation: `next dev` compiles lazily and a cold route's first request reads
exactly like an assertion failure.

Re-run the six-variant timing probe after the change and put the
before/after table in the PR body — the fast path must still reach its
destination in the same time, with one screen fewer.

## Closing

The PR closes **#435** and **#254** — the same defect, reported twice, from
the signup side and from the login side.
