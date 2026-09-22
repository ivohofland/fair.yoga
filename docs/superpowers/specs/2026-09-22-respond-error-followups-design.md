# #652 follow-ups: respondRefusal ergonomics, remaining split-CodedRefusal sites

**Issue:** #652 (follow-ups from #649/PR #651, none block that PR, all pure cleanup/ergonomics)
**Status:** design approved, ready for planning

## Premise, verified

Read the current state of every file the issue names, on `main` post-#649 (`9edc781f`):

- **Item 1a** — the six `CLASS_GONE`-style split call sites the issue lists
  (`waitlist/route.ts:38`, `classes/[id]/route.ts:21`,
  `classes/[id]/cancel/route.ts:58`, `classes/[id]/transition/route.ts:65`,
  `classes/[id]/payments/route.ts:26`, `classes/[id]/complete/route.ts:49`) all still read
  `respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code)`. Confirmed by grep;
  #649's own spec explicitly left these alone ("outside the scope agreed for this issue").
- **Item 1b** — `src/services/studio-class-edit-refusals.ts`'s `STUDIO_CLASS_EDIT_REFUSALS` is
  still `satisfies Record<StudioClassEditRefusal, { message: string; code: string }>` — no
  `status` field — and all three call sites in `studio-classes/[id]/route.ts` (lines 118-123,
  138-143, 156-163) hardcode the literal `409`. All three codes
  (`STUDIO_CLASS_INCOME_RECORD`, `STUDIO_CLASS_GENERATED_DATE`, `STUDIO_CLASS_PAST_DATE`) are
  registered at 409 in `API_ERROR_STATUS` today, so no live bug — confirmed.
- **Item 2** — `respondError`'s rejecting branch (`src/lib/api-utils.ts:69-73`) still types the
  `status` parameter as bare `never` on rejection; a rejected call surfaces as
  `error TS2345: Argument of type '409' is not assignable to parameter of type 'never'` with no
  pointer to `respondRefusal`. Confirmed by reading the current overload.
- **Item 3** — `StatusOf<C>` (`src/lib/api-error-codes.ts:96`) already exists, defined as
  `(typeof API_ERROR_STATUS)[C]`, but is used today only by `CodedRefusal`'s mapped type — not
  by `respondError`, which still carries the two-type-parameter form
  (`C`, `S extends ApiErrorStatus`) from #649. Confirmed.
- **Item 4** — `TRANSITION_REFUSAL`, `COMPLETE_REFUSAL`, `STUDIO_CLASS_REFUSALS` each hand-type
  a `status` literal beside `code` at every entry; `PaymentRefusal`'s six construction sites
  (`PAYMENT_GONE`, `PAYMENT_CHANGED`, and four inline literals at `payments.ts:158-162,
  167-171, 285-289, 372-376` — confirmed by reading the file) do the same. No `codedRefusal`
  smart constructor exists anywhere in `src/lib/api-error-codes.ts`. Confirmed.

All four items hold exactly as described. Nothing in the issue was stale or wrong.

## Decision

Implement all four items. None carry a correctness stake on their own (the issue says so, and
premise verification confirms no live bug anywhere), but #652 exists as the PR-sized home for
exactly this cleanup, and every one of the four is a leaf — no open design question, no
dependency on a decision only a human can make.

**Task order is load-bearing.** The `codedRefusal` constructor (item 4) is built first so items
1b and the studio-class-edit-refusals status field are *derived*, never hand-typed, from the
day they're added — never write `status: 409 as const` by hand and then replace it two commits
later. Items 1a/1b (route call sites onto `respondRefusal`) land next, which *shrinks* the
population of call sites still using `respondError`'s coded overload before the riskiest
change — the item 2+3 signature rewrite — touches it. Item 2+3 land together at the end: both
edit the same five-line overload signature in `api-utils.ts`, so doing them as two separate
tasks would have the second task's diff collide with the first's.

## Item 2+3 — the only genuinely risky task: type-level equivalence proof

