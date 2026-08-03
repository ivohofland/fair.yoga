# API Error Classification Implementation Plan (#121)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `withErrorHandler` exactly one log call and one response, so no error can return from the API boundary without a logged method and path.

**Architecture:** Extract a pure `classifyApiError(error) → ApiFailure` into a new `src/lib/api-errors.ts`, then rewrite `withErrorHandler`'s `catch` to classify, log once, and respond once. The wrapper's generic is constrained to `[NextRequest, ...unknown[]]` so `args[0]` is typed without a cast. No route handler changes — all 76 call sites already satisfy the constraint.

**Tech Stack:** TypeScript (strict), Next.js App Router route handlers, Prisma 6, pino, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-api-error-classification-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `noUncheckedIndexedAccess` is on — indexing an array yields `T | undefined`.
- **Test-first.** Write the failing test, watch it fail *for the right reason*, then implement.
- **`src/lib/api-errors.ts` must stay pure:** no `next/server` import, no `@/lib/log` import. Its only dependency is `@prisma/client`.
- **Response contract does not move.** Same statuses, same messages, no new error `code`. This is an observability change.
- **Log `nextUrl.pathname` only** — never `search`, never `href`, never the whole request.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Test command for this plan:** `npx vitest run --project unit <path>`. Never run `--project integration` without a file path (one file there is IP rate-limited).
- **Do not start or restart the dev server on :3000.**

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/api-errors.ts` *(create)* | Pure classification: thrown value → `{ status, message, logMessage, level, detail? }`. The home for #113's future `P2028`/`55P03` cases. |
| `src/lib/api-errors.test.ts` *(create)* | Unit tests for `classifyApiError`, using plain objects and constructed Prisma errors. No HTTP, no mocks. |
| `src/lib/api-utils.ts` *(modify, `:101-116`)* | `withErrorHandler` becomes single-exit and gains the constrained generic. Nothing else in the file changes. |
| `src/lib/api-utils.test.ts` *(modify, append)* | New `withErrorHandler` describe block — the file's first coverage of it. Establishes the repo's first `vi.mock('@/lib/log')`. |
| `docs/technical-architecture.md` *(modify, `:28`)* | Its enumeration of what `api-utils.test.ts` covers goes incomplete once the wrapper is tested there. |

---

### Task 1: Pure error classification

**Files:**
- Create: `src/lib/api-errors.ts`
- Test: `src/lib/api-errors.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type ApiFailure = { status: number; message: string; logMessage: string; level: 'warn' | 'error'; detail?: Record<string, unknown> }` and `export function classifyApiError(error: unknown): ApiFailure`. Task 2 imports both.

- [ ] **Step 1: Write the failing test**

Create `src/lib/api-errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { classifyApiError } from './api-errors';

