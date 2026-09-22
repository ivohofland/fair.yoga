# Coded-Refusal Union Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the hole where `respondError`'s code-fixes-its-status guard silently
accepts any status when `code` is a union (read off a `Record<Reason, CodedRefusal>` map by
a non-literal reason), and correct the shipped code and docs that claim the call site already
checks this.

**Architecture:** Add `respondRefusal(refusal: CodedRefusal)` to `src/lib/api-utils.ts` for
the map-indexed refusal shape, and gate `respondError`'s coded overload with an `IsUnion<C>`
conditional so a union-typed `code` is a compile error there too — the two together mean a
map-indexed refusal can no longer reach `respondError` split into two arguments, by
construction, at every current and future call site. Then migrate the four call sites that
have this shape today and correct the one docblock that credits the wrong mechanism for it.

**Tech Stack:** TypeScript (strict), Next.js Route Handlers, Vitest (`@ts-expect-error` +
`pnpm run typecheck` for compile-time guards, per the existing pattern in
`src/lib/api-utils.test.ts`).

**Spec:** `docs/superpowers/specs/2026-09-22-coded-refusal-union-guard-design.md`

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types (CLAUDE.md).
- A comment states what is true now; correct a wrong claim by replacing it, not annotating it
  with "this previously said X" (CLAUDE.md, Comment Discipline).
- `pnpm run verify` (typecheck, lint, full test suite) must be green before this is considered
  done; the app must be live on `:3000` for the integration tier — do not start or restart it,
  check first (project hazard).
- Never write "does not close #N" in a commit message or PR body — GitHub's auto-close parser
  matches the keyword regardless of a leading negation.
- Tasks are strictly ordered: Task 2 depends on Task 1 (`respondRefusal` must exist before any
  call site can use it); Task 3 depends on Task 2 (the corrected docblock in Task 3 describes
  the call site's mechanism *after* migration — it would be false if written before Task 2
  lands); Task 4 depends on Task 2 (it mutates and restores the line Task 2 migrated).

---

## Task 1: Add `respondRefusal` and tighten `respondError` against union codes

**Files:**
- Modify: `src/lib/api-utils.ts:1-71` (import line, `respondError`'s docblock and coded
  overload, new `respondRefusal` export)
- Modify: `src/lib/api-utils.test.ts:1-4` (new type-only import), `:37-48` (import list),
  `:155-201` (extend the existing `respondError` describe block, add a new `respondRefusal`
  describe block)

**Interfaces:**
- Produces: `export function respondRefusal(refusal: CodedRefusal): NextResponse` — accepts
  any value of the `CodedRefusal` distributed union (`src/lib/api-error-codes.ts:107-109`) and
  sends its `message`/`status`/`code` unchanged. This is what Task 2's four call sites call.
