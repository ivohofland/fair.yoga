# One exit from `withErrorHandler`: classify, log, respond (#121)

**Issue:** #121 — `withErrorHandler` logs unhandled errors with no request context, and 409s with none at all
**Date:** 2026-08-03
**Related:** #113 (maps lock-race losers to 503 in the same handler — owns *status*, this owns *logging shape*)

## What the issue reported, and what measurement found

### The three source claims hold

All three are true as filed, at `src/lib/api-utils.ts`:

1. `log.error({ err: error }, 'unhandled API error')` (`:112`) carries no route, no method, no id.
2. The `P2002` branch (`:109-111`) returns *above* that log line, so it logs nothing.
3. `respondError` (`:13-19`) does not log either — so an escaped `P2002` becomes
   `"Resource already exists"` with zero server-side trace.

The contrast the issue draws is also real: `src/services/class-generator.ts:275` and
`src/services/studio-class-generator.ts:266` both log
`{ err, templateId, teacherId }` for the same class of failure.

### The `args[0]` claim holds — measured, not sampled

The issue asserts "handlers all receive `NextRequest` as `args[0]`". A parse of every
`withErrorHandler(` call site (not a grep with a `head` limit) confirms it:

- **76 wrapped handlers across 50 route files.** 38 take `(request: NextRequest)`;
  38 take `(request: NextRequest, { params }: { params: Promise<{ id: string }> })`.
- Arithmetic: 52 `route.ts` files under `src/app/api` − 2 that do not use the wrapper
  (`health/route.ts`, `notifications/stream/route.ts`, each with its own `try`/`catch`)
  = 50 files. By method: 31 POST + 24 GET + 10 PUT + 7 DELETE + 4 PATCH = 76.
- No other call sites exist. The three other repo mentions of `withErrorHandler`
  (`src/services/class-lifecycle.ts:423`, `tests/integration/classes-api.test.ts:357`,
  `tests/integration/rooms-api.test.ts:393`) are all prose in comments.

### Where the issue is pessimistic

It lists "no route, no method, **no id**" as three gaps. `nextUrl.pathname` is the
*concrete* path — `/api/classes/clx…/transition` — so the id arrives free for all 38
`[id]` handlers. Threading `params` through (it is a `Promise` in Next 15, so this would
mean awaiting inside a `catch`) is unnecessary.

### ...but the issue's headline scenario is only partly delivered

Issue #121's own example is an operator "paging on a `P2028` transaction timeout" who "now
cannot tell a studio resume from an archive from an account deletion." This design does
not fully close that gap, and the rest of the spec reads as though it does. It does not.

Method + path get one of the three: account deletion is `DELETE /api/account`,
distinguishable on sight from everything else. The other two do not separate. Studio
archive and studio resume are both `PATCH /api/studio-class-templates/[id]` — the same
method, the same path, the same id — and the only discriminator between them is
`?state=archived` vs `?state=active`, read from `nextUrl.searchParams`. That is exactly
what this spec's own `pathname`-only rule excludes from the log. The same shape recurs on
`class-templates/[id]`. So today, an operator staring at a `P2028` logged from either PATCH
sees identical `method`/`path` for a resume and an archive; #121's headline scenario is
one-third solved, not solved.

This is not a reason to widen the rule. `GET /api/students?search=<name>` would put a
student's name in the log the moment the rule stretched from `pathname` to `search` — the
`pathname`-only line is still right, and stays as designed above. What closes the
remainder is out of scope here: #113, which gives the lock-race loser its own 503 and its
own copy, is what actually lets an operator tell resume from archive apart.

### Two things the issue does not mention

**`withErrorHandler` has no tests.** `src/lib/api-utils.test.ts` (290 lines) covers
`respondOk`, `respondError`, `parseBody`, `isErrorResponse`, `requireSession`,
`requireTeacher`, `requireStudent` — every export in the file *except* `withErrorHandler`
and `pick`. No test anywhere asserts the 409: the string `Resource already exists` appears
once in source and once in a comment, never in an assertion.

**The `P2002` branch is reachable today, via check-then-create races — and this section's
first count was wrong.** The issue says the branch is "not reachable from #118's path
today", which is true but narrower than the facts. An earlier draft of this spec called it
"two routes." That was an undercount: re-checking every check-then-create sequence against
a unique constraint in the API routes turns up **at least four routes, five windows** —
stated as a floor, not a fresh exhaustive census; no exhaustive sweep of every route was
redone to produce this correction.

