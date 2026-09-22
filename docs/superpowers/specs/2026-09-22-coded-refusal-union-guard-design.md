# `respondError`'s code-fixes-its-status guard collapses on a union-typed code

**Issue:** #649 (found during #648/#647, reviewer-discovered, reproduced independently)
**Status:** design approved, ready for planning

## Premise, verified

`respondError<C extends ApiErrorCode>(message, status: StatusOf<C>, code: C)` infers
`C` once, from `code`. When `code`'s static type is a union — which it always is when it
comes from indexing a `Record<Reason, CodedRefusal>` map by a runtime-variable `reason` —
`StatusOf<C>` becomes the union of every member's status, and any one of those statuses is
accepted for every member. The map itself is correctly checked, entry by entry, by its own
`satisfies Record<Reason, CodedRefusal>` (`CodedRefusal` is a distributed object union —
`src/lib/api-error-codes.ts:107-109` — so each entry is individually pinned at its own
status). What loses the correlation is splitting an already-correlated refusal object into
two independently-typed call arguments.

I reproduced this on current `main` (post #647/#648 merge), not just the branch the issue
measured against. Four call sites share the exact shape — read `refusal` out of a
`Record<Reason, CodedRefusal>`-like source, then call
`respondError(refusal.message, refusal.status, refusal.code)`:

| Call site | Refusal source | Statuses spanned | Exploitable today? |
|---|---|---|---|
| `src/app/api/classes/[id]/transition/route.ts:94` | `TRANSITION_REFUSAL[result.reason]` | 404, 409 | **Yes** — issue's own repro, reconfirmed |
| `src/app/api/classes/[id]/cancel/route.ts:166` | `outcome.refusal`, typed as bare `CodedRefusal` (widest possible union — all 6 `ApiErrorStatus` members) | 400,403,404,409,500,503 | **Yes, worse** — I mutated the status to a nonsense `400` for a 409-registered code; `pnpm run typecheck` passed clean |
| `src/app/api/classes/[id]/complete/route.ts:77` | `COMPLETE_REFUSAL[result.reason]` | 404, 409 | **Yes** — not named in the issue; I mutated it to `409` the same way and it also compiled clean |
| `src/app/api/studio-classes/[id]/route.ts:382` | `STUDIO_CLASS_REFUSALS[verdict.reason]` | 409 only (`StudioClassRefusal` has exactly one member, `'regenerates'`, today) | No — but the identical latent trap `studio-class-deletion.ts`'s own docblock warns about: "adding a member to a refusal map at a new status silently widens that map's union and loosens every call site reading it" |

All three mutations were applied, typechecked (exit 0, no diagnostics), and reverted; the
tree was confirmed clean after each (`git status --porcelain`).

A fifth site, `src/app/api/studio-classes/[id]/route.ts:141`, has a related but distinct
shape: it reads from `STUDIO_CLASS_EDIT_REFUSALS`, whose entries are typed
`{ message: string; code: string }` — no `status` field at all — and calls
`respondError(refusal.message, 409, refusal.code)` with a **hardcoded** literal status. All
three of that map's codes (`STUDIO_CLASS_INCOME_RECORD`, `STUDIO_CLASS_GENERATED_DATE`,
`STUDIO_CLASS_PAST_DATE`) are registered at 409 today, so there is no live defect, and the
hardcoded literal (not the map) determines the status sent — this call site cannot currently
diverge from what it sends regardless of which reason is selected. **Out of scope for this
issue**: fixing it means widening `STUDIO_CLASS_EDIT_REFUSALS`'s type to `CodedRefusal`
(adding a `status` field to all three entries) for a site with no live bug, which is a
separate, smaller cleanup. Left as a note for the fold/file/let-go step at the end of this
issue's work, not silently bundled in.

## Decision (approved)

Two options from the issue are combined rather than chosen between:

1. **`respondRefusal(refusal: CodedRefusal): NextResponse`** — takes the whole
   already-correlated object, so a map-indexed refusal is never split into two
   independently-typed arguments. (Issue's Option 1, reviewer-verified.)
2. **Tighten `respondError`'s coded overload** so any call where `C` infers as a union is a
   compile error, via an `IsUnion<C>` conditional that collapses `status`'s parameter type to
   `never` — the same idiom this file already uses for `respondTyped<T = never>`. (Issue's
   Option 3, flagged there as needing investigation; spiked below.)

Combined, call sites get an ergonomic one-argument call for the map-indexed pattern *and* a
permanent compiler wall against any call site — the four above, or a fifth nobody has written
yet — recreating this exact collapse by passing a union-typed `code` straight to
`respondError`.

**Option 3 feasibility, spiked and confirmed:**

```ts
type IsUnion<T, B = T> = T extends T ? ([B] extends [T] ? false : true) : never;

declare function respondErrorTight<C extends ApiErrorCode>(
  message: string,
  status: IsUnion<C> extends true ? never : StatusOf<C>,
  code: C,
): void;

respondErrorTight('ok', 403, 'NOT_YOUR_PROFILE');           // compiles — single literal code, unaffected
respondErrorTight('bad', unionStatus, unionCode);            // TS2345: not assignable to 'never'
respondErrorTight('bad', 409, unionCode);                    // TS2345: not assignable to 'never'
```

Run against the real project tsconfig (`pnpm run typecheck`), both union-typed calls were
rejected and the literal-code call was untouched. `IsUnion` relies on distributive
conditional types over a naked type parameter (`T extends T ? ... `), a standard TS idiom —
the pattern doesn't distribute per-union-member the way a mapped type does, so `C` staying a
union at the call site is exactly what makes `IsUnion<C>` resolve to `true`.

## Design

### A. `src/lib/api-utils.ts`

Add the private `IsUnion` type next to `respondError` (not exported — nothing outside this
file needs it). Change the coded overload's `status` parameter type from `StatusOf<C>` to
`IsUnion<C> extends true ? never : StatusOf<C>`. The uncoded 2-arg overload and the
implementation signature are untouched.

Add:

```ts
export function respondRefusal(refusal: CodedRefusal): NextResponse {
  return sendError(refusal.message, refusal.status, refusal.code);
}
```

No generics — the object's fields are already correlated by construction (checked once, at
the map's own `satisfies Record<Reason, CodedRefusal>`), so nothing here re-derives or
re-checks them; it only carries the already-consistent triple through to `sendError`, the
same private function `respondError`'s implementation already delegates to.

Rewrite `respondError`'s docblock: state that a union-typed `code` is now a compile error
(not merely that a code fixes its status), and point to `respondRefusal` as the required path
for a refusal read out of a `Record<Reason, CodedRefusal>` map. `respondError` itself remains
correct and unchanged in behavior for a single literal code known at the call site.

### B. Migrate the four confirmed call sites

`transition/route.ts:94`, `cancel/route.ts:166`, `complete/route.ts:77`,
`studio-classes/[id]/route.ts:382` each become:

```ts
return respondRefusal(refusal);
```

replacing `return respondError(refusal.message, refusal.status, refusal.code);`. No other
line in any of these four files changes — the refusal is already read into a local `refusal`
binding in every case, so this is a pure call-site swap.

`CLASS_GONE`-style call sites (`respondError(CLASS_GONE.message, CLASS_GONE.status,
CLASS_GONE.code)`, six of them across `waitlist/route.ts`, `classes/[id]/route.ts`, and the
`CLASS_GONE` line inside each of the four files above) are **not** touched: `CLASS_GONE.code`
is a single literal (`'NOT_FOUND'`), so `C` infers as a single type, `IsUnion<C>` is `false`,
and these compile identically to today under the tightened overload. Converting them to
`respondRefusal(CLASS_GONE)` for uniformity was considered and set aside — it's a pure style
question with no correctness stake, outside the scope agreed for this issue.

### C. Correct the false claim, everywhere it appears

`src/services/studio-class-deletion.ts:161-166`'s docblock currently reads (in part):

> Each entry carries its status and the call site passes `refusal.status`, which is what
> makes a code sent at the wrong status a compile error here as it is everywhere else (#197).

Replace with a version crediting what actually guards the code/status pairing:
`satisfies Record<StudioClassRefusal, CodedRefusal>` checks each map entry against its own
status at definition time, and — after this fix — `respondRefusal` (not `respondError` split
into two arguments) is what carries that pairing to the response without re-deriving it.

`docs/technical-architecture.md`'s "Error responses" section (`:145`, "A refusal is
`respondError(message, status, code)`.") gets one added sentence documenting `respondRefusal`
as the required path when the refusal comes from a `Record<Reason, CodedRefusal>` map, and
noting that splitting such a refusal into separate `status`/`code` arguments is now a compile
error rather than a silent hole.

**Swept and intentionally left alone:** `docs/superpowers/specs/2026-09-17-api-error-contract-design.md`
(:205, :635) and `docs/superpowers/plans/2026-09-17-api-error-contract.md` (:7) describe the
single-literal-code mechanism `respondError` already had from #197 — accurately, for the case
they cover. They're closed-issue records (`#197` is merged), not living documentation, and
this fix *strengthens* the invariant they describe rather than contradicting it; nothing in
them asserts the union case is safe. No edit needed.

### D. Tests

Extend the existing compile-time guard test in `src/lib/api-utils.test.ts`
(`'ties a code to its status, and a conflict to a code, at compile time'`, `@ts-expect-error`
+ `pnpm run typecheck`-verified per its own docblock) with:

- A refusal built the way `TRANSITION_REFUSAL[reason]` is (a `Record` over a 2+ member union,
  `as const satisfies Record<..., CodedRefusal>`, indexed by a non-literal key) — confirm
  `respondError(refusal.message, refusal.status, refusal.code)` is now a compile error
  (`@ts-expect-error`), including at a status that happens to match one member (the exact
  mutation from #649: `respondError(refusal.message, 409, refusal.code)` where one member is
  registered at 404).
- The same union-typed `refusal` passed whole to `respondRefusal(refusal)` — compiles, and at
  runtime returns the right status/code for each member (parameterized or two explicit
  cases).
- A hand-built object literal with a mismatched `status`/`code` pair passed directly to
  `respondRefusal` — `@ts-expect-error`, proving `CodedRefusal`'s own distributed-union
  definition (not anything `respondRefusal` adds) is what rejects it.

PR body carries the three manual mutation-test results from the Premise section above
(exact commands, exact "exit 0, no output" result, confirmed revert) as the record that the
guard bit before the fix and the fix closes it — not re-derived from the automated
`@ts-expect-error` tests alone, since those only exist after this PR.

## Acceptance criteria (supersedes the issue's, given the wider verified scope)

- `respondError(refusal.message, 409, refusal.code)` at any of the four confirmed call sites,
  with each site's map unchanged, is a compile error.
- `respondRefusal` is used at all four call sites; no `CLASS_GONE`-style call site is touched.
- `src/services/studio-class-deletion.ts:161-166` no longer attributes the code/status
  correlation check to the call site.
- `docs/technical-architecture.md` documents `respondRefusal` as the required path for a
  map-indexed refusal.
- A mutation test recorded in the PR: the tightened guard broken (the same way the issue and
  this spec did it), exact error text captured, restored, re-verified — for at least one of
  the four sites.
- `pnpm run verify` green.

**#197, #647, #648 are unaffected** — all merged/closed on their own terms; this fix
strengthens the invariant #197 shipped rather than changing it for any call site that was
already using a single literal code.