/**
 * Matches the construction used in src/services/studio-class-generator.test.ts
 * — Prisma 6 takes the code and clientVersion in an options object.
 */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('classifyApiError', () => {
  it('maps P2002 to a 409 logged at warn, naming the constraint that fired', () => {
    const failure = classifyApiError(prismaError('P2002', { target: ['teacherId', 'roomId'] }));

    expect(failure.status).toBe(409);
    expect(failure.message).toBe('Resource already exists');
    expect(failure.level).toBe('warn');
    expect(failure.detail).toEqual({ target: ['teacherId', 'roomId'] });
  });

  /**
   * The whole point of splitting the two: "Resource already exists" is a
   * reasonable thing to return to a client and a useless thing to find in a
   * log. Collapsing them back into one field is the regression this pins.
   */
  it('does not reuse the client-facing message as the log message', () => {
    const failure = classifyApiError(prismaError('P2002'));

    expect(failure.logMessage).not.toBe(failure.message);
    expect(failure.logMessage.length).toBeGreaterThan(0);
  });

  /**
   * P2025 stands in for "some other Prisma error". #113 will add P2028 and
   * 55P03 as their own cases here; until it does, they land in this default.
   */
  it('maps a non-P2002 Prisma error to a 500 logged at error', () => {
    const failure = classifyApiError(prismaError('P2025'));

    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
    expect(failure.level).toBe('error');
    expect(failure.detail).toBeUndefined();
  });

  it('maps a plain Error to a 500 logged at error', () => {
    const failure = classifyApiError(new Error('kaboom'));

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
  });

  /**
   * `throw 'boom'` is legal JavaScript and reaches this function as-is. The
   * classifier must not assume it was handed an Error.
   */
  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a plain object', { code: 'P2002' }],
  ])('maps %s to a 500 rather than throwing', (_label, thrown) => {
    const failure = classifyApiError(thrown);

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/api-errors.test.ts`

Expected: FAIL — the module does not exist yet, so the failure is a resolution error naming `./api-errors`. This red proves only that the test file runs; Step 4's red is the one that proves the assertions bite.

- [ ] **Step 3: Write the implementation**

Create `src/lib/api-errors.ts`:

```ts
import { Prisma } from '@prisma/client';

/**
 * The outcome of classifying a thrown value at the API boundary: what the
 * client is told (`message`, `status`) and what the operator is told
 * (`logMessage`, `level`, `detail`). Deliberately two different strings —
 * "Resource already exists" is a reasonable thing to return and a useless
 * thing to find in a log.
 *
 * `withErrorHandler` (src/lib/api-utils.ts) is the only consumer, and it has
 * exactly one log call and one response. That is the point of this module:
 * before it, the P2002 branch returned *above* the log line, so an escaped
 * unique-constraint violation reached a teacher as "Resource already exists"
 * with no server-side trace at all (#121). A new case added here cannot
 * reintroduce that, because no case controls its own return.
 */
export type ApiFailure = {
  status: number;
  message: string;
  logMessage: string;
  level: 'warn' | 'error';
  detail?: Record<string, unknown>;
};

/**
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * #113 will add P2028 and 55P03 -> 503 here. Until then they fall to the 500.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // Reaching this branch means a route's own check-then-create lost its race
  // (teacher-rooms and students POST both have that window), or a route never
  // pre-checked at all. Both are worth knowing about; neither is an outage,
  // which is why this is `warn` and not `error`. `meta.target` names the
  // constraint — without it the log says something already existed but not
  // what, which is the same gap one level in.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    return {
      status: 409,
      message: 'Resource already exists',
      logMessage: 'unique constraint escaped a route to the 409 fallback',
      level: 'warn',
      detail: { target: error.meta?.target },
    };
  }

  return {
    status: 500,
    message: 'Internal server error',
    logMessage: 'unhandled API error',
    level: 'error',
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit src/lib/api-errors.test.ts`

Expected: PASS, 8 tests (4 named + 4 from the `it.each` table).

- [ ] **Step 5: Prove the P2002 guard bites**

Temporarily change `error.code === 'P2002'` to `error.code === 'P9999'` in `src/lib/api-errors.ts`, re-run the command from Step 4, and confirm **the first test** ("maps P2002 to a 409 logged at warn…") fails. Record the failure text in the commit body. Restore the line and re-run to confirm green again.

Expect exactly one failing test, and within it only the `status` assertion in the output: `expect` throws on its first failure, so that test's `level` and `detail` assertions never execute. The other tests legitimately stay green — the `logMessage`/`message` test passes under a broken guard because the 500 branch also has two distinct strings, and the remaining cases never touched the P2002 branch. One deterministic red→green flip is the proof required here; more failures would not add to it.

This matters because a classifier that returns the 500 for everything would pass a test suite that only ever checked the 500 path.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/api-errors.ts src/lib/api-errors.test.ts`

Expected: both clean, no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api-errors.ts src/lib/api-errors.test.ts
git commit -m "feat: classify API errors into status, message, and log level (#121)"
```

---

### Task 2: One exit from `withErrorHandler`

**Files:**
- Modify: `src/lib/api-utils.ts:101-116`
- Modify: `src/lib/api-utils.test.ts` (append a describe block; add two imports and one `vi.mock`)
- Modify: `docs/technical-architecture.md:28`

**Interfaces:**
- Consumes: `classifyApiError` and `ApiFailure` from Task 1 (`./api-errors`).
- Produces: `withErrorHandler<Args extends [NextRequest, ...unknown[]]>(handler) => (...args: Args) => Promise<NextResponse>`. Signature is source-compatible with all 76 existing call sites; no route file changes.

- [ ] **Step 1: Write the failing tests**

In `src/lib/api-utils.test.ts`, add to the mock block near the top of the file (alongside the existing `vi.mock('./auth')` and `vi.mock('./db')`):

```ts
// First log mock in the repo. api-utils.ts imports '@/lib/log'; the alias
// resolves to ./src via vitest.config.ts, so the specifier must match.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
```

Add `withErrorHandler` to the existing named import from `./api-utils`, and add these two imports:

```ts
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
```

Then append this describe block at the end of the file:

```ts
describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  it('logs the failing request method and path, then returns 500', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    });

    const res = await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
  });

  /**
   * The bug this file's coverage was added for: the P2002 branch used to
   * return *above* the log line, so this 409 reached a teacher with no
   * server-side trace whatsoever.
   */
  it('logs an escaped P2002 at warn with its constraint, and still returns 409', async () => {
    const handler = withErrorHandler(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['teacherId', 'roomId'] },
      });
    });

    const res = await handler(
      makeRequest('http://localhost/api/teacher-rooms', { method: 'POST' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { message: 'Resource already exists' } });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/teacher-rooms',
        target: ['teacherId', 'roomId'],
      }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  /**
   * Nine routes under src/app/api read searchParams. Logging nextUrl.href or
   * .search instead of .pathname would put every one of their query values in
   * the log; this pins the narrow choice so a future edit cannot widen it
   * quietly.
   */
  it('logs the path without the query string', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    });

    await handler(
      makeRequest('http://localhost/api/students?search=alice&token=sensitive', {
        method: 'GET',
      }),
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/students' }),
      'unhandled API error',
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('sensitive');
  });

  /**
   * The wrapper exists to stop stack traces leaking. If reading args[0] could
   * throw, a TypeError raised *inside* the catch would escape the wrapper —
   * strictly worse than the bug being fixed. TypeScript forbids this call, so
   * the cast simulates a JavaScript caller, which the types cannot see.
   */
  it('still returns 500 when invoked with no request at all', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    }) as unknown as () => Promise<NextResponse>;

    const res = await handler();

    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: undefined, path: undefined }),
      'unhandled API error',
    );
  });

  it('does not log when the handler returns normally', async () => {
    const handler = withErrorHandler(async () => respondOk({ fine: true }));

    const res = await handler(makeRequest('http://localhost/api/classes'));

    expect(res.status).toBe(200);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  /**
   * Bound to a const first, so the whole call fits on one line: TypeScript
   * reports the assignability error at the *argument's* position, and a
   * @ts-expect-error only suppresses errors on the line directly after it. An
   * inline multi-line arrow would put the error on a different line than the
   * directive, and the directive would read as unused.
   */
  const paramsFirstHandler = async (
    _ctx: { params: Promise<{ id: string }> },
    _req: Request,
  ): Promise<NextResponse> => respondOk({});

  // @ts-expect-error — args[0] must be the NextRequest. A params-first handler
  // is rejected by the constraint; if the generic is ever loosened back to
  // `unknown[]`, this line stops erroring and the unused directive becomes a
  // compile error itself. That inversion is the guard.
  withErrorHandler(paramsFirstHandler);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx vitest run --project unit src/lib/api-utils.test.ts`

Expected: FAIL. The first, second and third tests fail on the *assertion* — `log.error` was called with `{ err }` only, so the `objectContaining({ method, path })` match fails. That is the meaningful red: it proves the assertions detect the missing context rather than merely detecting a missing module.

The `@ts-expect-error` line will also currently be reported by `tsc` as an unused directive, because today's unconstrained generic accepts that handler. Leave it; Step 3 makes it bite.

- [ ] **Step 3: Rewrite `withErrorHandler`**

In `src/lib/api-utils.ts`, replace the whole `withErrorHandler` function (`:97-116`, including its docblock) with:

```ts
/**
 * Wraps an API route handler in a try-catch to prevent unhandled exceptions
 * from leaking stack traces to the client.
 *
 * Exactly one log call and one response, both unconditional. Error-specific
 * behaviour lives in `classifyApiError` (src/lib/api-errors.ts), so adding a
 * case cannot skip the logger the way the old P2002 early return did (#121).
 *
 * `Args` is constrained rather than narrowed at runtime: every one of the 76
 * wrapped handlers takes the NextRequest first, so `args[0]` types without a
 * cast. The constraint rejects a params-first handler, but TypeScript still
 * accepts a zero-parameter one, and nothing stops a JavaScript caller — hence
 * the optional chaining. A TypeError thrown inside this catch would leak the
 * very stack trace the wrapper exists to contain.
 */
export function withErrorHandler<Args extends [NextRequest, ...unknown[]]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      const failure = classifyApiError(error);
      log[failure.level](
        {
          err: error,
          method: args[0]?.method,
          path: args[0]?.nextUrl?.pathname,
          ...failure.detail,
        },
        failure.logMessage,
      );
      return respondError(failure.message, failure.status);
    }
  };
}
```

Add the import at the top of the file, after the existing `./db` import:

```ts
import { classifyApiError } from './api-errors';
```

Remove the now-unused `Prisma` import from `src/lib/api-utils.ts` — `classifyApiError` owns that check now. Confirm first with `grep -n "Prisma" src/lib/api-utils.ts`: the only remaining match should be the `import { Prisma } from '@prisma/client';` line itself. If any other line matches, stop and report rather than deleting the import.

**Known friction point:** if `vi.mocked(log.error)` fights TypeScript over pino's overloaded `LogFn` type, do not reach for `any`. Assert against the mock through `expect` only (`expect(log.error).toHaveBeenCalledWith(...)`, which needs no cast) and clear with `vi.mocked(log.error).mockClear()`; if that specific call still errors, `vi.clearAllMocks()` inside this describe's `beforeEach` is an acceptable substitute, since the auth mocks it would also clear are set per-test by the describes that use them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/api-utils.test.ts`