| Route | Constraint | Its own conflict response |
|---|---|---|
| `src/app/api/teacher-rooms/route.ts:55-69` | `TeacherRoom @@unique([teacherId, roomId])` | 409 `DUPLICATE` |
| `src/app/api/students/route.ts:112-124` | `TeacherStudent @@unique([teacherId, studentId])` | 409 `ALREADY_LINKED` |
| `src/app/api/students/route.ts:126-134` | `Student.email @unique` — the *other* branch, `tx.student.create` | none |
| `src/app/api/teachers/route.ts:31-50` | `Account.email @unique`, `Teacher.pageSlug @unique` | 409 `EMAIL_TAKEN` / `SLUG_TAKEN` |
| `src/app/api/auth/student-signup/route.ts:34-50` | `Account.email @unique`, `Student.email @unique` | none — returns 200 on the no-op path |

Lose one of these TOCTOU races — a double-tapped "Add room" is the easy example, but the
same shape recurs across all five — and the loser falls through to the wrapper's generic
409 instead of the route's own coded one, leaving no trace beyond this branch's log. Rare,
but that is exactly the case where a log is the only way anyone learns it fires.

The two **signup/creation** paths — `teachers/route.ts` and `auth/student-signup/route.ts`
— are the worse instance of the five. Both windows guard `Account.email`, the identity the
account is keyed on, and neither has a `P2002` catch of its own. Lose that race and a
stranger who signed up with an email already in use is told "Resource already exists"
rather than "Email already in use" — the generic message, landing on exactly the path
where the specific one is load-bearing for someone trying to recover access to their own
account.

## Root cause, and why the fix is shaped this way

The filed symptom is missing context. The shape underneath is that **`withErrorHandler` has
two exits and only one of them logs.** The `P2002` branch is silent by *position*, not by
decision. #113 wants to add `P2028`/`55P03` to this same function; under today's shape that
is a third `if`-with-its-own-`return`, i.e. a third chance to reintroduce this bug.

So the fix is not "add two lines" but "make it structurally impossible to return without
logging".

## Design

### `src/lib/api-errors.ts` (new)

Pure classification. No `next/server` import, no pino import — testable with plain objects.

```ts
export type ApiFailure = {
  status: number;
  message: string;       // client-facing, goes in the response body
  logMessage: string;    // operator-facing — deliberately NOT the same string
  level: 'warn' | 'error';
  detail?: Record<string, unknown>;  // extra log fields, spread flat
};

export function classifyApiError(error: unknown): ApiFailure;
```

Two cases today:

- `PrismaClientKnownRequestError` with `code === 'P2002'` → status 409, message
  `'Resource already exists'`, level `warn`, `detail: { target: error.meta?.target }`.
- Everything else → status 500, message `'Internal server error'`, level `error`.

**Why `warn` for `P2002`:** the existing comment already calls these "client conflicts, not
server bugs", and every deliberate duplicate path in the codebase pre-checks and returns its
own coded 409. Reaching this branch therefore means a race fired or a route forgot a
pre-check — worth knowing, not worth paging at `error`.

**Why `detail.target`:** Prisma puts the offending constraint in `meta.target`. Without it
the log says something already existed but not what, which is the same failure the issue is
about, one level in.

**Why a separate module:** `api-utils.ts` is already a grab-bag (responses, session guards,
body parsing, `pick`, the wrapper). Classification is pure and framework-free, and it is the
obvious home for #113's mapping without that issue having to touch the logging code.

**Why `logMessage` is separate from `message`:** `'Resource already exists'` is a reasonable
thing to tell a client and a useless thing to find in a log.

### `withErrorHandler` becomes single-exit

