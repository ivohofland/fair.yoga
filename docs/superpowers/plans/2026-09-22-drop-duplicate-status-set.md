# #650 — drop the hand-copied status Set from `api-error-codes.test.ts`

**Direction (agreed):** delete the test. No replacement pin.

## Premise, as measured

- `satisfies Record<string, ApiErrorStatus>` on `API_ERROR_STATUS` rejects a
  registered status outside `ApiErrorStatus` at the entry itself (TS2322).
- With `satisfies` removed as well, `sendError(…, status: ErrorStatus, …)` in
  `src/lib/api-utils.ts` still rejects it (TS2345), because `respondError`
  passes `StatusOf<C>` into it. The claim does not rest on one guard.
- The runtime test is the only thing that reddens when `ApiErrorStatus` is
  widened *correctly* and the registry uses the new member.
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
     and TS2345 at `sendError` beside it.
   - b. Also delete `satisfies Record<string, ApiErrorStatus>` → TS2345 at
     `sendError` in `api-utils.ts`.
   - c. Widen `ApiErrorStatus` and `ErrorStatus` with `422` and register
     `UNPROCESSABLE: 422` → typecheck clean, and the unit files still green:
     the correct change no longer reddens anything. Not `418`:
     `api-utils.test.ts` holds it as its example of a status the app never
     sends, so widening with it reddens that `@ts-expect-error` for a reason
     unrelated to this test.
4. `pnpm run verify` before pushing.

Single task, so no whole-branch review (skill §5); PR review via
`/pr-review-toolkit:review-pr`.
