# API Error Classification Implementation Plan (#121)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `withErrorHandler` exactly one log call and one response, so no error can return from the API boundary without a logged method and path.

**Architecture:** Extract a pure `classifyApiError(error) → ApiFailure` into a new `src/lib/api-errors.ts`, then rewrite `withErrorHandler`'s `catch` to classify, log once, and respond once. The wrapper names the request positionally and leaves only the trailing arguments generic, so `request` is typed without a cast. No route handler changes — all 76 call sites already match that signature.

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
| `src/lib/api-errors.ts` *(create)* | Pure classification: thrown value → `{ status, message, logMessage, level, detail? }`. A candidate home for future mappings; nothing is queued to land here (#113 proposes the service-union route instead). |
| `src/lib/api-errors.test.ts` *(create)* | Unit tests for `classifyApiError`, using plain objects and constructed Prisma errors. No HTTP, no mocks. |
| `src/lib/api-utils.ts` *(modify, `:97-116` — the whole function including its docblock)* | `withErrorHandler` becomes single-exit and names its request positionally. Nothing else in the file changes. |
| `src/lib/api-utils.test.ts` *(modify, append)* | New `withErrorHandler` describe block — the file's first coverage of it. Establishes the repo's first `vi.mock('@/lib/log')`. |
| `docs/technical-architecture.md` *(modify, `:28`)* | Its enumeration of what `api-utils.test.ts` covers goes incomplete once the wrapper is tested there. |

---

### Task 1: Pure error classification

**Files:**
- Create: `src/lib/api-errors.ts`
- Test: `src/lib/api-errors.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type ApiLogDetail`, `export type ApiFailure = { readonly status: 409 | 500; readonly message: string; readonly logMessage: string; readonly level: 'warn' | 'error'; readonly detail?: ApiLogDetail }` and `export function classifyApiError(error: unknown): ApiFailure`. Task 2 imports the function and the failure type.

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

  /** P2025 stands in for "some other Prisma error". */
  it('maps a non-P2002 Prisma error to a 500 logged at error', () => {
    const failure = classifyApiError(prismaError('P2025'));

    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
    expect(failure.level).toBe('error');
    expect(failure.detail).toBeUndefined();
  });

  it('maps a plain Error to a 500 logged at error, adding nothing to the log', () => {
    const failure = classifyApiError(new Error('kaboom'));

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
    // pino serializes an Error under `err` with its type and stack; there is
    // nothing left for the classification to say about it.
    expect(failure.detail).toBeUndefined();
  });

  /**
   * `throw 'boom'` is legal JavaScript and reaches this function as-is. The
   * classifier must not assume it was handed an Error — and must still let
   * the operator see what *was* thrown, because pino drops an `err` key whose
   * value is `undefined`, leaving a log line that names no error at all.
   */
  it.each<[string, unknown, string]>([
    ['a string', 'boom', 'string'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
    ['a plain object', { code: 'P2002' }, 'object'],
  ])('maps %s to a 500 that records what was thrown', (_label, thrown, thrownType) => {
    const failure = classifyApiError(thrown);

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
    expect(failure.detail).toEqual({ thrownType });
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
 * Extra log fields a classification contributes, spread flat into the log
 * line.
 *
 * The `never` keys are the ones a classification must not be able to write.
 * `err`/`method`/`path` are the request context the API wrapper guarantees on
 * every error. `level`/`time`/`msg` are pino's own, and pino writes those
 * *before* the merge object, so a `detail` carrying one emits a duplicate JSON
 * key that `JSON.parse` resolves to the last:
 *
 *   {"level":50,"time":...,"level":"debug","time":0,...}
 *
 * That parses as `level === "debug"`, a string no numeric level filter
 * matches — the line silently disappears from every filtered view. Making it
 * a compile error costs one type and cannot be forgotten.
 */
export type ApiLogDetail = Record<string, unknown> & {
  err?: never;
  method?: never;
  path?: never;
  level?: never;
  time?: never;
  msg?: never;
};

/**
 * The outcome of classifying a thrown value at the API boundary: what the
 * client is told (`message`, `status`) and what the operator is told
 * (`logMessage`, `level`, `detail`). Deliberately two different strings —
 * "Resource already exists" is a reasonable thing to return and a useless
 * thing to find in a log.
 *
 * No case controls its own return; a case says what should happen, never when
 * to stop. That is the point of the module. Before it, the P2002 branch
 * returned *above* the log line, so an escaped unique-constraint violation
 * reached a teacher as "Resource already exists" with no server-side trace at
 * all (#121) — and a second early return could have done it again.
 *
 * `status` is a union rather than `number` because it reaches the `Response`
 * constructor, which throws `RangeError: init["status"] must be in the range
 * of 200 to 599` outside that band. A typo'd `status: 5000` would throw from
 * inside the API wrapper's `catch`, leaking the stack trace that wrapper
 * exists to contain. Widening the union is a deliberate one-line edit at the
 * moment a case needs it.
 */
export type ApiFailure = {
  readonly status: 409 | 500;
  readonly message: string;
  readonly logMessage: string;
  readonly level: 'warn' | 'error';
  readonly detail?: ApiLogDetail;
};

/**
 * Classify anything thrown out of a route handler. Total: every input,
 * including non-Error throwables, yields an ApiFailure.
 *
 * This is the obvious home for further mappings — a lock-race loser to 503,
 * say — but nothing is queued to land here. #113, which wants that mapping,
 * currently proposes the other route: a `busy` variant on the archive
 * services' result unions, so that the routes' exhaustive narrowing turns an
 * unhandled variant into a compile error. A catch-all classifier cannot offer
 * that, so the two are alternatives, not a plan.
 */
export function classifyApiError(error: unknown): ApiFailure {
  // Reaching this branch means a route's own check-then-create lost its race
  // — at least four routes have that window today — or a route never
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
    // Pino passes a non-Error `err` through unserialized and drops the key
    // outright when the value is `undefined`, so `throw undefined` in a
    // wrapped handler would otherwise log a line that names no error at all.
    // `typeof` is total and cannot throw; `String(error)` can — an object may
    // have no `toString` (`Object.create(null)`) or a throwing one — and this
    // runs inside the very `catch` it must not throw from.
    ...(error instanceof Error ? {} : { detail: { thrownType: typeof error } }),
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

Run: `npx tsc --noEmit --incremental false && npx eslint src/lib/api-errors.ts src/lib/api-errors.test.ts`

Expected: both clean, no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api-errors.ts src/lib/api-errors.test.ts
git commit -m "feat: classify API errors into status, message, and log level (#121)"
```

---

### Task 2: One exit from `withErrorHandler`

**Files:**
- Modify: `src/lib/api-utils.ts:97-116` (the whole function, docblock included)
- Modify: `src/lib/api-utils.test.ts` (append a describe block; add three imports and two `vi.mock` calls)
- Modify: `docs/technical-architecture.md:28`

**Interfaces:**
- Consumes: `classifyApiError` from Task 1 (`./api-errors`).
- Produces: `withErrorHandler<Rest extends unknown[]>(handler: (request: NextRequest, ...rest: Rest) => Promise<NextResponse>) => (request: NextRequest, ...rest: Rest) => Promise<NextResponse>`. Signature is source-compatible with all 76 existing call sites; no route file changes.

- [ ] **Step 1: Write the failing tests**

In `src/lib/api-utils.test.ts`, add to the mock block near the top of the file (alongside the existing `vi.mock('./auth')` and `vi.mock('./db')`):

```ts
// First log mock in the repo. api-utils.ts imports '@/lib/log'; the alias
// resolves to ./src via vitest.config.ts, so the specifier must match.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Real classification for every test except the one that overrides it with
// `mockReturnValueOnce` — the default implementation delegates to the actual
// `classifyApiError`, so this mock is transparent to every other
// `withErrorHandler` test in the file, which depend on real classification.
// The describe's `beforeEach` resets it back to that implementation, so the
// transparency does not depend on every override being consumed.
vi.mock('./api-errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-errors')>();
  return {
    ...actual,
    classifyApiError: vi.fn(actual.classifyApiError),
  };
});
```

Add `withErrorHandler` to the existing named import from `./api-utils`, and add these three imports:

```ts
import { Prisma } from '@prisma/client';
import { classifyApiError } from './api-errors';
import { log } from '@/lib/log';
```

Then append this describe block at the end of the file:

```ts
/**
 * The merge object of the first log call. Needed because `objectContaining`
 * compares an Error structurally: it cannot tell the thrown error from a
 * same-message replica, and the whole value of `err` is the real stack.
 */
function firstLoggedMerge(fn: typeof log.error): Record<string, unknown> {
  const call = vi.mocked(fn).mock.calls[0];
  return (call?.[0] ?? {}) as unknown as Record<string, unknown>;
}

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
    // Also reset classifyApiError, which `mockReset` returns to the
    // delegating implementation it was constructed with. Clearing only the
    // log mocks would leave a `mockReturnValueOnce` that its own test failed
    // to consume queued for the next test, silently falsifying the claim at
    // the mock factory that this mock is transparent to every other test.
    vi.mocked(classifyApiError).mockReset();
  });

  it('logs the failing request method and path, then returns 500', async () => {
    const thrown = new Error('kaboom');
    const handler = withErrorHandler(async () => {
      throw thrown;
    });

    const res = await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
    // Identity, not `expect.any(Error)`: substituting a fresh Error loses the
    // operator's only stack trace and would satisfy a class-level assertion.
    expect(firstLoggedMerge(log.error)['err']).toBe(thrown);
  });

  /**
   * The bug this file's coverage was added for: the P2002 branch used to
   * return *above* the log line, so this 409 reached a teacher with no
   * server-side trace whatsoever.
   */
  it('logs an escaped P2002 at warn with its constraint, and still returns 409', async () => {
    const thrown = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['teacherId', 'roomId'] },
    });
    const handler = withErrorHandler(async () => {
      throw thrown;
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
    expect(firstLoggedMerge(log.warn)['err']).toBe(thrown);
    expect(log.error).not.toHaveBeenCalled();
  });

  /**
   * Pins the spread order in the log call: `...failure.detail` must come
   * FIRST so the literal `err`/`method`/`path` keys win. Move the spread
   * below them and a classification's `detail` displaces the request context
   * this branch exists to guarantee — `err` included, which is why all three
   * are clobbered here rather than the two a partial reorder would leave.
   *
   * `ApiLogDetail` now rejects such a `detail` outright, hence the directive.
   * The two guards invert each other: relax the type and the directive goes
   * unused and `tsc` fails; move the spread and this assertion fails.
   */
  it('keeps the real request context even when classifyApiError returns a clobbering detail', async () => {
    const thrown = new Error('kaboom');
    vi.mocked(classifyApiError).mockReturnValueOnce({
      status: 500,
      message: 'Internal server error',
      logMessage: 'unhandled API error',
      level: 'error',
      // @ts-expect-error — ApiLogDetail forbids exactly these keys.
      detail: { err: 'CLOBBERED', method: 'CLOBBERED', path: 'CLOBBERED' },
    });

    const handler = withErrorHandler(async () => {
      throw thrown;
    });

    await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
    expect(firstLoggedMerge(log.error)['err']).toBe(thrown);
  });

  /**
   * `throw 'boom'` is legal JavaScript and reaches the wrapper as-is. Pino
   * logs a non-Error `err` verbatim but drops the key entirely when the value
   * is `undefined`, so the classification carries `thrownType` to keep the
   * line naming something whatever was thrown.
   */
  it('still names what was thrown when it is not an Error', async () => {
    const handler = withErrorHandler(async () => {
      throw 'boom';
    });

    const res = await handler(makeRequest('http://localhost/api/students', { method: 'GET' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'boom',
        thrownType: 'string',
        method: 'GET',
        path: '/api/students',
      }),
      'unhandled API error',
    );
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
   * The wrapper exists to stop stack traces leaking. If reading the request
   * could throw, a TypeError raised *inside* the catch would escape the
   * wrapper — strictly worse than the bug being fixed. TypeScript forbids
   * this call, so the cast simulates a JavaScript caller, which the types
   * cannot see. That caller is the only thing the optional chaining guards.
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

  // @ts-expect-error — the first parameter must be the NextRequest. A
  // params-first handler is rejected by the signature; make the whole
  // parameter list generic again and this line stops erroring, turning the
  // unused directive into a compile error itself. That inversion is the guard.
  withErrorHandler(paramsFirstHandler);
});
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `npx vitest run --project unit src/lib/api-utils.test.ts`