The current (#649-shipped) coded overload:

```ts
export function respondError<C extends ApiErrorCode, S extends ApiErrorStatus>(
  message: string,
  status: IsUnion<S> extends true ? never : ([C] extends [CodeWithStatus<S>] ? S : never),
  code: C,
): NextResponse;
```

`S` is inferred from the `status` argument's own type, `C` from `code`'s. The proposed
replacement, using the `StatusOf<C>` indexed-access type that already exists:

```ts
export function respondError<C extends ApiErrorCode>(
  message: string,
  status: IsUnion<StatusOf<C>> extends true ? never : StatusOf<C>,
  code: C,
): NextResponse;
```

**Why they accept the same calls.** Indexed access on a union of keys distributes
automatically (`T[K1 | K2]` = `T[K1] | T[K2]`), and a union of identical literal members
collapses to one (`404 | 404` = `404`). So `StatusOf<C>`:

- Single literal `C` (e.g. `'NOT_FOUND'`) → `StatusOf<C>` is the single literal `404`.
  `IsUnion<404>` is false, so the expected type is the literal `404` — a call must pass exactly
  that status, identical to today.
- Union `C` whose members all share one status (e.g. every `SLOT_TAKEN` member registered at
  409) → `StatusOf<C>` collapses to the single literal `409` for the same reason. `IsUnion`
  false, expected type `409` — accepted, identical to today's `[C] extends [CodeWithStatus<S>]`
  outcome for this shape.
- Union `C` spanning more than one status (the #649 bug shape, e.g. `TRANSITION_REFUSAL`'s
  `404 | 409`) → `StatusOf<C>` is a genuine multi-member union → `IsUnion` true → expected type
  `never` → any `status` argument is rejected. Identical outcome to today.

**Where the mechanisms could in principle diverge, and why they don't.** The two-parameter
form's outer `IsUnion<S>` guard exists to catch a `status` argument whose own static type is
already a union (before any correlation check runs) — needed there because the inner check,
`[C] extends [CodeWithStatus<S>]`, only asks "is every member of C valid for *some* member of
S", which is too weak on its own when S is a union (it doesn't pin *which* S member goes with
*which* C member). The one-parameter form has no separate `S` at all: the expected type for
`status` is derived purely from `C`, then checked by ordinary TypeScript assignability against
whatever the caller actually passed. A wider or union-typed `status` argument is never
assignable to the single literal (or `never`) that `StatusOf<C>` produces, so the failure mode
the two-parameter form needed a dedicated guard for is instead caught for free by ordinary
literal-type assignability. No case was found — by construction, not by search — where the
one-parameter form accepts something the two-parameter form rejects, or vice versa.

**Verification plan (required before landing, per the issue's own acceptance bar — "verify
against the full call-site population, not just the representative test matrix"):**

1. Enumerate every existing call to `respondError`'s coded (3-argument) overload across `src/`
   after Tasks 1 and 2 have landed (grep `respondError(` minus the 2-arg uncoded calls).
   #649's own spec already did this exhaustively for the pre-#652 codebase and found the
   population splits into: single-literal-code call sites (majority), the `SLOT_TAKEN`
   destructured-tuple maps (uniform-status unions, several files), `students/route.ts`,
   `waitlist/claim/route.ts` + `waitlist/route.ts` (`satisfies Record<Reason,
   CodeWithStatus<409>>`), and `payments/[id]/shared.ts`'s `respondPaymentRefusal` (now itself
   routed through `respondRefusal`, so no longer in this population at all). Re-run the grep
   fresh rather than trusting that list, since Tasks 1/2 change which sites still use the coded
   overload.
2. Swap the one-parameter signature in, run `pnpm run typecheck` (whole project) — must be
   exit 0, same as the two-parameter baseline, with zero new and zero fewer diagnostics.
3. Mutation-test the guard directly, the same three shapes #649's spec proved for the old
   mechanism, against the new one: (a) a call built the way `TRANSITION_REFUSAL[reason]` is —
   `respondError(refusal.message, 409, refusal.code)` where the reason union spans 404/409 —
   must be `@ts-expect-error`; (b) the same shape at a status literal that matches every member
   (a `SLOT_TAKEN`-style uniform-409 union) must compile; (c) a single literal code passed at
   its one wrong status (e.g. `'NOT_YOUR_PROFILE'` at `409` instead of its registered `403`)
   must be `@ts-expect-error`. Record the exact `tsc` error text for each rejected case, the
   same evidentiary bar #649 set.
4. Extend `src/lib/api-utils.test.ts`'s existing compile-time guard test block with these three
   cases rather than replacing it — the existing cases keep proving the two-parameter-era
   behaviour didn't regress in observable outcome, just in mechanism.

## Design

### A. `src/lib/api-error-codes.ts` — `codedRefusal` smart constructor (item 4)

```ts
export function codedRefusal<C extends ApiErrorCode>(code: C, message: string): CodedRefusal {
  return { code, status: API_ERROR_STATUS[code], message } as CodedRefusal;
}
```

One cast is unavoidable: `{ code: C; status: StatusOf<C>; message: string }` is what the
expression actually produces and is exactly one member of `CodedRefusal`'s distributed union
for that `C`, but TypeScript does not narrow a generic return position that way without help —
the same reason `CodedRefusal`'s own definition exists as a mapped-and-indexed type rather than
a plain interface. Kept private to this concern: the function's *signature* pins the real
relationship (`C` in, `CodedRefusal` out, narrowed per call by the literal passed for `code`),
so every call site is checked correctly even though the one line inside is not re-derived by
the compiler.

