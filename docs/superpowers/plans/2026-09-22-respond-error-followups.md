# #652 Follow-Ups: respondRefusal Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four follow-ups #649/PR #651 deliberately left out of scope: route the
remaining split-`CodedRefusal` call sites through `respondRefusal`, give
`STUDIO_CLASS_EDIT_REFUSALS` a `status` field, brand `respondError`'s rejecting branch so the
compiler error names the fix, simplify the coded overload to one type parameter, and add a
`codedRefusal` smart constructor so no map hand-types a `status` literal beside its `code`.

**Architecture:** Add `codedRefusal<C extends ApiErrorCode>(code: C, message: string):
CodedRefusal` to `src/lib/api-error-codes.ts` and use it everywhere a `Record<Reason,
CodedRefusal>`-shaped map (or `PaymentRefusal`'s six construction sites) currently hand-types
`status` beside `code`. Route every remaining split `respondError(x.message, x.status,
x.code)` call onto `respondRefusal(x)`. Replace `respondError`'s two-type-parameter coded
overload with a one-type-parameter form built on the `StatusOf<C>` indexed-access type that
already exists (`api-error-codes.ts:96`, currently used only by `CodedRefusal` itself) —
indexed access distributes over a union of keys and a union of identical literals collapses to
one, so `IsUnion<StatusOf<C>> extends true ? never : StatusOf<C>` accepts exactly the same
calls the two-parameter mechanism did, proven in the spec's "Item 2+3" section. Brand the
rejecting branch's type so its diagnostic names `respondRefusal`.

**Tech Stack:** TypeScript (strict), Next.js Route Handlers, Vitest (`@ts-expect-error` +
`pnpm run typecheck` for compile-time guards).

**Spec:** `docs/superpowers/specs/2026-09-22-respond-error-followups-design.md`

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types (CLAUDE.md).
- A comment states what is true now; correct a wrong claim by replacing it, not annotating it
  with "this previously said X" (CLAUDE.md, Comment Discipline).
- `pnpm run verify` (typecheck, lint, full test suite) must be green before this is considered
  done; the app must be live on its worktree port for the integration tier — check
  `INTEGRATION_BASE_URL` / `pnpm run worktree:up`, do not start or restart a shared dev server.
- Never write "does not close #N" in a commit message or PR body.
- **Task order is load-bearing**, for two different reasons:
  - Task 2 depends on Task 1: `STUDIO_CLASS_EDIT_REFUSALS` must gain its `status` field (built
    with `codedRefusal`) before its call sites can route through `respondRefusal`.
  - Task 3 should land last even though it has no hard compile dependency on Tasks 1/2: it
    rewrites `respondError`'s coded overload, the riskiest change in this plan, and Tasks 1/2
    shrink the population of real call sites still using that overload's 3-argument form before
    Task 3 touches it — smaller blast radius for the riskiest task, not smaller correctness
    burden (Task 3's own verification step re-derives the full remaining population regardless).

---

## Task 1: Add `codedRefusal`, apply it to every hand-typed `CodedRefusal` map

**Files:**
- Modify: `src/lib/api-error-codes.ts` (new export, after `isApiErrorCode`)
- Modify: `src/app/api/classes/[id]/transition/route.ts:22` (import), `:39-50`
  (`TRANSITION_REFUSAL`'s three inline members)
- Modify: `src/services/studio-class-deletion.ts:1` (import), `:168-175`
  (`STUDIO_CLASS_REFUSALS`)
- Modify: `src/services/payments.ts:9` (import), `:56-60` (`PAYMENT_GONE`), `:67-71`
  (`PAYMENT_CHANGED`), `:156-163`, `:164-172`, and the two further inline refusal literals at
  the `markNotCharged` and reminder-refusal sites (re-locate by searching for
  `code: 'PAYMENT_ALREADY_PAID'` and `code: 'PAYMENT_SETTLED'` — this file's line numbers have
  drifted from the #649 plan's citations; read the current file before editing)
- Modify: `src/services/studio-class-edit-refusals.ts:1`, `:20-42` (all three members gain
  `status`)
- Modify: `src/services/studio-class-editability.ts` — re-export change only if
  `StudioClassEditRefusal`'s re-export needs no update (check; likely untouched)

**Interfaces:**
- Produces: `export function codedRefusal<C extends ApiErrorCode>(code: C, message: string):
  CodedRefusal` — every call site above becomes a leaf of the plan's Global Constraint on
  derive-don't-duplicate.
- Consumes nothing new — `API_ERROR_STATUS` is already in scope in
  `src/lib/api-error-codes.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/api-error-codes.test.ts` (read the file first to match its existing style —
it already has `Assert`/`Equals` compile-time pins for `CodeWithStatus`/`StatusOf`):

```ts
import { codedRefusal } from './api-error-codes';
```

(add to the existing import from `'./api-error-codes'` if one exists in this file; otherwise
as a new import line)

```ts
describe('codedRefusal', () => {
  it('derives status from the registered code, never taking one as an argument', () => {
    const refusal = codedRefusal('NOT_FOUND', 'This payment no longer exists.');

    expect(refusal).toEqual({
      code: 'NOT_FOUND',
      status: 404,
      message: 'This payment no longer exists.',
    });
  });

  it('produces a value assignable to CodedRefusal for any registered code', () => {
    const refusal: CodedRefusal = codedRefusal('PAYMENT_WAIVED', 'x');
    expect(refusal.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/lib/api-error-codes.test.ts`
Expected: FAIL — `codedRefusal` is not exported yet (`SyntaxError`/`TypeError` depending on
how the import resolves).

- [ ] **Step 3: Write the minimal implementation**

In `src/lib/api-error-codes.ts`, add after `isApiErrorCode`'s closing brace:

```ts
/**
 * Builds a `CodedRefusal` from a code and a message, deriving `status` from
 * `API_ERROR_STATUS` rather than letting a call site hand-type it beside
 * `code` — the same "derive, don't duplicate" `respondPaymentRefusal` used to
 * be the one place doing before #649/#652 folded every other map onto this.
 *
 * The cast is the one place this function trusts rather than re-derives:
 * `{ code, status: API_ERROR_STATUS[code], message }` is exactly one member
 * of `CodedRefusal`'s distributed union for the literal `C` a caller passes,
 * but TypeScript does not narrow a generic function's return expression that
 * way on its own — the signature is what keeps every call site checked.
 */
export function codedRefusal<C extends ApiErrorCode>(code: C, message: string): CodedRefusal {
  return { code, status: API_ERROR_STATUS[code], message } as CodedRefusal;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/lib/api-error-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Apply `codedRefusal` to `TRANSITION_REFUSAL`**

In `src/app/api/classes/[id]/transition/route.ts`, add `codedRefusal` to the type-only import
on line 22 — split it into a value import, since `codedRefusal` is a function:

```ts
import { codedRefusal } from '@/lib/api-error-codes';
import type { CodedRefusal } from '@/lib/api-error-codes';
```

Replace `TRANSITION_REFUSAL` (currently lines 39-50):

```ts
const TRANSITION_REFUSAL = {
  NOT_FOUND: CLASS_GONE,
  CANCELLED: CLASS_CANCELLED,
  CONCURRENT_MODIFICATION: codedRefusal(
    'CONCURRENT_MODIFICATION',
    'This class was just changed elsewhere. Refresh and try again.',
  ),
  STARTS_IN_PAST: codedRefusal('CLASS_STARTS_IN_PAST', STARTS_IN_PAST_MESSAGE),
  ROOM_ARCHIVED: codedRefusal('ROOM_ARCHIVED', ROOM_ARCHIVED_MESSAGE),
  NOT_ENDED_YET: CLASS_NOT_ENDED_YET,
} as const satisfies Record<Exclude<TransitionFailureReason, 'ILLEGAL_TRANSITION'>, CodedRefusal>;
```

- [ ] **Step 6: Apply `codedRefusal` to `STUDIO_CLASS_REFUSALS`**

In `src/services/studio-class-deletion.ts`, change line 1 the same way:

```ts
import { codedRefusal } from '@/lib/api-error-codes';
import type { CodedRefusal } from '@/lib/api-error-codes';
```

Replace `STUDIO_CLASS_REFUSALS` (currently lines 168-175):

```ts
export const STUDIO_CLASS_REFUSALS = {
  regenerates: codedRefusal(
    'STUDIO_CLASS_REGENERATES',
    'This class comes from a recurring template and is not yet past, so removing it would only create it again. Cancel it instead.',
  ),
} as const satisfies Record<StudioClassRefusal, CodedRefusal>;
```

The docblock above it (lines 161-166, corrected by #649's Task 3) already credits `satisfies`
and `respondRefusal` for the pairing, not the call site — re-read it after this edit and
confirm it still states what's true; if it names `status: 409` as hand-typed anywhere, correct
that clause too (do not leave a docblock claiming a literal that no longer exists).

- [ ] **Step 7: Apply `codedRefusal` to `PaymentRefusal`'s six construction sites**

Read `src/services/payments.ts` fresh before editing — line numbers may have drifted. Add the
value import next to the existing type-only one:

```ts
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
```

Replace each of the six construction sites, preserving every existing message string exactly:

```ts
export const PAYMENT_GONE: PaymentRefusal = codedRefusal('NOT_FOUND', 'This payment no longer exists.');
```

```ts
const PAYMENT_CHANGED: PaymentRefusal = codedRefusal(
  'CONCURRENT_MODIFICATION',
  'This payment was just changed elsewhere. Refresh and try again.',
);
```

The four inline literals (each currently `{ kind: 'refused', refusal: { code: '...', status:
409, message: '...' } }`) become `{ kind: 'refused', refusal: codedRefusal('...', '...') }` —
same code, same message, `status` no longer written by hand. Locate them by their `code`
values: `'PAYMENT_ALREADY_PAID'` (two sites — the mark-paid conflict and the not-charged
conflict, different messages), `'PAYMENT_WAIVED'` (one site), `'PAYMENT_SETTLED'` (one site).

- [ ] **Step 8: Give `STUDIO_CLASS_EDIT_REFUSALS` a `status` field, derived not hand-typed**

In `src/services/studio-class-edit-refusals.ts`, this is a genuinely new field (item 1b), not
a mechanical swap — read the whole file first (it is short and entirely reproduced in the
Premise section of the spec). Add the import:

```ts
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
```

Change the type alias and the `satisfies` clause:

```ts
export type StudioClassEditRefusal = 'income_record' | 'generated_date' | 'past_date';

export const STUDIO_CLASS_EDIT_REFUSALS = {
  income_record: codedRefusal(
    'STUDIO_CLASS_INCOME_RECORD',
    'This class is in the past, so only its student count and cancellation can still change.',
  ),
  generated_date: codedRefusal(
    'STUDIO_CLASS_GENERATED_DATE',
    'This class comes from a recurring template, so it cannot move to another date. Cancel it and log a manual class on the new date instead.',
  ),
  /**
   * A date move that would land strictly before the teacher's today. Refused
   * because it is one-way through this editor: the row arrives already frozen
   * by `income_record`, so the typo that caused it cannot be undone here.
   * Logging a past class outright stays open — `/studio-class/new` bounds its
   * date field at neither end.
   */
  past_date: codedRefusal(
    'STUDIO_CLASS_PAST_DATE',
    'A class cannot move to a date in the past — it would become an income record and could not be edited again. Log a separate class on that date instead.',
  ),
} as const satisfies Record<StudioClassEditRefusal, CodedRefusal>;
```

(The `as const satisfies Record<StudioClassEditRefusal, { message: string; code: string }>`
annotation this file's own docblock explains — "the annotation checked exhaustiveness but
widened every `code` back to `string`" — no longer applies verbatim once the target is
`CodedRefusal`, whose own shape already keeps `code` narrow per member; re-read that docblock
paragraph after this edit and correct it if it now describes a widening that no longer
happens.)

This module's own docblock states it is import-free so client components can value-import it.
`codedRefusal` imports nothing beyond `API_ERROR_STATUS` and `CodedRefusal`, both already
zero-import (`api-error-codes.ts`'s own header docblock), so this module's guarantee holds —
confirm by re-reading that header claim in `api-error-codes.ts` rather than assuming it, since
this step is exactly the kind of edit that could quietly falsify it if `codedRefusal` ever
gained a framework import.

- [ ] **Step 9: Run typecheck**

Run: `pnpm run typecheck` (whole project)
Expected: FAIL — the three `STUDIO_CLASS_EDIT_REFUSALS`-derived call sites in
`studio-classes/[id]/route.ts` still pass `409` as a hardcoded literal third-argument-adjacent
value where the map's shape changed; this task does not touch those call sites (Task 2 does).
Confirm the failures are exactly there and nowhere else — if `pnpm run typecheck` fails
anywhere outside `studio-classes/[id]/route.ts`, STOP and investigate before proceeding.

Actually check: the three call sites use `STUDIO_CLASS_EDIT_REFUSALS.income_record.message`,
`409` (a literal, not read from the object), `.code` — since the third argument is still a
literal `409` and matches every member's now-real status, this should in fact still typecheck
clean (the object gained a field the call site doesn't read). If `pnpm run typecheck` is
clean, say so plainly rather than assuming the FAIL above — this whole step's purpose is to
observe which outcome actually happens, not to confirm a prediction.

- [ ] **Step 10: Run the full test suite for the touched files**

The app must already be live (check `INTEGRATION_BASE_URL` / `pnpm run worktree:up` — do not
start or restart a server that's already running).

Run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/studio-api.test.ts tests/integration/payments-api.test.ts`
Expected: PASS — every refusal's wire shape (status, code, message) is unchanged; only how
each value is constructed changed.

- [ ] **Step 11: Commit**

```bash
git add src/lib/api-error-codes.ts src/lib/api-error-codes.test.ts \
  "src/app/api/classes/[id]/transition/route.ts" src/services/studio-class-deletion.ts \
  src/services/payments.ts src/services/studio-class-edit-refusals.ts
git commit -m "refactor(api): derive CodedRefusal status via codedRefusal, not by hand (#652)"
```

---

## Task 2: Route the remaining split call sites through `respondRefusal`

**Files:**
- Modify: `src/app/api/waitlist/route.ts:3-9` (import), `:38`
- Modify: `src/app/api/classes/[id]/route.ts:3-9` (import), `:19-22` (`classGone()`)
- Modify: `src/app/api/classes/[id]/cancel/route.ts:58`
- Modify: `src/app/api/classes/[id]/transition/route.ts:65`
- Modify: `src/app/api/classes/[id]/payments/route.ts:3-9` (import), `:26`
- Modify: `src/app/api/classes/[id]/complete/route.ts:49`
- Modify: `src/app/api/studio-classes/[id]/route.ts:119-123`, `:139-142`, `:158-162`

**Interfaces:**
- Consumes: `respondRefusal` (already exported since #649) and, for the studio-classes sites,
  the `status` field Task 1 gave `STUDIO_CLASS_EDIT_REFUSALS`.

Pure call-site swap, no behavior change — every one of these refusals already carries the
exact same `status`/`code`/`message` it did before. No new test: the existing integration
suites for each route are the regression check.

- [ ] **Step 1: `waitlist/route.ts`**

Add `respondRefusal` to the import from `'@/lib/api-utils'` (currently lines 3-9). Replace
line 38:

```ts
  if (!cls) return respondRefusal(CLASS_GONE);
```

- [ ] **Step 2: `classes/[id]/route.ts`**

Add `respondRefusal` to the import from `'@/lib/api-utils'` (currently lines 3-9). Replace the
`classGone()` helper (currently lines 19-22):

```ts
/** The 404 for a class that is not there, whichever read in this file found it gone. */
function classGone() {
  return respondRefusal(CLASS_GONE);
}
```

- [ ] **Step 3: `classes/[id]/cancel/route.ts`**

`respondRefusal` is already imported (used at Task 2's #649 predecessor for `outcome.refusal`
at line 166). Replace line 58:

```ts
  if (!cls) return respondRefusal(CLASS_GONE);
```

- [ ] **Step 4: `classes/[id]/transition/route.ts`**

`respondRefusal` is already imported. Replace line 65:

```ts
  if (!cls) return respondRefusal(CLASS_GONE);
```

- [ ] **Step 5: `classes/[id]/payments/route.ts`**

Add `respondRefusal` to the import from `'@/lib/api-utils'` (currently lines 3-9). Replace
line 26:

```ts
  if (!cls) return respondRefusal(CLASS_GONE);
```

- [ ] **Step 6: `classes/[id]/complete/route.ts`**

`respondRefusal` is already imported. Replace line 49:

```ts
  if (!cls) return respondRefusal(CLASS_GONE);
```

- [ ] **Step 7: `studio-classes/[id]/route.ts`**

`respondRefusal` is already imported. Replace the three `STUDIO_CLASS_EDIT_REFUSALS`-derived
call sites. First (currently lines 119-123):

```ts
    return respondRefusal(STUDIO_CLASS_EDIT_REFUSALS.income_record);
```

Second (currently lines 139-142, the `refusal` local built just above stays as-is — only the
final line changes):

```ts
    return respondRefusal(refusal);
```

Third (currently lines 158-162):

```ts
    return respondRefusal(STUDIO_CLASS_EDIT_REFUSALS.past_date);
```

- [ ] **Step 8: Run typecheck**

Run: `pnpm run typecheck` (whole project)
Expected: PASS — no diagnostics.

- [ ] **Step 9: Run the regression suites for every touched route**

The app must already be live — check first, do not restart.

Run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/studio-api.test.ts tests/integration/waitlist-api.test.ts`
Expected: PASS — every 404/409 refusal case on these routes passes unchanged (same status,
same code, same message).

- [ ] **Step 10: Commit**

```bash
git add src/app/api/waitlist/route.ts "src/app/api/classes/[id]/route.ts" \
  "src/app/api/classes/[id]/cancel/route.ts" "src/app/api/classes/[id]/transition/route.ts" \
  "src/app/api/classes/[id]/payments/route.ts" "src/app/api/classes/[id]/complete/route.ts" \
  "src/app/api/studio-classes/[id]/route.ts"
git commit -m "refactor(api): route the remaining split-CodedRefusal call sites through respondRefusal (#652)"
```

---

## Task 3: Simplify and brand `respondError`'s coded overload

**Files:**
- Modify: `src/lib/api-utils.ts:1-95` (import line, `IsUnion`, `respondError`'s docblock and
  coded overload)
- No test file changes expected — see Step 1.

**Interfaces:**
- Produces: `respondError<C extends ApiErrorCode>(message: string, status: IsUnion<StatusOf<C>>
  extends true ? UseRespondRefusal : StatusOf<C>, code: C): NextResponse` — replaces the
  two-type-parameter overload. The uncoded 2-arg overload and every existing call site's
  observable behavior are unchanged; only the mechanism and the rejected-call diagnostic
  change.

- [ ] **Step 1: Confirm the existing compile-time guard tests already cover every case this
      change must preserve**

Read `src/lib/api-utils.test.ts`'s `'ties a code to its status, and a conflict to a code, at
compile time'` test and the `SYNTHETIC_REFUSAL`/`SYNTHETIC_SAFE_CODE` fixtures above it. It
already has, unmodified:
- a wrong-status single literal code (`respondError('Wrong status.', 409, 'NOT_FOUND')`,
  `respondError('Wrong status.', 404, 'PAYMENT_WAIVED')`) — the single-literal-code rejection
  case.
- a union code spanning two statuses, rejected both at no status
  (`unionRefusal.status`/`.code`) and at a status matching one member but not the other
  (`409, unionRefusal.code`) — the #649 bug shape.
- a union code whose members all share one status, accepted (`safeCode` from
  `SYNTHETIC_SAFE_CODE`).

This is exactly the three-shape test matrix the spec's "Item 2+3" verification plan calls for.
No new test is written for the mechanism swap itself — the existing suite is the proof, and
adding a parallel copy would just be two things to keep in step. Confirm this by reading, not
by assuming; if any of the three shapes is missing or was changed since the spec was written,
add it here before proceeding, matching the existing fixtures' style.

- [ ] **Step 2: Run typecheck to record the pre-change baseline**

Run: `pnpm run typecheck` (whole project)
Expected: PASS — no diagnostics. Record this as the baseline the swap must not regress.

- [ ] **Step 3: Enumerate the real call-site population still using the coded overload**

Run:

```bash
grep -rn "respondError(" src --include="*.ts" | grep -v "respondError('[^']*', [0-9]*)" | grep -v "\.test\.ts"
```

(a rough filter — refine by reading hits; the goal is every 3-argument `respondError` call
outside test files, now that Tasks 1 and 2 have removed the map-indexed and `CLASS_GONE`-style
ones). Cross-check against the spec's "Item 2+3" list (`SLOT_TAKEN` maps across 4 template
route files, `students/route.ts`, `waitlist/claim/route.ts`, `waitlist/route.ts`) — confirm
the list matches what's actually there today, since Tasks 1/2 may have changed it. Note any
site the spec's list doesn't mention.

- [ ] **Step 4: Write the simplified, branded overload**

In `src/lib/api-utils.ts`, change the type-only import on line 6 from:

```ts
import type { ApiErrorCode, ApiErrorStatus, CodedRefusal, CodeWithStatus } from './api-error-codes';
```

to:

```ts
import type { ApiErrorCode, CodedRefusal, StatusOf } from './api-error-codes';
```

(`ApiErrorStatus` and `CodeWithStatus` are no longer referenced in this file — confirmed by
Step 3's grep of this file specifically; `CodeWithStatus` keeps its other uses elsewhere,
per the spec's Premise section.)

Replace the `respondError` docblock and coded overload signature:

```ts
/**
 * Named so a rejected call's diagnostic points here instead of reading like an
 * arbitrary `never`. Carries no data — it exists only as a distinct nominal
 * type the coded overload's rejecting branch can resolve to.
 */
type UseRespondRefusal = {
  readonly __use: 'respondRefusal — this code union spans more than one status';
};

/**
 * A refusal. `C` is inferred from `code`; `status` must equal `StatusOf<C>` —
 * the one status every member of `C` is registered at. `StatusOf<C>`
 * distributes over a union `C` on its own (indexed access on a union of keys
 * distributes, and a union of identical literals collapses to one), so a
 * union `code` is fine exactly when every member shares one status (several
 * existing call sites rely on this), and is a compile error — naming
 * `respondRefusal` in the diagnostic — the moment it spans more than one,
 * regardless of which status literal is passed, because no single literal
 * can be correct for all its members. A 409 must name its code, because a
 * conflict is exactly what a client has to tell apart. A refusal read off a
 * `Record<Reason, CodedRefusal>` map — where each member carries its OWN
 * status, not one shared by every member — uses `respondRefusal` instead,
 * never this overload split into two arguments. The rules are in
 * `docs/technical-architecture.md` (The Services Layer → Error responses).
 */
export function respondError<C extends ApiErrorCode>(
  message: string,
  status: IsUnion<StatusOf<C>> extends true ? UseRespondRefusal : StatusOf<C>,
  code: C,
): NextResponse;
```

The `IsUnion` type alias, the uncoded 2-arg overload, the implementation signature, and
`respondRefusal`/`sendError` below are unchanged.

- [ ] **Step 5: Run typecheck — this is the step that proves equivalence**

Run: `pnpm run typecheck` (whole project)
Expected: PASS, identical diagnostic count to Step 2's baseline (zero). If this fails anywhere
— including inside `api-utils.test.ts`'s existing `@ts-expect-error` lines going unused, which
itself is a compile error — STOP. Do not edit a call site to work around a new failure without
first determining whether the failure reveals a genuine gap in the equivalence reasoning above;
read the spec's "Item 2+3" section again against the actual diagnostic before changing
anything.

- [ ] **Step 6: Mutation-test the branded diagnostic text**

Temporarily change one real call site to the rejected shape — reuse
`src/app/api/classes/[id]/transition/route.ts`'s `TRANSITION_REFUSAL[result.reason]` call
(now `respondRefusal(refusal)` after Task 2) by temporarily changing it to
`respondError(refusal.message, 409, refusal.code)`.

Run: `pnpm run typecheck`
Expected: FAIL. Record the exact diagnostic text verbatim for the PR body — confirm it names
`UseRespondRefusal` (and, from that type's own literal member, the string `respondRefusal — ...`)
rather than a bare `never`.

Restore the line to `respondRefusal(refusal)`.

Run: `pnpm run typecheck`
Expected: PASS — no diagnostics.

Run: `git status --porcelain -- "src/app/api/classes/[id]/transition/route.ts"`
Expected: empty output.

- [ ] **Step 7: Full verify**

The app must already be live — check first, do not restart.

Run: `pnpm run verify`
Expected: PASS — typecheck, lint, and the full test suite (unit + component + integration) all
green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/api-utils.ts
git commit -m "refactor(api): simplify respondError's coded overload to one type parameter, brand the rejection (#652)"
```

---

## Finishing

The PR body carries: the premise-verification results for all four issue items (confirmed
exactly as described, no stale claims); the Task 3 Step 6 mutation-test result (exact `tsc`
error text, confirming the branded diagnostic names `respondRefusal`); a note on the one
pre-existing gap found and left alone (`COMPLETE_REFUSAL` has no inline members to convert —
all three alias shared constants); and which `integration` files this branch touched. Cite the
final `pnpm run verify` run from Task 3 Step 7 with its pass/fail arithmetic, the same
`105 = 46 unit + 32 components + 27 integration` style breakdown the project convention uses
(re-derive the actual numbers from that run's own output, don't reuse this example).