Expected: FAIL. The tests that assert `method` and `path` fail on the *assertion* — `log.error` was called with `{ err }` only, so the `objectContaining({ method, path })` match fails. That is the meaningful red: it proves the assertions detect the missing context rather than merely detecting a missing module.

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
 * The request is named positionally and only the trailing arguments are
 * generic. So `request` types as a NextRequest without a cast, and nothing a
 * handler declares can widen it: a params-first handler is rejected, and the
 * produced wrapper demands a NextRequest first even when the handler names no
 * parameters or types it as a plain `Request`. The optional chaining is
 * therefore not defending against TypeScript — it is defending against an
 * untyped JavaScript caller, which the types cannot see. A TypeError thrown
 * inside this catch would leak the very stack trace the wrapper exists to
 * contain.
 *
 * `path` is `nextUrl.pathname` only, never `search`/`href` — the privacy
 * guard against query strings (tokens, search terms) reaching the log.
 */
export function withErrorHandler<Rest extends unknown[]>(
  handler: (request: NextRequest, ...rest: Rest) => Promise<NextResponse>,
): (request: NextRequest, ...rest: Rest) => Promise<NextResponse> {
  return async (request: NextRequest, ...rest: Rest): Promise<NextResponse> => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      const failure = classifyApiError(error);
      log[failure.level](
        {
          // `...failure.detail` spreads FIRST so the literal keys below always
          // win: a classification's `detail` must never be able to displace
          // the request context this wrapper guarantees on every error.
          ...failure.detail,
          err: error,
          method: request?.method,
          path: request?.nextUrl?.pathname,
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

Expected: PASS — the file's pre-existing tests plus 7 new ones.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit --incremental false && npx eslint src/lib/api-utils.ts src/lib/api-utils.test.ts`

Expected: both clean. A clean `tsc` here is also the proof that all 76 call sites still compile against the new signature, and that the `@ts-expect-error` directive is now *used* (the signature rejects that handler).

**`--incremental false` is load-bearing, not decoration.** `tsconfig.json` includes `.next/types/**/*.ts` and `.next/dev/types/**/*.ts`, so a Next dev server running on :3000 rewrites the compiler's own file set while it works. That produces errors on a tree `git diff` reports as unmodified — including `Unused '@ts-expect-error' directive`, which is byte-identical in shape to the guard firing. Any break-and-restore proof run without it is not evidence. Do **not** stop the dev server to work around this; the user owns that process.

- [ ] **Step 6: Prove the signature bites**

Temporarily make the whole parameter list generic again (`<Args extends unknown[]>(handler: (...args: Args) => …)`) and run `npx tsc --noEmit --incremental false`.

Expected: compilation fails, and the `@ts-expect-error` line reports `Unused '@ts-expect-error' directive` — that inversion is the guard. Record the **actual** output rather than matching it against a prediction.

Two corrections to what this step used to claim. First, the original prediction of "two failures" was wrong: loosening the generic also produces property-access errors reading `Property 'method' does not exist on type '{}'` and several `TS2554` arity errors in the test file. Second, and more important, the output recorded here the first time proved nothing — it was collected without `--incremental false` against a running dev server, and that fingerprint is indistinguishable from the guard firing. The guard is genuinely sound; it was re-confirmed on a quiet compiler. The lesson is the methodology, and it is now in Step 5.

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

- [ ] **Step 11: Prove the spread order bites**

Two mutants, both of which a whole-object reorder test would miss. Move `err: error` *above* the spread, leaving `method` and `path` below it — a partial reorder — and re-run. Expected: the clobber test fails with `expected 'CLOBBERED' to be Error: kaboom // Object.is equality`. Then restore, replace `err: error` with `err: new Error('substituted')`, and re-run. Expected: three tests fail on the identity assertions, e.g. `expected Error: substituted to be Error: kaboom`. Restore and re-run green.

Both are the reason the clobber test names all three keys and the assertions use identity rather than `expect.any(Error)`: `expect.objectContaining` compares Errors structurally, so a class-level assertion cannot tell the thrown error from a replacement.

---

## Verification before the PR

- [ ] `npx tsc --noEmit --incremental false` clean
- [ ] `npx eslint` clean on all four changed source/test files
- [ ] `npx vitest run --project unit` green
- [ ] `src/lib/api-errors.ts` is still pure: `grep -nE "next/server|@/lib/log|'\./log'" src/lib/api-errors.ts` returns nothing. Its only import is `@prisma/client`.
- [ ] `git diff main --stat` shows **seven** files: the spec and the plan under `docs/superpowers/`, two created (`src/lib/api-errors.ts`, `src/lib/api-errors.test.ts`), and three modified (`src/lib/api-utils.ts`, `src/lib/api-utils.test.ts`, `docs/technical-architecture.md`). **Zero** files under `src/app/api/` — if any route file appears, the new signature was not source-compatible after all and that is a finding, not something to patch around.
- [ ] Every guard in Step 5 (Task 1) and Steps 6, 7 and 11 (Task 2) has a recorded failure text, collected with `--incremental false`