```ts
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

Four properties, each already verified against the real tree (see Evidence):

1. **One log call, one response.** No branch can early-return past the logger.
2. **Constrained generic**, so `args[0]` is typed `NextRequest` — no cast, no runtime
   narrowing, and zero edits at any of the 76 call sites.
3. **Optional chaining regardless of the type.** The type cannot see a JS caller or a
   zero-parameter wrapped handler. A `TypeError` thrown *inside the `catch`* would make this
   wrapper leak the stack trace it exists to contain — strictly worse than the bug being fixed.
4. **`pathname` only, never `search`/`href`.** Nine routes under `src/app/api` read
   `searchParams`; logging only the path keeps any future secret out of the logs by
   construction rather than by review. (Today's magic-link token travels in the request
   *body*, not the query string — so this is a guard against regression, not a live leak.)

### What does not change

Statuses, response messages, and the absence of an error `code` on the fallback 409 all stay
exactly as they are. This is an observability change; no route's behaviour moves.

## Testing

`withErrorHandler` has no tests today, so all of this is new coverage.

**`src/lib/api-errors.test.ts` (new)** — `classifyApiError` over:
- a `P2002` `PrismaClientKnownRequestError` → 409 / `warn` / `detail.target`
- a `PrismaClientKnownRequestError` with some other code → 500 / `error`
- a plain `Error` → 500 / `error`
- non-`Error` throwables (`'boom'`, `null`) → 500 / `error`, which today's code handles only
  by accident of the `instanceof` check failing

**`src/lib/api-utils.test.ts` (extended)** — using the file's existing `makeRequest` helper,
which already builds real `NextRequest` objects with a chosen URL and method:
- a handler that throws a plain `Error` → 500 body, and `log.error` called once with
  `method` and `path` matching the request actually passed
- a handler that throws `P2002` → 409 body unchanged, and `log.warn` (not `log.error`)
  called with the constraint target
- a wrapped handler invoked with no arguments → still returns 500, does not propagate a
  `TypeError`
- a handler that returns normally → log not called at all

This establishes the first `vi.mock('@/lib/log', …)` in the repo; the file's existing
`vi.mock('./auth')` / `vi.mock('./db')` calls are the pattern to follow.

**Proving each guard bites** (project rule: a guard that compiles but cannot fail certifies
nothing). For every assertion above, and for the type constraint: break the source, record
the exact failure text, restore, re-verify. The type constraint's text is already captured
in Evidence below.

## Evidence already gathered

Run against the real tree, then reverted (`git status` clean before writing this spec).

- Constraining the generic to `Args extends [NextRequest, ...unknown[]]` and dereferencing
  `args[0].method` / `args[0].nextUrl.pathname`: `npx tsc --noEmit` exits **0**. All 76 call
  sites compile unchanged.
- `log[lvl]` with `lvl: 'warn' | 'error'` is callable under `strict` against pino's types.
- Optional-chained `args[0]?.method` / `args[0]?.nextUrl?.pathname`: `tsc` clean and
  `eslint src/lib/api-utils.ts` clean (no `no-unnecessary-condition` complaint).
- **The constraint bites — but less broadly than "it guarantees a `NextRequest`".** Of three
  deliberately wrong handlers:
  - first parameter typed `{ params }` with the request second → **rejected**:
    `error TS2345: … Types of parameters '_ctx' and 'args_0' are incompatible. Property
    'params' is missing in type 'NextRequest' but required in type '{ params: Promise<{ id:
    string; }>; }'.`
  - a zero-parameter handler → **accepted** (TS arity rule).
  - a handler typed `(r: Request)` → **accepted** (`NextRequest extends Request`).

  Both accepted cases are runtime-safe for route handlers, since Next.js always passes a
  `NextRequest`. The honest claim is therefore: *the constraint prevents a handler from
  treating `args[0]` as anything but a `NextRequest` or a supertype* — which is why property
  3 (optional chaining) is not redundant with property 2.

## Out of scope

- **#113's status mapping** (`P2028`/`55P03` → 503 with actionable copy). `classifyApiError`
  is shaped so that lands as a new case in a pure function, but the mapping and its user-facing
  copy belong to #113.
- **Request ids / `AsyncLocalStorage`.** Correlating the other `log.error` sites — those in
  `services/gdpr.ts`, `services/class-transitions.ts`, `services/email-fallback.ts` and
  friends — with the request that caused them is a real want, but it is additive on top of
  this design —
  nothing here would be rewritten — and it would modify `src/lib/log.ts`, which is imported
  widely and is server-only-hazardous per CLAUDE.md.
- **The check-then-create races** in `teacher-rooms`/`students` POST. Pre-existing; this change
  makes them *visible*, which is the point. Whether they merit filing is a decision for after
  the log exists, not a prerequisite for it.
- **The two unwrapped routes** (`health`, `notifications/stream`). Both have their own
  `try`/`catch`; the wrapper cannot help them and they are not silently 500-ing.

## Acceptance

- `src/lib/api-errors.ts` exists, is pure (no `next/server`, no pino import), and is unit-tested.
- `withErrorHandler` contains exactly one `log` call and one `return` in its `catch`.
- Every unhandled error logs `method` and `path`; an escaped `P2002` logs at `warn` with its
  constraint target and still returns an unchanged 409.
- `npx tsc --noEmit` clean; `npx eslint` clean; `npx vitest run src/lib/api-errors.test.ts
  src/lib/api-utils.test.ts` green.
- Each new guard has a recorded break-and-restore proving it can fail.