- Produces: `respondError`'s coded overload now rejects a call where `C` (inferred from
  `code`) is a union of more than one `ApiErrorCode` member — any such call becomes a compile
  error regardless of what status is passed. The uncoded 2-arg overload
  (`respondError(message, status: Exclude<ErrorStatus, 409>)`) is unchanged.

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/api-utils.test.ts`. First, add a type-only import for `CodedRefusal` right after
the existing `import type { SessionUser } from './types';` (line 4):

```ts
import type { CodedRefusal } from './api-error-codes';
```

Add `respondRefusal` to the named import from `'./api-utils'` (currently lines 37-48):

```ts
import {
  respondOk,
  respondTyped,
  respondUnchanged,
  respondError,
  respondRefusal,
  requireSession,
  requireTeacher,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from './api-utils';
```

Immediately before `describe('respondError', () => {` (currently line 155), add the synthetic
fixture both the extended test and the new describe block below use:

```ts
/**
 * A refusal read off a `Record<Reason, CodedRefusal>` by a non-literal key —
 * the exact shape `TRANSITION_REFUSAL[result.reason]` has in
 * `src/app/api/classes/[id]/transition/route.ts`. `code`'s inferred type
 * here is the union `'NOT_FOUND' | 'PAYMENT_WAIVED'`, not either literal
 * alone — that's what the tests below exercise (#649).
 */
type SyntheticReason = 'gone' | 'waived';
const SYNTHETIC_REFUSAL = {
  gone: { code: 'NOT_FOUND', status: 404, message: 'A gone.' },
  waived: { code: 'PAYMENT_WAIVED', status: 409, message: 'B waived.' },
} as const satisfies Record<SyntheticReason, CodedRefusal>;

function pickSyntheticReason(): SyntheticReason {
  return 'gone';
}

```

Inside the existing test `'ties a code to its status, and a conflict to a code, at compile
time'` (currently lines 182-200), add two new lines right before the test's closing `});`
(after the existing `respondError('Teapot.', 418);` line):

```ts
    const unionRefusal = SYNTHETIC_REFUSAL[pickSyntheticReason()];

    // @ts-expect-error — unionRefusal.code is a union (read from
    // SYNTHETIC_REFUSAL by a non-literal reason); a union-typed code must go
    // through respondRefusal, not a split status/code call (#649)
    respondError(unionRefusal.message, unionRefusal.status, unionRefusal.code);

    // @ts-expect-error — same union, even at a status that happens to match
    // one member: before #649 this compiled clean, because StatusOf<C> was
    // the union of every member's status (404 | 409), and 409 is assignable
    // to that union even though it is NOT_FOUND's wrong status
    respondError(unionRefusal.message, 409, unionRefusal.code);
```

Immediately after the `describe('respondError', ...)` block's closing `});` (currently line
201, before `const testSchema = z.object({`), add a new describe block:

```ts
/**
 * The `@ts-expect-error` line is verified by `pnpm run typecheck` only, same
 * as `respondError`'s guard above.
 */
describe('respondRefusal', () => {
  it('sends a literal CodedRefusal exactly as given', async () => {
    const response = respondRefusal(SYNTHETIC_REFUSAL.gone);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { message: 'A gone.', code: 'NOT_FOUND' } });
  });

  it("accepts a refusal read from a union-typed index, and sends that member's own status", async () => {
    const refusal = SYNTHETIC_REFUSAL[pickSyntheticReason()];
    const response = respondRefusal(refusal);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { message: 'A gone.', code: 'NOT_FOUND' } });
  });

  it("rejects a status/code pair that is not one of CodedRefusal's own members", () => {
    // @ts-expect-error — NOT_FOUND is registered at 404, not 409;
    // CodedRefusal is a distributed union of { code, status } pairs, so this
    // literal matches none of its members
    respondRefusal({ code: 'NOT_FOUND', status: 409, message: 'wrong' });
  });
});
```

- [ ] **Step 2: Run typecheck and the test file to verify both fail**

Run: `pnpm run typecheck`
Expected: FAIL — `error TS2305: Module '"./api-utils"' has no exported member 'respondRefusal'`,
plus `error TS2578: Unused '@ts-expect-error' directive.` on the two new lines inside the
`'ties a code...'` test (today's `respondError` overload still accepts a union `code`, so
nothing suppresses there yet).

Run: `pnpm exec vitest run src/lib/api-utils.test.ts`
Expected: FAIL — the new `describe('respondRefusal', ...)` block throws
`TypeError: respondRefusal is not a function`, since nothing exports it yet.

- [ ] **Step 3: Write the minimal implementation**

Edit `src/lib/api-utils.ts`. Change the type-only import on line 6 from:

```ts
import type { ApiErrorCode, StatusOf } from './api-error-codes';
```

to:

```ts
import type { ApiErrorCode, CodedRefusal, StatusOf } from './api-error-codes';
```

Replace the block from the `respondError` docblock through `sendError`'s declaration
(currently lines 49-71) with:

```ts
/** True exactly when `T` is a union with more than one member (`A | B`, not `A`). */
type IsUnion<T, B = T> = T extends T ? ([B] extends [T] ? false : true) : never;

/**
 * A refusal. A code fixes its status (`src/lib/api-error-codes.ts`), so a code
 * sent at another status does not compile; a 409 must name its code, because
 * a conflict is exactly what a client has to tell apart. `C` is inferred from
 * `code`, so a union-typed `code` — reading a refusal off a
 * `Record<Reason, CodedRefusal>` map by a non-literal reason — poisons
 * `status`'s parameter type to `never` rather than being accepted at the
 * union of every member's status: use `respondRefusal` for that shape
 * instead. This overload is for a single literal code known at the call
 * site. The rules are in `docs/technical-architecture.md` (The Services
 * Layer → Error responses).
 */
export function respondError<C extends ApiErrorCode>(
  message: string,
  status: IsUnion<C> extends true ? never : StatusOf<C>,
  code: C,
): NextResponse;
export function respondError(message: string, status: Exclude<ErrorStatus, 409>): NextResponse;
export function respondError(
  message: string,
  status: ErrorStatus,
  code?: ApiErrorCode,
): NextResponse {
  return sendError(message, status, code);
}

/**
 * A refusal read whole off a `Record<Reason, CodedRefusal>` map (or any other
 * already-correlated `CodedRefusal` value) — never split into a `status` and
 * a `code` argument, which is what let a union-typed reason silently widen
 * `respondError`'s status check to every member's status at once (#649). The
 * pairing was already checked once, at the map's own
 * `satisfies Record<Reason, CodedRefusal>` — this only carries it to the
 * response.
 */
export function respondRefusal(refusal: CodedRefusal): NextResponse {
  return sendError(refusal.message, refusal.status, refusal.code);
}

function sendError(message: string, status: ErrorStatus, code?: ApiErrorCode): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}
```

- [ ] **Step 4: Run typecheck and the test file to verify both pass**

Run: `pnpm run typecheck`
Expected: PASS — no diagnostics.

Run: `pnpm exec vitest run src/lib/api-utils.test.ts`
Expected: PASS — all tests green, including the new `respondRefusal` describe block and the
extended `respondError` compile-time test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api-utils.ts src/lib/api-utils.test.ts
git commit -m "feat(api): add respondRefusal, reject union-typed codes in respondError (#649)"
```

---

## Task 2: Migrate the four call sites to `respondRefusal`

**Files:**
- Modify: `src/app/api/classes/[id]/transition/route.ts:5-11` (import), `:94` (call site)
- Modify: `src/app/api/classes/[id]/cancel/route.ts:3-10` (import), `:166` (call site)
- Modify: `src/app/api/classes/[id]/complete/route.ts:1-9` (import), `:77` (call site)
- Modify: `src/app/api/studio-classes/[id]/route.ts:3-9` (import), `:382` (call site)
- Test: `tests/integration/classes-api.test.ts` (`describe('POST /api/classes/[id]/complete'`
  at :376, `describe('POST /api/classes/[id]/transition'` at :457, which also holds the cancel
  door's tests), `tests/integration/studio-api.test.ts` (regenerates-refusal cases)

**Interfaces:**
- Consumes: `respondRefusal(refusal: CodedRefusal): NextResponse` from Task 1.

This task is a pure refactor — each call site's `refusal` binding is unchanged, only how it
reaches the response changes. No new observable behavior, so no new test is written; the
existing integration tests are the regression check.

- [ ] **Step 1: Migrate `transition/route.ts`**

In `src/app/api/classes/[id]/transition/route.ts`, add `respondRefusal` to the import from
`'@/lib/api-utils'` (currently lines 3-11):

```ts
import {
  respondOk,
  respondError,
  respondRefusal,
  respondUnchanged,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

Replace the final line of the `POST` handler (currently line 94):

```ts
  return respondError(refusal.message, refusal.status, refusal.code);
```

with:

```ts
  return respondRefusal(refusal);
```

- [ ] **Step 2: Migrate `cancel/route.ts`**

In `src/app/api/classes/[id]/cancel/route.ts`, add `respondRefusal` to the import from
`'@/lib/api-utils'` (currently lines 3-9):

```ts
import {
  respondTyped,
  respondError,
  respondRefusal,
  respondUnchanged,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

Replace (currently line 166):

```ts
    return respondError(refusal.message, refusal.status, refusal.code);
```

with:

```ts
    return respondRefusal(refusal);
```

- [ ] **Step 3: Migrate `complete/route.ts`**

In `src/app/api/classes/[id]/complete/route.ts`, add `respondRefusal` to the import from
`'@/lib/api-utils'` (currently lines 3-8):

```ts
import {
  respondOk,
  respondError,
  respondRefusal,
  respondUnchanged,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

Replace (currently line 77):

```ts
  return respondError(refusal.message, refusal.status, refusal.code);
```

with:

```ts
  return respondRefusal(refusal);
```

- [ ] **Step 4: Migrate `studio-classes/[id]/route.ts`**

In `src/app/api/studio-classes/[id]/route.ts`, add `respondRefusal` to the import from
`'@/lib/api-utils'` (currently lines 3-9):

```ts
import {
  respondOk,
  respondError,
  respondRefusal,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

Replace the line inside the `if (!verdict.deletable)` block (currently the line right after
the `log.info(...)` call, `return respondError(refusal.message, refusal.status,
refusal.code);`) with:

```ts
    return respondRefusal(refusal);
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm run typecheck`
Expected: PASS — no diagnostics.

- [ ] **Step 6: Run the regression suites for all four routes**

The app must already be live on `:3000` (do not start or restart it — check first; see the
project's `verify` skill if it is not running).

Run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS — every test in `describe('POST /api/classes/[id]/complete', ...)` and
`describe('POST /api/classes/[id]/transition', ...)` (which holds the `/cancel` door's tests
too) passes unchanged, including the `expectRefusal` assertions on status and code.

Run: `pnpm exec vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS — the `STUDIO_CLASS_REGENERATES` refusal cases (409, that code) pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/classes/[id]/transition/route.ts" "src/app/api/classes/[id]/cancel/route.ts" "src/app/api/classes/[id]/complete/route.ts" "src/app/api/studio-classes/[id]/route.ts"
git commit -m "refactor(api): route the four map-indexed refusals through respondRefusal (#649)"
```

---

## Task 3: Correct the docblock and docs that credit the wrong mechanism

**Files:**
- Modify: `src/services/studio-class-deletion.ts:161-166`
- Modify: `docs/technical-architecture.md:145`

**Interfaces:**
- Consumes: Task 2's migration of `studio-classes/[id]/route.ts:382` to `respondRefusal` — this
  task's corrected docblock states that as fact, so it must land after Task 2.

This task edits comments and documentation prose only; no production code changes. There is no
automated test for prose — verification is the grep sweep in Step 3 below plus a typecheck and
lint pass to confirm nothing else broke.

- [ ] **Step 1: Correct `studio-class-deletion.ts`'s docblock**

In `src/services/studio-class-deletion.ts`, the docblock above `STUDIO_CLASS_REFUSALS`
currently ends (lines 161-166) with:

```ts
 * `CodedRefusal`, not `{ message: string; code: ApiErrorCode }`: the latter
 * widens `code` to the whole union, so `respondError`'s `status: StatusOf<C>`
 * infers `C` as every code at once and admits every status — the entry's own
 * status stops being checked. Each entry carries its status and the call site
 * passes `refusal.status`, which is what makes a code sent at the wrong
 * status a compile error here as it is everywhere else (#197).
 */
```

Replace those six lines with:

```ts
 * `CodedRefusal`, not `{ message: string; code: ApiErrorCode }`: the latter
 * widens `code` to the whole union, so `respondError`'s `status: StatusOf<C>`
 * would infer `C` as every code at once and admit every status. What
 * actually pins each entry to its own status is
 * `satisfies Record<StudioClassRefusal, CodedRefusal>` above, checked once at
 * definition; the call site passes the whole entry to `respondRefusal`
 * rather than splitting it into a `status` and a `code` argument, which is
 * what a union-typed `code` would otherwise silently widen (#649).
 */
```

- [ ] **Step 2: Document `respondRefusal` in the Error responses section**

In `docs/technical-architecture.md`, the "Error responses" section currently opens (line 145)
with:

```
A refusal is `respondError(message, status, code)`. The code comes from
```

Replace that line with:

```
A refusal is `respondError(message, status, code)` for a single literal code
known at the call site, or `respondRefusal(refusal)` for one read whole off a
`Record<Reason, CodedRefusal>` map — splitting such a refusal into separate
`status`/`code` arguments does not compile, because a union-typed `code` no
longer pins a single status (#649). The code comes from
```

(The rest of the paragraph, starting with `` `src/lib/api-error-codes.ts`, which fixes one
status per code: ...``, is unchanged.)

- [ ] **Step 3: Sweep for the corrected claim, confirm nothing else needs it**

Run:

```bash
grep -rn "a code sent at the wrong\|call site passes .refusal.status.\|everywhere else (#197)" src docs --include="*.ts" --include="*.tsx" --include="*.md"
```

Expected: no hits in `src/services/studio-class-deletion.ts` (the corrected text no longer
matches). Any hits in `docs/superpowers/specs/2026-09-17-api-error-contract-design.md` or
`docs/superpowers/plans/2026-09-17-api-error-contract.md` are expected and intentionally
unchanged — see the spec's "Swept and intentionally left alone" note (those are closed-issue
`#197` records describing the single-literal-code mechanism accurately for the case they
cover; this fix strengthens that invariant rather than contradicting it).

- [ ] **Step 4: Run typecheck and lint**

Run: `pnpm run typecheck`
Expected: PASS — no diagnostics (comment-only changes).

Run: `pnpm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/studio-class-deletion.ts docs/technical-architecture.md
git commit -m "docs(api): credit satisfies + respondRefusal, not the call site, for the code/status pairing (#649)"
```

---

## Task 4: Mutation-prove the guard against the real call site, then full verify

**Files:**
- Modify (temporarily, reverted within this task):
  `src/app/api/classes/[id]/transition/route.ts:94`

**Interfaces:**
- Consumes: Task 2's migration of this line to `respondRefusal(refusal)`, and Task 1's
  tightened `respondError`.

Task 1's `respondRefusal` describe block already proves the guard against a synthetic fixture.
This task proves it once more against the real `TRANSITION_REFUSAL` map — the same call site
and the same mutation the issue and the spec used to prove the hole existed — so the PR body
can record the guard biting on the actual regression shape, not only a synthetic one.

- [ ] **Step 1: Break it**

In `src/app/api/classes/[id]/transition/route.ts`, temporarily change line 94 from:

```ts
  return respondRefusal(refusal);
```

to:

```ts
  return respondError(refusal.message, 409, refusal.code);
```

- [ ] **Step 2: Run typecheck and record the exact error text**

Run: `pnpm run typecheck`
Expected: FAIL. Record the exact diagnostic text verbatim for the PR body — it will name the
argument type (built from `TRANSITION_REFUSAL`'s reason union) as not assignable to `never`.

- [ ] **Step 3: Restore**

Change line 94 back to:

```ts
  return respondRefusal(refusal);
```

- [ ] **Step 4: Re-verify clean**

Run: `pnpm run typecheck`
Expected: PASS — no diagnostics.

Run: `git status --porcelain -- "src/app/api/classes/[id]/transition/route.ts"`
Expected: empty output (file matches what Task 2 committed; nothing left uncommitted from the
mutation).

- [ ] **Step 5: Full verify**

The app must already be live on `:3000` (do not start or restart it — check first).

Run: `pnpm run verify`
Expected: PASS — typecheck, lint, and the full test suite (unit + component + integration) all
green.

No commit for this task — Steps 1-4 are applied and reverted within the task, leaving the tree
exactly as Task 2 left it; Step 5 is a read-only verification run.

---

## Finishing

The PR body carries: the manual mutation-test results from the spec's Premise section (the
three hand-applied mutations to `transition/route.ts`, `cancel/route.ts`, and
`complete/route.ts` against pre-fix `main`, each confirmed to compile clean and reverted) as
the record that the guard was missing before this plan landed, plus Task 4's exact error text
as the record that it now bites. Name which `integration` files this branch touched
(`tests/integration/classes-api.test.ts`, `tests/integration/studio-api.test.ts`) and cite the
`pnpm run verify` run from Task 4 Step 5 with its pass/fail arithmetic.