Expected: PASS — the file's pre-existing tests plus 5 new ones.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/api-utils.ts src/lib/api-utils.test.ts`

Expected: both clean. A clean `tsc` here is also the proof that all 76 call sites still compile against the constrained generic, and that the `@ts-expect-error` directive is now *used* (the constraint rejects that handler).

- [ ] **Step 6: Prove the type constraint bites**

Temporarily change the generic back to `<Args extends unknown[]>` and run `npx tsc --noEmit`.

Expected: compilation fails, and the `@ts-expect-error` line reports `Unused '@ts-expect-error' directive` — that inversion is the guard. Record the **actual** output in the commit body rather than matching it against a prediction.

Measured when this step was run: more errors than the two originally predicted here. `args[0]` resolves to `{}`, not `unknown`, so the property-access errors read differently than expected, and four further `TS2554` arity errors surface in the test file. The guard bites either way; the original prediction of "two failures" was wrong, and the verbatim text lives in `task-2-report.md`.

- [ ] **Step 7: Prove the single-exit shape bites**

Temporarily reinstate an early return above the log call:

```ts
if (failure.status === 409) return respondError(failure.message, failure.status);
```

Re-run `npx vitest run --project unit src/lib/api-utils.test.ts`. Expected: the P2002 test fails on `expect(log.warn).toHaveBeenCalledWith(...)` — receiving zero calls. Record the text, remove the line, re-run green.

