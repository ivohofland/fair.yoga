# #650 — drop the hand-copied status Set from `api-error-codes.test.ts`

**Direction (agreed):** delete the test. PR review then found a single-cast
path only the deleted test caught; the agreed response is Task 2, a type pin
in its place that restates no status list.

## Premise, as measured

- `satisfies Record<string, ApiErrorStatus>` on `API_ERROR_STATUS` rejects a
  registered status outside `ApiErrorStatus` at the entry itself (TS2322).
- With `satisfies` removed as well, `sendError(…, status: ErrorStatus, …)` in
  `src/lib/api-utils.ts` still rejects it (TS2345), because `respondRefusal`
  passes `CodedRefusal`'s `status` — `StatusOf<C>` — into it uncast. That
  second guard exists only through that one call.
- Neither guard sees a cast on an entry: `TEAPOT: 418 as ApiErrorStatus`
  typechecks clean, because the whole union fits both `ApiErrorStatus` and
  `ErrorStatus`. The cast also widens that code's `StatusOf` to a union, which
  drops it out of every `CodeWithStatus<S>`. The runtime test caught this.
- The runtime test is the only thing that reddens when the status band is
  widened *correctly* — `ApiErrorStatus` and `ErrorStatus` together — and the
  registry uses the new member.
- CI runs `pnpm run typecheck` as its own step (`.github/workflows/ci.yml`).
- The only other copy of the test's text is
  `docs/superpowers/plans/2026-09-17-api-error-contract.md`, a plan kept as a
  record; left as written.

## Task 1 — delete the test

**File:** `src/lib/api-error-codes.test.ts`

1. Remove the `describe('API_ERROR_STATUS', …)` block.
2. Remove the `API_ERROR_STATUS` value import, which nothing else in the file
   uses.

**Verification (each step recorded in the PR body):**

1. Unit file green:
   `pnpm exec vitest run --project unit src/lib/api-error-codes.test.ts`.
2. `pnpm run typecheck` and `pnpm run lint` green.
3. Prove both remaining guards bite, each with the exact error text, then
   restore and confirm `git status` clean:
   - a. Register `TEAPOT: 418` → TS2322 at the registry entry (`satisfies`),
     and TS2345 in `api-utils.ts` at `respondRefusal`'s `sendError` call.
   - b. Also delete `satisfies Record<string, ApiErrorStatus>` → the same
     TS2345 alone.
   - c. Widen `ApiErrorStatus` and `ErrorStatus` with `422` and register
     `UNPROCESSABLE: 422` → typecheck clean, and the unit files still green:
     the correct change no longer reddens anything. Not `418`:
     `api-utils.test.ts` holds it as its example of a status the app never
     sends, so widening with it reddens that `@ts-expect-error` for a reason
     unrelated to this test.
4. `pnpm run verify` before pushing.

## Task 2 — pin one literal status per code

**Files:** `src/lib/api-error-codes.test.ts`, `src/lib/api-utils.ts`

1. Export `IsUnion` from `api-utils.ts` rather than copying it.
2. Add `_eachCodeHasOneStatus`: `NoneOf` over the codes whose `StatusOf` is a
   union, alongside the file's other structural pins. The helper,
   `CodesWithUnionStatusIn<R>`, is generic over a status map so that
   `_unionStatusIsNamed` can pin its failing direction on a two-entry fixture:
   against the real registry it only ever resolves to `never`, which a
   hollowed body would too.

**Verification:** each mutation restored, `git status` clean.

- `TEAPOT: 418 as ApiErrorStatus` → TS2344 naming `"TEAPOT"`.
- `TEAPOT: 401 as ApiErrorStatus` (inside `ErrorStatus`) → the same.
- `IsUnion` hollowed to `false` → the pin goes silent, but the #649
  `@ts-expect-error` cases in `api-utils.test.ts` report TS2578, so the
  dependency is not unguarded.
- The helper's body hollowed (`IsUnion<C>` for `IsUnion<R[C]>`;
  `R[C] extends number ? never : C`; `}[never]`) → the fixture reports TS2344
  `Type 'false' does not satisfy the constraint 'true'`.
- Not caught, accepted: a double cast to a single literal
  (`418 as number as 409`), which is deliberate rather than a slip; and
  deleting `satisfies` together with registering a code at 401 or 429, which
  is two separate edits to one reviewed file.

Review: the PR review covers the whole branch; its fix wave gets one re-review.