Apply at:
- `TRANSITION_REFUSAL` (`classes/[id]/transition/route.ts`) — the two inline members
  (`CONCURRENT_MODIFICATION`, `STARTS_IN_PAST`, `ROOM_ARCHIVED`; the other three already alias
  shared constants and are untouched).
- `COMPLETE_REFUSAL` (`classes/[id]/complete/route.ts`) — no inline members today (all three
  alias shared constants); left as-is, noted in the PR body rather than silently skipped.
- `STUDIO_CLASS_REFUSALS` (`studio-class-deletion.ts`) — its one member, `regenerates`.
- `PaymentRefusal`'s six construction sites (`payments.ts`) — `PAYMENT_GONE`, `PAYMENT_CHANGED`,
  and the four inline literals.
- `STUDIO_CLASS_EDIT_REFUSALS` (item 1b) — all three members, giving the map a `status` field
  for the first time rather than hand-typing one now only to route it through `codedRefusal`
  later.

`CLASS_GONE`/`CLASS_CANCELLED`/`CLASS_NOT_ENDED_YET` (`classes/[id]/shared.ts`) are **not**
touched — the issue's item 4 names `Record<Reason, CodedRefusal>`-shaped maps specifically,
these are single top-level constants outside that shape, and converting them is a scope
question the issue never raised.

### B. Route the split call sites onto `respondRefusal` (items 1a, 1b)

The six `CLASS_GONE`-style sites: replace
`respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code)` with
`respondRefusal(CLASS_GONE)`.

The three `STUDIO_CLASS_EDIT_REFUSALS`-derived sites in `studio-classes/[id]/route.ts`: once
each map entry carries `status` (via `codedRefusal`, part A), replace
`respondError(STUDIO_CLASS_EDIT_REFUSALS.income_record.message, 409,
STUDIO_CLASS_EDIT_REFUSALS.income_record.code)` (and the two others) with
`respondRefusal(STUDIO_CLASS_EDIT_REFUSALS.income_record)`, and the `refusal` local built at
lines 138-141 / 158-161 the same way.

### C. `respondError`'s coded overload (items 2, 3)

Replace the two-parameter overload with the one-parameter form in "Item 2+3" above. Brand the
rejecting branch so the diagnostic names the fix, matching the issue's proposal:

```ts
type UseRespondRefusal = { readonly __use: 'respondRefusal — this code union spans more than one status' };

export function respondError<C extends ApiErrorCode>(
  message: string,
  status: IsUnion<StatusOf<C>> extends true ? UseRespondRefusal : StatusOf<C>,
  code: C,
): NextResponse;
```

Import `StatusOf` from `./api-error-codes` (already exported); drop the now-unused `S extends
ApiErrorStatus` type parameter and the `CodeWithStatus` import if nothing else in the file uses
it (check — `respondRefusal`'s own signature doesn't need it, so confirm before removing).
Update the overload's docblock to describe the one-parameter mechanism and to state that the
rejecting branch's type names `respondRefusal` directly.

### D. Tests

`api-utils.test.ts`'s existing `@ts-expect-error` compile-time guard block gains the three
mutation-test cases from the verification plan above, phrased as permanent tests rather than
one-off manual checks. The branded-type assertion (item 2) gets its own case: a rejected call's
inferred type error string includes `'respondRefusal'` — checked the same way the file already
pins other diagnostic text, if it does; otherwise document in the PR body that the brand was
confirmed by reading the actual `tsc` output once, since a string embedded in a type has no
runtime representation to assert against directly.

## Acceptance criteria

- All six `CLASS_GONE`-style call sites and all three `STUDIO_CLASS_EDIT_REFUSALS`-derived call
  sites use `respondRefusal`; `respondError`'s coded overload is not called with a
  pre-correlated refusal's parts split apart anywhere in `src/`.
- `STUDIO_CLASS_EDIT_REFUSALS` entries carry `status`, derived via `codedRefusal`, not
  hand-typed.
- `respondError`'s coded overload takes one type parameter; a rejected call's error names
  `respondRefusal`.
- `TRANSITION_REFUSAL`'s inline members, `STUDIO_CLASS_REFUSALS`, and `PaymentRefusal`'s six
  construction sites go through `codedRefusal` rather than hand-typing `status`.
- The three mutation-test cases in "Item 2+3" are recorded in the PR body with exact `tsc`
  error text, and `pnpm run typecheck` is clean across the whole project both before and after
  the item 2+3 swap (same diagnostic count: zero).
- `pnpm run verify` green.

**#649/PR #651 are unaffected** — this strengthens the same invariant along the axes #649 left
open, on call sites #649's own spec named and explicitly deferred.