This is the regression the whole issue is about, so it must be demonstrably caught.

- [ ] **Step 8: Update the architecture doc**

In `docs/technical-architecture.md:28`, the parenthetical enumerating that file's coverage goes incomplete. Replace:

```
that coverage lives in `src/lib/api-utils.test.ts` (401 paths for `requireSession`, 403 + happy paths for `requireTeacher`/`requireStudent`)
```

with:

```
that coverage lives in `src/lib/api-utils.test.ts` (401 paths for `requireSession`, 403 + happy paths for `requireTeacher`/`requireStudent`, and `withErrorHandler`'s logging and status classification)
```

- [ ] **Step 9: Run the full unit suite**

Run: `npx vitest run --project unit`

Expected: green. This catches anything else in the repo that asserted on the old logging shape. Do **not** run `--project integration` without a file path.

- [ ] **Step 10: Commit**

```bash
git add src/lib/api-utils.ts src/lib/api-utils.test.ts docs/technical-architecture.md
git commit -m "fix: log method and path on every API error, including the 409 (#121)"
```

---

## Verification before the PR

- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint` clean on all four changed source/test files
- [ ] `npx vitest run --project unit` green
- [ ] `src/lib/api-errors.ts` is still pure: `grep -nE "next/server|@/lib/log|'\./log'" src/lib/api-errors.ts` returns nothing. Its only import is `@prisma/client`.
- [ ] `git diff main --stat` shows **seven** files: the spec and the plan under `docs/superpowers/`, two created (`src/lib/api-errors.ts`, `src/lib/api-errors.test.ts`), and three modified (`src/lib/api-utils.ts`, `src/lib/api-utils.test.ts`, `docs/technical-architecture.md`). **Zero** files under `src/app/api/` — if any route file appears, the constrained generic was not source-compatible after all and that is a finding, not something to patch around.
- [ ] Every guard in Steps 5 (Task 1) and 6–7 (Task 2) has a recorded failure text
