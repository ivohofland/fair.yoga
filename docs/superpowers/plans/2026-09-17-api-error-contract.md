# API Error Contract Implementation Plan (#197)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every refusal the API sends carries a registered code whose status is fixed; an outcome the server can prove already holds answers 200 `outcome: 'unchanged'` instead of a red error; developer-phrased refusals get product copy; #307's swallowed unreadable bodies get logged.

**Architecture:** A client-safe registry (`src/lib/api-error-codes.ts`) maps each code to its one HTTP status. Tasks 2–9 walk the API one domain at a time — splitting "already done" from "genuinely refused" in each route or service, rewriting copy, giving every touched refusal a code, and updating the clients that render them — while `respondError` still accepts any status. Task 10 then tightens `respondError` so a 409 without a code, or a code at the wrong status, fails to compile, and gives `classifyApiError`'s fallbacks their codes.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `unit-sweeps`, `integration`, `components` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-api-error-contract-design.md` — read §4 (contract), §5 (the unchanged rule and per-endpoint table), §6 (copy) and §7 (folded fixes) before any task. The census behind it is `docs/superpowers/specs/2026-09-17-api-error-contract-census/`.

## Global Constraints

- **TypeScript `strict: true`; no `any`.** `noUncheckedIndexedAccess` is on.
- **Test first, every task.** Write the failing test, run it and see the expected failure, implement, run it green.
- **Assert codes, not prose.** A new or rewritten server-side assertion checks the status and the code (`expectRefusal`, Task 1). It never reads `error.message`. Component tests may assert rendered text, because the mocked body is test data.
- **Every refusal a task touches carries a code from `src/lib/api-error-codes.ts`**, at the status the registry gives it. A code a task needs that the registry lacks is added to the registry in that task.
- **The unchanged answer** is `respondUnchanged<T>(data)` → `200 { data, outcome: 'unchanged' }` (Task 1), with no write and no side effect. Its place in a handler is fixed (spec §5.1):
  1. authentication and ownership;
  2. refusals that make the goal moot (class cancelled, payment settled);
  3. the unchanged check;
  4. every other status, window or capacity refusal.

  "Unchanged" requires the stored state to equal what the request asks for, **including every value the request carries**.
- **Copy** follows spec §6.1:
  1. the user's terms, never a model name, status literal, id or list of valid values;
  2. what is true, then the next step if there is one;
  3. "someone else" only when the server knows it was not this user;
  4. full sentences, sentence case, a closing period, no `Invalid …`/`Cannot …: …`/`Must be …`, no apology;
  5. one code, one meaning;
  6. use the label the UI shows.

  The exact strings are in spec §6.2 — copy them verbatim.
- **Comment discipline (CLAUDE.md):** no counts, censuses or member lists in comments; a comment annotates the code it sits on and states what is true now. History goes in the commit message.
- **Client bundle:** `src/lib/api-error-codes.ts` imports nothing. A `'use client'` file may value-import it and `src/lib/client-errors.ts`; `@/lib/log` never reaches one (type imports are fine).
- **Staging:** stage exact paths, never `git add -A`/`git add .`; quote paths containing `[`, `]`, `(` or `)`.
- **Integration and e2e tests run against this worktree's own app**, never `:3000`:
  1. `pnpm install --frozen-lockfile`;
  2. `pnpm run worktree:setup`, once;
  3. `pnpm run worktree:up`;
  4. `pnpm exec vitest run --project integration <path>` or `pnpm exec playwright test <path>`;
  5. `pnpm run worktree:down` when done.
- **Proving a guard bites:**
  1. commit the task's work first (restoring a mutated file with `git checkout -- <path>` discards any uncommitted edit to it);
  2. apply the mutation;
  3. for a route, send one request to the touched route first — `next dev` compiles lazily, and a first-request timeout reads like an assertion failure;
  4. run the named test and record the exact failure text in the task's report;
  5. `git checkout -- <path>`;
  6. re-run the test green.
- **Shared list edits:** Tasks 2, 3, 7, 8 and 9 each add race-test files to `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`). Line numbers a task gives for that list are as of the branch's base; by the time the task runs, earlier tasks have added entries. Add each new entry at the end of the list, before `] as const;`, and confirm the marker check still passes: `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts`. The same applies to any other line number in a file an earlier task has already edited: locate the code by its content, not its line.
- **Commits:** one or more per task, message in the repo's `type(scope): summary (#197)` style, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Before the PR:** `pnpm run verify` green, with the worktree app up.

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `src/lib/api-error-codes.ts` (new) | 1, then 7/8 remove retired codes | The code → status registry, `ApiErrorCode`, `StatusOf`, `CodeWithStatus`, `CodedRefusal`, `isApiErrorCode`. Imports nothing. |
| `src/lib/api-error-codes.test.ts` (new) | 1 | `isApiErrorCode`; structural type pins |
| `src/lib/client-errors.ts` | 1 | `readError` narrows the code and logs an unreadable body; `readErrorMessage` delegates to it |
| `src/lib/client-errors.test.ts` (new) | 1 | #307's acceptance |
| `src/lib/api-utils.ts` | 1 (`respondUnchanged`, typed `code`), 10 (overloads) | Response helpers |
| `src/lib/api-errors.ts` | 10 | `ApiFailure` union; fallback codes |
| `tests/api-assertions.ts` (new) | 1 | `expectRefusal`, `expectUnchanged`, `expectApplied` — shared by every later task |
| `src/services/class-lifecycle.ts`, `src/app/api/classes/[id]/{transition,complete,cancel}/route.ts`, `src/lib/transition-refusal.ts` (new) | 2 (3 extends the copy module) | Class lifecycle doors; the per-status lifecycle copy functions, each exhaustive over `ClassStatus` |
| `src/app/api/classes/…`, `src/app/api/class-templates/…`, `src/app/api/studio-class-templates/[id]/route.ts`, `src/app/api/studio-classes/[id]/route.ts`, the two template toggle buttons | 3 | Edit-time refusals; room re-read; studio delete; stale-page refresh |
| `src/services/payments.ts`, `src/app/api/payments/[id]/*/route.ts`, `src/app/api/payments/[id]/shared.ts` (new) | 4 | Payment status doors; one responder mapping a payment outcome to a response |
| `src/app/api/registrations/route.ts`, `src/app/api/registrations/[id]/route.ts` | 5 | Booking, attendance, booking cancel |
| `src/services/waitlist.ts`, `src/app/api/waitlist/…` | 6 | Join, claim, leave |
| `src/app/api/rooms/[id]/…`, `src/app/api/teacher-rooms/…`, `src/services/room-archive.ts`, `src/services/room-deletion.ts`, `src/services/teacher-room-attach.ts` (new) | 7 | Rooms; the attach-time value comparison |
| `src/app/api/account/{student,teacher}-profile/route.ts`, `src/app/api/teachers/[id]/route.ts`, `src/lib/schemas.ts` (one shared slug sentence), auth verify routes | 8 | Profiles, sign-in copy |
| `src/services/invitations.ts`, `src/app/api/students/route.ts`, `src/app/api/invitations/[id]/…`, `src/app/api/teacher-links/[teacherId]/route.ts`, `src/app/api/students/[id]/privacy/route.ts` | 9 | Invitations, contacts, teacher links |
| `vitest.tiers.ts` | 2, 3, 7, 8, 9 | `LOCK_CONTENTION_TESTS` entries for the new race files |
| `docs/lock-order.md` | 5, 6, 9 | The erasure-gate table's quoted answers, corrected by the task that changes each |
| `docs/technical-architecture.md`, `CLAUDE.md` | 10 | The rules, written once |

**Task order is load-bearing at both ends.** Task 1 creates what every other task imports. Task 10 must be last: it makes every uncoded 409 a compile error, so run earlier it would force throwaway codes onto rows that Tasks 2–9 turn into 2xx answers. Tasks 2–9 are independent of each other apart from shared registry entries, all of which Task 1 creates. Run them in order anyway; each assumes the previous ones are merged into the branch.

---

### Task 1: The registry, `respondUnchanged`, and code-aware client helpers (#307)

**Files:**
- Create: `src/lib/api-error-codes.ts`, `src/lib/api-error-codes.test.ts`, `src/lib/client-errors.test.ts`, `tests/api-assertions.ts`
- Modify: `src/lib/client-errors.ts` (whole file), `src/lib/api-utils.ts:35-41` (respondError's `code` type; add `respondUnchanged` after `respondTyped`), `src/lib/api-utils.test.ts:133-154` (the `respondError` describe) and after `:131` (a `respondUnchanged` describe), `src/app/api/classes/[id]/transition/route.ts` (`TRANSITION_FAILURE_RESPONSE`'s value type), `src/services/studio-class-deletion.ts:160-163` (`STUDIO_CLASS_REFUSALS`' value type), `src/lib/generation.ts:4-16` (docblock example)

**Interfaces:**
- Produces (`src/lib/api-error-codes.ts`):
  ```ts
  export type ApiErrorStatus = 400 | 403 | 404 | 409 | 500 | 503;
  export const API_ERROR_STATUS: { readonly [code: string]: ApiErrorStatus } /* as const literal */;
  export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
  export type StatusOf<C extends ApiErrorCode> = (typeof API_ERROR_STATUS)[C];
  export type CodeWithStatus<S extends ApiErrorStatus> = { [C in ApiErrorCode]: StatusOf<C> extends S ? C : never }[ApiErrorCode];
  export type CodedRefusal = { [C in ApiErrorCode]: { readonly code: C; readonly status: StatusOf<C>; readonly message: string } }[ApiErrorCode];
  export function isApiErrorCode(value: unknown): value is ApiErrorCode;
  ```
- Produces (`src/lib/api-utils.ts`):
  ```ts
  export function respondError(message: string, status: number, code?: ApiErrorCode): NextResponse; // tightened in Task 10
  export function respondUnchanged<T = never>(data: NoInfer<T>): NextResponse; // 200 { data, outcome: 'unchanged' }
  ```
- Produces (`src/lib/client-errors.ts`):
  ```ts
  export async function readError(res: Response, fallback: string): Promise<{ code?: ApiErrorCode; message: string }>;
  export async function readErrorMessage(res: Response, fallback: string): Promise<string>;
  ```
- Produces (`tests/api-assertions.ts`):
  ```ts
  export async function expectRefusal(res: Response, code: ApiErrorCode): Promise<void>; // status must equal API_ERROR_STATUS[code]
  export async function expectUnchanged(res: Response): Promise<unknown>;  // 200 + outcome 'unchanged'; returns data
  export async function expectApplied(res: Response, status?: 200 | 201): Promise<unknown>; // that status, no outcome; returns data
  ```

- [ ] **Step 1: Write the registry test**

`src/lib/api-error-codes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  API_ERROR_STATUS,
  isApiErrorCode,
  type ApiErrorCode,
  type CodeWithStatus,
  type StatusOf,
} from './api-error-codes';
import type { Assert, Equals } from './type-pins';

describe('isApiErrorCode', () => {
  it('accepts a registered code', () => {
    expect(isApiErrorCode('NOT_FOUND')).toBe(true);
  });

  it('rejects an unregistered string, including an inherited property name', () => {
    expect(isApiErrorCode('NOT_A_CODE')).toBe(false);
    expect(isApiErrorCode('toString')).toBe(false);
    expect(isApiErrorCode('__proto__')).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(isApiErrorCode(undefined)).toBe(false);
    expect(isApiErrorCode(404)).toBe(false);
    expect(isApiErrorCode({ code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('API_ERROR_STATUS', () => {
  it('registers each code at a status the app sends', () => {
    const allowed = new Set([400, 403, 404, 409, 500, 503]);
    for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
      expect(allowed.has(status), `${code} → ${status}`).toBe(true);
    }
  });
});

// Structural pins: true for any membership, so adding a code never breaks them.
type _conflictCodesAre409 = Assert<Equals<StatusOf<CodeWithStatus<409>>, 409>>;
type _notFoundIs404 = Assert<Equals<StatusOf<'NOT_FOUND'>, 404>>;
type _codesAreStrings = Assert<Equals<ApiErrorCode extends string ? true : false, true>>;
void 0 as unknown as [_conflictCodesAre409, _notFoundIs404, _codesAreStrings];
```

- [ ] **Step 2: Write the client helper test (#307)**

`src/lib/client-errors.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readError, readErrorMessage } from './client-errors';
import type { ApiErrorCode } from './api-error-codes';
import type { Assert, Equals } from './type-pins';

type _codeIsRegistered = Assert<
  Equals<Awaited<ReturnType<typeof readError>>['code'], ApiErrorCode | undefined>
>;
void 0 as unknown as [_codeIsRegistered];

function jsonResponse(body: unknown, status = 409): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withUrl(res: Response, url: string): Response {
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readError', () => {
  it('passes a registered code and the server message through', async () => {
    const res = jsonResponse({ error: { code: 'NOT_FOUND', message: 'This class no longer exists.' } }, 404);
    expect(await readError(res, 'fallback')).toEqual({
      code: 'NOT_FOUND',
      message: 'This class no longer exists.',
    });
  });

  it('drops a code the registry does not know', async () => {
    const res = jsonResponse({ error: { code: 'RETIRED_CODE', message: 'Server words.' } });
    expect(await readError(res, 'fallback')).toEqual({ code: undefined, message: 'Server words.' });
  });

  it('reads a string-shaped error body', async () => {
    const res = jsonResponse({ error: 'Plain words.' });
    expect(await readError(res, 'fallback')).toEqual({ message: 'Plain words.' });
  });

  it('falls back when the body has no usable message', async () => {
    expect(await readError(jsonResponse({ error: { code: 'NOT_FOUND' } }, 404), 'fallback')).toEqual({
      code: 'NOT_FOUND',
      message: 'fallback',
    });
    expect(await readError(jsonResponse({ error: '' }), 'fallback')).toEqual({ message: 'fallback' });
    expect(await readError(jsonResponse(null), 'fallback')).toEqual({ message: 'fallback' });
  });

  it('logs an unreadable body with its status and URL, then falls back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = withUrl(new Response('<html>502 Bad Gateway</html>', { status: 502 }), 'https://fair.yoga/api/rooms/r1');

    expect(await readError(res, 'fallback')).toEqual({ message: 'fallback' });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 502, url: 'https://fair.yoga/api/rooms/r1' }),
    );
  });

  it('does not log a readable body', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await readError(jsonResponse({ error: { message: 'Words.' } }), 'fallback');
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('readErrorMessage', () => {
  it('returns the server message', async () => {
    const res = jsonResponse({ error: { code: 'NOT_FOUND', message: 'Gone.' } }, 404);
    expect(await readErrorMessage(res, 'fallback')).toBe('Gone.');
  });

  it('returns a string-shaped error', async () => {
    expect(await readErrorMessage(jsonResponse({ error: 'Plain.' }), 'fallback')).toBe('Plain.');
  });

  it('falls back on a body with no message', async () => {
    expect(await readErrorMessage(jsonResponse({}), 'fallback')).toBe('fallback');
  });

  it('logs an unreadable body and falls back', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = withUrl(new Response('not json', { status: 500 }), 'https://fair.yoga/api/x');
    expect(await readErrorMessage(res, 'fallback')).toBe('fallback');
    expect(logged).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: 500, url: 'https://fair.yoga/api/x' }),
    );
  });
});
```

- [ ] **Step 3: Write the `respondUnchanged` tests and rewrite the `VALIDATION_ERROR` sample**

In `src/lib/api-utils.test.ts`, add `respondUnchanged` to the import list from `./api-utils` (`:37-47`). Replace the second `it` of `describe('respondError')` (`:143-153`, the one sending `'VALIDATION_ERROR'` at 422 — no production code sends that code, and Task 1 types `code` to the registry):

```ts
  it('includes code when provided', async () => {
    const response = respondError('This class no longer exists.', 404, 'NOT_FOUND');

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({
      error: { message: 'This class no longer exists.', code: 'NOT_FOUND' },
    });
  });
```

After `describe('respondTyped')` closes (`:131`), add:

```ts
describe('respondUnchanged', () => {
  it('answers 200 with the data and an unchanged outcome beside it', async () => {
    const response = respondUnchanged<{ id: string }>({ id: 'abc' });

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'abc' }, outcome: 'unchanged' });
  });

  it('enforces an explicit type argument, as respondTyped does', () => {
    const res = respondUnchanged<{ id: string }>({ id: 'valid' });
    expect(res.status).toBe(200);

    // @ts-expect-error — omitting <T> defaults T to never, rejecting any payload
    respondUnchanged({ id: 'omitted-type-parameter' });

    // @ts-expect-error — the payload must match T
    respondUnchanged<{ id: string }>({ id: 1 });
  });
});
```

- [ ] **Step 4: Write the shared test assertions**

`tests/api-assertions.ts`:

```ts
import { expect } from 'vitest';
import { API_ERROR_STATUS, type ApiErrorCode } from '@/lib/api-error-codes';

/**
 * A refusal carrying exactly this code, at the status the registry fixes for
 * it. Reads no message: copy is free to change without touching a test.
 */
export async function expectRefusal(res: Response, code: ApiErrorCode): Promise<void> {
  const body = (await res.json()) as { error?: { code?: unknown } };
  expect({ status: res.status, code: body.error?.code }).toEqual({
    status: API_ERROR_STATUS[code],
    code,
  });
}

/** A 200 `outcome: 'unchanged'` answer. Returns its `data`. */
export async function expectUnchanged(res: Response): Promise<unknown> {
  const body = (await res.json()) as { data?: unknown; outcome?: unknown };
  expect({ status: res.status, outcome: body.outcome }).toEqual({
    status: 200,
    outcome: 'unchanged',
  });
  return body.data;
}

/** A success that did the work: this status and no `outcome`. Returns its `data`. */
export async function expectApplied(res: Response, status: 200 | 201 = 200): Promise<unknown> {
  const body = (await res.json()) as { data?: unknown; outcome?: unknown };
  expect({ status: res.status, outcome: body.outcome }).toEqual({ status, outcome: undefined });
  return body.data;
}
```

- [ ] **Step 5: Run the new tests to see them fail**

Run: `pnpm exec vitest run --project unit src/lib/api-error-codes.test.ts src/lib/client-errors.test.ts src/lib/api-utils.test.ts`
Expected: FAIL. `api-error-codes.test.ts` fails with `Failed to resolve import "./api-error-codes"`; `client-errors.test.ts` fails the unknown-code, empty-message and logging cases; `api-utils.test.ts` fails with `respondUnchanged is not a function`.

- [ ] **Step 6: Create the registry**

`src/lib/api-error-codes.ts`:

```ts
/**
 * Every machine-readable error code the API sends, each at the one HTTP status
 * it is always sent with. A client compares against `ApiErrorCode`, so a code
 * removed here fails to compile wherever a caller still expects it.
 *
 * This module imports nothing, because `'use client'` components value-import
 * it through `client-errors.ts`.
 *
 * Adding a code: one entry here, at its status; the route sends it with
 * `respondError`; a test asserts it with `expectRefusal`. The rules for when a
 * refusal is a code and when it is a 200 `unchanged` answer are in
 * `docs/technical-architecture.md` (The Services Layer → Error responses).
 */
export type ApiErrorStatus = 400 | 403 | 404 | 409 | 500 | 503;

export const API_ERROR_STATUS = {
  ACCOUNT_EXISTS: 409,
  ALREADY_ANSWERED: 409,
  ALREADY_INVITED: 409,
  ALREADY_LATE_CANCELLED: 409,
  ALREADY_LINKED: 409,
  ALREADY_REGISTERED: 409,
  ALREADY_SHARED: 409,
  ALREADY_STUDENT: 409,
  ALREADY_TEACHER: 409,
  CLAIM_NOT_OPEN: 409,
  CLASS_CANCELLED: 409,
  CLASS_FROZEN: 409,
  CLASS_FULL: 409,
  CLASS_NOT_BOOKABLE: 409,
  CLASS_NOT_CANCELLABLE: 409,
  CLASS_NOT_ENDED_YET: 409,
  CLASS_NOT_FULL: 409,
  CLASS_NOT_STARTED: 409,
  CLASS_SCHEDULE_FROZEN: 409,
  CLASS_STARTS_IN_PAST: 409,
  CLASS_TERMINAL: 409,
  CONCURRENT_MODIFICATION: 409,
  CONTACT_CHANGED: 409,
  CONTACT_EMAIL_TAKEN: 409,
  CROSS_FAMILY_CLASS_TEMPLATE_SLOT: 409,
  CROSS_FAMILY_STUDIO_TEMPLATE_SLOT: 409,
  DECLINED: 409,
  DECLINED_IS_PERMANENT: 409,
  DUPLICATE: 409,
  DUPLICATE_CLASS_SLOT: 409,
  DUPLICATE_ROOM: 409,
  DUPLICATE_STUDIO_SLOT: 409,
  DUPLICATE_STUDIO_TEMPLATE_SLOT: 409,
  DUPLICATE_TEMPLATE_SLOT: 409,
  ENTRY_SLOT_TAKEN: 409,
  ERASURE_BUSY: 503,
  ERASURE_FAILED: 500,
  ILLEGAL_TRANSITION: 409,
  NO_PROFILE_SOURCE: 409,
  NOT_FOUND: 404,
  NOT_ON_WAITLIST: 409,
  NOT_PENDING: 409,
  NOT_ROOM_CREATOR: 403,
  NOT_YOUR_PROFILE: 403,
  NOW_SHARED: 409,
  ONBOARDING_NOT_SETTLED: 409,
  PARTIAL_ERASURE: 500,
  PARTIAL_ERASURE_BUSY: 503,
  PAYMENT_ALREADY_PAID: 409,
  PAYMENT_SETTLED: 409,
  PAYMENT_WAIVED: 409,
  REGISTRATION_CANCELLED: 409,
  ROOM_ALREADY_LISTED: 409,
  ROOM_ARCHIVED: 409,
  ROOM_IN_USE: 409,
  ROOM_IN_USE_RACE: 409,
  ROOM_NOT_ON_LIST: 400,
  RULE_SLOT_TAKEN: 409,
  SETTINGS_LOCKED: 409,
  SLUG_TAKEN: 409,
  SPOT_TAKEN: 409,
  STUDENT_ERASED: 409,
  STUDIO_CLASS_GENERATED_DATE: 409,
  STUDIO_CLASS_INCOME_RECORD: 409,
  STUDIO_CLASS_PAST_DATE: 409,
  STUDIO_CLASS_REGENERATES: 409,
  STUDIO_TEMPLATE_BUSY: 503,
  STUDIO_TEMPLATE_SLOT_CONFLICT: 409,
  TEACHER_NOT_LINKED: 403,
  TEMPLATE_ARCHIVED: 409,
  TEMPLATE_BUSY: 503,
  TEMPLATE_INSTANCE_DATE_CONFLICT: 409,
  TEMPLATE_SLOT_CONFLICT: 409,
  UNIQUE_CONFLICT: 409,
  WAITLIST_ENTRY_INACTIVE: 409,
  WAITLIST_FROZEN: 409,
} as const satisfies Record<string, ApiErrorStatus>;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export type StatusOf<C extends ApiErrorCode> = (typeof API_ERROR_STATUS)[C];

/** The codes registered at status `S`. */
export type CodeWithStatus<S extends ApiErrorStatus> = {
  [C in ApiErrorCode]: StatusOf<C> extends S ? C : never;
}[ApiErrorCode];

/**
 * A refusal whose status is its code's own. For reason → response maps: each
 * entry is checked on its own, which a `{ status: number; code: ApiErrorCode }`
 * value type cannot do.
 */
export type CodedRefusal = {
  [C in ApiErrorCode]: { readonly code: C; readonly status: StatusOf<C>; readonly message: string };
}[ApiErrorCode];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.hasOwn(API_ERROR_STATUS, value);
}
```

Before saving, re-derive the existing half of the list rather than trusting it — it must match what `src/` sends today, each at the status shown:

```bash
rg -o --no-filename "respondError\([^;]*?,\s*[0-9]{3}\s*,\s*'[A-Z_]+'" src -g '!*.test.ts' | grep -oE "'[A-Z_]+'" | sort -u
rg -n "code: '[A-Z_]+'" src -g '!*.test.ts' -g '!*.test.tsx' | grep -v 'src/components'
```

Every code those print must be a key above. Codes relayed through a variable are `DECLINED_IS_PERMANENT`, `NOT_PENDING` (`invitations/[id]/shared.ts`), `ALREADY_INVITED`, `ALREADY_LINKED`, `DECLINED`, `CONTACT_CHANGED` (`InviteRefusal`, `services/invitations.ts`), `ROOM_IN_USE`, `ROOM_IN_USE_RACE` (`services/room-deletion.ts`), and the studio-class refusal codes (`services/studio-class-edit-refusals.ts`, `services/studio-class-deletion.ts`); the type check in Step 8 catches any that is missing.

- [ ] **Step 7: Rewrite `client-errors.ts`**

`src/lib/client-errors.ts` (whole file):

```ts
import { isApiErrorCode, type ApiErrorCode } from './api-error-codes';

/**
 * Both halves of a failed response in one read: the server's `code` and the
 * message to show. A body can be read only once, so a caller that must branch
 * on the code AND display the message gets them together.
 *
 * `code` is `undefined` when the server named no case or named one the
 * registry does not know — a caller treating one outcome as success compares
 * against the code, never the status, because two responses can share a
 * status and mean opposite things.
 *
 * A body that is not JSON — a proxy's HTML error page, a truncated response —
 * answers the caller's fallback, and is logged with its status and URL first:
 * otherwise nothing, client or server, records which failure the user saw.
 */
export async function readError(
  res: Response,
  fallback: string,
): Promise<{ code?: ApiErrorCode; message: string }> {
  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.error('API error response body could not be read', {
      status: res.status,
      url: res.url,
      err,
    });
    return { message: fallback };
  }

  const error = typeof json === 'object' && json !== null ? (json as { error?: unknown }).error : undefined;
  if (typeof error === 'string') return { message: error || fallback };
  if (typeof error !== 'object' || error === null) return { message: fallback };

  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: isApiErrorCode(code) ? code : undefined,
    message: typeof message === 'string' && message !== '' ? message : fallback,
  };
}

/** The message half of `readError`, for a caller that branches on nothing. */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  return (await readError(res, fallback)).message;
}
```

- [ ] **Step 8: Type `respondError`'s code and add `respondUnchanged`**

In `src/lib/api-utils.ts`, add `import type { ApiErrorCode } from './api-error-codes';` to the imports, replace `respondError` (`:35-41`) with:

```ts
export function respondError(
  message: string,
  status: number,
  code?: ApiErrorCode,
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}
```

and add, directly after `respondTyped`:

```ts
/**
 * The answer to a request whose goal already holds: 200, no write, no side
 * effect. `outcome` sits beside `data` rather than inside it, so a client that
 * reads `data` sees the same shape as for an applied request. Typed like
 * `respondTyped`: `T` must be given, and `data` is checked against it.
 */
export function respondUnchanged<T = never>(data: NoInfer<T>): NextResponse {
  return NextResponse.json({ data, outcome: 'unchanged' }, { status: 200 });
}
```

Then run `pnpm run typecheck`. Expected: two errors, both a `string` code no longer assignable to `ApiErrorCode` — `src/app/api/classes/[id]/transition/route.ts` (the `TRANSITION_FAILURE_RESPONSE` destructure) and `src/app/api/studio-classes/[id]/route.ts` (`refusal.code`). Fix them at their source:

- `src/app/api/classes/[id]/transition/route.ts`: add `import type { ApiErrorCode } from '@/lib/api-error-codes';` and change the map's value type from `{ httpStatus: number; code: string }` to `{ httpStatus: 404 | 409; code: ApiErrorCode }`. (Task 2 rewrites this map; Task 10 tightens it further.)
- `src/services/studio-class-deletion.ts`: add `import type { ApiErrorCode } from '@/lib/api-error-codes';` and change `{ readonly message: string; readonly code: string }` to `{ readonly message: string; readonly code: ApiErrorCode }`. A type import erases completely, so the module stays safe for any client that imports it.

Run `pnpm run typecheck` again. Expected: clean. If it reports a code string the registry lacks, add that code at the status its site sends (§2 of the spec says none should be missing — a hit here means the census missed one; note it in the report).

- [ ] **Step 9: Correct `generation.ts`'s example list**

`src/lib/generation.ts:4-16` names `src/lib/client-errors.ts` as an example of a module that "VALUE-imports nothing itself". That is no longer true. In that sentence replace `` `src/lib/client-errors.ts` `` with `` `src/lib/api-error-codes.ts` `` and change nothing else.

- [ ] **Step 10: Run the tests green**

Run: `pnpm exec vitest run --project unit src/lib/api-error-codes.test.ts src/lib/client-errors.test.ts src/lib/api-utils.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project components src/components/account/set-up-student-side.test.tsx`
Expected: PASS (its only `readError` caller; `ALREADY_STUDENT` is still registered until Task 8).

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add src/lib/api-error-codes.ts src/lib/api-error-codes.test.ts src/lib/client-errors.ts src/lib/client-errors.test.ts src/lib/api-utils.ts src/lib/api-utils.test.ts tests/api-assertions.ts "src/app/api/classes/[id]/transition/route.ts" src/services/studio-class-deletion.ts src/lib/generation.ts
git commit -m "feat(api): register error codes, add respondUnchanged, log unreadable error bodies (#197, #307)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 12: Prove the guards bite**

Each: apply, run, record the exact failure in the report, `git checkout -- <path>`, re-run green.

1. In `src/lib/client-errors.ts`, delete the `console.error(...)` call. Run `pnpm exec vitest run --project unit src/lib/client-errors.test.ts` → the two logging tests fail (`expected "spy" to be called …`).
2. In `src/lib/api-error-codes.ts`, change `Object.hasOwn(API_ERROR_STATUS, value)` to `value in API_ERROR_STATUS`. Run `src/lib/api-error-codes.test.ts` → "rejects an unregistered string, including an inherited property name" fails on `'toString'`.
3. In `src/lib/client-errors.ts`, return `code` unfiltered (`code: code as ApiErrorCode`). Run `src/lib/client-errors.test.ts` → "drops a code the registry does not know" fails.
4. In `src/lib/api-utils.ts`, drop `outcome: 'unchanged'` from `respondUnchanged`. Run `src/lib/api-utils.test.ts` → the `respondUnchanged` body test fails.
5. In `src/lib/api-utils.ts`, change `respondUnchanged<T = never>` to `respondUnchanged<T>`. Run `pnpm run typecheck` → `Unused '@ts-expect-error' directive` at the omitted-type-parameter line (`T` falls back to `unknown`).
6. In `src/lib/api-utils.ts`, change `data: NoInfer<T>` to `data: T` in `respondUnchanged`. Run `pnpm run typecheck` → the same unused-directive error (`T` is now inferred from the payload). Measured before this plan was written: both annotations are load-bearing here, unlike on `respondError`'s status (spec §4.2).

---
### Task 2: Class lifecycle — transition, complete, cancel

**Files:**
- Create: `src/lib/transition-refusal.ts` (the per-state copy functions; no runtime imports), `src/lib/transition-refusal.test.ts`, `src/app/api/classes/[id]/transition/route.test.ts` (mocked service: every reason → response), `src/app/api/classes/[id]/complete/route.test.ts` (mocked service: every reason → response), `src/app/api/classes/[id]/complete/route-lock-order.test.ts` (serial tier: the completion twin, and the class deleted while the completion waits)
- Modify: `src/services/class-lifecycle.ts:170-220` (`TransitionFailureReason` docblock; `IllegalTransition`; `TransitionResult`), `:234-250` (`validateTransition` carries `from`/`to`), `:280-314` (`TransitionDbResult`'s ILLEGAL arm; export `ROOM_ARCHIVED_MESSAGE`; add `STARTS_IN_PAST_MESSAGE`, carrying the coordinator's rewording of the publish-past-start sentence), `:493-503` (the `STARTS_IN_PAST` return uses the constant)
- Modify: `src/app/api/classes/[id]/transition/route.ts` (whole file), `src/app/api/classes/[id]/complete/route.ts` (whole file), `src/app/api/classes/[id]/cancel/route.ts` (whole file)
- Modify: `vitest.tiers.ts` (one `LOCK_CONTENTION_TESTS` entry, after the `#626` privacy entry)
- Test: `src/services/class-lifecycle.test.ts` (`describe('validateTransition')` `:196-230`; `describe('transitionClass (DB)')` after the `'reports a missing class differently from an illegal transition'` case `:596-623`; `describe('completeClass (DB)')` after `'refuses to complete a class that is already cancelled'` `:1055-1069`)
- Test: `tests/integration/classes-api.test.ts` (import; two module helpers after `makeTeacher` `:50-64`; `describe('POST /api/classes/[id]/complete')` `:346-383`; `describe('POST /api/classes/[id]/transition')` `:385-840`, which also holds the cancel cases)
- Test (components): `src/components/class/publish-class-button.test.tsx:41-62`, `src/components/class/complete-class-button.test.tsx:35-50`, `src/components/class/cancel-class-button.test.tsx:63-93`
- Components, no source change (each branches on `res.ok` alone, so a 200 `unchanged` renders exactly as the applied 200 does): `publish-class-button.tsx:25`, `complete-class-button.tsx:23`, `cancel-class-button.tsx:32`. All three already render the error with `role="alert"` through `readErrorMessage`.

**Interfaces:**
- Consumes (Task 1): `respondUnchanged<T>(data)` and `respondError(message, status, code?: ApiErrorCode)` from `@/lib/api-utils`; `type CodedRefusal` from `@/lib/api-error-codes`; `expectRefusal(res, code)`, `expectUnchanged(res)`, `expectApplied(res, status?)` from `tests/api-assertions.ts`. Registry codes used: `NOT_FOUND`, `ILLEGAL_TRANSITION`, `CLASS_NOT_ENDED_YET`, `CONCURRENT_MODIFICATION`, `CLASS_STARTS_IN_PAST`, `ROOM_ARCHIVED`, `CLASS_CANCELLED`, `CLASS_NOT_CANCELLABLE` — all already registered.
- Produces:
  ```ts
  // src/lib/transition-refusal.ts
  export function transitionRefusalMessage(from: ClassStatus, to: ClassStatus): string;
  export function notCancellableMessage(status: ClassStatus): string;

  // src/services/class-lifecycle.ts
  export type IllegalTransition = {
    ok: false; reason: 'ILLEGAL_TRANSITION'; error: string; from: ClassStatus; to: ClassStatus;
  };
  export type TransitionResult = { ok: true } | IllegalTransition;
  export type TransitionDbResult<R extends TransitionFailureReason = TransitionFailureReason> =
    | { ok: true; newStatus: ClassStatus }
    | { ok: false; reason: Exclude<R, 'ILLEGAL_TRANSITION'>; error: string }
    | ('ILLEGAL_TRANSITION' extends R ? IllegalTransition : never);
  export const ROOM_ARCHIVED_MESSAGE: string;   // was module-private
  export const STARTS_IN_PAST_MESSAGE: string;  // new; replaces the inline literal, reworded
  ```
  The service's `error` strings are unchanged: they stay log text, and the routes word their own answers from `reason` (and from `from`/`to`).

**Who else calls what changes.** Re-derive before starting:

```bash
rg -n "completeClass\(|transitionClass\(|validateTransition\(" src -g '!*.test.ts'
```

Expected (non-test callers only): `src/services/class-transitions.ts:614` and `src/services/gdpr.ts:1071` (`completeClass`), the two routes this task rewrites, and `class-lifecycle.ts` itself (`:605`, `:761`, `:770`). `autoCompleteClasses` (`class-transitions.ts:614-634`) reads `result.ok`, `result.reason` and `result.error`; GDPR erasure (`gdpr.ts:1071-1111`) reads `result.ok` and `result.error`. For every input both receive the same `ok`, the same `reason` and the same `error` string as before — `completed → completed` included, which is still `{ ok: false, reason: 'ILLEGAL_TRANSITION' }`, now with two extra fields neither reads. So the sweep still does not count an already-completed class, and erasure still reaches its `benignDuplicate` warn. The "already completed → unchanged" decision is made in the complete route only; Step 1's `completeClass` test pins that the service still refuses.

- [ ] **Step 1: Write the failing service tests**

In `src/services/class-lifecycle.test.ts`, inside `describe('validateTransition')`, after `it('error message describes the invalid transition', …)` (`:222-229`), add:

```ts
  it('carries the pair it refused, including a request for the status already held', () => {
    expect(validateTransition('draft', 'completed')).toEqual({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
      error: expect.any(String),
      from: 'draft',
      to: 'completed',
    });
    expect(validateTransition('open', 'open')).toEqual({
      ok: false,
      reason: 'ILLEGAL_TRANSITION',
      error: expect.any(String),
      from: 'open',
      to: 'open',
    });
  });
```

Inside `describe('transitionClass (DB)')`, directly after the `it('reports a missing class differently from an illegal transition', …)` block, add:

```ts
  it('answers a request for the status the class already holds as ILLEGAL_TRANSITION carrying that pair', async () => {
    const cls = await makeClass({ status: 'open' });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result).toMatchObject({ ok: false, reason: 'ILLEGAL_TRANSITION', from: 'open', to: 'open' });
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('open');
  });

  // The route turns a same-status ILLEGAL_TRANSITION into `unchanged`, so the
  // cancellation has to be reported first or a cancelled class reads as done.
  it('reports CANCELLED ahead of the status a cancelled class already holds', async () => {
    const cls = await makeClass({ status: 'open' });
    await prisma.calendarEntry.update({
      where: { id: cls.calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result).toMatchObject({ ok: false, reason: 'CANCELLED' });
  });
```

Inside `describe('completeClass (DB)')`, directly after the `it('refuses to complete a class that is already cancelled', …)` block, add:

```ts
  /**
   * The service keeps refusing `completed → completed`. The complete route is
   * what answers it `unchanged`; `autoCompleteClasses` and teacher erasure
   * branch on this refusal and must keep seeing it.
   */
  it('refuses an already-completed class as ILLEGAL_TRANSITION from completed, and bills nothing twice', async () => {
    const cls = await makeClass({ status: 'open' });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: studentIds[2]!, status: 'registered', tierAtBooking: 3 },
    });
    try {
      expect(await completeClass(prisma, cls.id, { finishedEarly: true })).toMatchObject({ ok: true });
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);

      const again = await completeClass(prisma, cls.id, { finishedEarly: true });

      expect(again).toMatchObject({
        ok: false,
        reason: 'ILLEGAL_TRANSITION',
        from: 'completed',
        to: 'completed',
      });
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);
    } finally {
      // `Notification.relatedClass` is `onDelete: SetNull`; the block's
      // `afterAll` removes the class, not these.
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    }
  });
```

- [ ] **Step 2: Write the copy function's test**

`src/lib/transition-refusal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ClassStatus } from '@prisma/client';
import { canTransition } from '@/services/class-lifecycle';
import { notCancellableMessage, transitionRefusalMessage } from './transition-refusal';

const STATUSES = Object.values(ClassStatus);
const QUOTED_STATUS = new RegExp(`["'\`](${STATUSES.join('|')})["'\`]`);

/** Spec §6.1: a full sentence in the user's terms — no status literal, no identifier. */
function expectUserSentence(message: string): void {
  expect(message).toMatch(/^[A-Z].*\.$/);
  expect(message).not.toMatch(QUOTED_STATUS);
  expect(message).not.toContain('_');
}

describe('transitionRefusalMessage', () => {
  const REFUSED = [
    ['draft', 'in_progress', 'Publish this class first.'],
    ['draft', 'completed', 'Publish this class first.'],
    ['open', 'draft', "A published class can't go back to draft."],
    ['open', 'completed', "This class can't be completed from here."],
    ['in_progress', 'draft', 'This class has already started.'],
    ['in_progress', 'open', 'This class has already started.'],
    ['completed', 'draft', 'This class has already finished.'],
    ['completed', 'open', 'This class has already finished.'],
    ['completed', 'in_progress', 'This class has already finished.'],
  ] as const;

  it.each(REFUSED)('%s → %s: %s', (from, to, message) => {
    expect(transitionRefusalMessage(from, to)).toBe(message);
  });

  // Tethers the table above to `VALID_TRANSITIONS`: a transition added or
  // removed there fails here until the table says what to answer.
  it('lists exactly the pairs the state machine refuses, other than a status to itself', () => {
    const refused = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => to !== from && !canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    expect(refused.sort()).toEqual(REFUSED.map(([from, to]) => `${from}→${to}`).sort());
  });

  it('answers every pair with a sentence that names no status literal', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) expectUserSentence(transitionRefusalMessage(from, to));
    }
  });
});

describe('notCancellableMessage', () => {
  it.each([
    ['in_progress', "This class has already started, so it can't be cancelled."],
    ['completed', "This class has already finished, so it can't be cancelled."],
  ] as const)('%s: %s', (status, message) => {
    expect(notCancellableMessage(status)).toBe(message);
  });

  it('answers a status the cancel door accepts with a sentence that names no state', () => {
    for (const status of ['draft', 'open'] as const) {
      expect(notCancellableMessage(status)).toBe(
        "This class can't be cancelled right now. Refresh and try again.",
      );
    }
  });

  it('answers every status with a sentence that names no status literal', () => {
    for (const status of STATUSES) expectUserSentence(notCancellableMessage(status));
  });
});
```

- [ ] **Step 3: Write the routes' mapping tests (mocked service)**

The mocking header is `src/app/api/class-templates/[id]/vanished-room-double-race.test.ts:25-48`'s, with the lifecycle service in place of the template service. These are the only place a reason no database state reaches through the route (`CONCURRENT_MODIFICATION`, `NOT_ENDED_YET`) is answered, and the only place the copy a route picks is compared — against the copy function it calls, never against prose, so copy can change without touching them.

`src/app/api/classes/[id]/transition/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * How `POST /api/classes/[id]/transition` answers each result
 * `transitionClass` can return. The service is mocked, so every reason is
 * reached directly, including the ones no database state reaches through this
 * route.
 */
const transitionClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, transitionClass: (...args: unknown[]) => transitionClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { POST } = await import('./route');

const CLASS_ID = '6f1c1a52-3a55-4d6e-9d2b-8c1f0b7e2a10';

function transition(status: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

/** Read from a clone, so `expectRefusal` can still read the body. */
async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('POST /api/classes/[id]/transition — each service result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueClass.mockResolvedValue({ id: CLASS_ID, calendarEntry: { teacherId: 'teacher-1' } });
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await transition('open'), 'NOT_FOUND');
    expect(transitionClass).not.toHaveBeenCalled();
  });

  it('answers a request for the status the class holds as unchanged, in the applied shape', async () => {
    transitionClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'open', to: 'open',
    });

    expect(await expectUnchanged(await transition('open'))).toEqual({ ok: true, newStatus: 'open' });
  });

  it('words an illegal pair by its own from and to', async () => {
    transitionClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'open', to: 'draft',
    });

    const res = await transition('draft');

    expect(await messageOf(res)).toBe(transitionRefusalMessage('open', 'draft'));
    await expectRefusal(res, 'ILLEGAL_TRANSITION');
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CANCELLED', 'CLASS_CANCELLED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
    ['STARTS_IN_PAST', 'CLASS_STARTS_IN_PAST'],
    ['ROOM_ARCHIVED', 'ROOM_ARCHIVED'],
    ['NOT_ENDED_YET', 'CLASS_NOT_ENDED_YET'],
  ] as const)('answers %s with %s', async (reason, code) => {
    transitionClass.mockResolvedValueOnce({ ok: false, reason, error: 'service words' });

    await expectRefusal(await transition('open'), code);
  });
});
```

`src/app/api/classes/[id]/complete/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * How `POST /api/classes/[id]/complete` answers each result `completeClass`
 * can return, with the service mocked. The race that makes the unchanged
 * answer matter is staged against a real database in
 * `route-lock-order.test.ts` beside this file.
 */
const completeClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, completeClass: (...args: unknown[]) => completeClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { POST } = await import('./route');

const CLASS_ID = '0b8d4a0e-5d0f-4c3e-8f55-2a7b9c1d3e40';

function complete(): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}/complete`, { method: 'POST' }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('POST /api/classes/[id]/complete — each service result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueClass.mockResolvedValue({ id: CLASS_ID, calendarEntry: { teacherId: 'teacher-1' } });
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await complete(), 'NOT_FOUND');
    expect(completeClass).not.toHaveBeenCalled();
  });

  it('answers an already-completed class as unchanged, in the applied shape', async () => {
    completeClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'completed', to: 'completed',
    });

    expect(await expectUnchanged(await complete())).toEqual({ ok: true, newStatus: 'completed' });
  });

  it('words a draft by its own pair', async () => {
    completeClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'draft', to: 'completed',
    });

    const res = await complete();

    expect(await messageOf(res)).toBe(transitionRefusalMessage('draft', 'completed'));
    await expectRefusal(res, 'ILLEGAL_TRANSITION');
  });

  // NOT_FOUND was a 409 before: the route sent every refusal at one status.
  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CANCELLED', 'CLASS_CANCELLED'],
    ['NOT_ENDED_YET', 'CLASS_NOT_ENDED_YET'],
  ] as const)('answers %s with %s', async (reason, code) => {
    completeClass.mockResolvedValueOnce({ ok: false, reason, error: 'service words' });

    await expectRefusal(await complete(), code);
  });
});
```

- [ ] **Step 4: Write the completion race test (serial tier)**

The uncommitted-holder pattern, copied from `src/app/api/students/[id]/privacy/route-lock-order.test.ts:21-140` (`latch`, `ownPid`, `waiterOf` polling `pg_blocking_pids`, `handshake`, and the `vi.spyOn(dbLocks, …)` pause) and from `tests/integration/classes-api.test.ts:731-742` (a holder that deletes the `Class` row). The handler is called directly, as `src/app/api/classes/route.test.ts:109-124` does.

`src/app/api/classes/[id]/complete/route-lock-order.test.ts`:

```ts
/**
 * @serial-tier lock-contention — each case parks this route's completion on a
 * `Class` row another transaction holds, under `lockClassRow`'s 2s
 * `lock_timeout`, and asserts that it waited. Lock noise from a tier-mate can
 * stretch that wait past the bound and turn the answer under test into a 503.
 *
 * `POST` is invoked directly, as `src/app/api/classes/route.test.ts` invokes
 * its own; the pause is the spy technique of
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, type Prisma } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';
import { completeClass } from '@/services/class-lifecycle';
import { cookie, seedSession, uniqueSuffix } from '../../../../../../tests/helpers';
import { createClassFixture } from '../../../../../../tests/class-fixtures';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';
import { POST } from './route';

const prisma = new PrismaClient();
const suffix = `complete-lock-${uniqueSuffix()}`;

/** How long a pause or holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/** How long the route may take to start waiting: inside the 2s `lock_timeout` it waits under. */
const WAIT_MS = 1_500;

type Tracked<T> = { racer: Promise<T>; settled: () => boolean };

function complete(token: string, classId: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${classId}/complete`, {
      method: 'POST',
      headers: cookie(token),
    }),
    { params: Promise.resolve({ id: classId }) },
  );
}

function track<T>(racer: Promise<T>): Tracked<T> {
  let done = false;
  void racer.then(
    () => { done = true; },
    () => { done = true; },
  );
  return { racer, settled: () => done };
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function handshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)),
          HANDSHAKE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Pauses the first `completeClass` to lock `classId` right after it holds the
 * class row, before it reads anything. Later callers lock normally, so they
 * wait on it.
 */
function pauseCompletionAtLock(classId: string): {
  reached: Promise<void>;
  pid: () => number;
  release: () => void;
} {
  const reached = latch();
  const held = latch();
  let pid = 0;
  let paused = false;
  const original = dbLocks.lockClassRow;
  const spy = vi.spyOn(dbLocks, 'lockClassRow').mockImplementation(async (tx, id) => {
    await original(tx, id);
    if (id === classId && !paused) {
      paused = true;
      pid = await ownPid(tx);
      reached.open();
      await held.promise;
    }
  });
  onTestFinished(() => spy.mockRestore());
  return { reached: reached.promise, pid: () => pid, release: held.open };
}

describe('POST /api/classes/[id]/complete against a transaction holding the class', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let token: string;
  let day = 0;

  /** In progress, one day apart per call so no two fixtures share a slot. */
  const makeClass = () => {
    day += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Complete Race',
      date: new Date(Date.UTC(2099, 10, day)),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 4,
      status: 'in_progress',
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    const email = `${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Complete', lastName: 'Race', email, bio: 'complete race fixture',
        pageSlug: suffix, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Complete Race Room', address: `${suffix} Race St`, city: 'Testville',
        postcode: '1234CR', floor: '1', roomName: 'Race', maxCapacity: 10, createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;
    const student = await prisma.student.create({
      data: { firstName: 'Complete', lastName: 'Racer', email: `${suffix}-student@test.local`, incomeTier: 3 },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    // The entry cascades to its class, the class to its registrations, a
    // registration to its payment.
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The double-click on Complete. Both requests pass the route's own read; the
   * second waits on the class row while the first completes it, then reads
   * `completed` under the lock. Only the service's answer can tell the route
   * that — its own read, taken before the wait, still says `in_progress`.
   */
  it('answers the second of two completions unchanged, decided under the lock, and bills once', async () => {
    const cls = await makeClass();
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });
    try {
      const pause = pauseCompletionAtLock(cls.id);
      const winning = completeClass(prisma, cls.id, { finishedEarly: true });
      let losing: Tracked<Response> | undefined;
      let waited = false;
      try {
        await handshake(pause.reached, 'the first completion taking the class lock');
        losing = track(complete(token, cls.id));
        waited = (await waiterOf(pause.pid(), losing.settled)) !== null;
      } finally {
        pause.release();
        await winning.catch(() => undefined);
        await losing?.racer.catch(() => undefined);
      }
      if (losing === undefined) throw new Error('the second completion never started');

      expect(await winning).toMatchObject({ ok: true, newStatus: 'completed' });
      expect(waited).toBe(true);
      expect(await expectUnchanged(await losing.racer)).toEqual({ ok: true, newStatus: 'completed' });
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(1);
      expect(
        await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'payment_request' } }),
      ).toBe(2);
    } finally {
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntryId } });
    }
  }, 15_000);

  /**
   * A template archive hard-deletes future live classes, so a class can vanish
   * between the route's read and the service's locked one. That used to be a
   * 409 carrying "Class not found".
   */
  it('answers NOT_FOUND when the class is deleted while the completion waits on it', async () => {
    const cls = await makeClass();
    const holderLocked = latch();
    const release = latch();
    let holderPid = 0;
    const holding = prisma.$transaction(
      async (tx) => {
        holderPid = await ownPid(tx);
        await tx.$executeRaw`DELETE FROM "Class" WHERE id = ${cls.id}`;
        holderLocked.open();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    try {
      let losing: Tracked<Response> | undefined;
      let waited = false;
      try {
        await handshake(holderLocked.promise, 'the holder deleting the class');
        losing = track(complete(token, cls.id));
        waited = (await waiterOf(holderPid, losing.settled)) !== null;
      } finally {
        release.open();
        await holding.catch(() => undefined);
        await losing?.racer.catch(() => undefined);
      }
      if (losing === undefined) throw new Error('the completion never started');

      await holding;
      expect(waited).toBe(true);
      await expectRefusal(await losing.racer, 'NOT_FOUND');
    } finally {
      // The holder deleted the class, which orphans the entry rather than
      // cascading to it; removed by its own id.
      await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntryId } });
    }
  }, 15_000);
});
```

In `vitest.tiers.ts`, replace

```ts
  // #626: the same shape, for the privacy route.
  'src/app/api/students/[id]/privacy/route-lock-order.test.ts',
] as const;
```

with

```ts
  // #626: the same shape, for the privacy route.
  'src/app/api/students/[id]/privacy/route-lock-order.test.ts',
  // #197: the same shape, for the class completion route.
  'src/app/api/classes/[id]/complete/route-lock-order.test.ts',
] as const;
```

- [ ] **Step 5: Write the integration tests, and rewrite the ones this change breaks**

All in `tests/integration/classes-api.test.ts`.

Add to the imports (after `import { createClassFixture } from '../class-fixtures';`, `:6`):

```ts
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
```

Add after `makeTeacher` (`:50-64`):

```ts
/**
 * A class of its own, for a test that writes to it. Every caller passes a
 * date no other fixture in this file uses, so a run that fails before its
 * cleanup cannot block another test's slot.
 */
function isolatedClass(classType: string, date: string, status: ClassStatus, cancelled = false) {
  return createClassFixture(prisma, {
    teacherId: ownerId,
    teacherRoomId,
    classType,
    date: new Date(date),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 30,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 4,
    status,
    cancelledAt: cancelled ? new Date() : null,
  });
}

/**
 * Notifications first: `Notification.relatedClass` is `onDelete: SetNull`.
 * The entry takes the class with it, the class its registrations, and a
 * registration its payment.
 */
async function removeIsolatedClass(cls: { id: string; calendarEntryId: string }): Promise<void> {
  await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
  await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntryId } });
}
```

**`describe('POST /api/classes/[id]/complete')`.** Replace `it('404s an unknown class', …)` (`:358-361`) with:

```ts
  it('404s an unknown class with NOT_FOUND', async () => {
    await expectRefusal(await complete(ownerToken, UNKNOWN_CLASS_ID), 'NOT_FOUND');
  });
```

Replace `it('409s completing a class straight from draft (invalid transition)', …)` (`:371-382`) with:

```ts
  it('refuses completing a class straight from draft with ILLEGAL_TRANSITION', async () => {
    await expectRefusal(await complete(ownerToken, classId), 'ILLEGAL_TRANSITION');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('answers a repeat completion unchanged, and bills nobody twice', async () => {
    const cls = await isolatedClass('Complete Twice', '2099-10-04', 'open');
    try {
      await prisma.registration.create({
        data: { classId: cls.id, studentId: waitStudentId, status: 'registered', tierAtBooking: 3 },
      });
      const billed = { registration: { classId: cls.id } };
      const requested = { relatedClassId: cls.id, type: 'payment_request' as const };

      expect(await expectApplied(await complete(ownerToken, cls.id))).toEqual({ ok: true, newStatus: 'completed' });
      expect(await prisma.payment.count({ where: billed })).toBe(1);
      expect(await prisma.notification.count({ where: requested })).toBe(2);
      const first = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });

      expect(await expectUnchanged(await complete(ownerToken, cls.id))).toEqual({ ok: true, newStatus: 'completed' });

      expect(await prisma.payment.count({ where: billed })).toBe(1);
      expect(await prisma.notification.count({ where: requested })).toBe(2);
      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(after.status).toBe('completed');
      expect(after.updatedAt).toEqual(first.updatedAt);
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  // Moot first (spec §5.1): the cancellation answers before the "already
  // completed" check could.
  it('refuses a cancelled class with CLASS_CANCELLED, even when it is already completed', async () => {
    const cls = await isolatedClass('Complete Cancelled', '2099-10-05', 'completed', true);
    try {
      await expectRefusal(await complete(ownerToken, cls.id), 'CLASS_CANCELLED');
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  // Ownership first (spec §5.1): a class that is already completed is exactly
  // where an unchanged check placed above this gate would answer 200.
  it("403s another teacher's class even when it is already completed", async () => {
    const res = await complete(otherTeacherToken, completedClassId);
    expect(res.status).toBe(403);
  });
```

**`describe('POST /api/classes/[id]/transition')`.** Replace `it('404s an unknown class', …)` (`:418-421`) with:

```ts
  it('404s an unknown class with NOT_FOUND', async () => {
    await expectRefusal(await transition(ownerToken, UNKNOWN_CLASS_ID, { status: 'open' }), 'NOT_FOUND');
  });
```

Replace `it('409s an invalid transition (draft -> in_progress)', …)` (`:431-442`) with:

```ts
  it('refuses an illegal transition (draft -> in_progress) with ILLEGAL_TRANSITION', async () => {
    await expectRefusal(
      await transition(ownerToken, classId, { status: 'in_progress' }),
      'ILLEGAL_TRANSITION',
    );

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('answers a repeat publish unchanged, and writes nothing the second time', async () => {
    const cls = await isolatedClass('Publish Twice', '2099-10-01', 'draft');
    try {
      expect(
        await expectApplied(await transition(ownerToken, cls.id, { status: 'open' })),
      ).toEqual({ ok: true, newStatus: 'open' });
      const first = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(first.status).toBe('open');

      expect(
        await expectUnchanged(await transition(ownerToken, cls.id, { status: 'open' })),
      ).toEqual({ ok: true, newStatus: 'open' });

      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(after.status).toBe('open');
      expect(after.updatedAt).toEqual(first.updatedAt);
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  // Moot first (spec §5.1): a cancelled class keeps its status, so the
  // requested status can already hold on a class that is off.
  it('refuses a cancelled class with CLASS_CANCELLED, even when it already holds the requested status', async () => {
    const cls = await isolatedClass('Publish Cancelled', '2099-10-02', 'open', true);
    try {
      await expectRefusal(await transition(ownerToken, cls.id, { status: 'open' }), 'CLASS_CANCELLED');

      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(after.status).toBe('open');
      expect(after.calendarEntry.cancelledAt).not.toBeNull();
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  // Ownership first (spec §5.1).
  it("403s another teacher's class even when it already holds the requested status", async () => {
    const cls = await isolatedClass('Publish Not Yours', '2099-10-03', 'open');
    try {
      const res = await transition(otherTeacherToken, cls.id, { status: 'open' });
      expect(res.status).toBe(403);
    } finally {
      await removeIsolatedClass(cls);
    }
  });
```

In `it('publishing a draft whose start has passed is refused with 409 (#249)', …)` (`:456-477`), the sentence it pinned is reworded by this task. Replace `:457-473`

```ts
    const res = await transition(ownerToken, pastDraftClassId, { status: 'open' });
    expect(res.status).toBe(409);

    // The CODE, not just the status. A bare 409 cannot tell STARTS_IN_PAST
    // from an illegal transition or a concurrent modification, so this test
    // would have stayed green if the publish were refused for an unrelated
    // reason — which it nearly was, since a past-dated draft is exactly the
    // kind of fixture other guards also dislike. This route used to answer
    // every reason but NOT_FOUND with a bare 409 and no code at all, and the
    // earlier version of this comment recorded that as a limitation to live
    // with; #249's review made the case for fixing it instead.
    //
    // The same code the PUT door answers with, deliberately — one condition,
    // one code, whichever door refuses it.
    const json = (await res.json()) as { error: { message: string; code?: string } };
    expect(json.error.code).toBe('CLASS_STARTS_IN_PAST');
    expect(json.error.message).toMatch(/already passed/i);
```

with

```ts
    // The code, not the status: a bare 409 cannot tell a past start from an
    // illegal transition, and a past-dated draft is exactly the fixture other
    // guards dislike too. The same code the PUT door answers with — one
    // condition, one code, whichever door refuses it.
    await expectRefusal(
      await transition(ownerToken, pastDraftClassId, { status: 'open' }),
      'CLASS_STARTS_IN_PAST',
    );
```

In `it('404s when the class is deleted while the cancel is parked on its row', …)`, replace `:761-765`:

```ts
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('Class not found');
      // The specific lie the fallback used to tell.
      expect(json.error.message).not.toContain('status "open"');
```

with:

```ts
      // NOT_FOUND, and so not the status refusal the stale snapshot used to give.
      await expectRefusal(res, 'NOT_FOUND');
```

Replace `it('409s cancelling an already-cancelled class', …)` (`:787-801`; still order-dependent on `'cancels a class (happy path)'` at `:479`) with:

```ts
  it('answers a class that is already cancelled unchanged, and leaves its cancellation where it was', async () => {
    // `cancelClassId` was cancelled by 'cancels a class (happy path)' above.
    const before = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId }, include: { calendarEntry: true } });
    expect(before.calendarEntry.cancelledAt).not.toBeNull();

    expect(await expectUnchanged(await cancel(ownerToken, cancelClassId))).toEqual({ ok: true, cancelled: true });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toEqual(before.calendarEntry.cancelledAt);
  });

  it('answers a repeat cancel unchanged, and notifies nobody twice', async () => {
    const cls = await isolatedClass('Cancel Twice', '2099-10-06', 'open');
    try {
      await prisma.registration.create({
        data: { classId: cls.id, studentId: waitStudentId, status: 'registered', tierAtBooking: 3 },
      });
      const notices = { relatedClassId: cls.id, type: 'class_cancelled' as const };

      expect(await expectApplied(await cancel(ownerToken, cls.id))).toEqual({ ok: true, cancelled: true });
      expect(await prisma.notification.count({ where: notices })).toBe(1);
      const first = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cls.calendarEntryId } });

      expect(await expectUnchanged(await cancel(ownerToken, cls.id))).toEqual({ ok: true, cancelled: true });

      expect(await prisma.notification.count({ where: notices })).toBe(1);
      const after = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cls.calendarEntryId } });
      expect(after.cancelledAt).toEqual(first.cancelledAt);
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  it('refuses to cancel a class that has started with CLASS_NOT_CANCELLABLE', async () => {
    const cls = await isolatedClass('Cancel Started', '2099-10-07', 'in_progress');
    try {
      await expectRefusal(await cancel(ownerToken, cls.id), 'CLASS_NOT_CANCELLABLE');

      const after = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cls.calendarEntryId } });
      expect(after.cancelledAt).toBeNull();
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  it('refuses to cancel a finished class with CLASS_NOT_CANCELLABLE', async () => {
    await expectRefusal(await cancel(ownerToken, completedClassId), 'CLASS_NOT_CANCELLABLE');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.cancelledAt).toBeNull();
  });

  // The unchanged check comes before the status refusal (spec §5.1). No
  // product path cancels a class and then starts it; the fixture writes the
  // pair directly so the order is observable.
  it('answers a cancelled class unchanged even when its status is past cancelling', async () => {
    const cls = await isolatedClass('Cancel Cancelled Started', '2099-10-08', 'in_progress', true);
    try {
      expect(await expectUnchanged(await cancel(ownerToken, cls.id))).toEqual({ ok: true, cancelled: true });
    } finally {
      await removeIsolatedClass(cls);
    }
  });

  // Ownership first (spec §5.1).
  it("403s another teacher's cancel even when the class is already cancelled", async () => {
    const res = await cancel(otherTeacherToken, cancelledTerminalClassId);
    expect(res.status).toBe(403);
  });

  it('404s cancelling an unknown class with NOT_FOUND', async () => {
    await expectRefusal(await cancel(ownerToken, UNKNOWN_CLASS_ID), 'NOT_FOUND');
  });
```

The fresh fixtures use dates `2099-10-01` … `2099-10-08`, which no other fixture in the file uses (`rg -n "2099-10" tests/integration/classes-api.test.ts` before the edit prints nothing).

- [ ] **Step 6: Replace the component tests' mocks, and add the unchanged case**

`src/components/class/publish-class-button.test.tsx` — replace the mock at `:42-46`:

```tsx
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'Set a room before publishing.' } }),
    });
```

with

```tsx
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'CLASS_STARTS_IN_PAST',
          message: "This class's start time has already passed, so it can't be published.",
        },
      }),
    });
```

and `:52` `expect(await screen.findByText('Set a room before publishing.')).toBeInTheDocument();` with

```tsx
    expect(
      await screen.findByText("This class's start time has already passed, so it can't be published."),
    ).toBeInTheDocument();
```

Then add, after that test:

```tsx
  it('treats an unchanged answer as success: the class was already published', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, newStatus: 'open' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

`src/components/class/complete-class-button.test.tsx` — replace `it('shows the server message when completion is refused', …)` (`:35-50`; its mock is the case that is now a 200) with:

```tsx
  it('treats an unchanged answer as success: the class was already completed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, newStatus: 'completed' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server message when completion is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'CLASS_CANCELLED', message: 'This class has been cancelled.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toHaveTextContent('This class has been cancelled.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });
```

`src/components/class/cancel-class-button.test.tsx` — replace the mock body at `:67`

```tsx
      json: async () => ({ error: { message: 'That class can no longer be changed' } }),
```

with

```tsx
      json: async () => ({
        error: {
          code: 'CLASS_NOT_CANCELLABLE',
          message: "This class has already started, so it can't be cancelled.",
        },
      }),
```

and `:74` with

```tsx
    expect(
      await screen.findByText("This class has already started, so it can't be cancelled."),
    ).toBeInTheDocument();
```

Replace the comment and test at `:78-93` (`'reads a bare string error as well as a nested one'` — no route sends a bare-string error; `readError`'s own test covers that shape) with:

```tsx
  // Cancelling is not removing: this button did not ask for the class to be
  // gone, so its absence is a failure to report, not a success.
  it('shows NOT_FOUND as an error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'This class no longer exists.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    expect(await screen.findByRole('alert')).toHaveTextContent('This class no longer exists.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('treats an unchanged answer as success: the class was already cancelled', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, cancelled: true }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelClassButton classId="c-7" registrationCount={0} />);

    confirm();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

- [ ] **Step 7: Run the new tests to see them fail**

With the worktree app up (Global Constraints):

```bash
pnpm exec vitest run --project unit src/lib/transition-refusal.test.ts src/services/class-lifecycle.test.ts "src/app/api/classes/[id]/transition/route.test.ts" "src/app/api/classes/[id]/complete/route.test.ts"
pnpm exec vitest run --project unit-sweeps "src/app/api/classes/[id]/complete/route-lock-order.test.ts"
pnpm exec vitest run --project integration tests/integration/classes-api.test.ts
pnpm exec vitest run --project components src/components/class/publish-class-button.test.tsx src/components/class/complete-class-button.test.tsx src/components/class/cancel-class-button.test.tsx
```

Expected:
- `transition-refusal.test.ts`: `Failed to resolve import "./transition-refusal"`. Both `route.test.ts` files: `Failed to resolve import "@/lib/transition-refusal"` (they import the copy function to compare against).
- `class-lifecycle.test.ts`: the three new cases fail on the missing `from`/`to` (`toMatchObject`/`toEqual` diffs); `reports CANCELLED ahead of …` passes already.
- `route-lock-order.test.ts`: the twin fails `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`; the deleted class fails `expected { status: 409, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
- `classes-api.test.ts`: every new unchanged case fails with a 409 status in the `expectUnchanged` diff; every `expectRefusal` case fails on `code: undefined` (or on status 409 for the complete `NOT_FOUND`); the three 403 cases pass already.
- Components: the three unchanged cases pass already (each button checks only `res.ok`) — that is the "no client change" claim, observed. The rewritten refusal cases pass.

- [ ] **Step 8: Create the copy functions**

`src/lib/transition-refusal.ts`:

```ts
/**
 * What a teacher reads when a class's lifecycle state refuses a request.
 *
 * The one import is a type and is erased at build, so this module runs
 * anywhere. Each `switch` ends in a `never` default: a new `ClassStatus`
 * fails to compile here until it has its own sentence.
 */
import type { ClassStatus } from '@prisma/client';

/**
 * Why moving a class from `from` to `to` is refused. Keyed on `from`; only a
 * published class has two refused targets that need different words. A pair
 * the state machine accepts, or `from === to`, is never refused, and gets the
 * sentence its `from` row gives.
 */
export function transitionRefusalMessage(from: ClassStatus, to: ClassStatus): string {
  switch (from) {
    case 'draft':
      return 'Publish this class first.';
    case 'open':
      return to === 'draft'
        ? "A published class can't go back to draft."
        : "This class can't be completed from here.";
    case 'in_progress':
      return 'This class has already started.';
    case 'completed':
      return 'This class has already finished.';
    default: {
      const unhandled: never = from;
      return unhandled;
    }
  }
}

/**
 * Why the cancel door refuses a class that is not already cancelled, by its
 * status. `draft` and `open` are the statuses the door cancels, so their
 * sentence names no state.
 */
export function notCancellableMessage(status: ClassStatus): string {
  switch (status) {
    case 'in_progress':
      return "This class has already started, so it can't be cancelled.";
    case 'completed':
      return "This class has already finished, so it can't be cancelled.";
    case 'draft':
    case 'open':
      return "This class can't be cancelled right now. Refresh and try again.";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}
```

- [ ] **Step 9: Carry the refused pair out of the service**

In `src/services/class-lifecycle.ts`:

(a) In `TransitionFailureReason`'s docblock, replace `:173-174`

```ts
 * `error` alongside it stays free text for humans — a 409 body, a log line. The
 * split matters: those two have opposite change pressures. User-facing copy
```

with

```ts
 * `error` alongside it stays free text for a log line; a caller words its own
 * answer from `reason`. The split matters: the two have opposite change
 * pressures. User-facing copy
```

and replace `:204-207`

```ts
 * The looseness predates #249 and no member added since introduces it.
 * `POST /api/classes/[id]/transition` handles the full union anyway via an
 * exhaustive `Record`, so the widening costs a table row rather than a wrong
 * answer.
```

with

```ts
 * The looseness predates #249 and no member added since introduces it. A
 * caller that handles the full union pays a table row for the widening, not a
 * wrong answer.
```

(b) Replace `TransitionResult` (`:218-220`)

```ts
export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: 'ILLEGAL_TRANSITION'; error: string };
```

with

```ts
/**
 * `validateTransition`'s refusal. `from` is the status the decision was made
 * from and `to` the one asked for, so a caller can word the refusal per pair
 * and can tell a request for the status a class already holds from a move the
 * state machine forbids.
 */
export type IllegalTransition = {
  ok: false;
  reason: 'ILLEGAL_TRANSITION';
  error: string;
  from: ClassStatus;
  to: ClassStatus;
};

export type TransitionResult = { ok: true } | IllegalTransition;
```

(c) Replace `validateTransition` (`:234-250`) with:

```ts
/**
 * Validate a state transition, returning a typed result. A refusal carries the
 * pair it refused; `error` describes it for a log line.
 */
export function validateTransition(
  from: ClassStatus,
  to: ClassStatus,
): TransitionResult {
  if (canTransition(from, to)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: 'ILLEGAL_TRANSITION',
    error: `Invalid transition: cannot move from "${from}" to "${to}". Valid transitions from "${from}": [${VALID_TRANSITIONS[from].join(', ')}]`,
    from,
    to,
  };
}
```

(d) Replace `TransitionDbResult`'s docblock tail and type (`:292-303`)

```ts
 * A caller that switches on `reason` now gets the narrow union, so a branch for
 * a reason its callee never returns is a compile error rather than dead code.
 * `POST /api/classes/[id]/transition` deliberately keeps handling the full
 * union in one exhaustive `Record`: a route table that narrowed with its callee
 * would need editing every time a service's range changed, which is churn for
 * no safety.
 */
export type TransitionDbResult<
  R extends TransitionFailureReason = TransitionFailureReason,
> =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; reason: R; error: string };
```

with

```ts
 * A caller that switches on `reason` now gets the narrow union, so a branch for
 * a reason its callee never returns is a compile error rather than dead code.
 *
 * `ILLEGAL_TRANSITION` is its own arm, `IllegalTransition`, because it alone
 * carries the pair it refused. It exists only where `R` names it.
 */
export type TransitionDbResult<
  R extends TransitionFailureReason = TransitionFailureReason,
> =
  | { ok: true; newStatus: ClassStatus }
  | { ok: false; reason: Exclude<R, 'ILLEGAL_TRANSITION'>; error: string }
  | ('ILLEGAL_TRANSITION' extends R ? IllegalTransition : never);
```

(e) Replace `ROOM_ARCHIVED_MESSAGE` and its docblock (`:305-314`) with:

```ts
/**
 * The one sentence a teacher reads for `ROOM_ARCHIVED`, whichever of
 * `transitionClass`'s two doors answers it: the pre-check's read of
 * `teacherRoom.isArchived` before the transaction opens, or the catch around
 * the CAS below when `Class_live_needs_open_room` closes the window between
 * that read and the write (#339). A teacher who lost that race and a teacher
 * who never had it need the same thing done, so both sites share this
 * constant. Exported so the route answering the refusal sends this text
 * rather than a copy of it.
 */
export const ROOM_ARCHIVED_MESSAGE = 'This room is archived. Unarchive it to publish classes here.';

/** The sentence a teacher reads for `STARTS_IN_PAST`, exported for the same reason. */
export const STARTS_IN_PAST_MESSAGE = "This class's start time has already passed, so it can't be published.";
```

(f) In the `STARTS_IN_PAST` return (`:493-503`), replace

```ts
      return {
        ok: false,
        reason: 'STARTS_IN_PAST',
        // Prose, because this string is the whole of what the teacher sees:
        // `transition/route.ts` returns it as the 409 body and `PublishClassButton`
        // renders it, and this route logs nothing, so there is no diagnostic use
        // to preserve. The instant it used to carry was rendered in UTC — a time
        // the teacher never sees anywhere else in the app, from a guard whose
        // entire point is reading the start in `Teacher.defaultTimezone`.
        error: 'Cannot publish a class whose start time has already passed.',
      };
```

with

```ts
      return {
        ok: false,
        reason: 'STARTS_IN_PAST',
        error: STARTS_IN_PAST_MESSAGE,
      };
```

Nothing else in the service changes: `transitionClass` returns `validation` (now an `IllegalTransition`) at `:605-606`, and `completeClass` returns `toInProgress`/`validation` at `:761-762`/`:770-771`, all under the widened type as written. Both functions still read the status they pass to `validateTransition` after checking cancellation: `completeClass` under its `lockClassRow` (`:691`), `transitionClass` from its post-CAS re-read (`:587-606`).

- [ ] **Step 10: Rewrite the three routes**

The order each handler runs in (spec §5.1): authentication and ownership in the route; the moot refusal (cancelled) and not-found in the service or the locked re-read; then the unchanged check; then every other refusal.

`src/app/api/classes/[id]/transition/route.ts` (whole file; replaces Task 1's interim map type):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import {
  transitionClass,
  ROOM_ARCHIVED_MESSAGE,
  STARTS_IN_PAST_MESSAGE,
  type TransitionFailureReason,
} from '@/services/class-lifecycle';
import { transitionClassSchema } from '@/lib/schemas';

type TransitionApplied = Extract<Awaited<ReturnType<typeof transitionClass>>, { ok: true }>;

const CLASS_GONE = {
  code: 'NOT_FOUND',
  status: 404,
  message: 'This class no longer exists.',
} as const satisfies CodedRefusal;

/**
 * How each refusal but `ILLEGAL_TRANSITION` reaches the client. That one is
 * answered in the handler, because its words depend on the pair it refused and
 * one of its pairs is not a refusal at all.
 *
 * Keyed by the full `TransitionFailureReason` union rather than by
 * `transitionClass`'s range, so a reason added to the union has an answer here
 * before any caller can return it. `CodedRefusal` checks each entry's status
 * against its own code.
 *
 * `CLASS_STARTS_IN_PAST` is the code `PUT /api/classes/[id]` answers the same
 * condition with.
 */
const TRANSITION_REFUSAL = {
  NOT_FOUND: CLASS_GONE,
  CANCELLED: { code: 'CLASS_CANCELLED', status: 409, message: 'This class has been cancelled.' },
  CONCURRENT_MODIFICATION: {
    code: 'CONCURRENT_MODIFICATION',
    status: 409,
    message: 'This class was just changed elsewhere. Refresh and try again.',
  },
  STARTS_IN_PAST: { code: 'CLASS_STARTS_IN_PAST', status: 409, message: STARTS_IN_PAST_MESSAGE },
  ROOM_ARCHIVED: { code: 'ROOM_ARCHIVED', status: 409, message: ROOM_ARCHIVED_MESSAGE },
  NOT_ENDED_YET: { code: 'CLASS_NOT_ENDED_YET', status: 409, message: "This class hasn't finished yet." },
} as const satisfies Record<Exclude<TransitionFailureReason, 'ILLEGAL_TRANSITION'>, CodedRefusal>;

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: { select: { teacherId: true } } },
  });
  if (!cls) return respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, transitionClassSchema);
  if ('error' in parsed) return parsed.error;

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (result.ok) return respondOk(result);

  if (result.reason === 'ILLEGAL_TRANSITION') {
    // The service asks about cancellation before the state machine, so a
    // same-status refusal here is a live class already where it was asked to
    // be.
    if (result.from === result.to) {
      return respondUnchanged<TransitionApplied>({ ok: true, newStatus: result.from });
    }
    return respondError(
      transitionRefusalMessage(result.from, result.to),
      409,
      'ILLEGAL_TRANSITION',
    );
  }

  const refusal = TRANSITION_REFUSAL[result.reason];
  return respondError(refusal.message, refusal.status, refusal.code);
});
```

`src/app/api/classes/[id]/complete/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { completeClass } from '@/services/class-lifecycle';

type CompleteResult = Awaited<ReturnType<typeof completeClass>>;
type CompleteApplied = Extract<CompleteResult, { ok: true }>;
type CompleteRefusalReason = Exclude<
  Extract<CompleteResult, { ok: false }>['reason'],
  'ILLEGAL_TRANSITION'
>;

const CLASS_GONE = {
  code: 'NOT_FOUND',
  status: 404,
  message: 'This class no longer exists.',
} as const satisfies CodedRefusal;

/**
 * How each refusal but `ILLEGAL_TRANSITION` reaches the client, keyed by
 * `completeClass`'s own range: a reason added to it fails to compile here
 * until it has an answer. `NOT_ENDED_YET` cannot reach this route, which
 * passes `finishedEarly`.
 */
const COMPLETE_REFUSAL = {
  NOT_FOUND: CLASS_GONE,
  CANCELLED: { code: 'CLASS_CANCELLED', status: 409, message: 'This class has been cancelled.' },
  NOT_ENDED_YET: { code: 'CLASS_NOT_ENDED_YET', status: 409, message: "This class hasn't finished yet." },
} as const satisfies Record<CompleteRefusalReason, CodedRefusal>;

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: { select: { teacherId: true } } },
  });
  if (!cls) return respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  // `finishedEarly`: this endpoint IS the teacher ending a class early, which
  // is why it does not pass a clock to check against.
  const result = await completeClass(prisma, id, { finishedEarly: true });
  if (result.ok) return respondOk(result);

  if (result.reason === 'ILLEGAL_TRANSITION') {
    // Decided from the status `completeClass` read under its lock, after its
    // cancellation check — not from `cls` above, which a concurrent
    // completion can overtake while this request waits for the lock.
    if (result.from === result.to) {
      return respondUnchanged<CompleteApplied>({ ok: true, newStatus: result.to });
    }
    return respondError(
      transitionRefusalMessage(result.from, result.to),
      409,
      'ILLEGAL_TRANSITION',
    );
  }

  const refusal = COMPLETE_REFUSAL[result.reason];
  return respondError(refusal.message, refusal.status, refusal.code);
});
```

`src/app/api/classes/[id]/cancel/route.ts` (whole file; the transaction body from `lockClassRow` to the notifications is unchanged except the refusal branch):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondTyped,
  respondError,
  respondUnchanged,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodedRefusal } from '@/lib/api-error-codes';
import { notCancellableMessage } from '@/lib/transition-refusal';
import { formatDayHeader } from '@/lib/format';
import { createBulkNotifications, type CreateNotificationInput } from '@/services/notifications';
import { timeToHHmm } from '@/lib/time-of-day';
import { lockClassRow } from '@/lib/db-locks';

type CancelApplied = { ok: true; cancelled: true };

type CancelOutcome =
  | { kind: 'cancelled' }
  | { kind: 'unchanged' }
  | { kind: 'refused'; refusal: CodedRefusal };

const CLASS_GONE = {
  code: 'NOT_FOUND',
  status: 404,
  message: 'This class no longer exists.',
} as const satisfies CodedRefusal;

/**
 * The regular family's cancel door (#327).
 *
 * Cancellation stopped being a transition when `cancelled` left `ClassStatus`:
 * there is no target status to move to, and the wire format would be naming a
 * value the enum does not have. It is `CalendarEntry.cancelledAt` now, which
 * both families share — but each family keeps its OWN door, because their duty
 * of care genuinely differs. This one has to notify every registered student
 * and close the waitlist; a `StudioClass` has neither, and its existing PUT
 * already writes the same column.
 *
 * The block below is `POST …/transition`'s cancel branch, moved rather than
 * rewritten — the notification set, the queue close and the re-read under the
 * CAS are all #112's, and none of that reasoning changed.
 *
 * No body. The old endpoint took `{ status: 'cancelled' }`; the URL now says
 * the whole request, so there is nothing left to parse or validate.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: { select: { id: true, teacherId: true } } },
  });
  if (!cls) return respondError(CLASS_GONE.message, CLASS_GONE.status, CLASS_GONE.code);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const outcome = await prisma.$transaction(async (tx): Promise<CancelOutcome> => {
    // `Class` then `CalendarEntry`, the order every writer of this pair takes
    // (`db-locks.ts`). The old branch relied on its CAS `UPDATE` to take the
    // `Class` lock for free; the CAS now writes the ENTRY, so the free lock
    // would land on the wrong row — the same shape `updateClass` was rewritten
    // for. It also brings this path the 2s bound it never had — the branch
    // this replaced reached the `Class` row through a bare CAS with no
    // `setLockTimeout` ahead of it, so it waited as long as it took.
    // `waitlist.ts`'s docblock carries that among the `WaitlistEntry`-adjacent
    // writers and their bounds.
    await lockClassRow(tx, id);

    // The CAS moved to the entry with the column. The class-side conjunct is
    // carried through the relation so it still asks what it always did:
    // cancel this class only while it is a draft or open.
    const updated = await tx.calendarEntry.updateMany({
      where: {
        id: cls.calendarEntry.id,
        cancelledAt: null,
        classes: { some: { status: { in: ['draft', 'open'] } } },
      },
      data: { cancelledAt: new Date() },
    });
    if (updated.count === 0) {
      // Re-read under the lock rather than naming `cls`, the handler's
      // top-of-function snapshot taken outside this transaction. Cheap here:
      // the CAS already failed, so there is nothing left to protect by not
      // reading.
      const current = await tx.class.findUnique({
        where: { id },
        select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
      });

      // GONE, not "still whatever the snapshot said". A failed CAS leaves the
      // row freely deletable in that window: archiving a recurring template
      // hard-deletes its future `draft`/`open` instances, the same status set
      // this CAS matches on.
      if (!current) return { kind: 'refused', refusal: CLASS_GONE };

      // Already cancelled: what the request asks for holds, and nothing is
      // written or sent. Asked before the status, because a cancelled class
      // keeps whatever status it had.
      if (current.calendarEntry.cancelledAt !== null) return { kind: 'unchanged' };

      return {
        kind: 'refused',
        refusal: {
          code: 'CLASS_NOT_CANCELLABLE',
          status: 409,
          message: notCancellableMessage(current.status),
        },
      };
    }

    const registrations = await tx.registration.findMany({
      where: { classId: id, status: 'registered' },
      select: { studentId: true },
    });
    const waiting = await tx.waitlistEntry.findMany({
      where: { classId: id, status: 'waiting' },
      select: { studentId: true },
    });
    if (waiting.length > 0) {
      await tx.waitlistEntry.updateMany({
        where: { classId: id, status: 'waiting' },
        data: { status: 'removed' },
      });
    }

    // Named in full — type, day, time — like the three service paths #112
    // fixed. `relatedClassId` below is set and still does not help: this
    // transaction has just cancelled the class, and `studentNotificationHref`
    // (`lib/notification-links.ts`) links only an `open` class, deliberately,
    // so the inbox row is inert. A waitlisted recipient has even less — their
    // entry was closed to `removed` a few lines above, which drops the class
    // off `/bookings`.
    //
    // Re-read under the lock this transaction holds — not from `cls`, the
    // handler's top-of-function read, taken outside it. `date` and `startTime`
    // are NOT in `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so `settingsLocked`
    // does not freeze them and a teacher can reschedule a booked open class at
    // any time. Reschedule while cancelling and the notice named the old day.
    // `autoCancelClasses` (`class-transitions.ts`) re-reads inside its own
    // transaction for exactly this reason.
    const fresh = await tx.calendarEntry.findUniqueOrThrow({
      where: { id: cls.calendarEntry.id },
      select: { classType: true, date: true, startTime: true },
    });
    const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
      recipientType: 'student' as const,
      recipientId: r.studentId,
      type: 'class_cancelled' as const,
      title: 'Class cancelled',
      body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${timeToHHmm(fresh.startTime)} has been cancelled by your teacher.`,
      relatedClassId: id,
    }));
    if (notifications.length > 0) {
      await createBulkNotifications(tx, notifications);
    }
    return { kind: 'cancelled' };
  });

  if (outcome.kind === 'refused') {
    const { refusal } = outcome;
    return respondError(refusal.message, refusal.status, refusal.code);
  }
  if (outcome.kind === 'unchanged') {
    return respondUnchanged<CancelApplied>({ ok: true, cancelled: true });
  }
  return respondTyped<CancelApplied>({ ok: true, cancelled: true });
});
```

The applied body is unchanged on all three doors (`{ data: { ok: true, newStatus } }`, `{ data: { ok: true, cancelled: true } }`), and each `unchanged` answer carries that same `data` shape (spec §4.4). No client reads either body.

The comment that stood at `cancel/route.ts:161-167` ("No code here … deliberate") is gone with the uncoded answer it described.

- [ ] **Step 11: Run green**

```bash
pnpm run typecheck
pnpm exec vitest run --project unit src/lib/transition-refusal.test.ts src/services/class-lifecycle.test.ts src/services/room-archive-doors.test.ts "src/app/api/classes/[id]/transition/route.test.ts" "src/app/api/classes/[id]/complete/route.test.ts" src/lib/serial-tier-membership.test.ts
pnpm exec vitest run --project unit-sweeps "src/app/api/classes/[id]/complete/route-lock-order.test.ts" src/services/class-lifecycle-lock-order.test.ts src/services/class-transitions.test.ts
pnpm exec vitest run --project components src/components/class/publish-class-button.test.tsx src/components/class/complete-class-button.test.tsx src/components/class/cancel-class-button.test.tsx
pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/full-flow.test.ts tests/integration/account-api.test.ts
pnpm run lint
```

Expected: all PASS; typecheck and lint clean. `class-transitions.test.ts`, `account-api.test.ts` (teacher erasure) and `full-flow.test.ts` are the other `completeClass`/`transitionClass` consumers, run unedited to observe that nothing about them moved.

- [ ] **Step 12: Commit**

```bash
git add src/lib/transition-refusal.ts src/lib/transition-refusal.test.ts src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts "src/app/api/classes/[id]/transition/route.ts" "src/app/api/classes/[id]/transition/route.test.ts" "src/app/api/classes/[id]/complete/route.ts" "src/app/api/classes/[id]/complete/route.test.ts" "src/app/api/classes/[id]/complete/route-lock-order.test.ts" "src/app/api/classes/[id]/cancel/route.ts" vitest.tiers.ts tests/integration/classes-api.test.ts src/components/class/publish-class-button.test.tsx src/components/class/complete-class-button.test.tsx src/components/class/cancel-class-button.test.tsx
git commit -m "fix(classes): a repeated publish, completion or cancel answers unchanged; lifecycle refusals carry codes and product copy (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Prove the guards bite**

For every route mutation, warm the route first: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "rejects a signed-out caller"` (it hits both `/complete` and `/transition`). Record each failure verbatim; restore with `git checkout -- <path>`; re-run green.

1. **Ownership above unchanged (transition).** In `src/app/api/classes/[id]/transition/route.ts`, cut the block `if (cls.calendarEntry.teacherId !== session.teacherId) { return respondError('Not your class', 403); }` and paste it on the line after `if (result.ok) return respondOk(result);`. Run `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "already holds the requested status"` → `"403s another teacher's class even when it already holds the requested status"` fails with `expected 200 to be 403`. (This mutation also lets another teacher publish a draft; the file's fixtures are minted per run, so the next run starts clean.)
2. **Moot after unchanged (transition).** In `src/services/class-lifecycle.ts`, move the `if (cls.calendarEntry.cancelledAt !== null) { … reason: 'CANCELLED' … }` block (`:597-603` before this task) to directly after `if (!validation.ok) return validation;`. Warm the route. Run `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "reports CANCELLED ahead"` → fails, `reason: 'ILLEGAL_TRANSITION'` where `'CANCELLED'` was expected; and `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "refuses a cancelled class with CLASS_CANCELLED, even when it already holds"` → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'CLASS_CANCELLED' }`.
3. **No unchanged answer.** In `transition/route.ts`, change `if (result.from === result.to) {` to `if (false) {`. Run `pnpm exec vitest run --project unit "src/app/api/classes/[id]/transition/route.test.ts"` → `answers a request for the status the class holds as unchanged` fails with `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
4. **Swapped pair.** In `transition/route.ts`, change `transitionRefusalMessage(result.from, result.to)` to `transitionRefusalMessage(result.to, result.from)`. Same command → `words an illegal pair by its own from and to` fails: `expected 'Publish this class first.' to be "A published class can't go back to draft."`.
5. **Wrong code, right status.** In `transition/route.ts`, change `CANCELLED`'s `code: 'CLASS_CANCELLED'` to `code: 'CONCURRENT_MODIFICATION'`. `pnpm run typecheck` stays clean (both are 409). Same unit command → `answers CANCELLED with CLASS_CANCELLED` fails on `code`.
6. **Wrong status for a code.** In `transition/route.ts`, change `CLASS_GONE`'s `status: 404` to `status: 409`. `pnpm run typecheck` → error at the `CLASS_GONE` literal: it `does not satisfy the expected type 'CodedRefusal'`.
7. **A status with no sentence.** In `src/lib/transition-refusal.ts`, delete `case 'in_progress':` and the `return` under it in `transitionRefusalMessage`. `pnpm run typecheck` → `Type '"in_progress"' is not assignable to type 'never'` at `const unhandled: never = from;`.
8. **Unchanged decided from the route's own read (complete).** In `src/app/api/classes/[id]/complete/route.ts`, add after the ownership block `if (cls.status === 'completed') return respondUnchanged<CompleteApplied>({ ok: true, newStatus: 'completed' });` and change `if (result.from === result.to) {` to `if (false) {`. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/classes/[id]/complete/route-lock-order.test.ts"` → `answers the second of two completions unchanged …` fails with `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`. Warm the route and run `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "repeat completion"` → it passes: the sequential retry cannot see this mutation, which is why the race test exists. Record both.
9. **The service stops refusing a completed class.** In `src/services/class-lifecycle.ts`, in `completeClass`'s `else` branch, insert before `const validation = validateTransition(cls.status, 'completed');`: `if (cls.status === 'completed') return { ok: true, newStatus: 'completed' as ClassStatus };`. Run `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "refuses an already-completed class"` → fails, `ok: true` where `false` was expected.
10. **Not-found as a conflict (complete).** In `complete/route.ts`, change `NOT_FOUND: CLASS_GONE,` to `NOT_FOUND: { code: 'CLASS_CANCELLED', status: 409, message: CLASS_GONE.message },`. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/classes/[id]/complete/route-lock-order.test.ts" -t "deleted while"` → `expected { status: 409, code: 'CLASS_CANCELLED' } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
11. **Status refusal before unchanged (cancel).** In `src/app/api/classes/[id]/cancel/route.ts`, move the line `if (current.calendarEntry.cancelledAt !== null) return { kind: 'unchanged' };` to directly below the `CLASS_NOT_CANCELLABLE` `return { … };` (unreachable there). Warm with `-t "rejects a signed-out caller"`. Run `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "past cancelling"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`. The already-cancelled `draft` cases fail too (the `draft` arm answers 409).
12. **Ownership above unchanged (cancel).** In `cancel/route.ts`, cut the ownership block and paste it directly before `if (outcome.kind === 'refused') {`. Run `-t "403s another teacher's cancel"` → `expected 200 to be 403`.
13. **Ownership above unchanged (complete).** In `complete/route.ts`, cut the ownership block and paste it directly after `if (result.ok) return respondOk(result);`. Run `-t "403s another teacher's class even when it is already completed"` → `expected 200 to be 403`.
14. **The retry writes again (cancel).** In `cancel/route.ts`, delete `cancelledAt: null,` from the CAS `where`. Run `-t "repeat cancel"` → fails at the second request's `expectUnchanged` with a 409 status: the entry's `entry_terminal_liveness_guard` refuses the rewrite before the notification count can move. Record that the database guard, not the count, caught this one.

---

### Task 3: Class and template edits, studio-class delete

**Files:**
- Create: `src/app/api/classes/[id]/route.test.ts` (mocked service: `PUT`'s refusal mapping and per-state copy), `src/app/api/class-templates/route.test.ts` (mocked service: `POST`'s room pre-check and the FK-race re-read), `src/app/api/studio-classes/[id]/route-lock-order.test.ts` (serial tier: `DELETE`'s concurrent twin)
- Modify: `src/lib/transition-refusal.ts` (add `frozenClassMessage`), `src/services/class-lifecycle.ts:1194-1221` (`UpdateClassResult` docblock), `:1414-1416` (a comment quoting the old past-start sentence)
- Modify: `src/app/api/classes/[id]/route.ts:1-15` (imports), `:17` (a `classGone` helper above `GET`), `:34`, `:66`, `:98-121`, `:217-223` (the reworded past-start sentence, by coordinator ruling)
- Modify: `src/app/api/classes/route.ts:15` (helper after the imports), `:78-82`, `:192`
- Modify: `src/app/api/class-templates/route.ts:28-47` (helpers), `:72-76`, `:83-93`, `:100-139`
- Modify: `src/app/api/class-templates/[id]/route.ts:61-74` (helper beside `roomArchivedResponse`), `:193`, `:262`, `:317`, `:335-336`, `:433-438`, `:520-522`
- Modify: `src/app/api/studio-class-templates/[id]/route.ts:299-301`
- Modify: `src/app/api/studio-classes/[id]/route.ts:45` (`GET`), `:80` (`PUT`), `:354`, `:398-409` (`DELETE`)
- Modify: `src/components/studio-class/delete-studio-class-button.tsx:5`, `:63-95`; `src/components/studio-class/student-count-editor.tsx:65-67`; `src/components/settings/toggle-template-button.tsx:5`, `:68-70`; `src/components/settings/toggle-studio-template-button.tsx:5`, `:68-70`
- Modify: `vitest.tiers.ts` (one `LOCK_CONTENTION_TESTS` entry, after Task 2's)
- Test: `src/lib/transition-refusal.test.ts`; `src/app/api/classes/route.test.ts:56-65`, `:126-130`; `src/app/api/class-templates/[id]/vanished-room-double-race.test.ts:13`, `:75-110`, `:157-177`, new case; `tests/integration/classes-api.test.ts` (`beforeAll` comment `:167-174`, `describe('PUT /api/classes/[id]')`, `describe('POST /api/classes')`); `tests/integration/class-templates-api.test.ts` (import, `describe('POST /api/class-templates')`, `:667`, `:1452`, `:2549-2552`); `tests/integration/studio-api.test.ts` (import, `describe('/api/studio-classes')` new cases after `:1397`, `:943`, `:2128-2135`, `:2206`, `:2278-2282`); `tests/e2e/class-edit.spec.ts:162`; `src/components/studio-class/delete-studio-class-button.test.tsx:89-106` plus new cases; `src/components/studio-class/student-count-editor.test.tsx:25-60`; `src/components/settings/toggle-template-button.test.tsx` and `src/components/settings/toggle-studio-template-button.test.tsx` (one new case each)
- Line numbers in `tests/integration/classes-api.test.ts` are as on this branch before Task 2; Task 2 moves them, so each edit below is anchored on the test's title.

**Clients** (spec §8.4), each named with what it does with the answers this task changes:
- `src/components/class/class-edit-form.tsx:122-126` (`PUT /api/classes/[id]`) parses the body itself and shows `error.message`: `SETTINGS_LOCKED`, `CLASS_TERMINAL`, `CLASS_STARTS_IN_PAST` and `NOT_FOUND` render as errors through that path. No source change; the e2e at Step 9 observes the `SETTINGS_LOCKED` sentence rendered.
- `GET /api/classes/[id]` and `GET /api/studio-classes/[id]` have no component caller (the detail pages read the database directly); their `NOT_FOUND` changes no client.
- `src/app/(teacher)/class/new/page.tsx:326-329` (`POST /api/classes`) shows `json.error?.message`: `ROOM_NOT_ON_LIST` renders as an error. No change.
- `src/components/settings/template-form.tsx:356-358` (`POST`/`PUT /api/class-templates…`) uses `readErrorMessage`: `ROOM_NOT_ON_LIST`, `ROOM_ARCHIVED`, `TEMPLATE_BUSY` render as errors. No change.
- `src/components/settings/toggle-template-button.tsx` and `toggle-studio-template-button.tsx` (`PATCH …?state=active`) — changed, by coordinator ruling: they read the code with `readError`, show the message, and `router.refresh()` on `TEMPLATE_ARCHIVED`, the refusal only a stale page can produce.
- `PUT /api/studio-classes/[id]`'s `NOT_FOUND` reaches `student-count-editor.tsx:40`, `studio-class-edit-form.tsx:193`, `cancel-studio-class-button.tsx:35` and `restore-studio-class-button.tsx:28`, each through `readErrorMessage`, as an error with today's wording. None of them is a deleting component, so none changes for it.
- `src/components/studio-class/delete-studio-class-button.tsx` (`DELETE /api/studio-classes/[id]`) — changed: its own `NOT_FOUND` is done (spec §5.3).
- `src/components/studio-class/student-count-editor.tsx` (`PUT /api/studio-classes/[id]`) — changed: `role="alert"` (spec §7.7).

**Interfaces:**
- Consumes (Task 1): `respondError(message, status, code?: ApiErrorCode)`; `expectRefusal`. Registry codes used: `NOT_FOUND`, `SETTINGS_LOCKED`, `CLASS_TERMINAL`, `ROOM_NOT_ON_LIST` (400), `ROOM_ARCHIVED`, `TEMPLATE_BUSY`, `TEMPLATE_ARCHIVED`, `STUDIO_CLASS_REGENERATES` — all registered.
- Consumes (Task 2): `src/lib/transition-refusal.ts` and its test file; Task 2's `vitest.tiers.ts` entry and `tests/api-assertions` import in `classes-api.test.ts`.
- Produces:
  ```ts
  // src/lib/transition-refusal.ts
  export function frozenClassMessage(state: ClassStatus | 'cancelled'): string;
  ```
  Nothing else exported. `UpdateClassResult` and `TerminalClassState` keep their shapes.

- [ ] **Step 1: Write the failing unit tests**

Append to `src/lib/transition-refusal.test.ts` (and add `frozenClassMessage` to its import from `./transition-refusal`):

```ts
describe('frozenClassMessage', () => {
  it.each([
    ['completed', 'This class has finished and can no longer be changed.'],
    ['cancelled', 'This class has been cancelled and can no longer be changed.'],
  ] as const)('%s: %s', (state, message) => {
    expect(frozenClassMessage(state)).toBe(message);
  });

  it('answers a live status, which is never frozen, with a sentence that names no state', () => {
    for (const status of ['draft', 'open', 'in_progress'] as const) {
      expect(frozenClassMessage(status)).toBe('This class can no longer be changed.');
    }
  });

  it('answers every state with a sentence that names no status literal', () => {
    for (const state of [...STATUSES, 'cancelled' as const]) expectUserSentence(frozenClassMessage(state));
  });
});
```

`src/app/api/classes/[id]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { frozenClassMessage } from '@/lib/transition-refusal';
import { expectRefusal } from '../../../../../tests/api-assertions';

/**
 * How `PUT /api/classes/[id]` answers `updateClass`'s refusals, with the
 * service mocked. The copy comparison is against the function the route calls,
 * so it pins which state the route passed on, not the wording.
 */
const updateClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, updateClass: (...args: unknown[]) => updateClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { PUT } = await import('./route');

const CLASS_ID = '3c9e7b1a-2d4f-4a6b-8c0d-1e2f3a4b5c6d';

const OWNED_CLASS = {
  id: CLASS_ID,
  calendarEntryId: 'entry-1',
  calendarEntry: {
    teacherId: 'teacher-1',
    date: new Date('2099-06-01T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    durationMinutes: 60,
  },
};

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('PUT /api/classes/[id] — refusals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueClass.mockResolvedValue(OWNED_CLASS);
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await put({ description: 'x' }), 'NOT_FOUND');
    expect(updateClass).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND when the service finds the class gone', async () => {
    updateClass.mockResolvedValueOnce({ ok: false, reason: 'not_found' });

    await expectRefusal(await put({ description: 'x' }), 'NOT_FOUND');
  });

  it('answers a locked economic edit with SETTINGS_LOCKED', async () => {
    updateClass.mockResolvedValueOnce({ ok: false, reason: 'locked', fields: ['roomCost'] });

    await expectRefusal(await put({ roomCost: 1 }), 'SETTINGS_LOCKED');
  });

  it.each(['completed', 'cancelled'] as const)(
    'answers a %s class with CLASS_TERMINAL, in that state’s words',
    async (state) => {
      updateClass.mockResolvedValueOnce({ ok: false, reason: 'terminal', state });

      const res = await put({ date: '2020-01-01' });

      expect(await messageOf(res)).toBe(frozenClassMessage(state));
      await expectRefusal(res, 'CLASS_TERMINAL');
    },
  );
});
```

`src/app/api/class-templates/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { expectRefusal } from '../../../../tests/api-assertions';

/**
 * `POST /api/class-templates`: the room ownership pre-check, and what the
 * handler answers when the insert's room foreign key refuses the row. The
 * service is mocked, so each re-read outcome is reached directly; the pattern
 * is `[id]/vanished-room-double-race.test.ts`'s for `PUT`.
 */
const createClassTemplate = vi.fn();
const findUniqueTeacherRoom = vi.fn();

vi.mock('@/services/class-template-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-template-lifecycle')>();
  return { ...actual, createClassTemplate: (...args: unknown[]) => createClassTemplate(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    teacherRoom: { findUnique: (...args: unknown[]) => findUniqueTeacherRoom(...args) },
  },
}));

const { POST } = await import('./route');

const ROOM_ID = 'e2b26090-4a81-4286-9057-df498d361596';
const OWNED_OPEN_ROOM = { id: ROOM_ID, teacherId: 'teacher-1', isArchived: false };

function create(): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/class-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teacherRoomId: ROOM_ID,
        classType: 'Race Flow',
        dayOfWeek: 2,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      }),
    }),
  );
}

function roomForeignKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('FK error', {
    code: 'P2003',
    clientVersion: '6.19.3',
    meta: { constraint: 'ClassTemplate_teacherRoomId_roomArchived_fkey' },
  });
}

describe('POST /api/class-templates — room pre-check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers another teacher's room with ROOM_NOT_ON_LIST, before the service", async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce({ ...OWNED_OPEN_ROOM, teacherId: 'teacher-2' });

    await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
    expect(createClassTemplate).not.toHaveBeenCalled();
  });

  it('answers an unknown room with ROOM_NOT_ON_LIST, before the service', async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce(null);

    await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
    expect(createClassTemplate).not.toHaveBeenCalled();
  });
});

describe('POST /api/class-templates — the insert lost a race on the room', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createClassTemplate.mockRejectedValue(roomForeignKeyViolation());
  });

  it('answers ROOM_NOT_ON_LIST when the room is gone at the re-read', async () => {
    findUniqueTeacherRoom.mockResolvedValueOnce(OWNED_OPEN_ROOM).mockResolvedValueOnce(null);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'ROOM_NOT_ON_LIST');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create target room vanished',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('answers ROOM_ARCHIVED when the room is archived at the re-read', async () => {
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockResolvedValueOnce({ isArchived: true });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'ROOM_ARCHIVED');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create lost the room-archive race',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('answers TEMPLATE_BUSY when the room is open again at the re-read', async () => {
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockResolvedValueOnce({ isArchived: false });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      await expectRefusal(await create(), 'TEMPLATE_BUSY');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create lost a room-state race the other way; the room is open again',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rethrows the constraint error, not its own, when the re-read itself fails', async () => {
    const fkError = roomForeignKeyViolation();
    createClassTemplate.mockReset().mockRejectedValueOnce(fkError);
    findUniqueTeacherRoom
      .mockResolvedValueOnce(OWNED_OPEN_ROOM)
      .mockRejectedValueOnce(new Error('DB connection drop'));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const errorLog = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const res = await create();

      expect(res.status).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ teacherId: 'teacher-1', teacherRoomId: ROOM_ID }),
        'template create hit the room constraint, but the diagnostic re-read failed',
      );
      const logged = vi.mocked(errorLog).mock.calls[0]?.[0] as unknown as Record<string, unknown> | undefined;
      expect(logged?.['err']).toBe(fkError);
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
});
```

In `src/app/api/class-templates/[id]/vanished-room-double-race.test.ts`:
- add `import { expectRefusal } from '../../../../../tests/api-assertions';` after `import { log } from '@/lib/log';` (`:4`);
- in the header, replace `:11-13`

  ```ts
   * 1. Double-race room deletion: when a room vanishes after updateRule's
   *    internal re-read, the route re-reads, finds null, logs warn, and returns
   *    400 ('Invalid teacher room') rather than 409 (#231).
  ```

  with

  ```ts
   * 1. Double-race room deletion: when a room vanishes after updateRule's
   *    internal re-read, the route re-reads, finds null, logs warn, and returns
   *    400 ROOM_NOT_ON_LIST rather than 409 (#231).
  ```
- rename `it('maps double-race room deletion to 400 with invalid room message and logs warn', …)` to `it('maps double-race room deletion to 400 ROOM_NOT_ON_LIST and logs warn', …)`, and replace its `:96-98`

  ```ts
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: { message: string } };
      expect(payload.error.message).toBe('Invalid teacher room');
  ```

  with

  ```ts
      await expectRefusal(res, 'ROOM_NOT_ON_LIST');
  ```
- in `it('returns 400 when the move target room does not exist at the pre-check', …)`, replace `:168` `expect(res.status).toBe(400);` with `await expectRefusal(res, 'ROOM_NOT_ON_LIST');`;
- add at the end of the `describe`:

  ```ts
  it("answers the service's invalid_room with ROOM_NOT_ON_LIST", async () => {
    // No pre-check: the probe finds no template, so the service decides.
    findUniqueClassTemplate.mockResolvedValue(null);
    updateClassTemplate.mockResolvedValue({ ok: false, reason: 'invalid_room' });

    const res = await PUT(putWithRoom(VALID_ROOM_ID), { params: Promise.resolve({ id: TEMPLATE_ID }) });

    await expectRefusal(res, 'ROOM_NOT_ON_LIST');
  });
  ```

In `src/app/api/classes/route.test.ts`: add `import { expectRefusal } from '../../../../tests/api-assertions';` after `:4`; in the docblock replace `:63-64`

```ts
   * discovering `{ ok: false, reason: 'room_not_found' }`, which must answer
   * 400 "Invalid teacher room", not the slot-conflict 409.
```

with

```ts
   * discovering `{ ok: false, reason: 'room_not_found' }`, which must answer
   * 400 ROOM_NOT_ON_LIST, not the slot-conflict 409.
```

and replace `:126-130`

```ts
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('Invalid teacher room');
      // Discriminated from a genuine slot conflict, whose message would be misleading here.
      expect(json.error.message).not.toContain('overlaps that time');
```

with

```ts
      // A 400 with this code, and so not the slot conflict's 409.
      await expectRefusal(res, 'ROOM_NOT_ON_LIST');
```

- [ ] **Step 2: Write the studio-class delete race test (serial tier)**

The same uncommitted-holder pattern as Task 2 Step 4, here with a holder that deletes the calendar entry and holds the delete uncommitted. The handler's unlocked read still sees the row and passes every gate; its own `delete` waits on the holder's row lock and, once the holder commits, finds nothing to delete. The `log.warn` assertion is what shows the answer came from the P2025 catch and not from the handler's read.

`src/app/api/studio-classes/[id]/route-lock-order.test.ts`:

```ts
/**
 * @serial-tier lock-contention — holds an uncommitted `DELETE` of a studio
 * class's calendar entry while this route's own delete of that row waits on
 * it, and asserts the route started waiting inside a fixed window. Lock noise
 * from a tier-mate can push the wait past that window and fail the case for a
 * reason that is not the route's.
 *
 * `DELETE` is invoked directly, as `src/app/api/classes/route.test.ts` invokes
 * its `POST`.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, type Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { hhmmToTime } from '@/lib/time-of-day';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { createStudioClassFixture } from '../../../../../tests/class-fixtures';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { DELETE } from './route';

const prisma = new PrismaClient();
const suffix = `studio-delete-lock-${uniqueSuffix()}`;

/** How long the holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/** How long the route may take to start waiting on the holder. */
const WAIT_MS = 1_500;

type Tracked<T> = { racer: Promise<T>; settled: () => boolean };

function remove(token: string, studioClassId: string): Promise<Response> {
  return DELETE(
    new NextRequest(`http://localhost:3000/api/studio-classes/${studioClassId}`, {
      method: 'DELETE',
      headers: cookie(token),
    }),
    { params: Promise.resolve({ id: studioClassId }) },
  );
}

function track<T>(racer: Promise<T>): Tracked<T> {
  let done = false;
  void racer.then(
    () => { done = true; },
    () => { done = true; },
  );
  return { racer, settled: () => done };
}

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

async function handshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)),
          HANDSHAKE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('DELETE /api/studio-classes/[id] against a concurrent delete of the same class', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio', lastName: 'Twin', email, bio: 'studio delete race fixture',
        pageSlug: suffix, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('answers NOT_FOUND from its P2025 catch when the other delete commits first', async () => {
    // Manual and past-dated: removable by every rule `studioClassDeletability` has.
    const sc = await createStudioClassFixture(prisma, {
      teacherId,
      classType: 'Twin Removal',
      date: new Date('2020-07-01T00:00:00.000Z'),
      startTime: hhmmToTime('07:00'),
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    onTestFinished(() => warn.mockRestore());

    const holderDeleted = latch();
    const release = latch();
    let holderPid = 0;
    const holding = prisma.$transaction(
      async (tx) => {
        holderPid = await ownPid(tx);
        await tx.$executeRaw`DELETE FROM "CalendarEntry" WHERE id = ${sc.calendarEntryId}`;
        holderDeleted.open();
        await release.promise;
      },
      { timeout: 10_000 },
    );

    let removing: Tracked<Response> | undefined;
    let waited = false;
    try {
      await handshake(holderDeleted.promise, 'the holder deleting the entry');
      removing = track(remove(token, sc.id));
      waited = (await waiterOf(holderPid, removing.settled)) !== null;
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await removing?.racer.catch(() => undefined);
    }
    if (removing === undefined) throw new Error('the removal never started');

    await holding;
    expect(waited).toBe(true);
    await expectRefusal(await removing.racer, 'NOT_FOUND');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ studioClassId: sc.id, teacherId }),
      'studio class vanished between the ownership read and the delete',
    );
    expect(await prisma.calendarEntry.count({ where: { id: sc.calendarEntryId } })).toBe(0);
  }, 15_000);
});
```

In `vitest.tiers.ts`, after Task 2's entry

```ts
  // #197: the same shape, for the class completion route.
  'src/app/api/classes/[id]/complete/route-lock-order.test.ts',
```

add

```ts
  // #197: the same shape, for the studio class removal route.
  'src/app/api/studio-classes/[id]/route-lock-order.test.ts',
```

- [ ] **Step 3: Write the integration tests, and rewrite the ones this change breaks**

**`tests/integration/classes-api.test.ts`** (Task 2 added the `../api-assertions` import).

In the top-level `beforeAll`, replace the comment above `cancelledCls` (`:167-174`)

```ts
  // The cancelled side of the freeze. `updateClass` answers `reason:
  // 'terminal'` carrying a `TerminalClassState` (`class-lifecycle.ts`) —
  // `ClassStatus | 'cancelled'` rather than a `ClassStatus` since #327,
  // because a cancelled class keeps whatever live status it had and carries
  // `cancelledAt` on its entry — and the route interpolates that value
  // straight into the 409. `frozenStateOf` picks between a
  // `TERMINAL_CLASS_STATUSES` member and `'cancelled'`; one fixture per side
  // of that choice, so neither half of the rendered message goes unasserted.
```

with

```ts
  // The cancelled side of the freeze. A cancelled class keeps whatever live
  // status it had and carries `cancelledAt` on its entry, so `updateClass`
  // finds this freeze on a different row than the completed fixture's; one
  // fixture per side.
```

In `describe('PUT /api/classes/[id]')`, replace the whole `it('locked class: economic edit is rejected with 409 naming the fields sent', …)` (`:865-891`) with:

```ts
  it('locked class: an economic edit is refused with SETTINGS_LOCKED and writes nothing', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(before.settingsLocked).toBe(true); // sanity: the beforeAll fixture registration locked it

    await expectRefusal(await put(ownerToken, lockedClassId, { minRate: 1, roomCost: 999 }), 'SETTINGS_LOCKED');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
  });
```

In `it('locked class: a mixed economic + non-economic body is rejected atomically', …)`, replace `:901-902`

```ts
    const res = await put(ownerToken, lockedClassId, { description: 'x', roomCost: 999 });
    expect(res.status).toBe(409);
```

with

```ts
    await expectRefusal(
      await put(ownerToken, lockedClassId, { description: 'x', roomCost: 999 }),
      'SETTINGS_LOCKED',
    );
```

In the `"403s another teacher's cookie on a locked class …"` case, replace the comment line `:932`

```ts
    // -> 409 "Cannot update economic fields...".
```

with

```ts
    // -> 409 SETTINGS_LOCKED.
```

Add, directly after that 403 case:

```ts
  it('answers an unknown class with NOT_FOUND', async () => {
    await expectRefusal(await put(ownerToken, UNKNOWN_CLASS_ID, { description: 'x' }), 'NOT_FOUND');
  });

  // The read half of the same route file, which answers a missing class the same way.
  it('GET answers an unknown class with NOT_FOUND', async () => {
    const res = await fetch(`${BASE_URL}/api/classes/${UNKNOWN_CLASS_ID}`, { headers: cookie(ownerToken) });
    await expectRefusal(res, 'NOT_FOUND');
  });
```

In `it('completed class: the edit is refused with 409 and the stored date does not move (#247)', …)`, rename it to `'completed class: the edit is refused with CLASS_TERMINAL and the stored date does not move (#247)'` and replace `:1117-1122`

```ts
    const res = await put(ownerToken, completedClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.message).toContain('completed');
    expect(json.error.code).toBe('CLASS_TERMINAL');
```

with

```ts
    await expectRefusal(await put(ownerToken, completedClassId, { date: '2020-01-01' }), 'CLASS_TERMINAL');
```

Replace the whole `it('cancelled class: the edit is refused with 409 naming cancelled, not completed (#247)', …)` (`:1130-1159`) with:

```ts
  // Each freeze's own sentence is pinned in `src/app/api/classes/[id]/route.test.ts`,
  // against the function the route words it with.
  it('cancelled class: the edit is refused with CLASS_TERMINAL and the stored date does not move (#247)', async () => {
    const before = await prisma.class.findUniqueOrThrow({
      where: { id: cancelledTerminalClassId }, include: { calendarEntry: true } });
    // The premise, on the row that carries it since #327: the class keeps a
    // live status and the ENTRY holds the cancellation.
    expect(before.calendarEntry.cancelledAt).not.toBeNull();

    await expectRefusal(
      await put(ownerToken, cancelledTerminalClassId, { date: '2020-01-01' }),
      'CLASS_TERMINAL',
    );

    const after = await prisma.class.findUniqueOrThrow({
      where: { id: cancelledTerminalClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-06-01');
  });
```

In `describe('POST /api/classes')`, replace `:1383-1384`

```ts
    const res = await post(ownerToken, { ...baseBody(), teacherRoomId: victimRoomId });
    expect(res.status).toBe(400);
```

with

```ts
    await expectRefusal(
      await post(ownerToken, { ...baseBody(), teacherRoomId: victimRoomId }),
      'ROOM_NOT_ON_LIST',
    );
```

replace `:1393-1394`

```ts
    const res = await post(ownerToken, { ...baseBody(), teacherRoomId: UNKNOWN_CLASS_ID });
    expect(res.status).toBe(400);
```

with

```ts
    await expectRefusal(
      await post(ownerToken, { ...baseBody(), teacherRoomId: UNKNOWN_CLASS_ID }),
      'ROOM_NOT_ON_LIST',
    );
```

and in `'answers 400, not a false slot conflict, when the room is deleted while the create is parked on it'`, replace `:1467-1471`

```ts
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('Invalid teacher room');
      // Discriminated from a genuine slot conflict, whose message would be misleading here.
      expect(json.error.message).not.toContain('overlaps that time');
```

with

```ts
      // A 400 with this code, and so not the slot conflict's 409.
      await expectRefusal(res, 'ROOM_NOT_ON_LIST');
```

**`tests/integration/class-templates-api.test.ts`.** Add `import { expectRefusal } from '../api-assertions';` after `import { createClassFixture } from '../class-fixtures';` (`:12`).

In `describe('POST /api/class-templates')`, directly after `it('refuses to create a template on an archived room, and writes nothing', …)` (ends `:480`), add:

```ts
  // Refused before any write, so neither case holds a slot.
  it("refuses another teacher's room with ROOM_NOT_ON_LIST, and creates nothing", async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({
        ...templateBody('Foreign Room Template', '20:00', ALT_DAY_2),
        teacherRoomId: otherTeacherRoomId,
      }),
    });

    await expectRefusal(res, 'ROOM_NOT_ON_LIST');
    expect(
      await prisma.scheduleRule.count({
        where: { teacherId: { in: [teacherId, otherTeacherId] }, classType: 'Foreign Room Template' },
      }),
    ).toBe(0);
  });

  it('refuses an unknown room with ROOM_NOT_ON_LIST, and creates nothing', async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({
        ...templateBody('Unknown Room Template', '21:30', ALT_DAY_2),
        teacherRoomId: '00000000-0000-4000-8000-000000000000',
      }),
    });

    await expectRefusal(res, 'ROOM_NOT_ON_LIST');
    expect(
      await prisma.scheduleRule.count({ where: { teacherId, classType: 'Unknown Room Template' } }),
    ).toBe(0);
  });
```

In `it('refuses to activate an archived template — no instant classes for shelved things', …)`, replace `:667` `expect(toggle.status).toBe(409);` with `await expectRefusal(toggle, 'TEMPLATE_ARCHIVED');`.

In `it("refuses a teacherRoom belonging to another teacher", …)` (PUT), replace `:1452` `expect(res.status).toBe(400);` with `await expectRefusal(res, 'ROOM_NOT_ON_LIST');`.

In `it('names the archived template, not the archived room, when both are true', …)`, replace `:2549-2552`

```ts
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code?: string; message: string } };
      expect(body.error.message).toBe('Unarchive the template before activating it');
      expect(body.error.code).not.toBe('ROOM_ARCHIVED');
```

with

```ts
      // TEMPLATE_ARCHIVED, and so not ROOM_ARCHIVED.
      await expectRefusal(res, 'TEMPLATE_ARCHIVED');
```

**`tests/integration/studio-api.test.ts`.** Add `import { expectRefusal } from '../api-assertions';` after `import { createClassFixture, createStudioClassFixture } from '../class-fixtures';` (`:26`).

In `it('refuses to activate an archived template — no classes for shelved things', …)`, replace `:943` `expect(res.status).toBe(409);` with `await expectRefusal(res, 'TEMPLATE_ARCHIVED');`.

No test reaches `GET` or `PUT /api/studio-classes/[id]` with an unknown id. In `describe('/api/studio-classes')` (`:1383`), directly after `it('creates against the calling teacher', …)` (ends `:1397`), add:

```ts
  it('GET answers an unknown studio class with NOT_FOUND', async () => {
    await expectRefusal(
      await send('GET', ownerToken, '/api/studio-classes/00000000-0000-4000-8000-000000000000'),
      'NOT_FOUND',
    );
  });

  // The ownership read comes before the body is parsed, so a valid body is
  // not what makes this a 404.
  it('PUT answers an unknown studio class with NOT_FOUND', async () => {
    await expectRefusal(
      await send('PUT', ownerToken, '/api/studio-classes/00000000-0000-4000-8000-000000000000', {
        studentCount: 3,
      }),
      'NOT_FOUND',
    );
  });
```

In `describe('DELETE /api/studio-classes/[id]')`, replace `it('answers 404 for an id that is not there', …)` (`:2128-2135`) with:

```ts
  it('answers NOT_FOUND for an id that is not there', async () => {
    const res = await send(
      'DELETE',
      ownerToken,
      '/api/studio-classes/00000000-0000-4000-8000-000000000000',
    );
    await expectRefusal(res, 'NOT_FOUND');
  });
```

and replace `it('answers the second removal with 404 rather than a 500', …)` (`:2278-2282`) with:

```ts
  // The concurrent twin — both removals past the read before either commits —
  // is `src/app/api/studio-classes/[id]/route-lock-order.test.ts`.
  it('answers the second removal with NOT_FOUND, which the removing button reads as done', async () => {
    const sc = await makeClass({ date: PAST, startTime: '06:45' });
    expect((await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`)).status).toBe(200);
    await expectRefusal(await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`), 'NOT_FOUND');
  });
```

Also delete the orphaned one-line docblock `/** The double-click. P2025 must read as 404, not as a 500. */` that sits directly above the `THE OTHER DIRECTION` docblock (`:2206`), which describes no test.

**`tests/e2e/class-edit.spec.ts`.** Replace `:162`

```ts
    await expect(page.getByText(/Cannot update economic fields/)).toBeVisible();
```

with

```ts
    await expect(
      page.getByText('Prices and capacity are locked once the first student books.'),
    ).toBeVisible();
```

- [ ] **Step 4: Write the component tests**

`src/components/studio-class/delete-studio-class-button.test.tsx` — replace the mock body at `:94-96`

```tsx
      json: async () => ({
        error: { message: 'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.' },
      }),
```

with the body the server sends:

```tsx
      json: async () => ({
        error: {
          code: 'STUDIO_CLASS_REGENERATES',
          message:
            'This class comes from a recurring template and is not yet past, so removing it would only create it again. Cancel it instead.',
        },
      }),
```

and add, after that test:

```tsx
  // Spec §5.3: this button asked for the row to be gone, so its own NOT_FOUND
  // is the end state the teacher confirmed.
  it('treats NOT_FOUND as done: the class is already gone', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 'NOT_FOUND', message: 'That class is already gone.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/schedule'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a 403 as an error, and stays put', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'Access denied' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied');
    expect(assign).not.toHaveBeenCalled();
  });
```

`src/components/studio-class/student-count-editor.test.tsx` — in `it('saves the typed count and confirms it', …)`, after `:40` `expect(await screen.findByText('Saved')).toBeInTheDocument();` add:

```tsx
    // "Saved" is not an alert; only a failure is announced.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
```

In `it('shows the server message instead of "Saved" when the save is refused', …)`, replace the mock at `:44-48`

```tsx
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Student count cannot be negative.' } }),
    });
```

with the body `PUT /api/studio-classes/[id]` sends for `{ studentCount: -4 }` — `parseBody`'s join of zod's issue (`api-utils.ts:86-89`), measured with the repo's zod 4 as `studentCount: Too small: expected number to be >=0`:

```tsx
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'studentCount: Too small: expected number to be >=0' } }),
    });
```

and replace `:55`

```tsx
    expect(await screen.findByText('Student count cannot be negative.')).toBeInTheDocument();
```

with

```tsx
    // A role, not just text: without it a screen reader never announces the failure.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'studentCount: Too small: expected number to be >=0',
    );
```

`src/components/settings/toggle-template-button.test.tsx` — after `it('renders the server error message when the request fails', …)` (`:134-142`), add:

```tsx
  // Only a stale page can offer Resume on an archived template. The refusal
  // re-reads the page, so the controls it shows next match the template.
  it('refreshes the page on TEMPLATE_ARCHIVED, and still shows why', async () => {
    stubFetch({
      ok: false,
      json: async () => ({
        error: {
          code: 'TEMPLATE_ARCHIVED',
          message: 'Unarchive this recurring class before resuming it.',
        },
      }),
    });
    render(<ToggleTemplateButton templateId="tpl-1" isActive={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unarchive this recurring class before resuming it.',
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });
```

`src/components/settings/toggle-studio-template-button.test.tsx` — after `it('renders the server error message when the request fails', …)` (`:135-143`), add:

```tsx
  // Only a stale page can offer Resume on an archived template. The refusal
  // re-reads the page, so the controls it shows next match the template.
  it('refreshes the page on TEMPLATE_ARCHIVED, and still shows why', async () => {
    stubFetch({
      ok: false,
      json: async () => ({
        error: {
          code: 'TEMPLATE_ARCHIVED',
          message: 'Unarchive this studio class before resuming it.',
        },
      }),
    });
    render(<ToggleStudioTemplateButton templateId="tpl-1" isActive={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unarchive this studio class before resuming it.',
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });
```

Both files' existing `'renders the server error message when the request fails'` case (a 404 with no code) keeps asserting `routerRefresh` was not called, which pins that only this code refreshes.

- [ ] **Step 5: Run the new tests to see them fail**

With the worktree app up:

```bash
pnpm exec vitest run --project unit src/lib/transition-refusal.test.ts "src/app/api/classes/[id]/route.test.ts" src/app/api/class-templates/route.test.ts "src/app/api/class-templates/[id]/vanished-room-double-race.test.ts"
pnpm exec vitest run --project unit-sweeps src/app/api/classes/route.test.ts "src/app/api/studio-classes/[id]/route-lock-order.test.ts"
pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
pnpm exec vitest run --project components src/components/studio-class/delete-studio-class-button.test.tsx src/components/studio-class/student-count-editor.test.tsx src/components/settings/toggle-template-button.test.tsx src/components/settings/toggle-studio-template-button.test.tsx
```

Expected:
- `transition-refusal.test.ts` and `classes/[id]/route.test.ts`: `frozenClassMessage is not a function` (or `does not provide an export named 'frozenClassMessage'`).
- `class-templates/route.test.ts`: every `ROOM_NOT_ON_LIST` case fails `expected { status: 400, code: undefined } …`; the gone case fails `expected { status: 409, code: 'ROOM_ARCHIVED' } …`; the open-again case fails the same way; the probe-failure case fails with `expected 409 to be 500` (the catch answers without re-reading).
- `vanished-room-double-race.test.ts` and `classes/route.test.ts`: the rewritten cases fail on `code: undefined`.
- Studio `route-lock-order.test.ts`: `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }` — the P2025 branch already answers 404; only the code is missing. If it instead reports a 500 or a 200, stop: the race did not reach the catch the spec says handles it, and that is a finding to report, not a test to adjust.
- Integration: each rewritten `expectRefusal` fails on `code: undefined`; the unknown-class `PUT` and `GET` and the unknown studio-class `GET` and `PUT` fail on `code: undefined`; the two new POST template cases fail on `code: undefined` (their counts pass).
- Components: the NOT_FOUND case fails (`assign` not called; an alert shows `That class is already gone.`); the refused count-editor case fails with `Unable to find role="alert"`; both `TEMPLATE_ARCHIVED` cases fail on `routerRefresh` never being called (their alert assertions pass); the 403 case and the success-without-alert assertion pass already.

- [ ] **Step 6: Add `frozenClassMessage`, and word the edit refusals**

Append to `src/lib/transition-refusal.ts`:

```ts
/**
 * Why a frozen class refuses an edit. `state` is a status or `'cancelled'`,
 * the domain a freeze is reported in. A live status is never reported as
 * frozen, so its sentence names no state.
 */
export function frozenClassMessage(state: ClassStatus | 'cancelled'): string {
  switch (state) {
    case 'completed':
      return 'This class has finished and can no longer be changed.';
    case 'cancelled':
      return 'This class has been cancelled and can no longer be changed.';
    case 'draft':
    case 'open':
    case 'in_progress':
      return 'This class can no longer be changed.';
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}
```

In `src/services/class-lifecycle.ts`, replace `UpdateClassResult`'s docblock `:1194-1216`

```ts
/**
 * Why an update did or did not happen.
 *
 * `locked` carries a NON-EMPTY tuple of offending fields deliberately. The bug
 * this type replaced (#72) returned a "locked" response naming no fields at
 * all, for a request that touched none — the compiler now refuses to construct
 * that. Callers own the user-facing wording; this type owns the distinction.
 *
 * `terminal` carries the state for the same reason `locked` carries fields:
 * the caller owns the wording and needs to name what happened. It is
 * `TerminalClassState` rather than `ClassStatus` because since #327 one of the
 * two things it can name is not a status at all — a cancelled class keeps
 * whatever live status it had, and its cancellation is a column on the entry.
 * The 409's sentence still has to say "cancelled", so the value has to.
 *
 * `past_start` carries NOTHING, and the asymmetry with its two neighbours is
 * deliberate. `locked` and `terminal` carry data because their callers' MESSAGE
 * VARIES with it — `terminal`'s 409 renders "completed" or "cancelled" from one
 * branch, and an integration test exists to pin that variance. This refusal has
 * one sentence for every past start, whether the offending value arrived as
 * `date`, as `startTime`, or as both. A carried instant would be a payload
 * nothing reads.
 *
```

with

```ts
/**
 * Why an update did or did not happen. Callers own the user-facing wording;
 * this type owns the distinction.
 *
 * `locked` carries a NON-EMPTY tuple of the economic fields the request sent.
 * The bug this type replaced (#72) reported "locked" for a request that sent
 * none — the compiler now refuses to construct that.
 *
 * `terminal` carries the state, which is what tells a completed class from a
 * cancelled one. It is `TerminalClassState` rather than `ClassStatus` because
 * since #327 one of the two is not a status at all — a cancelled class keeps
 * whatever live status it had, and its cancellation is a column on the entry.
 *
 * `past_start` carries NOTHING: a past start is one refusal whether the
 * offending value arrived as `date`, as `startTime`, or as both, and a carried
 * instant would be a payload nothing reads.
 *
```

(the paragraph from `Every *business* outcome` to the end of the docblock stays).

In `src/app/api/classes/[id]/route.ts`:
- add `import { frozenClassMessage } from '@/lib/transition-refusal';` after `:15`;
- add directly above `export const GET` (`:17`):

  ```ts
  /** The 404 for a class that is not there, whichever read in this file found it gone. */
  function classGone() {
    return respondError('This class no longer exists.', 404, 'NOT_FOUND');
  }
  ```
- replace `:34` (`GET`) and `:66` (`PUT`), each `if (!cls) return respondError('Class not found', 404);`, with `if (!cls) return classGone();`;
- replace `:100-107`

  ```ts
    if (result.reason === 'not_found') return respondError('Class not found', 404);
    if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
    if (result.reason === 'locked') {
      return respondError(
        `Cannot update economic fields when settings are locked: ${result.fields.join(', ')}`,
        409,
      );
    }
  ```

  with

  ```ts
    if (result.reason === 'not_found') return classGone();
    if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
    if (result.reason === 'locked') {
      // The fields go to the log, not into the sentence.
      log.info(
        { classId: id, teacherId: session.teacherId, fields: result.fields },
        'class edit refused: its economics are locked',
      );
      return respondError(
        'Prices and capacity are locked once the first student books.',
        409,
        'SETTINGS_LOCKED',
      );
    }
  ```
- replace `:119-121`

  ```ts
    if (result.reason === 'terminal') {
      return respondError(`Cannot edit a class that is ${result.state}`, 409, 'CLASS_TERMINAL');
    }
  ```

  with

  ```ts
    if (result.reason === 'terminal') {
      return respondError(frozenClassMessage(result.state), 409, 'CLASS_TERMINAL');
    }
  ```

- replace the past-start refusal `:217-223`

  ```ts
    if (result.reason === 'past_start') {
      return respondError(
        'Cannot move a class to a date and time that has already passed.',
        409,
        'CLASS_STARTS_IN_PAST',
      );
    }
  ```

  with

  ```ts
    if (result.reason === 'past_start') {
      return respondError(
        'That time has already passed. Choose a later date or time.',
        409,
        'CLASS_STARTS_IN_PAST',
      );
    }
  ```

In `src/services/class-lifecycle.ts`, the comment in `updateClass` quotes that sentence. Replace `:1414-1416`

```ts
  // editing only the description of a past-dated draft was refused with
  // "Cannot move a class to a date and time that has already passed" having
  // moved nothing. The rule is that a write may not NEWLY PLACE the start in
```

with

```ts
  // editing only the description of a past-dated draft was refused as a past
  // start having moved nothing. The rule is that a write may not NEWLY PLACE the start in
```

In `src/app/api/studio-classes/[id]/route.ts`, `GET` and `PUT` keep their wording and gain the code (Step 7 does `DELETE`): replace `:45` (`GET`) and `:80` (`PUT`), each `if (!studioClass) return respondError('Studio class not found', 404);`, with `if (!studioClass) return respondError('Studio class not found', 404, 'NOT_FOUND');`.

In `src/app/api/studio-class-templates/[id]/route.ts`, replace `:299-301`

```ts
  if (result.reason === 'archived') {
    return respondError('Unarchive the template before activating it', 409);
  }
```

with

```ts
  if (result.reason === 'archived') {
    return respondError('Unarchive this studio class before resuming it.', 409, 'TEMPLATE_ARCHIVED');
  }
```

- [ ] **Step 7: `ROOM_NOT_ON_LIST` at every site, and POST's re-read**

Each of the three route files gets its own one-line helper, the shape `class-templates/[id]/route.ts` already uses for `roomArchivedResponse`.

`src/app/api/classes/route.ts` — add after the imports (`:15`):

```ts
/**
 * The 400 for a `teacherRoomId` that is not one of this teacher's rooms:
 * never was, or was deleted before the create could hold it.
 */
function roomNotOnListResponse() {
  return respondError('That room is no longer in your rooms.', 400, 'ROOM_NOT_ON_LIST');
}
```

Replace `:80-82`

```ts
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }
```

with

```ts
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return roomNotOnListResponse();
  }
```

and `:192` `return respondError('Invalid teacher room', 400);` with `return roomNotOnListResponse();`. The comment above it ("Same message and status for the same reason") stays true.

`src/app/api/class-templates/[id]/route.ts`:
- add below `roomArchivedResponse` (after `:74`):

  ```ts
  /**
   * The 400 for a `teacherRoomId` that is not one of this teacher's rooms:
   * never was, or was deleted before the move could write it.
   */
  function roomNotOnListResponse() {
    return respondError('That room is no longer in your rooms.', 400, 'ROOM_NOT_ON_LIST');
  }
  ```
- replace `:193`, `:262` and `:317`'s `respondError('Invalid teacher room', 400)` with `roomNotOnListResponse()` (at `:317` the line becomes `if (result.reason === 'invalid_room') return roomNotOnListResponse();`);
- replace the comment `:335-336`

  ```ts
    // Exhaustiveness: a new UpdateClassTemplateResult variant becomes a compile
    // error here rather than being silently answered as "Invalid teacher room".
  ```

  with

  ```ts
    // Exhaustiveness: a new UpdateClassTemplateResult variant becomes a compile
    // error here rather than being silently answered as ROOM_NOT_ON_LIST.
  ```
- replace `:433-436`

  ```ts
      //   - `isArchived` — an ARCHIVED template on an archived room is refused
      //     by `archiveOrUnarchiveRule`'s own `archived` branch, whose message
      //     ("Unarchive the template before activating it") is the one the
      //     teacher can act on. Un-archiving the room accomplishes nothing for
  ```

  with

  ```ts
      //   - `isArchived` — an ARCHIVED template on an archived room is refused
      //     by `pauseOrResumeRule`'s own `archived` reason, whose
      //     `TEMPLATE_ARCHIVED` answer below is the one the
      //     teacher can act on. Un-archiving the room accomplishes nothing for
  ```
- replace `:520-522`

  ```ts
    if (result.reason === 'archived') {
      return respondError('Unarchive the template before activating it', 409);
    }
  ```

  with

  ```ts
    if (result.reason === 'archived') {
      return respondError('Unarchive this recurring class before resuming it.', 409, 'TEMPLATE_ARCHIVED');
    }
  ```

`src/app/api/class-templates/route.ts`:
- add after `SLOT_TAKEN` (`:47`):

  ```ts
  /**
   * The 400 for a `teacherRoomId` that is not one of this teacher's rooms:
   * never was, or was deleted before the insert could reference it.
   */
  function roomNotOnListResponse() {
    return respondError('That room is no longer in your rooms.', 400, 'ROOM_NOT_ON_LIST');
  }

  /** The 409 both room-archive checks in this file answer with. */
  function roomArchivedResponse() {
    return respondError(
      'This room is archived. Unarchive it to add a recurring class here.',
      409,
      'ROOM_ARCHIVED',
    );
  }

  /** The 503 for a create that lost a race and wrote nothing. */
  function templateCreateBusyResponse() {
    return respondError(
      'The system was busy and could not create this recurring class. Nothing was created. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }
  ```
- replace `:74-76`'s `return respondError('Invalid teacher room', 400);` with `return roomNotOnListResponse();`;
- replace `:88-92`

  ```ts
      return respondError(
        'This room is archived. Unarchive it to add a recurring class here.',
        409,
        'ROOM_ARCHIVED',
      );
  ```

  with `return roomArchivedResponse();`;
- replace the whole `catch` of the create (`:103-123`) with the three-outcome re-read `PUT` uses (`class-templates/[id]/route.ts:201-288`, #231). `body.teacherRoomId` is required by the schema, so `PUT`'s arm for a request that sent no room has no counterpart here:

  ```ts
    } catch (e) {
      if (
        isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room') ||
        isRestrictViolationOn(e, [CLASS_TEMPLATE_ROOM_FK])
      ) {
        // WHICH WAY THE ROOM MOVED, because the constraint name does not say.
        // The service ASSERTS `roomArchived: false`, so the room mirror's
        // foreign key refuses the row when the room changed after the
        // pre-check above: archived since, deleted since (#231), or archived at
        // the insert and open again by now, where a retry simply works. The
        // re-read tells those apart; a failure of the re-read itself rethrows
        // the constraint error rather than replacing it.
        let room: { isArchived: boolean } | null;
        try {
          room = await prisma.teacherRoom.findUnique({
            where: { id: body.teacherRoomId },
            select: { isArchived: true },
          });
        } catch (probeErr) {
          log.warn(
            { err: e, probeErr, teacherId: session.teacherId, teacherRoomId: body.teacherRoomId },
            'template create hit the room constraint, but the diagnostic re-read failed',
          );
          throw e;
        }
        if (room === null) {
          log.warn(
            { err: e, teacherId: session.teacherId, teacherRoomId: body.teacherRoomId },
            'template create target room vanished',
          );
          return roomNotOnListResponse();
        }
        if (room.isArchived) {
          log.warn(
            { err: e, teacherId: session.teacherId, teacherRoomId: body.teacherRoomId },
            'template create lost the room-archive race',
          );
          return roomArchivedResponse();
        }
        log.warn(
          { err: e, teacherId: session.teacherId, teacherRoomId: body.teacherRoomId },
          'template create lost a room-state race the other way; the room is open again',
        );
        return templateCreateBusyResponse();
      }
      throw e;
    }
  ```
- replace the `busy` branch `:133-139`

  ```ts
    if (!result.ok && result.reason === 'busy') {
      return respondError(
        'The system was busy and could not create this recurring class. Nothing was created. Wait a moment, then try again.',
        503,
        'TEMPLATE_BUSY',
      );
    }
  ```

  with

  ```ts
    if (!result.ok && result.reason === 'busy') {
      return templateCreateBusyResponse();
    }
  ```

`src/app/api/studio-classes/[id]/route.ts` (`DELETE`; Step 6 did `GET` and `PUT`):
- replace `:354` `if (!studioClass) return respondError('Studio class not found', 404);` with `if (!studioClass) return respondError('Studio class not found', 404, 'NOT_FOUND');`;
- replace `:403-407`

  ```ts
        // Not "not found": the teacher answered "yes, remove it" and the row is
        // gone, which is the end state they asked for. A red "Studio class not
        // found" under a successful removal reads as failure — the second half of
        // the confirm-then-silence family the button's docblock names.
        return respondError('That class is already gone.', 404);
  ```

  with

  ```ts
        // Gone, which is the end state the teacher asked for: the same code as
        // the read above, worded for someone who just confirmed the removal.
        return respondError('That class is already gone.', 404, 'NOT_FOUND');
  ```

- [ ] **Step 8: The two components**

`src/components/studio-class/delete-studio-class-button.tsx`:
- replace `:5` `import { readErrorMessage } from '@/lib/client-errors';` with `import { readError } from '@/lib/client-errors';`;
- replace `:68-74`

  ```tsx
      try {
        const res = await fetch(`/api/studio-classes/${studioClassId}`, { method: 'DELETE' });
        if (res.ok) removed = true;
        else setError(await readErrorMessage(res, 'Could not remove the class. Please try again.'));
      } catch {
        setError('Network error. Please try again.');
      }
  ```

  with

  ```tsx
      try {
        const res = await fetch(`/api/studio-classes/${studioClassId}`, { method: 'DELETE' });
        if (res.ok) {
          removed = true;
        } else {
          const { code, message } = await readError(res, 'Could not remove the class. Please try again.');
          // This button asked for the row to be gone, and NOT_FOUND says it is —
          // a second click or another tab got there first. Only this button may
          // read it that way: it is the one that asked.
          if (code === 'NOT_FOUND') removed = true;
          else setError(message);
        }
      } catch {
        setError('Network error. Please try again.');
      }
  ```
- replace `:85-87`

  ```tsx
      // Outside the `try` on purpose: inside it, a throw here would report a
      // removal the server COMMITTED as "Network error. Please try again.", and
      // the retry would then answer 404. `removing` is left set — the page is
  ```

  with

  ```tsx
      // Outside the `try` on purpose: inside it, a throw here would report a
      // removal the server COMMITTED as "Network error. Please try again." —
      // a failure message for a removal that happened. `removing` is left set — the page is
  ```

`src/components/studio-class/student-count-editor.tsx` — replace `:65-67`

```tsx
      {error
        ? <span className="type-caption text-danger mb-3.5">{error}</span>
        : success && <span className="type-caption text-teal mb-3.5">{success}</span>}
```

with

```tsx
      {error
        ? <span role="alert" className="type-caption text-danger mb-3.5">{error}</span>
        : success && <span className="type-caption text-teal mb-3.5">{success}</span>}
```

`src/components/settings/toggle-template-button.tsx` and `src/components/settings/toggle-studio-template-button.tsx` — the same two edits in each:
- replace `:5` `import { readErrorMessage } from '@/lib/client-errors';` with `import { readError } from '@/lib/client-errors';`;
- replace `:68-70`

  ```tsx
        } else {
          setError(await readErrorMessage(res, 'Failed to update. Please try again.'));
        }
  ```

  with

  ```tsx
        } else {
          const { code, message } = await readError(res, 'Failed to update. Please try again.');
          setError(message);
          // Only a page rendered before the archive offers this toggle on an
          // archived template; re-reading it replaces the control.
          if (code === 'TEMPLATE_ARCHIVED') router.refresh();
        }
  ```

- [ ] **Step 9: Run green**

```bash
pnpm run typecheck
pnpm exec vitest run --project unit src/lib/transition-refusal.test.ts "src/app/api/classes/[id]/route.test.ts" src/app/api/class-templates/route.test.ts "src/app/api/class-templates/[id]/vanished-room-double-race.test.ts" "src/app/api/class-templates/[id]/unknown-slot-holder.test.ts" "src/app/api/studio-class-templates/[id]/unknown-slot-holder.test.ts" src/services/class-lifecycle.test.ts src/lib/serial-tier-membership.test.ts
pnpm exec vitest run --project unit-sweeps src/app/api/classes/route.test.ts "src/app/api/classes/[id]/complete/route-lock-order.test.ts" "src/app/api/studio-classes/[id]/route-lock-order.test.ts"
pnpm exec vitest run --project components src/components/studio-class/delete-studio-class-button.test.tsx src/components/studio-class/student-count-editor.test.tsx src/components/settings/toggle-template-button.test.tsx src/components/settings/toggle-studio-template-button.test.tsx src/components/class/class-edit-form.test.tsx
pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
pnpm exec playwright test tests/e2e/class-edit.spec.ts
pnpm run lint
```

Expected: all PASS; typecheck and lint clean. (`src/app/api/classes/route.test.ts` is on `LOCK_CONTENTION_TESTS`, which is why it runs under `unit-sweeps`.)

- [ ] **Step 10: Commit**

```bash
git add src/lib/transition-refusal.ts src/lib/transition-refusal.test.ts src/services/class-lifecycle.ts "src/app/api/classes/[id]/route.ts" "src/app/api/classes/[id]/route.test.ts" src/app/api/classes/route.ts src/app/api/classes/route.test.ts src/app/api/class-templates/route.ts src/app/api/class-templates/route.test.ts "src/app/api/class-templates/[id]/route.ts" "src/app/api/class-templates/[id]/vanished-room-double-race.test.ts" "src/app/api/studio-class-templates/[id]/route.ts" "src/app/api/studio-classes/[id]/route.ts" "src/app/api/studio-classes/[id]/route-lock-order.test.ts" vitest.tiers.ts tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts tests/e2e/class-edit.spec.ts src/components/studio-class/delete-studio-class-button.tsx src/components/studio-class/delete-studio-class-button.test.tsx src/components/studio-class/student-count-editor.tsx src/components/studio-class/student-count-editor.test.tsx src/components/settings/toggle-template-button.tsx src/components/settings/toggle-template-button.test.tsx src/components/settings/toggle-studio-template-button.tsx src/components/settings/toggle-studio-template-button.test.tsx
git commit -m "fix(classes): coded refusals for class and template edits; POST template re-reads the room; a gone studio class is NOT_FOUND (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Prove the guards bite**

Warm each route before an integration run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "answers an unknown class with NOT_FOUND"` for `PUT /api/classes/[id]`, and `-t "rejects a signed-out caller"` in the same file for `POST /api/classes`; `pnpm exec vitest run --project integration tests/integration/class-templates-api.test.ts -t "unknown room with ROOM_NOT_ON_LIST"` for the template routes. Record each failure verbatim; restore with `git checkout -- <path>`; re-run green.

1. **Locked edits lose their code.** In `src/app/api/classes/[id]/route.ts`, change `'SETTINGS_LOCKED'` to `'CLASS_TERMINAL'`. Run `pnpm exec vitest run --project unit "src/app/api/classes/[id]/route.test.ts"` → `answers a locked economic edit with SETTINGS_LOCKED` fails on `code`. Warm, then `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "locked class"` → both locked cases fail on `code`.
2. **One state's words for both.** In the same file, change `frozenClassMessage(result.state)` to `frozenClassMessage('completed')`. Run the unit command → `answers a cancelled class with CLASS_TERMINAL …` fails: `expected 'This class has finished and can no longer be changed.' to be 'This class has been cancelled and can no longer be changed.'`.
3. **The service's not-found uncoded.** In the same file, change `if (result.reason === 'not_found') return classGone();` to `if (result.reason === 'not_found') return respondError('This class no longer exists.', 404);`. Unit command → `answers NOT_FOUND when the service finds the class gone` fails: `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
4. **POST's re-read collapsed.** In `src/app/api/class-templates/route.ts`, replace the body of the `if (isCheckViolationOn(…) || isRestrictViolationOn(…)) { … }` block with `return roomArchivedResponse();`. Run `pnpm exec vitest run --project unit src/app/api/class-templates/route.test.ts` → the gone case fails (`expected { status: 409, code: 'ROOM_ARCHIVED' } to deeply equal { status: 400, code: 'ROOM_NOT_ON_LIST' }`), the open-again case fails the same way against `TEMPLATE_BUSY`, and the probe-failure case fails with `expected 409 to be 500`.
5. **The probe error masks the constraint error.** In the same file, change the probe catch's `throw e;` to `throw probeErr;`. Same command → `rethrows the constraint error, not its own …` fails: the logged `err` is `Error: DB connection drop`, not the P2003.
6. **The service's invalid_room uncoded.** In `src/app/api/class-templates/[id]/route.ts`, change `if (result.reason === 'invalid_room') return roomNotOnListResponse();` to `if (result.reason === 'invalid_room') return respondError('That room is no longer in your rooms.', 400);`. Run `pnpm exec vitest run --project unit "src/app/api/class-templates/[id]/vanished-room-double-race.test.ts"` → `answers the service's invalid_room with ROOM_NOT_ON_LIST` fails on `code`.
7. **POST /api/classes' parked-delete site uncoded.** In `src/app/api/classes/route.ts`, change the `room_not_found` branch's `return roomNotOnListResponse();` to `return respondError('That room is no longer in your rooms.', 400);`. Run `pnpm exec vitest run --project unit-sweeps src/app/api/classes/route.test.ts` → fails on `code`.
8. **Archived template uncoded.** In `src/app/api/class-templates/[id]/route.ts`, delete `, 'TEMPLATE_ARCHIVED'` from the `archived` branch. Warm, then `pnpm exec vitest run --project integration tests/integration/class-templates-api.test.ts -t "archived template"` → `refuses to activate an archived template …` and `names the archived template, not the archived room …` fail: `expected { status: 409, code: undefined } to deeply equal { status: 409, code: 'TEMPLATE_ARCHIVED' }`.
9. **Studio twin: no P2025 catch.** In `src/app/api/studio-classes/[id]/route.ts`, delete the whole `if (isRecordNotFound(err)) { … }` block in `DELETE`. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/studio-classes/[id]/route-lock-order.test.ts"` → fails: `expected { status: 500, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
10. **Studio twin: catch without the code.** In the same file, change `return respondError('That class is already gone.', 404, 'NOT_FOUND');` to `return respondError('That class is already gone.', 404);`. Same command → fails on `code`.
11. **The button forgets its own NOT_FOUND.** In `src/components/studio-class/delete-studio-class-button.tsx`, replace `if (code === 'NOT_FOUND') removed = true;\n          else setError(message);` with `setError(message);` (and drop `code` from the destructure so lint stays quiet). Run `pnpm exec vitest run --project components src/components/studio-class/delete-studio-class-button.test.tsx` → `treats NOT_FOUND as done …` fails: `assign` was not called.
12. **No alert role.** In `src/components/studio-class/student-count-editor.tsx`, delete `role="alert" `. Run `pnpm exec vitest run --project components src/components/studio-class/student-count-editor.test.tsx` → `Unable to find role="alert"`.
13. **A frozen state with no sentence.** In `src/lib/transition-refusal.ts`, delete `case 'cancelled':` and the `return` under it in `frozenClassMessage`. `pnpm run typecheck` → `Type '"cancelled"' is not assignable to type 'never'`.
14. **The stale toggle stays stale.** In `src/components/settings/toggle-template-button.tsx`, delete the line `if (code === 'TEMPLATE_ARCHIVED') router.refresh();` (and `code` from the destructure). Run `pnpm exec vitest run --project components src/components/settings/toggle-template-button.test.tsx` → `refreshes the page on TEMPLATE_ARCHIVED …` fails: `expected "spy" to be called at least once`. Repeat for `toggle-studio-template-button.tsx` with its own test file.
15. **Every refusal refreshes.** In `toggle-template-button.tsx`, change `if (code === 'TEMPLATE_ARCHIVED') router.refresh();` to `router.refresh();`. Same command → `renders the server error message when the request fails` fails: `expected "spy" to not be called at all`.
16. **GET's not-found uncoded.** In `src/app/api/classes/[id]/route.ts`, change `GET`'s `if (!cls) return classGone();` back to `if (!cls) return respondError('Class not found', 404);`. Warm with `-t "GET answers an unknown class"`, then run it → `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`. The same mutation on `studio-classes/[id]/route.ts:45` fails `GET answers an unknown studio class with NOT_FOUND` in `tests/integration/studio-api.test.ts`.

---
### Task 4: Payments

The four payment doors — `POST /api/payments/[id]/{paid,unpaid,not-charged,remind}` — stop answering an already-done request with a 409. Each service decides what happened in the branch where its compare-and-swap matched nothing, and it already re-reads the row there. The route's ownership gate has run before the service is called, so the §5.1 order holds on every door:

| Door | 1. gates (route) | 2. moot (service) | 3. unchanged (service) | 4. other refusals (service) |
|---|---|---|---|---|
| `/paid` | session → own read (404 `NOT_FOUND` / 403) → body (400) | — | `paid` with the same `method` | `paid` with another method → `PAYMENT_ALREADY_PAID`; `not_charged` → `PAYMENT_WAIVED` |
| `/not-charged` | session → own read | — | `not_charged` | `paid` → `PAYMENT_ALREADY_PAID` |
| `/unpaid` | session → own read | — | `pending` or `overdue` | — |
| `/remind` | session → own read | settled (`paid` / `not_charged`) → `PAYMENT_SETTLED` | outstanding, with a stamp inside the cooldown | — |

On every door, the service's own "row gone" answer is `NOT_FOUND` (404). The route sends the same code and copy from its own read, and so does the non-mutating `GET /api/payments/[id]`, so the resource has one not-found body. Every door has one more answer: the swap missed, but the re-read finds a state the swap would have accepted, so another action landed between the two statements. That answer is `CONCURRENT_MODIFICATION` (409). Neither "done" nor a status refusal would be true of that row.

The service owns each refusal's code and copy, as `STUDIO_CLASS_REFUSALS` (`services/studio-class-deletion.ts`) does. The routes get the status from the registry (`API_ERROR_STATUS[code]`) through one shared responder, in `src/app/api/payments/[id]/shared.ts`. That follows the `invitations/[id]/shared.ts` precedent, because a `route.ts` may export only HTTP verbs.

`PaymentResult` stays exactly as it is. After this task its only user is `markPaymentOverdue`, which has no non-test caller (spec §10). That function, its type and its tests (`payments.test.ts:191-214`) are untouched and still compile.

**Files:**
- Create: `src/app/api/payments/[id]/shared.ts`, `src/app/api/payments/[id]/shared.test.ts`, `src/components/class/send-reminder-button.test.tsx`
- Modify: `src/services/payments.ts`:
  - `:15`: the import gains `isOutstanding`.
  - after `:23`: new `PaymentRefusal`, `PaymentOutcome`, `PAYMENT_GONE`, `PAYMENT_CHANGED`.
  - `:75-108`: `markPaymentPaid`.
  - `:139-171`: `reopenPayment`.
  - `:173-206`: `markPaymentNotCharged`.
  - `:228-316`: `sendPaymentReminder`.
- Modify (whole file, each): `src/app/api/payments/[id]/paid/route.ts`, `src/app/api/payments/[id]/unpaid/route.ts`, `src/app/api/payments/[id]/not-charged/route.ts`, `src/app/api/payments/[id]/remind/route.ts`
- Modify: `src/app/api/payments/[id]/route.ts` (the GET): `:11` (import), `:40` (its 404 becomes `NOT_FOUND` with the same copy as the four POSTs)
- Modify: `src/lib/use-payment-actions.ts:8-16` (docblock), `:107-112` (comment)
- Modify: `src/components/class/mark-unpaid-button.tsx:37-43` (comment), `:126` (`role="alert"`)
- Modify: `src/components/class/send-reminder-button.tsx:36-37` (docblock), `:77-80` (comment)
- Modify: `src/components/students/student-payment-list.tsx:31` (`role="alert"`)
- Test:
  - `src/services/payments.test.ts`: `:3-13`, after `:19`, `:170-189`, `:216-248`, `:258-259`, `:273-276`, `:423-469`, `:513-581`.
  - `tests/integration/payments-api.test.ts`: `:1-5`, after `:124`, after `:185`, `:240-299`, `:351-355`, `:393-404`, `:409-425`, `:433-436`, `:451-469`, `:476-479`, `:487-490`, `:500-519`, `:537-540`, `:550-598`.
  - `tests/integration/full-flow.test.ts:328-335`.
  - `src/components/class/mark-unpaid-button.test.tsx:205-239`.
  - `src/components/class/outstanding-payment-row.test.tsx`: `:246-259`, `:324-325`, `:330`, `:407-427`, `:509-528`.
  - `src/components/students/student-payment-list.test.tsx`: `:2-3` (imports), and a new test before the closing `});` at `:77`.
  - `src/components/settings/add-room-flow.test.tsx:175` (a stale line-number pointer into `use-payment-actions.ts` names `markPaid` instead).
- Unchanged, checked:
  - `src/components/class/outstanding-payment-row.tsx`, `payment-checklist.tsx` and `src/components/students/student-payment-list.tsx`. All three reach the endpoints only through `usePaymentActions`, which branches on `res.ok`. An unchanged 200 takes the success branch, and `undo` reads `data.status` from it, which the unchanged body carries. The only change among the three is `student-payment-list.tsx`'s `role="alert"`.
  - `received-payment-row.tsx` and `not-charged-payment-row.tsx` only render `MarkUnpaidButton`.
  - `src/services/payment-reminders.ts` calls none of the four functions.
  - `tests/e2e/teacher-journey.spec.ts` asserts only `resp.ok()` on these doors.

**Interfaces:**
- Consumes (Task 1):
  - `API_ERROR_STATUS` (value) from `@/lib/api-error-codes`.
  - `respondUnchanged<T>(data)` and `respondError(message, status, code?)` from `@/lib/api-utils`.
  - `readErrorMessage` from `@/lib/client-errors` (already imported by every client here; Task 1 reimplements it over `readError`).
  - `expectRefusal(res, code)`, `expectUnchanged(res)` and `expectApplied(res, status?)` from `tests/api-assertions.ts`.
  - Registry codes: `NOT_FOUND` (404), `CONCURRENT_MODIFICATION`, `PAYMENT_ALREADY_PAID`, `PAYMENT_SETTLED`, `PAYMENT_WAIVED` (all 409). All are already registered by Task 1, so this task adds no registry entry.
- Produces (`src/services/payments.ts`):
  ```ts
  export type PaymentRefusal = {
    readonly code:
      | 'CONCURRENT_MODIFICATION'
      | 'NOT_FOUND'
      | 'PAYMENT_ALREADY_PAID'
      | 'PAYMENT_SETTLED'
      | 'PAYMENT_WAIVED';
    readonly message: string;
  };
  export type PaymentOutcome =
    | { readonly kind: 'applied'; readonly payment: Payment }
    | { readonly kind: 'unchanged'; readonly payment: Payment }
    | { readonly kind: 'refused'; readonly refusal: PaymentRefusal };
  export const PAYMENT_GONE: PaymentRefusal;
  export async function markPaymentPaid(db: PrismaClient, paymentId: string, method: string): Promise<PaymentOutcome>;
  export async function reopenPayment(db: PrismaClient, paymentId: string): Promise<PaymentOutcome>;
  export async function markPaymentNotCharged(db: PrismaClient, paymentId: string): Promise<PaymentOutcome>;
  export async function sendPaymentReminder(db: PrismaClient, paymentId: string): Promise<PaymentOutcome>;
  // unchanged: PaymentResult, markPaymentOverdue
  ```
- Produces (`src/app/api/payments/[id]/shared.ts`):
  ```ts
  export function respondPaymentRefusal(refusal: PaymentRefusal): NextResponse;
  export function respondPaymentOutcome(outcome: PaymentOutcome): NextResponse;
  ```
- Every caller of the four changed functions (`rg -n "markPaymentPaid|markPaymentNotCharged|reopenPayment|sendPaymentReminder" src tests`):
  - the four routes (rewritten below);
  - `src/services/payments.test.ts` (rewritten below);
  - `tests/integration/full-flow.test.ts:328` (rewritten below, Step 2).
  
  Nothing else calls them. The GET route (`src/app/api/payments/[id]/route.ts`) calls none of them, but it uses `PAYMENT_GONE` and `respondPaymentRefusal` for its 404 (Step 6).

- [ ] **Step 1: Service and responder tests (unit): write the new ones, rewrite the ones this change breaks**

In `src/services/payments.test.ts`:

(a) `:3-13` — the import from `./payments` gains the two types:

```ts
import {
  markPaymentPaid,
  markPaymentOverdue,
  reopenPayment,
  markPaymentNotCharged,
  sendPaymentReminder,
  getOutstandingPayments,
  getPaymentsForClass,
  countOutstandingPaymentsForStudent,
  MANUAL_REMIND_COOLDOWN_MS,
  type PaymentOutcome,
  type PaymentRefusal,
} from './payments';
```

(b) After `:19` (`const uniqueSuffix = Date.now();`), insert:

```ts

/** The row an `applied` or `unchanged` outcome carries; throws, naming the outcome, otherwise. */
function paymentOf(outcome: PaymentOutcome, kind: 'applied' | 'unchanged'): Payment {
  if (outcome.kind === 'refused' || outcome.kind !== kind) {
    throw new Error(`expected ${kind}, got ${JSON.stringify(outcome)}`);
  }
  return outcome.payment;
}

/** The code a refused outcome carries; throws, naming the outcome, otherwise. */
function refusalCode(outcome: PaymentOutcome): PaymentRefusal['code'] {
  if (outcome.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return outcome.refusal.code;
}

/**
 * A client whose `payment.updateMany` runs `between` once, after the write and
 * before anything else: the window in which a concurrent action lands between
 * a service's compare-and-swap and its re-read. `fired` says whether it ran, so
 * a test can tell its interleaving from a hook that never fired.
 *
 * `$extends` returns a client missing `$on`, so the result is cast to the
 * `PrismaClient` the services take; every method they call is the real one.
 */
function interposeAfterPaymentWrite(between: () => Promise<unknown>): {
  db: PrismaClient;
  fired: () => boolean;
} {
  let armed = true;
  const db = prisma.$extends({
    query: {
      payment: {
        async updateMany({ args, query }) {
          const result = await query(args);
          if (armed) {
            armed = false;
            await between();
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
  return { db, fired: () => !armed };
}
```

(c) Replace `:170-189` with the following tests. Old: `markPaymentPaid rejects invalid status transition` sent `'cash'` to a row paid with `'bank_transfer'` and asserted `expect(result.error).toContain('paid')`. It is now two tests, one per branch.

```ts
  it('markPaymentPaid updates status, method, and paidAt', async () => {
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'bank_transfer'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('bank_transfer');
    expect(payment.paidAt).not.toBeNull();
  });

  it('markPaymentPaid answers unchanged for a payment already paid that way, writing nothing', async () => {
    // Paid with 'bank_transfer' by the previous test.
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'bank_transfer'), 'unchanged');

    expect(payment.method).toBe('bank_transfer');
    expect(payment.paidAt).toEqual(before.paidAt);
    expect(payment.updatedAt).toEqual(before.updatedAt);
  });

  it('markPaymentPaid refuses a paid payment when the method differs', async () => {
    expect(refusalCode(await markPaymentPaid(prisma, paymentId, 'cash'))).toBe('PAYMENT_ALREADY_PAID');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(row.method).toBe('bank_transfer');
  });
```

(d) Replace `:216-248` with the block below.
- `:218-224`: old `expect(result.ok).toBe(true)` becomes `paymentOf(…, 'applied')`.
- `:229-236`: the same change.
- `:239-243`: old `reopenPayment rejects when the payment is already outstanding` with `expect(result.ok).toBe(false)` becomes an unchanged test.
- `:246-247`: `.ok` becomes `paymentOf`.

```ts
  it('markPaymentPaid allows transition from overdue', async () => {
    // Payment is currently 'overdue' — should be allowed to mark as paid
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'cash'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('cash');
  });

  it('reopenPayment undoes a mistaken mark: paid → pending, fields cleared', async () => {
    // paymentId is 'paid' from the previous test
    const payment = paymentOf(await reopenPayment(prisma, paymentId), 'applied');

    expect(payment.status).toBe('pending');
    expect(payment.method).toBeNull();
    expect(payment.paidAt).toBeNull();
  });

  it('reopenPayment answers unchanged when the payment is already outstanding', async () => {
    // now 'pending' after the undo above
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const payment = paymentOf(await reopenPayment(prisma, paymentId), 'unchanged');

    expect(payment.status).toBe('pending');
    expect(payment.updatedAt).toEqual(before.updatedAt);
  });

  it('re-marking paid after an undo works', async () => {
    expect(paymentOf(await markPaymentPaid(prisma, paymentId, 'cash'), 'applied').status).toBe('paid');
  });
```

(e) `:258-259`. The row is `paid` and has never been reminded.

Old:
```ts
    const result = await sendPaymentReminder(prisma, paymentId);
    expect(result.ok).toBe(false);
```
New:
```ts
    expect(refusalCode(await sendPaymentReminder(prisma, paymentId))).toBe('PAYMENT_SETTLED');
```

(f) `:273-276`.

Old:
```ts
    const result = await sendPaymentReminder(prisma, paymentId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the reminder to send');
    expect(result.payment.reminderSentAt).not.toBeNull();
```
New:
```ts
    const payment = paymentOf(await sendPaymentReminder(prisma, paymentId), 'applied');
    expect(payment.reminderSentAt).not.toBeNull();
```

(g) Replace `:423-469`, the three tests inside `describe('manual reminder cooldown')`, with the block below.
- `:423-438`: `expect(second.ok).toBe(false)` flips to an unchanged test.
- `:442` and `:450`: `.ok` becomes `paymentOf`.
- `:458-469`: `expect(refused.error).toContain('"paid"')` becomes a code assertion.
- Four tests are new.

```ts
    it('answers a second manual reminder inside the cooldown unchanged, sending nothing', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('inside');
      const first = paymentOf(await sendPaymentReminder(prisma, id), 'applied');

      const second = await sendPaymentReminder(prisma, id);

      // The notification count comes before the outcome assertion, deliberately:
      // the defect is a student dunned twice for one debt, and this is the
      // assertion whose failure message names it.
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
      const repeated = paymentOf(second, 'unchanged');
      expect(repeated.reminderSentAt).toEqual(first.reminderSentAt);
      expect(repeated.updatedAt).toEqual(first.updatedAt);
    });

    it('answers unchanged to a fresh stamp it did not write, sending nothing', async () => {
      // `reminderSentAt` is the column the overdue sweep stamps too.
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('swept');
      const sweptAt = new Date();
      await prisma.payment.update({
        where: { id },
        data: { status: 'overdue', reminderSentAt: sweptAt },
      });

      const result = await sendPaymentReminder(prisma, id);

      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(0);
      expect(paymentOf(result, 'unchanged').reminderSentAt).toEqual(sweptAt);
    });

    it('allows a manual reminder once the cooldown has lapsed', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('lapsed');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');

      // Backdate the stamp past the window rather than sleeping two minutes.
      await prisma.payment.update({
        where: { id },
        data: { reminderSentAt: new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS - 1000) },
      });

      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(2);
    });

    it('refuses a just-reminded payment that was settled with PAYMENT_SETTLED, not unchanged', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('settled');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      await prisma.payment.update({ where: { id }, data: { status: 'paid' } });

      // Both terms of the WHERE now fail at once. Settled makes the reminder
      // moot, so it answers first: `unchanged` would report a reminder on a
      // payment that no longer needs one.
      expect(refusalCode(await sendPaymentReminder(prisma, id))).toBe('PAYMENT_SETTLED');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
    });

    it('refuses a not-charged payment with PAYMENT_SETTLED, sending nothing', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('waived');
      await prisma.payment.update({
        where: { id },
        data: { status: 'not_charged', notChargedAt: new Date() },
      });

      expect(refusalCode(await sendPaymentReminder(prisma, id))).toBe('PAYMENT_SETTLED');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(0);
    });

    it('refuses with CONCURRENT_MODIFICATION when the stamp it missed is gone by its re-read', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('raced');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      const racing = interposeAfterPaymentWrite(() =>
        prisma.payment.update({ where: { id }, data: { reminderSentAt: null } }),
      );

      const result = await sendPaymentReminder(racing.db, id);

      expect(racing.fired()).toBe(true);
      // `unchanged` would claim a reminder went out moments ago; the row no
      // longer says so.
      expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
    });
```

(h) Replace `:513-581` (the `describe('markPaymentNotCharged')` and `describe('reopenPayment')` blocks and the closing `});` of `describe('markPaymentNotCharged / reopenPayment')`) with the block below.
- `:517`, `:526`, `:557` and `:566`: `.ok` becomes `paymentOf`.
- `:532-535`: the exact `'Cannot mark as not charged: …'` pin becomes `PAYMENT_ALREADY_PAID`.
- `:541`: `ok` false becomes unchanged.
- `:547-550`: the exact `'Cannot mark payment as paid: …'` pin becomes `PAYMENT_WAIVED`.
- `:575-578`: the exact `'Cannot undo: …'` pin becomes unchanged, for both unpaid statuses.
- The race `describe` and the not-found `describe` are new.

```ts
    describe('markPaymentNotCharged', () => {
      it('settles a pending payment and stamps notChargedAt', async () => {
        const payment = await makePayment('pending');
        paymentOf(await markPaymentNotCharged(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('not_charged');
        expect(row.notChargedAt).not.toBeNull();
        expect(row.paidAt).toBeNull();
      });

      it('settles an overdue payment', async () => {
        const payment = await makePayment('overdue');
        expect(paymentOf(await markPaymentNotCharged(prisma, payment.id), 'applied').status).toBe(
          'not_charged',
        );
      });

      it('refuses a paid payment with PAYMENT_ALREADY_PAID — that would be a refund', async () => {
        const payment = await makePayment('paid');
        expect(refusalCode(await markPaymentNotCharged(prisma, payment.id))).toBe(
          'PAYMENT_ALREADY_PAID',
        );
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('paid');
        expect(row.notChargedAt).toBeNull();
      });

      it('answers a payment already not charged unchanged, writing nothing', async () => {
        const payment = await makePayment('not_charged');
        const row = paymentOf(await markPaymentNotCharged(prisma, payment.id), 'unchanged');
        expect(row.notChargedAt).toEqual(payment.notChargedAt);
        expect(row.updatedAt).toEqual(payment.updatedAt);
      });

      it('markPaymentPaid refuses a not-charged payment with PAYMENT_WAIVED', async () => {
        const payment = await makePayment('not_charged');
        expect(refusalCode(await markPaymentPaid(prisma, payment.id, 'cash'))).toBe('PAYMENT_WAIVED');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('not_charged');
      });
    });

    describe('reopenPayment', () => {
      it('returns a paid payment to pending, clearing method and paidAt', async () => {
        const payment = await makePayment('paid');
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('pending');
        expect(row.paidAt).toBeNull();
        expect(row.method).toBeNull();
      });

      it('returns a not-charged payment to pending, clearing notChargedAt', async () => {
        const payment = await makePayment('not_charged');
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('pending');
        expect(row.notChargedAt).toBeNull();
      });

      it.each(['pending', 'overdue'] as const)(
        'answers a %s payment unchanged, carrying its status and writing nothing',
        async (status) => {
          const payment = await makePayment(status);
          const row = paymentOf(await reopenPayment(prisma, payment.id), 'unchanged');
          expect(row.status).toBe(status);
          expect(row.updatedAt).toEqual(payment.updatedAt);
        },
      );
    });

    /**
     * A compare-and-swap that misses, then a re-read that finds a state the
     * swap would have accepted: another action landed between the two
     * statements, and neither "already done" nor a status refusal is true of
     * that row.
     */
    describe('a write that lands between the swap and the re-read', () => {
      it('markPaymentPaid: a paid payment reopened in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('paid');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'pending', method: null, paidAt: null },
          }),
        );

        const result = await markPaymentPaid(racing.db, payment.id, 'cash');

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });

      it('markPaymentNotCharged: a not-charged payment reopened in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('not_charged');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'pending', notChargedAt: null },
          }),
        );

        const result = await markPaymentNotCharged(racing.db, payment.id);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });

      it('reopenPayment: a pending payment settled in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('pending');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'paid', method: 'cash', paidAt: new Date() },
          }),
        );

        const result = await reopenPayment(racing.db, payment.id);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });
    });
  });

  /**
   * The service's own not-found answer. No code in `src/` deletes a
   * `Payment`, and each route reads the row before calling in, so this is
   * where it is pinned; `api/payments/[id]/shared.test.ts` pins its status.
   */
  describe('a payment that does not exist', () => {
    const UNKNOWN_PAYMENT_ID = '00000000-0000-4000-8000-000000000000';

    it.each([
      ['markPaymentPaid', () => markPaymentPaid(prisma, UNKNOWN_PAYMENT_ID, 'cash')],
      ['markPaymentNotCharged', () => markPaymentNotCharged(prisma, UNKNOWN_PAYMENT_ID)],
      ['reopenPayment', () => reopenPayment(prisma, UNKNOWN_PAYMENT_ID)],
      ['sendPaymentReminder', () => sendPaymentReminder(prisma, UNKNOWN_PAYMENT_ID)],
    ] as const)('%s answers NOT_FOUND', async (_name, act) => {
      expect(refusalCode(await act())).toBe('NOT_FOUND');
    });
  });
```

(The next line after this block is the existing `});` that closes `describe('Payment Service (DB)')`, formerly `:582`.)

Create `src/app/api/payments/[id]/shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma, type Payment } from '@prisma/client';
import { respondPaymentOutcome } from './shared';
import { PAYMENT_GONE, type PaymentRefusal } from '@/services/payments';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';

const payment: Payment = {
  id: 'pay-1',
  registrationId: 'reg-1',
  amount: new Prisma.Decimal('12.50'),
  status: 'paid',
  method: 'cash',
  processorRef: null,
  reminderSentAt: null,
  paidAt: new Date('2026-09-01T10:00:00.000Z'),
  notChargedAt: null,
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
  updatedAt: new Date('2026-09-01T10:00:00.000Z'),
};

describe('respondPaymentOutcome', () => {
  it('answers an applied action 200 with the row and no outcome', async () => {
    const data = await expectApplied(respondPaymentOutcome({ kind: 'applied', payment }));
    expect(data).toMatchObject({ id: 'pay-1', status: 'paid', method: 'cash' });
  });

  it('answers an unchanged action 200 with the row and outcome unchanged', async () => {
    const data = await expectUnchanged(respondPaymentOutcome({ kind: 'unchanged', payment }));
    expect(data).toMatchObject({ id: 'pay-1', status: 'paid', method: 'cash' });
  });

  // No request reaches the service's own not-found answer (each route reads
  // the row first), so its status is pinned here.
  it('answers a vanished payment 404 NOT_FOUND', async () => {
    await expectRefusal(respondPaymentOutcome({ kind: 'refused', refusal: PAYMENT_GONE }), 'NOT_FOUND');
  });

  it.each([
    'CONCURRENT_MODIFICATION',
    'PAYMENT_ALREADY_PAID',
    'PAYMENT_SETTLED',
    'PAYMENT_WAIVED',
  ] as const satisfies readonly PaymentRefusal['code'][])(
    'answers a %s refusal at its registered status',
    async (code) => {
      await expectRefusal(
        respondPaymentOutcome({ kind: 'refused', refusal: { code, message: 'Words.' } }),
        code,
      );
    },
  );
});
```

- [ ] **Step 2: Route tests (integration): write the new ones, rewrite the ones this change breaks**

In `tests/integration/payments-api.test.ts`:

(a) `:1-5` — add two imports after `import { createClassFixture } from '../class-fixtures';`:

```ts
import { MANUAL_REMIND_COOLDOWN_MS } from '@/services/payments';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
```

(b) After the file-level `afterAll` (ends `:124`), insert:

```ts

/**
 * An ownership refusal, with no `unchanged` answer ahead of it. Each door runs
 * this in a state where the unchanged condition holds, which is the only way a
 * check placed above the ownership gate becomes visible.
 */
async function expectForbidden(res: Response): Promise<void> {
  const body = (await res.json()) as { outcome?: unknown };
  expect({ status: res.status, outcome: body.outcome }).toEqual({ status: 403, outcome: undefined });
}
```

(b2) `describe('GET /api/payments, /api/payments/[id], /api/classes/[id]/payments')` has no test for the GET's own 404. After `:185` (the end of `it("GET /api/payments/[id] 403s another teacher's payment"`), insert:

```ts

  it('GET /api/payments/[id] 404s an unknown payment with NOT_FOUND', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/00000000-0000-4000-8000-000000000000`, {
      headers: cookie(teacherToken),
    });
    await expectRefusal(res, 'NOT_FOUND');
  });
```

(c) `describe('POST /api/payments/[id]/remind')`:

`:240-246`. Old: `expect(res.status).toBe(404);`. New: `await expectRefusal(res, 'NOT_FOUND');`.

`:266-268`. Old:
```ts
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { reminderSentAt: string | null } };
    expect(data.reminderSentAt).not.toBeNull();
```
New:
```ts
    const data = (await expectApplied(res)) as { reminderSentAt: string | null };
    expect(data.reminderSentAt).not.toBeNull();
```

Replace `:280-299`. Old: `409s a payment that is already paid, sending nothing` asserted `expect(res.status).toBe(409)`. The new block inserts the retry test and the ordering test ahead of the rewritten settled test.

```ts
  it('answers a retry inside the cooldown unchanged, with the stamp, sending nothing', async () => {
    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    const data = (await expectUnchanged(res)) as { reminderSentAt: string | null };
    expect(data.reminderSentAt).toBe(stamped.reminderSentAt!.toISOString());

    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      }),
    ).toBe(before);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.reminderSentAt).toEqual(stamped.reminderSentAt);
    expect(after.updatedAt).toEqual(stamped.updatedAt);
  });

  it("403s another teacher's reminder inside the cooldown rather than answering unchanged", async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(otherTeacherToken),
    });
    await expectForbidden(res);
  });

  it('refuses a settled payment inside the cooldown with PAYMENT_SETTLED, sending nothing', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid' } });
    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // Both the settled refusal and the unchanged answer fit this row, which
    // the reminder above stamped moments ago. Settled makes the reminder moot,
    // so it answers.
    expect(Date.now() - settled.reminderSentAt!.getTime()).toBeLessThan(MANUAL_REMIND_COOLDOWN_MS);
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    await expectRefusal(res, 'PAYMENT_SETTLED');

    const after = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(after).toBe(before);

    // Leave the fixture pending for cleanup symmetry.
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending' } });
  });
```

The #196 race, `:351-355`. Old:
```ts
      // The handshake, without which the lever is decorative: `$transaction`
      // returns before its callback has run, and a fresh `PrismaClient` has
      // to connect and start its engine first (50-200ms, measured), so both
      // requests could finish before the row was ever locked — and the second
      // would then 409 off its own pre-check rather than off the CAS.
```
New:
```ts
      // The handshake, without which the lever is decorative: `$transaction`
      // returns before its callback has run, and a fresh `PrismaClient` has
      // to connect and start its engine first (50-200ms, measured), so both
      // requests could finish before the row was ever locked — and the second
      // would then find the first's stamp already committed, never meeting it
      // inside the CAS.
```

`:393-404`. Old:
```ts
      // Asserted before the status pair, deliberately: the defect is a student
      // dunned twice for one debt, and this is the assertion whose failure
      // message names it. With the statuses first, removing the guard fails on
      // `[200, 200]`, which reports two successful requests without saying
      // what that cost anyone.
      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: raceStudentId, type: 'reminder' },
      });
      expect(notifications).toHaveLength(1);

      // Either request can win, so the loser is identified rather than assumed.
      expect([a.status, b.status].sort()).toEqual([200, 409]);
```
New:
```ts
      // Asserted before the outcomes, deliberately: the defect is a student
      // dunned twice for one debt, and this is the assertion whose failure
      // message names it. With the outcomes first, removing the guard fails on
      // a missing `unchanged`, which says nothing about what that cost anyone.
      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: raceStudentId, type: 'reminder' },
      });
      expect(notifications).toHaveLength(1);

      // Either request can win, so the loser is identified rather than assumed:
      // both answer 200, and exactly one says it changed nothing.
      expect([a.status, b.status]).toEqual([200, 200]);
      const bodies = (await Promise.all([a.json(), b.json()])) as {
        data: { reminderSentAt: string };
        outcome?: string;
      }[];
      expect(bodies.map((body) => body.outcome ?? 'applied').sort()).toEqual([
        'applied',
        'unchanged',
      ]);
      // The loser carries the winner's stamp, not one of its own.
      expect(bodies[0]!.data.reminderSentAt).toBe(bodies[1]!.data.reminderSentAt);
```

(d) After `const notCharged = …;` (ends `:425`), add:

```ts
/** The keys of a payment row on the wire — the applied and unchanged answers carry the same ones. */
const PAYMENT_ROW_KEYS = [
  'amount',
  'createdAt',
  'id',
  'method',
  'notChargedAt',
  'paidAt',
  'processorRef',
  'registrationId',
  'reminderSentAt',
  'status',
  'updatedAt',
];
```

(e) `describe('POST /api/payments/[id]/paid')`:

`:433-436`. Old: `expect(res.status).toBe(404);`. New: `await expectRefusal(res, 'NOT_FOUND');`.

`:453-455`. Old:
```ts
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string } };
    expect(data.status).toBe('paid');
```
New:
```ts
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('paid');
```

Replace `:463-469`. Old: `409s re-marking a payment that is already paid` asserted `expect(res.status).toBe(409)`. New:

```ts
  it('answers the same mark unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string; method: string | null };
    expect(data).toMatchObject({ status: 'paid', method: 'cash' });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('paid');
    expect(after.method).toBe('cash');
    expect(after.paidAt).toEqual(before.paidAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's identical mark rather than answering unchanged", async () => {
    const res = await paid(otherTeacherToken, paymentId);
    await expectForbidden(res);
  });

  it('refuses a mark with another method: PAYMENT_ALREADY_PAID', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId, { method: 'bank_transfer' });
    await expectRefusal(res, 'PAYMENT_ALREADY_PAID');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.method).toBe('cash');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('refuses a not-charged payment: PAYMENT_WAIVED', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'not_charged', method: null, paidAt: null, notChargedAt: new Date() },
    });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId);
    await expectRefusal(res, 'PAYMENT_WAIVED');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('not_charged');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
```

(f) `describe('POST /api/payments/[id]/unpaid')`:

`:476-479` — the `beforeAll` also clears `notChargedAt`, which the PAYMENT_WAIVED test above set.

Old:
```ts
      data: { status: 'paid', method: 'cash', paidAt: new Date() },
```
New:
```ts
      data: { status: 'paid', method: 'cash', paidAt: new Date(), notChargedAt: null },
```

`:487-490`. Old: `expect(res.status).toBe(404);`. New: `await expectRefusal(res, 'NOT_FOUND');`.

`:502-504`. Old:
```ts
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string } };
    expect(data.status).toBe('pending');
```
New:
```ts
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('pending');
```

Replace `:510-519`. Old: `409s a payment that is already pending` asserted `expect(res.status).toBe(409)`. New:

```ts
  it('answers an undo of a pending payment unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string };
    expect(data.status).toBe('pending');

    // Read BEFORE any restore: an unchanged answer must have written nothing.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('pending');
    expect(after.method).toBeNull();
    expect(after.paidAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('answers an undo of an overdue payment unchanged, carrying its status', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'overdue' } });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string };
    expect(data.status).toBe('overdue');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('overdue');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's undo of an unpaid payment rather than answering unchanged", async () => {
    const res = await unpaid(otherTeacherToken, paymentId);
    await expectForbidden(res);
  });
```

(g) `describe('POST /api/payments/[id]/not-charged')` (its `beforeAll` already resets to `pending`):

`:537-540`. Old: `expect(res.status).toBe(404);`. New: `await expectRefusal(res, 'NOT_FOUND');`.

Replace `:550-598` (from `it('marks a payment not charged'` through the end of `it('reverses a not-charged payment through /unpaid'`) with the block below.
- The applied test reads its body through `expectApplied`, and its inline key list becomes `PAYMENT_ROW_KEYS`.
- Old `409s a payment that is already not charged` (`expect(res.status).toBe(409)`) becomes the unchanged test.
- The ordering test and the `PAYMENT_ALREADY_PAID` test are new.

```ts
  it('marks a payment not charged', async () => {
    const res = await notCharged(teacherToken, paymentId);
    const data = (await expectApplied(res)) as Record<string, unknown>;
    expect(data.status).toBe('not_charged');
    // The key-allowlist assertion mirrors the existing key-allowlist
    // assertions elsewhere in this file — it is how this repo catches a
    // widened `select`, and
    // `notChargedAt` joining the row is exactly the kind of change it exists
    // to notice.
    expect(Object.keys(data).sort()).toEqual(PAYMENT_ROW_KEYS);

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.status).toBe('not_charged');
    expect(stamped.notChargedAt).not.toBeNull();
  });

  it('answers a payment already not charged unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await notCharged(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(PAYMENT_ROW_KEYS);
    expect(data.status).toBe('not_charged');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('not_charged');
    expect(after.notChargedAt).toEqual(before.notChargedAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's mark on a payment already not charged rather than answering unchanged", async () => {
    const res = await notCharged(otherTeacherToken, paymentId);
    await expectForbidden(res);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('not_charged');
  });

  it('reverses a not-charged payment through /unpaid', async () => {
    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('pending');

    const reverted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(reverted.status).toBe('pending');
    expect(reverted.notChargedAt).toBeNull();
  });

  it('refuses a paid payment: PAYMENT_ALREADY_PAID', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'paid', method: 'cash', paidAt: new Date() },
    });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await notCharged(teacherToken, paymentId);
    await expectRefusal(res, 'PAYMENT_ALREADY_PAID');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('paid');
    expect(after.notChargedAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
```

In `tests/integration/full-flow.test.ts`, replace `:328-335`. Old:
```ts
    const result = await markPaymentPaid(prisma, paymentId, 'bank_transfer');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe('paid');
      expect(result.payment.method).toBe('bank_transfer');
      expect(result.payment.paidAt).not.toBeNull();
    }
```
New:
```ts
    const result = await markPaymentPaid(prisma, paymentId, 'bank_transfer');

    expect(result.kind).toBe('applied');
    if (result.kind === 'applied') {
      expect(result.payment.status).toBe('paid');
      expect(result.payment.method).toBe('bank_transfer');
      expect(result.payment.paidAt).not.toBeNull();
    }
```

- [ ] **Step 3: Run the new tests to see them fail**

Run: `pnpm exec vitest run --project unit src/services/payments.test.ts "src/app/api/payments/[id]/shared.test.ts"`

Expected: FAIL.
- `shared.test.ts` fails with `Failed to resolve import "./shared"`.
- In `payments.test.ts`, every rewritten or new test for the four actions fails with one of:
  - `Error: expected applied, got {"ok":true,…}`
  - `Error: expected unchanged, got {"ok":false,…}`
  - `Error: expected a refusal, got {"ok":false,"error":"…"}`
- The race tests fail the same way after `fired()` passes.
- The `markPaymentOverdue`, query and `countOutstandingPaymentsForStudent` tests still pass.

With the worktree app up (`pnpm run worktree:up`), run: `pnpm exec vitest run --project integration tests/integration/payments-api.test.ts tests/integration/full-flow.test.ts`

Expected: FAIL.
- The four `404s an unknown payment` tests and `GET /api/payments/[id] 404s an unknown payment with NOT_FOUND`: `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
- Every "answers … unchanged" test: `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
- The `PAYMENT_ALREADY_PAID` / `PAYMENT_WAIVED` / `PAYMENT_SETTLED` tests: `code: undefined`.
- The #196 race: `expected [ 200, 409 ] to deeply equal [ 200, 200 ]`.
- full-flow Step 16: `expected undefined to be 'applied'`.

Passing already, which is correct:
- the three `expectApplied` success tests;
- the four ordering tests, which answer 403 today. Step 14's mutation 8 is what shows they bite.

- [ ] **Step 4: Rewrite the service**

In `src/services/payments.ts`:

`:15`. Old:
```ts
import { OUTSTANDING_STATUSES } from '@/lib/payment-status';
```
New:
```ts
import { OUTSTANDING_STATUSES, isOutstanding } from '@/lib/payment-status';
```

After `:23` (`export type PaymentResult = …;`, which stays as it is), insert:

```ts

/**
 * A refusal from one of the teacher's payment actions below. `code` is a
 * registered code (`src/lib/api-error-codes.ts`), which fixes the HTTP status;
 * `message` is what the teacher reads.
 */
export type PaymentRefusal = {
  readonly code:
    | 'CONCURRENT_MODIFICATION'
    | 'NOT_FOUND'
    | 'PAYMENT_ALREADY_PAID'
    | 'PAYMENT_SETTLED'
    | 'PAYMENT_WAIVED';
  readonly message: string;
};

/**
 * What a teacher's payment action did. `applied`: this call wrote the row.
 * `unchanged`: the row already held what the action asks for, and nothing was
 * written or sent. Either way `payment` is the row as stored. An `unchanged`
 * answer describes the row, so a caller checks ownership before calling.
 */
export type PaymentOutcome =
  | { readonly kind: 'applied'; readonly payment: Payment }
  | { readonly kind: 'unchanged'; readonly payment: Payment }
  | { readonly kind: 'refused'; readonly refusal: PaymentRefusal };

/** The answer when the payment row does not exist. */
export const PAYMENT_GONE: PaymentRefusal = {
  code: 'NOT_FOUND',
  message: 'This payment no longer exists.',
};

/**
 * The answer when a compare-and-swap missed but the re-read finds a state the
 * swap would have accepted: another action changed the row between the two
 * statements, so neither "already done" nor a status refusal is true.
 */
const PAYMENT_CHANGED: PaymentRefusal = {
  code: 'CONCURRENT_MODIFICATION',
  message: 'This payment was just changed elsewhere. Refresh and try again.',
};
```

Replace `:75-108` (`markPaymentPaid` with its docblock):

```ts
/**
 * Mark a payment as paid with the given method (e.g. 'bank_transfer', 'cash').
 * Sets status to 'paid', records the method, and timestamps paidAt.
 *
 * Applies from 'pending' or 'overdue'. A payment already paid with the same
 * method is `unchanged`; with another method it is refused, because answering
 * "done" would discard the method this call carries.
 */
export async function markPaymentPaid(
  db: PrismaClient,
  paymentId: string,
  method: string,
): Promise<PaymentOutcome> {
  // Conditional update: the status guard lives in the WHERE clause so a
  // double submission cannot both pass a pre-check and clobber method/paidAt.
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
    data: {
      status: 'paid',
      method,
      paidAt: new Date(),
    },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { kind: 'refused', refusal: PAYMENT_GONE };
    switch (payment.status) {
      case 'paid':
        if (payment.method === method) return { kind: 'unchanged', payment };
        return {
          kind: 'refused',
          refusal: { code: 'PAYMENT_ALREADY_PAID', message: 'This payment is already marked paid.' },
        };
      case 'not_charged':
        return {
          kind: 'refused',
          refusal: {
            code: 'PAYMENT_WAIVED',
            message: 'This payment was marked not charged. Mark it unpaid first.',
          },
        };
      case 'pending':
      case 'overdue':
        return { kind: 'refused', refusal: PAYMENT_CHANGED };
      default: {
        const unhandled: never = payment.status;
        throw new Error(`Unhandled payment status: ${String(unhandled)}`);
      }
    }
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { kind: 'applied', payment: updated };
}
```

Replace `:139-171` (`reopenPayment` with its docblock):

```ts
/**
 * Return a settled payment to outstanding: paid or not_charged → pending,
 * clearing whichever settlement fields were set. A payment already
 * outstanding — pending or overdue — is `unchanged`.
 *
 * Returns to 'pending' (not 'overdue') deliberately — the dunning sweep
 * (`markOverduePayments`) re-derives overdue from the payment's age, so an old
 * payment self-heals back to overdue on the sweep's next tick — see
 * `lib/scheduler.ts`'s `payment-reminders` registration for the interval.
 *
 * One function for both settled states because they reverse identically: both
 * mean "this is no longer owed", and undoing either means "it is owed again".
 */
export async function reopenPayment(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentOutcome> {
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['paid', 'not_charged'] } },
    data: { status: 'pending', method: null, paidAt: null, notChargedAt: null },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { kind: 'refused', refusal: PAYMENT_GONE };
    // Both outstanding statuses are "unpaid" to the teacher, and
    // `markOverduePayments` may have turned a reopened 'pending' into
    // 'overdue' before this call arrived.
    if (isOutstanding(payment.status)) return { kind: 'unchanged', payment };
    return { kind: 'refused', refusal: PAYMENT_CHANGED };
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { kind: 'applied', payment: updated };
}
```

Replace `:173-206` (`markPaymentNotCharged` with its docblock):

```ts
/**
 * The grace policy of `docs/product-concept.md:142`: the teacher chooses not to
 * collect. A settled state like `paid` — no longer outstanding, never dunned —
 * that differs from it in the one respect that matters to the money: nothing
 * arrived. `reopenPayment` is the reversal. A payment already not charged is
 * `unchanged`; a paid one is refused, because waiving it would be a refund.
 *
 * `reminderSentAt` is deliberately left alone. A reminder that was sent was
 * sent, and the row's history stays true.
 *
 * Conditional update for the same reason `markPaymentPaid` uses one: the status
 * guard lives in the WHERE clause so a double submission cannot both pass a
 * pre-check and clobber `notChargedAt`.
 */
export async function markPaymentNotCharged(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentOutcome> {
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
    data: { status: 'not_charged', notChargedAt: new Date() },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { kind: 'refused', refusal: PAYMENT_GONE };
    switch (payment.status) {
      case 'not_charged':
        return { kind: 'unchanged', payment };
      case 'paid':
        return {
          kind: 'refused',
          refusal: {
            code: 'PAYMENT_ALREADY_PAID',
            message: "This payment is already paid, so it can't be marked not charged.",
          },
        };
      case 'pending':
      case 'overdue':
        return { kind: 'refused', refusal: PAYMENT_CHANGED };
      default: {
        const unhandled: never = payment.status;
        throw new Error(`Unhandled payment status: ${String(unhandled)}`);
      }
    }
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { kind: 'applied', payment: updated };
}
```

Replace `:228-316` (`sendPaymentReminder`'s docblock and the whole function; `MANUAL_REMIND_COOLDOWN_MS` above it stays):

```ts
/**
 * Send a payment reminder: stamps reminderSentAt and creates the student's
 * reminder notification in one transaction.
 *
 * Only valid on an outstanding ('pending' or 'overdue') payment, and the guard
 * is fail-closed in the DB, not just the UI: dunning a student who has already
 * paid is the one failure this feature must never produce. The status check is
 * a conditional updateMany (compare-and-swap in the WHERE), the same idiom as
 * markPaymentPaid and the automatic sweep — so a concurrent mark-paid that
 * commits between a plain read and the write genuinely can't be raced past.
 * The notification and the stamp share the transaction, so a failed send rolls
 * the stamp back rather than silencing the next scheduled reminder.
 *
 * The status is not the whole CAS, though, and on its own it could not stop a
 * double-click: a reminder does not change status, so two concurrent clicks
 * both read 'pending', both passed, both stamped and both dunned the student.
 * `reminderSentAt` is the value that actually moves, so it is in the WHERE too
 * — bounded by MANUAL_REMIND_COOLDOWN_MS, which is a retry guard and not a
 * nagging policy (#196). A call inside that window is `unchanged`: the
 * reminder it asks for went out moments ago.
 */
export async function sendPaymentReminder(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentOutcome> {
  return db.$transaction(async (tx): Promise<PaymentOutcome> => {
    // Compare-and-swap on both things a reminder depends on: the payment is
    // still outstanding, and it was not just reminded. A count of 0 means one
    // of those two stopped holding and nothing is sent.
    const cooldownStart = new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS);
    const stamped = await tx.payment.updateMany({
      where: {
        id: paymentId,
        status: { in: ['pending', 'overdue'] },
        OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cooldownStart } }],
      },
      data: { reminderSentAt: new Date() },
    });
    if (stamped.count === 0) {
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return { kind: 'refused', refusal: PAYMENT_GONE };
      // Settled before cooldown: a settled payment needs no reminder, so
      // reporting that one already went out would answer a question that no
      // longer matters.
      if (!isOutstanding(payment.status)) {
        return {
          kind: 'refused',
          refusal: {
            code: 'PAYMENT_SETTLED',
            message: 'This payment is already settled, so no reminder is needed.',
          },
        };
      }
      // Outstanding, so the cooldown term is the one that missed — provided
      // this read still finds a stamp inside the window. `unchanged` returns
      // the row carrying that stamp.
      if (payment.reminderSentAt !== null && payment.reminderSentAt >= cooldownStart) {
        return { kind: 'unchanged', payment };
      }
      return { kind: 'refused', refusal: PAYMENT_CHANGED };
    }

    const { registration, ...payment } = await tx.payment.findUniqueOrThrow({
      where: { id: paymentId },
      include: {
        registration: {
          select: {
            studentId: true,
            class: {
              select: {
                id: true,
                calendarEntry: { select: { classType: true, date: true, startTime: true } },
              },
            },
          },
        },
      },
    });

    await createBulkNotifications(tx, [
      {
        recipientType: 'student',
        recipientId: registration.studentId,
        type: 'reminder',
        title: 'Payment outstanding',
        body: `€${Number(payment.amount).toFixed(2)} for ${registration.class.calendarEntry.classType} class on ${formatDayHeader(registration.class.calendarEntry.date)} at ${timeToHHmm(registration.class.calendarEntry.startTime)} is still open. Pay your teacher directly.`,
        relatedClassId: registration.class.id,
      },
    ]);

    return { kind: 'applied', payment };
  });
}
```

- [ ] **Step 5: Create the shared responder**

`src/app/api/payments/[id]/shared.ts`:

```ts
import type { NextResponse } from 'next/server';
import type { Payment } from '@prisma/client';
import { API_ERROR_STATUS } from '@/lib/api-error-codes';
import { respondError, respondOk, respondUnchanged } from '@/lib/api-utils';
import type { PaymentOutcome, PaymentRefusal } from '@/services/payments';

/**
 * The payment action routes' answers, in one place. A file of its own because
 * a `route.ts` may export only HTTP verbs and Next's config names.
 */

/** A refusal from `services/payments.ts`, at the status its code is registered with. */
export function respondPaymentRefusal(refusal: PaymentRefusal): NextResponse {
  return respondError(refusal.message, API_ERROR_STATUS[refusal.code], refusal.code);
}

/** What a payment action did. `data` is the payment row whether or not this call wrote it. */
export function respondPaymentOutcome(outcome: PaymentOutcome): NextResponse {
  switch (outcome.kind) {
    case 'applied':
      return respondOk(outcome.payment);
    case 'unchanged':
      return respondUnchanged<Payment>(outcome.payment);
    case 'refused':
      return respondPaymentRefusal(outcome.refusal);
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled payment outcome: ${JSON.stringify(unhandled)}`);
    }
  }
}
```

`API_ERROR_STATUS[refusal.code]` has the type `404 | 409`. Under Task 10's coded overload, `C` is inferred from `refusal.code` alone, so `StatusOf<C>` is that same `404 | 409` and the call still compiles. The value is right by construction, because it is the registry's own entry.

- [ ] **Step 6: Rewrite the four action routes, and the GET's 404**

`src/app/api/payments/[id]/paid/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markPaymentPaid, PAYMENT_GONE } from '@/services/payments';
import { markPaidSchema } from '@/lib/schemas';
import { respondPaymentOutcome, respondPaymentRefusal } from '../shared';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  // Verify teacher owns the payment via registration chain
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondPaymentRefusal(PAYMENT_GONE);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, markPaidSchema);
  if ('error' in parsed) return parsed.error;

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await markPaymentPaid(prisma, id, parsed.data.method));
});
```

`src/app/api/payments/[id]/unpaid/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { reopenPayment, PAYMENT_GONE } from '@/services/payments';
import { respondPaymentOutcome, respondPaymentRefusal } from '../shared';

/** Undo for a mistaken "mark paid" or "not charged" — same ownership chain as /paid. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondPaymentRefusal(PAYMENT_GONE);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await reopenPayment(prisma, id));
});
```

`src/app/api/payments/[id]/not-charged/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markPaymentNotCharged, PAYMENT_GONE } from '@/services/payments';
import { respondPaymentOutcome, respondPaymentRefusal } from '../shared';

/**
 * The teacher chooses not to collect — same ownership chain as /paid and
 * /unpaid. No request body: unlike /paid there is no `method` to record,
 * because no money moved.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondPaymentRefusal(PAYMENT_GONE);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await markPaymentNotCharged(prisma, id));
});
```

`src/app/api/payments/[id]/remind/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { sendPaymentReminder, PAYMENT_GONE } from '@/services/payments';
import { respondPaymentOutcome, respondPaymentRefusal } from '../shared';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  // Verify teacher owns the payment via registration chain
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondPaymentRefusal(PAYMENT_GONE);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await sendPaymentReminder(prisma, id));
});
```

`src/app/api/payments/[id]/route.ts` (the GET) gets the same not-found body as the four doors above.

`:11`. Old:
```ts
import type { TeacherPaymentRow } from '@/services/payments';
```
New:
```ts
import { PAYMENT_GONE, type TeacherPaymentRow } from '@/services/payments';
import { respondPaymentRefusal } from './shared';
```

`:40`. Old:
```ts
  if (!payment) return respondError('Payment not found', 404);
```
New:
```ts
  if (!payment) return respondPaymentRefusal(PAYMENT_GONE);
```

`respondError` stays imported, because the 403 at `:44` still uses it.

- [ ] **Step 7: Run the server side green**

Run: `pnpm exec vitest run --project unit src/services/payments.test.ts "src/app/api/payments/[id]/shared.test.ts" src/lib/api-utils.test.ts`

Expected: PASS.

With the worktree app up, first send one request to each touched route so `next dev` has compiled it. Use the `INTEGRATION_BASE_URL` that `worktree:up` printed (it is also in `.env`), and send each of:
- `curl -s -o /dev/null -X POST <INTEGRATION_BASE_URL>/api/payments/00000000-0000-4000-8000-000000000000/paid`
- the same request for `/unpaid`
- the same request for `/not-charged`
- the same request for `/remind`
- `curl -s -o /dev/null <INTEGRATION_BASE_URL>/api/payments/00000000-0000-4000-8000-000000000000` (the GET)

Then run: `pnpm exec vitest run --project integration tests/integration/payments-api.test.ts tests/integration/full-flow.test.ts`

Expected: PASS.

Run: `pnpm run typecheck && pnpm run lint`

Expected: clean. A `tsc` error in `src/services/payments.test.ts` or `tests/integration/full-flow.test.ts` on `.ok` or `.error` means a call site this task missed. Rewrite it the way Step 1 rewrites its neighbours.

- [ ] **Step 8: Commit the server side**

```bash
git add src/services/payments.ts src/services/payments.test.ts "src/app/api/payments/[id]/shared.ts" "src/app/api/payments/[id]/shared.test.ts" "src/app/api/payments/[id]/paid/route.ts" "src/app/api/payments/[id]/unpaid/route.ts" "src/app/api/payments/[id]/not-charged/route.ts" "src/app/api/payments/[id]/remind/route.ts" "src/app/api/payments/[id]/route.ts" tests/integration/payments-api.test.ts tests/integration/full-flow.test.ts
git commit -m "fix(payments): an already-settled payment action answers unchanged; refusals carry codes (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Client tests**

**No change needed, per component.** A 200 `unchanged` answer takes the same branch as an applied one in each of these:
- `usePaymentActions` (`src/lib/use-payment-actions.ts`):
  - `markPaid` (`:44`) and `markNotCharged` (`:68`) check only `res.ok`.
  - `undo` (`:102`) checks `res.ok`, then reads `data.status`, which the unchanged body carries (`pending` or `overdue`).
  - Behaviour is unchanged; Step 11 corrects two comments.
- `OutstandingPaymentRow`, `PaymentChecklist`, `StudentPaymentList`: through the hook only. `StudentPaymentList` does change in one way, unrelated to unchanged answers: its error `<p>` gains `role="alert"` (Step 11), so a refused mark is announced, as the other two surfaces already do.
- `MarkUnpaidButton` (`:36`) checks only `res.ok`.
- `SendReminderButton` (`:71`) checks `res.ok`, then reads `data.reminderSentAt` (`:82-86`), which the unchanged body carries as the stored stamp.

The tests below pin that, and replace the spec §7.9 mocks with bodies the server sends.

Create `src/components/class/send-reminder-button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SendReminderButton } from './send-reminder-button';

/**
 * What the button reports upward is its whole contract: `onSent` with the
 * stamp the server returns, or `onError` with something the teacher can act
 * on. A retry inside the server's cooldown answers 200 `unchanged` with the
 * stamp that suppressed it, and must read as sent.
 */
describe('SendReminderButton', () => {
  const fetchMock = vi.fn();
  const onSent = vi.fn();
  const onError = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    onSent.mockReset();
    onError.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderButton(): HTMLElement {
    render(
      <SendReminderButton
        paymentId="pay-1"
        studentName="Ana de Vries"
        context={null}
        onSent={onSent}
        onError={onError}
      />,
    );
    return screen.getByRole('button', { name: 'Send reminder to Ana de Vries' });
  }

  /** Every message `onError` received other than the '' that clears it. */
  function reportedErrors(): unknown[] {
    return onError.mock.calls.map(([message]) => message).filter((message) => message !== '');
  }

  it('POSTs to the remind endpoint and reports the stamp it returns', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { reminderSentAt: '2026-09-17T10:00:00.000Z' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/remind', { method: 'POST' });
    expect(onSent).toHaveBeenCalledWith(new Date('2026-09-17T10:00:00.000Z'));
    expect(reportedErrors()).toEqual([]);
  });

  it('reports an unchanged answer as sent, with the stamp that suppressed it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { reminderSentAt: '2026-09-17T09:59:00.000Z' },
        outcome: 'unchanged',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const button = renderButton();
    fireEvent.click(button);

    await waitFor(() => expect(onSent).toHaveBeenCalledWith(new Date('2026-09-17T09:59:00.000Z')));
    expect(reportedErrors()).toEqual([]);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('reports a refusal through onError and nothing through onSent', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'This payment is already settled, so no reminder is needed.',
          code: 'PAYMENT_SETTLED',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const button = renderButton();
    fireEvent.click(button);

    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        'This payment is already settled, so no reminder is needed.',
      ),
    );
    expect(onSent).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
  });

  /**
   * A 200 without a readable stamp is sent-but-unconfirmed, and the teacher is
   * told to reload rather than to send again. This is why every 200 from the
   * endpoint, the unchanged one included, carries the stamp.
   */
  it('asks for a reload when a 200 carries no stamp', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        'Reminder sent — reload to confirm before sending again.',
      ),
    );
    expect(onSent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[send-reminder] sent, but the response was unreadable',
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });

  it('reports a network failure as one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Network error. Try again.'));
    expect(onSent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[send-reminder] request failed',
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });
});
```

In `src/components/class/mark-unpaid-button.test.tsx`, replace `:205-239`. Old: both tests mocked `{ ok: false, json: async () => ({ error: 'Cannot undo: current status is "pending". Must be "paid".' }) }`. That body is string-shaped and quotes a message the server never sent, for a state that now answers 200 `unchanged`. New:

```tsx
  it('clears a failed attempt, so a reopened confirm is not pre-labelled as failed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: { message: 'This payment no longer exists.', code: 'NOT_FOUND' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));
    await screen.findByText('This payment no longer exists.');

    fireEvent.click(screen.getByRole('button', { name: /keep/i }));
    fireEvent.click(screen.getByRole('button', { name: /mark unpaid/i }));

    expect(screen.queryByText('This payment no longer exists.')).toBeNull();
  });

  /** The body the server sends when the payment is gone. */
  it('shows the server error and re-enables on a failed POST', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: { message: 'This payment no longer exists.', code: 'NOT_FOUND' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This payment no longer exists.');
    expect(screen.getByRole('button', { name: /confirm unpaid/i })).toBeEnabled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  /**
   * An undo of a payment that is already unpaid answers 200 `unchanged` — the
   * answer a retried confirm gets. It settles exactly as an applied undo does.
   */
  it('settles to "Marked unpaid" on an unchanged answer', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'overdue' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(await screen.findByText('Marked unpaid')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
```

In `src/components/class/outstanding-payment-row.test.tsx`:

Replace `:246-259`. The docblock called the `overdue` undo body a hypothetical, and an undo of an already-overdue payment now sends it for real. Old mock: `{ ok: true, json: async () => ({ data: { status: 'overdue' } }) }`. New:

```tsx
  /**
   * #58. `undo` renders whatever status the server's response carries, guard
   * included, rather than assuming the result is always 'pending'. The body
   * mocked below is a real answer: an undo of a payment that is already
   * unpaid is `unchanged` and carries the stored status, which is 'overdue'
   * for a payment left unpaid long enough. This is the only test here that
   * fails if someone "simplifies" the round trip to a hardcoded 'pending'.
   */
  it('renders the status the undo response carries', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'overdue' }, outcome: 'unchanged' }),
    });
```

(The rest of that test, `:260-275`, is unchanged.)

`:324-325`. Old:
```tsx
   * for a debt that now really existed. A second Undo then got the service's
   * contradictory `Cannot undo: current status is "pending"`.
```
New:
```tsx
   * for a debt that now really existed.
```

`:330` (now `:329` after the line above goes). Old:
```tsx
   * principle, and the same shape, as `send-reminder-button.tsx:71-86`.
```
New:
```tsx
   * principle, and the same shape, as `send-reminder-button.tsx`'s `handleSend`.
```

Replace `:407-427` (the mark-paid JSON-error test with its docblock). Its mock `{ error: 'Payment already marked paid' }` is spec §7.9's. New, followed by the new unchanged test:

```tsx
  /**
   * #134. A refusal is extracted and displayed to the teacher rather than
   * claimed as a network error. The body is the one the server sends when a
   * stale row offers Mark paid on a payment since marked not charged.
   */
  it('shows the server refusal when mark-paid is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'This payment was marked not charged. Mark it unpaid first.',
          code: 'PAYMENT_WAIVED',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · 12 Jun · 09:30' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This payment was marked not charged. Mark it unpaid first.',
    );
  });

  /**
   * A mark the server finds already done answers 200 `unchanged` — what a
   * retried tap receives when the first one's response was lost. The row
   * settles as for an applied mark, Undo included, and raises no alert.
   */
  it('settles on an unchanged mark-paid answer, with Undo and no alert', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'paid' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderRow({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: /^Mark paid —/ }));

    expect(await screen.findByText('✓ Paid')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Undo marking Anna Smith as paid for Vinyasa · 2 Sep · 18:00',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

Replace `:509-528` (the mark-not-charged JSON-error test with its docblock). Its mock `{ error: 'Payment already marked not charged' }` is spec §7.9's. New, followed by the new unchanged test:

```tsx
  /**
   * Mirrors the mark-paid refusal test above, with the body the server sends
   * when the payment was paid in the meantime.
   */
  it('shows the server refusal when mark-not-charged is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: "This payment is already paid, so it can't be marked not charged.",
          code: 'PAYMENT_ALREADY_PAID',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderRow({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: /^Not charged —/ }));

    expect(
      await screen.findByRole('button', { name: /^Not charged —/ }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This payment is already paid, so it can't be marked not charged.",
    );
  });

  it('settles on an unchanged not-charged answer, with Undo and no alert', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'not_charged' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderRow({ status: 'pending' });

    fireEvent.click(screen.getByRole('button', { name: /^Not charged —/ }));

    expect(await screen.findByText('⊘ Not charged')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Undo marking Anna Smith as not charged for Vinyasa · 2 Sep · 18:00',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

In `src/components/students/student-payment-list.test.tsx`, the test file has no fetch stub yet.

`:2-3`. Old:
```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
```
New:
```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
```

Insert before the `});` that closes `describe('StudentPaymentList')` (`:77`):

```tsx

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('announces a refused mark-paid as an alert', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          error: {
            message: 'This payment was marked not charged. Mark it unpaid first.',
            code: 'PAYMENT_WAIVED',
          },
        }),
      }),
    );
    renderList([
      { paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'pending', amount: 12 },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid — Vinyasa, Tue 2 Sep' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This payment was marked not charged. Mark it unpaid first.',
    );
  });
```

- [ ] **Step 10: Run the client tests**

Run: `pnpm exec vitest run --project components src/components/class/send-reminder-button.test.tsx src/components/class/mark-unpaid-button.test.tsx src/components/class/outstanding-payment-row.test.tsx src/components/students/student-payment-list.test.tsx`

Expected:
- `mark-unpaid-button.test.tsx`: FAIL in `shows the server error and re-enables on a failed POST` only, with `Unable to find an accessible element with the role "alert"`. The error `<span>` has no role yet.
- `student-payment-list.test.tsx`: FAIL in `announces a refused mark-paid as an alert` only, with `Unable to find an accessible element with the role "alert"`. The error `<p>` has no role yet.
- The other two files: PASS. The clients already treat the unchanged 200 as success. These tests record that behaviour, and Step 14's mutations 9 and 10 show they bite.

- [ ] **Step 11: Client code — the alert roles, the comments that went false, and a stale pointer**

`src/components/class/mark-unpaid-button.tsx:37-43`. Old:
```tsx
        // #40. The refresh below normally replaces this row (the payment moves
        // Received → Outstanding) and this component unmounts, so `done` is
        // never seen. When the commit is dropped it is the only thing standing
        // between the teacher and a dead button: the action HAS committed, so
        // re-offering it would earn a 409 ("current status is 'pending'") over
        // an action that worked. Say what happened instead, and offer the
        // repaint that failed.
```
New:
```tsx
        // #40. The refresh below normally replaces this row (the payment moves
        // Received → Outstanding) and this component unmounts, so `done` is
        // never seen. When the commit is dropped it is the only thing standing
        // between the teacher and a button that reads as if nothing happened:
        // the payment IS unpaid — this request reopened it, or the server
        // answered `unchanged` because it already was. Say so, and offer the
        // repaint that failed.
```

`src/components/class/mark-unpaid-button.tsx:126` — the same unannounced-error defect as spec §7.7. Old:
```tsx
      {error && <span className="text-[13px] text-danger">{error}</span>}
```
New:
```tsx
      {error && (
        <span role="alert" className="text-[13px] text-danger">
          {error}
        </span>
      )}
```

`src/components/class/send-reminder-button.tsx:36-37`. Old:
```tsx
 * minutes later goes through, and the server answers a suppressed one with a
 * 409 the button surfaces through `onError`. The stamp also defers the
```
New:
```tsx
 * minutes later goes through, and the server answers a suppressed one
 * `unchanged`, carrying the stamp that suppressed it, which this button
 * reports through `onSent` like any other send. The stamp also defers the
```

`src/components/class/send-reminder-button.tsx:77-80`. Old:
```tsx
    // The server commits the notification + stamp before it responds, so past
    // this point the reminder HAS been sent. A malformed or field-less body
    // must not be dressed up as a failure — that would provoke a second,
    // duplicate nudge.
```
New:
```tsx
    // The server commits the notification + stamp before it responds, so past
    // this point a reminder HAS been sent — by this request, or, on an
    // `unchanged` answer, by the one whose stamp the body carries. A malformed
    // or field-less body must not be dressed up as a failure — that would
    // provoke a second, duplicate nudge.
```

`src/lib/use-payment-actions.ts:8-16`. The docblock said Undo is offered "only for payments settled in this session". An unchanged answer also reaches `justMarked`, so the sentence changes; it keeps the same line count. Old:
```ts
/**
 * Mark-paid and mark-not-charged, both with transient undo. "Mark paid" is
 * the app's most repeated action, so it stays one tap — no confirm; "Not
 * charged" mirrors that shape for the grace policy. The safety net is Undo,
 * offered only for payments settled in this session (justMarked): old
 * records keep a clean row and can't be unmarked casually. Undo returns the
 * payment to 'pending'; the hourly dunning sweep re-derives 'overdue' from
 * the payment's age where applicable.
 */
```
New:
```ts
/**
 * Mark-paid and mark-not-charged, both with transient undo. "Mark paid" is
 * the app's most repeated action, so it stays one tap — no confirm; "Not
 * charged" mirrors that shape for the grace policy. The safety net is Undo,
 * offered only where a tap on this page settled the payment or found it
 * already settled that way (justMarked) — the answer a retried tap gets — so
 * a record settled before the page loaded can't be unmarked casually. Undo
 * returns the payment to 'pending', or reports the unpaid status it had.
 */
```

`src/lib/use-payment-actions.ts:107-112`. Old:
```ts
      // Past this point the undo HAS happened — same principle as
      // `send-reminder-button.tsx`, which commits before it responds too. An
      // unreadable body must not be dressed up as a failure or leave the UI in
      // its pre-action state; it is logged and the local state resolves to
      // 'pending', which is the reversal's own write. Returning true lets the
      // caller's `router.refresh()` reconcile against the server's real value.
```
New:
```ts
      // Past this point the payment is unpaid — this request reopened it, or it
      // already was and the answer is `unchanged`. Same principle as
      // `send-reminder-button.tsx`, which commits before it responds too. An
      // unreadable body must not be dressed up as a failure or leave the UI in
      // its pre-action state; it is logged and the local state resolves to
      // 'pending', which is the reversal's own write. Returning true lets the
      // caller's `router.refresh()` reconcile against the server's real value.
```

`src/components/students/student-payment-list.tsx:31` has the same unannounced-error defect. Old:
```tsx
      {error && <p className="text-sm text-danger mb-3">{error}</p>}
```
New:
```tsx
      {error && (
        <p role="alert" className="text-sm text-danger mb-3">
          {error}
        </p>
      )}
```

`src/components/settings/add-room-flow.test.tsx:175` points into `use-payment-actions.ts` by a line number. The number was already wrong, since `:51` is `setUpdating(null)`, so the pointer names the function instead. Old:
```tsx
   * The same distinction is stated for a write at src/lib/use-payment-actions.ts:51.
```
New:
```tsx
   * The same distinction is stated for a write in `markPaid` (src/lib/use-payment-actions.ts).
```

- [ ] **Step 12: Run everything this task touches green**

Run: `pnpm exec vitest run --project components src/components/class/send-reminder-button.test.tsx src/components/class/mark-unpaid-button.test.tsx src/components/class/outstanding-payment-row.test.tsx src/components/class/payment-checklist.test.tsx src/components/class/received-payment-row.test.tsx src/components/class/not-charged-payment-row.test.tsx src/components/students/student-payment-list.test.tsx src/components/settings/add-room-flow.test.tsx`

Expected: PASS.

Run: `pnpm exec vitest run --project unit src/services/payments.test.ts "src/app/api/payments/[id]/shared.test.ts" src/lib/payment-status.test.ts`

Expected: PASS.

With the worktree app up:
- Run: `pnpm exec vitest run --project integration tests/integration/payments-api.test.ts tests/integration/full-flow.test.ts`. Expected: PASS.
- Run: `pnpm exec playwright test tests/e2e/teacher-journey.spec.ts`. Expected: PASS. It drives remind, mark unpaid and not charged through the real components.

Run: `pnpm run typecheck && pnpm run lint`

Expected: clean.

- [ ] **Step 13: Commit the clients**

```bash
git add src/lib/use-payment-actions.ts src/components/class/mark-unpaid-button.tsx src/components/class/mark-unpaid-button.test.tsx src/components/class/send-reminder-button.tsx src/components/class/send-reminder-button.test.tsx src/components/class/outstanding-payment-row.test.tsx src/components/students/student-payment-list.tsx src/components/students/student-payment-list.test.tsx src/components/settings/add-room-flow.test.tsx
git commit -m "fix(payments): clients render an unchanged answer as done; real refusal bodies in the mocks (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 14: Prove the guards bite**

Both commits are in place, so `git checkout -- <path>` restores only the mutation. For each mutation:
1. Apply it.
2. Before an integration run, send the Step 7 `curl` to the touched route.
3. Run each named command on the **whole file**, never with `-t`. The describes in `payments-api.test.ts`, and the first block of `payments.test.ts`, share one payment that earlier tests put into state, so a filtered run fails for the wrong reason.
4. Check that exactly the listed tests fail, with the listed text, and record the output in the report.
5. Restore with `git checkout -- <path>`.
6. Re-run the same commands green.

The commands:
- **U** = `pnpm exec vitest run --project unit src/services/payments.test.ts`
- **S** = `pnpm exec vitest run --project unit "src/app/api/payments/[id]/shared.test.ts"`
- **I** = `pnpm exec vitest run --project integration tests/integration/payments-api.test.ts`

1. **Moot before unchanged (remind).** In `src/services/payments.ts` (`sendPaymentReminder`), move the whole `if (payment.reminderSentAt !== null && payment.reminderSentAt >= cooldownStart) { return { kind: 'unchanged', payment }; }` statement, with its comment, above the `if (!isOutstanding(payment.status)) {` block.
   - **U** — only "refuses a just-reminded payment that was settled with PAYMENT_SETTLED, not unchanged", with `Error: expected a refusal, got {"kind":"unchanged",…}`.
   - **I** — only "refuses a settled payment inside the cooldown with PAYMENT_SETTLED, sending nothing", with `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'PAYMENT_SETTLED' }`.
2. **Unchanged without the stored stamp (remind).** In `sendPaymentReminder`, replace the condition `payment.reminderSentAt !== null && payment.reminderSentAt >= cooldownStart` with `true`.
   - **U** — only "refuses with CONCURRENT_MODIFICATION when the stamp it missed is gone by its re-read", with `Error: expected a refusal, got {"kind":"unchanged",…}`.
3. **Method not compared (paid).** In `markPaymentPaid`, replace `payment.method === method` with `payment.status === 'paid'`.
   - **U** — only "markPaymentPaid refuses a paid payment when the method differs", with `Error: expected a refusal, got {"kind":"unchanged",…}`.
   - **I** — only "refuses a mark with another method: PAYMENT_ALREADY_PAID", with `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'PAYMENT_ALREADY_PAID' }`.
4. **An unchanged answer that wrote (unpaid).** In `reopenPayment`, change the CAS `status: { in: ['paid', 'not_charged'] }` to `status: { in: ['paid', 'not_charged', 'pending', 'overdue'] }`.
   - **U** — exactly these:
     - "reopenPayment answers unchanged when the payment is already outstanding", with `Error: expected unchanged, got {"kind":"applied",…}`;
     - both cases of "answers a %s payment unchanged, carrying its status and writing nothing", with the same text;
     - "reopenPayment: a pending payment settled in between → CONCURRENT_MODIFICATION", with `Error: expected a refusal, got {"kind":"applied",…}`.
   - **I** — exactly "answers an undo of a pending payment unchanged, writing nothing" and "answers an undo of an overdue payment unchanged, carrying its status". Each fails with `expected { status: 200, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
5. **No cooldown term (remind).** In `sendPaymentReminder`, delete the line `OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cooldownStart } }],`.
   - **U** — exactly these:
     - "answers a second manual reminder inside the cooldown unchanged, sending nothing", with `expected 2 to be 1`;
     - "answers unchanged to a fresh stamp it did not write, sending nothing", with `expected 1 to be 0`;
     - "refuses with CONCURRENT_MODIFICATION when the stamp it missed is gone by its re-read". The mutated swap now matches and locks the row, so the hook's write waits on the open transaction. Expect a transaction-expiry error (Prisma `P2028`) or a test timeout rather than an assertion message.
   - **I** — exactly these:
     - "answers a retry inside the cooldown unchanged, with the stamp, sending nothing", with `expected { status: 200, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`;
     - "duns the student once when the same reminder arrives twice at once", with `… to have a length of 1 but got 2`.
6. **Unchanged sent as applied.** In `src/app/api/payments/[id]/shared.ts`, change `return respondUnchanged<Payment>(outcome.payment);` to `return respondOk(outcome.payment);`.
   - **S** — only "answers an unchanged action 200 with the row and outcome unchanged", with `expected { status: 200, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
   - **I** — exactly these:
     - each of the following, with that same text:
       - "answers a retry inside the cooldown unchanged, with the stamp, sending nothing";
       - "answers the same mark unchanged, writing nothing";
       - "answers an undo of a pending payment unchanged, writing nothing";
       - "answers an undo of an overdue payment unchanged, carrying its status";
       - "answers a payment already not charged unchanged, writing nothing";
     - the #196 race, whose outcome check fails with `expected [ 'applied', 'applied' ] to deeply equal [ 'applied', 'unchanged' ]`.
7. **Status not taken from the registry.** In `shared.ts`, change `API_ERROR_STATUS[refusal.code]` to `409`.
   - **S** — only "answers a vanished payment 404 NOT_FOUND", with `expected { status: 409, code: 'NOT_FOUND' } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
   - **I** — exactly the NOT_FOUND tests: the four `404s an unknown payment` tests and "GET /api/payments/[id] 404s an unknown payment with NOT_FOUND". Each fails with the same shape of message. The routes' own 404 goes through `respondPaymentRefusal` too.
8. **Unchanged above the ownership gate**, one route at a time (a–d). Restore after each one.
   - In the route, add `respondUnchanged` to the `@/lib/api-utils` import.
   - Insert the line shown directly above `if (!payment) return respondPaymentRefusal(PAYMENT_GONE);`.
   - Run **I**. The ordering test named fails with `expected { status: 200, outcome: 'unchanged' } to deeply equal { status: 403, outcome: undefined }`. Some routes produce one more failure, listed with that route.
   
   a. `paid/route.ts`: `if (payment?.status === 'paid') return respondUnchanged<unknown>(payment);`
      - The ordering test that fails is "403s another teacher's identical mark rather than answering unchanged".
      - "refuses a mark with another method: PAYMENT_ALREADY_PAID" also fails, because the owner's request stops at the inserted line too. Its message is `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'PAYMENT_ALREADY_PAID' }`.
   
   b. `unpaid/route.ts`: `if (payment && (payment.status === 'pending' || payment.status === 'overdue')) return respondUnchanged<unknown>(payment);`
      - Only "403s another teacher's undo of an unpaid payment rather than answering unchanged" fails.
   
   c. `not-charged/route.ts`: `if (payment?.status === 'not_charged') return respondUnchanged<unknown>(payment);`
      - The ordering test that fails is "403s another teacher's mark on a payment already not charged rather than answering unchanged".
      - "answers a payment already not charged unchanged, writing nothing" also fails. The inserted line returns the route's row with its `registration` include, so the key assertion fails: `expected [ …, 'registration', … ] to deeply equal [ … ]`.
   
   d. `remind/route.ts`: `if (payment?.reminderSentAt) return respondUnchanged<unknown>(payment);`
      - The ordering test that fails is "403s another teacher's reminder inside the cooldown rather than answering unchanged".
      - "refuses a settled payment inside the cooldown with PAYMENT_SETTLED, sending nothing" also fails, with `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'PAYMENT_SETTLED' }`.
9. **A client that treats unchanged as not done.** In `src/lib/use-payment-actions.ts` (`markPaid`), change `if (res.ok) {` to `if (res.ok && (await res.json?.().catch(() => null))?.outcome !== 'unchanged') {`.
   - Run `pnpm exec vitest run --project components src/components/class/outstanding-payment-row.test.tsx`. Exactly these fail:
     - "settles on an unchanged mark-paid answer, with Undo and no alert", with `Unable to find an element with the text: ✓ Paid`;
     - "renders the status the undo response carries". Its Mark paid click receives the same unchanged body, so the Undo button never appears: `Unable to find an accessible element with the role "button" and name "Undo marking Ana de Vries as paid for Vinyasa · 12 Jun · 09:30"`.
10. **The button rejects an unchanged body.** In `src/components/class/send-reminder-button.tsx`, add `if ((json as unknown as { outcome?: string }).outcome === 'unchanged') throw new Error('unchanged');` directly after `const json = …;`.
    - Run `pnpm exec vitest run --project components src/components/class/send-reminder-button.test.tsx`. Only "reports an unchanged answer as sent, with the stamp that suppressed it" fails, on its `waitFor`, with `expected "spy" to be called with arguments: [ 2026-09-17T09:59:00.000Z ]`.
11. **The unpaid error is not announced.** In `src/components/class/mark-unpaid-button.tsx`, delete `role="alert"`.
    - Run `pnpm exec vitest run --project components src/components/class/mark-unpaid-button.test.tsx`. Only "shows the server error and re-enables on a failed POST" fails, with `Unable to find an accessible element with the role "alert"`.
12. **The student-page error is not announced.** In `src/components/students/student-payment-list.tsx`, delete `role="alert"`.
    - Run `pnpm exec vitest run --project components src/components/students/student-payment-list.test.tsx`. Only "announces a refused mark-paid as an alert" fails, with `Unable to find an accessible element with the role "alert"`.
13. **The GET's 404 uncoded.** In `src/app/api/payments/[id]/route.ts`, change `return respondPaymentRefusal(PAYMENT_GONE);` to `return respondError('This payment no longer exists.', 404);`. Send the GET `curl` from Step 7 first.
    - **I** — only "GET /api/payments/[id] 404s an unknown payment with NOT_FOUND", with `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.

---
### Task 5: Registrations — book, attendance, cancel a booking

**Files:**
- Create: `src/app/api/registrations/[id]/route.test.ts` (unit tier; the missed-write re-reads), `src/components/student/cancel-booking-button.test.tsx`
- Modify: `docs/lock-order.md` (the `POST /api/registrations` row of the erasure-gate table, Step 8a)
- Modify: `src/app/api/registrations/route.ts:1-23` (imports), `:25-47` (sentinel errors, response types), `:103` (transaction result type), `:142-196` (check order), `:277-278` (transaction return), `:314` (applied body), `:315-348` (catch)
- Modify: `src/app/api/registrations/[id]/route.ts:1-19` (imports, body types), `:150-190` (PUT write and miss branch), `:223-242` (DELETE gates), `:257-270` (comment), `:275-277`, `:289`, `:300-302`, `:338` (CAS misses, applied bodies), new helpers after `:339`
- Modify: `src/components/student/cancel-booking-button.tsx:6`, `:26-41` (`NOT_FOUND` is done)
- Test: `tests/integration/registrations-api.test.ts` (imports `:1-7`; `makeOtherTeacherClass` `:146-163` and its call `:316`; `:351-352`; `:369-375`; `:385`; `:409-411`; `:604-606`; `:648-650`; `:1248-1254`; `:1275`; `:1334`; `:1355`; new PUT tests before `:1388`; #196 block `:1524-1531`, `:1559-1563`, `:1570-1581`, `:1584`, `:1627-1629`, `:1642-1644`, `:1690`, `:1693-1705`; new describe after `:1829`), `src/app/api/registrations/route.test.ts` (imports `:1-9`, comment `:387-397`, new describe at the end), `src/app/api/registrations/route-lock-order.test.ts` (`:48-51`, `:65-80`, `:375`, `:409`, `:434`, `:464`, `:495`, `:570`, `:618`), `src/components/class/add-walk-in.test.tsx` (`:1-3`, `:204`, `:216`, new test after `:221`), `src/components/class/attendance-list.test.tsx` (`:125-138`, new test after `:150`), `src/components/booking/booking-flow.test.tsx` (new describe before `:141`)

**Interfaces:**
- Consumes (Task 1): `respondUnchanged<T>(data)` and `respondTyped<T>(data, status)` and `respondError(message, status, code?: ApiErrorCode)` from `@/lib/api-utils`; `readError(res, fallback)` from `@/lib/client-errors`; `expectRefusal(res, code)`, `expectUnchanged(res)`, `expectApplied(res, status?)` from `tests/api-assertions.ts`. Registry codes used: `CLASS_CANCELLED`, `CLASS_NOT_BOOKABLE`, `CLASS_FULL`, `STUDENT_ERASED`, `CLASS_NOT_STARTED`, `REGISTRATION_CANCELLED`, `ALREADY_LATE_CANCELLED`, `CLASS_TERMINAL`, `NOT_FOUND`, `CONCURRENT_MODIFICATION` — all already in the registry.
- Produces: nothing exported. Wire contract after this task:
  - `POST /api/registrations`: applied `201 { data: { id, status } }`; unchanged `200 { data: { id, status }, outcome: 'unchanged' }` — the same `{ id: string; status: RegistrationStatus }` type as the applied body, where `status` is the stored active status (`registered`, `attended` or `no_show`).
  - `PUT /api/registrations/[id]`: applied `200 { data: { id, status } }`; unchanged `200 { data: { id, status }, outcome: 'unchanged' }`.
  - `DELETE /api/registrations/[id]`: applied `200 { data: { id, status: 'cancelled' | 'late_cancel' } }`; unchanged the same `data` plus `outcome: 'unchanged'`, `status` being the stored one.
  - No client reads any of these bodies (every client below keys on `res.ok`), so matching the applied type is a choice, not a requirement.

The order each handler follows (spec §5.1), as this task writes it:

| Handler | 1. auth + ownership | 2. moot | 3. unchanged | 4. other refusals |
|---|---|---|---|---|
| POST | session, teacher/student 403s, `Student not found`, roster 403, `lockLiveStudent` (`STUDENT_ERASED`), class read (404), `NotYourClassError` (403) | entry cancelled → `CLASS_CANCELLED` | active registration → unchanged | status → `CLASS_NOT_BOOKABLE`; capacity → `CLASS_FULL` |
| PUT | session, teacher-only 403, pre-read 404, `Not your class` 403 | (after the write misses) entry cancelled → `CLASS_CANCELLED` | stored status = requested → unchanged | `late_cancel` → `CLASS_NOT_STARTED`; `cancelled` → `REGISTRATION_CANCELLED`; any other status → `CONCURRENT_MODIFICATION` |
| DELETE | session, pre-read 404 (`NOT_FOUND`), `Access denied` 403 | entry cancelled → `CLASS_CANCELLED` | student: `cancelled`/`late_cancel`; teacher: `cancelled` → unchanged; teacher on `late_cancel` → `ALREADY_LATE_CANCELLED` | class `completed` → `CLASS_TERMINAL`; each CAS miss re-reads: unchanged / `ALREADY_LATE_CANCELLED` / `NOT_FOUND` / `CONCURRENT_MODIFICATION` |

`STUDENT_ERASED` stays where the lock order puts it: `lockLiveStudent` is the transaction's first statement (`docs/lock-order.md`, "The `Student` row is the erasure's gate"), so it answers before the class is read.

- [ ] **Step 1: Write the failing server tests**

**1a. `tests/integration/registrations-api.test.ts` — imports.** Replace `:1` with:

```ts
import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import { randomUUID } from 'crypto';
```

and after `:7` (`import { isEssential } ...`) add:

```ts
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
```

**1b. `makeOtherTeacherClass` takes its start time**, so a second caller does not overlap the first on `CalendarEntry_teacher_slot_excl`. Replace `:146` and `:152`:

```ts
async function makeOtherTeacherClass(maxStudents: number, startTime: string): Promise<string> {
```

```ts
      startTime: hhmmToTime(startTime),
```

and change its one caller at `:316` to `const classId = await makeOtherTeacherClass(5, '09:00');`.

**1c. New POST tests.** Replace the whole test at `:369-375` (`'returns 409 (not 500) for a duplicate registration'`) with:

```ts
  it('answers a repeated booking as unchanged, and writes nothing', async () => {
    const classId = await makeClass(5);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    const booked = (await expectApplied(await post(studentTokens[0]!, { classId }), 201)) as {
      id: string;
    };
    const before = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });
    const notices = await prisma.notification.count({ where: { relatedClassId: classId } });
    // The booking's confirmation pair: one to the student, one to the teacher.
    expect(notices).toBe(2);

    const again = await post(studentTokens[0]!, { classId });

    expect(await expectUnchanged(again)).toEqual({ id: booked.id, status: 'registered' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await prisma.registration.count({ where: { classId } })).toBe(1);
    expect(await prisma.notification.count({ where: { relatedClassId: classId } })).toBe(notices);
  });

  it('answers a teacher re-adding a booked student as unchanged', async () => {
    const classId = await makeClass(5);
    const added = (await expectApplied(
      await post(ownerToken, { classId, studentId: studentIds[1] }),
      201,
    )) as { id: string };
    const before = await prisma.registration.findUniqueOrThrow({ where: { id: added.id } });

    const again = await post(ownerToken, { classId, studentId: studentIds[1] });

    expect(await expectUnchanged(again)).toEqual({ id: added.id, status: 'registered' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: added.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await prisma.registration.count({ where: { classId } })).toBe(1);
  });

  /**
   * The last seat, which is what the order of the checks is for: the holder's
   * retry finds its own booking before it finds the class full, and a student
   * without one finds the class full.
   */
  it('answers the holder of the last seat as unchanged and the next student as full', async () => {
    const classId = await makeClass(1);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    await expectApplied(await post(studentTokens[0]!, { classId }), 201);

    await expectUnchanged(await post(studentTokens[0]!, { classId }));
    await expectRefusal(await post(studentTokens[1]!, { classId }), 'CLASS_FULL');

    expect(await prisma.registration.count({ where: { classId } })).toBe(1);
  });

  /**
   * Cancelling a class leaves its registrations `registered`, so the booking
   * check would find this student's seat. The cancellation is checked first:
   * the class being off is what the student needs to hear.
   */
  it('tells a booked student retrying on a cancelled class that it was cancelled', async () => {
    const classId = await makeClass(5);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    await expectApplied(await post(studentTokens[0]!, { classId }), 201);
    const { calendarEntryId } = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { calendarEntryId: true },
    });
    await prisma.calendarEntry.update({
      where: { id: calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    await expectRefusal(await post(studentTokens[0]!, { classId }), 'CLASS_CANCELLED');
  });

  it('refuses a student booking into a class that is not taking bookings', async () => {
    const classId = await makeClass(5);
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    await expectRefusal(await post(studentTokens[0]!, { classId }), 'CLASS_NOT_BOOKABLE');
    expect(await prisma.registration.count({ where: { classId } })).toBe(0);
  });

  /**
   * The one test that can see the booking check placed above the ownership
   * check: the student already holds a seat in the other teacher's class, so a
   * check that ran first would tell this teacher "unchanged" about a class
   * they do not teach.
   */
  it("refuses another teacher's class even when the student already holds a seat in it", async () => {
    const classId = await makeOtherTeacherClass(5, '11:00');
    const held = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });

    const res = await post(ownerToken, { classId, studentId: studentIds[0] });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { outcome?: unknown };
    expect(body.outcome).toBeUndefined();
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: held.id } });
    expect(after.updatedAt).toEqual(held.updatedAt);
  });
```

**1d. New PUT tests.** Inside `describe('PUT /api/registrations/[id] — attendance is scoped by source status (#182)', …)`, directly before its closing `});` at `:1388`, add:

```ts
  function putStatus(token: string, id: string, status: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/registrations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ status }),
    });
  }

  it('answers a repeated attendance mark as unchanged, without rewriting the row', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    await expectApplied(await putStatus(ownerToken, reg.id, 'attended'));
    const before = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });

    const again = await putStatus(ownerToken, reg.id, 'attended');

    expect(await expectUnchanged(again)).toEqual({ id: reg.id, status: 'attended' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('attended');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  /**
   * The undo tap on a late cancel the teacher had marked present, arriving
   * after the class is back to what it asks for. Nothing to write.
   */
  it('answers a late cancel re-marked as late cancel as unchanged while the class is open', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'late_cancel', tierAtBooking: 3 },
    });

    const res = await putStatus(ownerToken, reg.id, 'late_cancel');

    expect(await expectUnchanged(res)).toEqual({ id: reg.id, status: 'late_cancel' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('late_cancel');
    expect(after.updatedAt).toEqual(reg.updatedAt);
  });

  it('applies a different status to a row already marked', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'attended', tierAtBooking: 3 },
    });

    const res = await putStatus(ownerToken, reg.id, 'no_show');

    expect(await expectApplied(res)).toEqual({ id: reg.id, status: 'no_show' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('no_show');
  });

  it('tells the teacher the class was cancelled before it compares statuses', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'attended', tierAtBooking: 3 },
    });
    const { calendarEntryId } = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { calendarEntryId: true },
    });
    await prisma.calendarEntry.update({
      where: { id: calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    await expectRefusal(await putStatus(ownerToken, reg.id, 'attended'), 'CLASS_CANCELLED');
  });

  it("refuses another teacher's attendance mark even when the status already matches", async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'attended', tierAtBooking: 3 },
    });

    const res = await putStatus(otherTeacherToken, reg.id, 'attended');

    expect(res.status).toBe(403);
    const body = (await res.json()) as { outcome?: unknown };
    expect(body.outcome).toBeUndefined();
  });
```

**1e. New DELETE describe.** At the end of the file (after `:1829`), add:

```ts
describe('DELETE /api/registrations/[id] — a booking already cancelled (#197)', () => {
  function cancel(token: string, id: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/registrations/${id}`, {
      method: 'DELETE',
      headers: cookie(token),
    });
  }

  async function cancelClass(classId: string): Promise<void> {
    const { calendarEntryId } = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { calendarEntryId: true },
    });
    await prisma.calendarEntry.update({
      where: { id: calendarEntryId },
      data: { cancelledAt: new Date() },
    });
  }

  function notices(classId: string, type: 'booking_cancelled' | 'booking_removed'): Promise<number> {
    return prisma.notification.count({
      where: { relatedClassId: classId, recipientType: 'student', type },
    });
  }

  it("answers a student's second cancel as unchanged, and sends no second notice", async () => {
    const classId = await makeClass(5);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    const booked = (await expectApplied(await post(studentTokens[0]!, { classId }), 201)) as {
      id: string;
    };
    await expectApplied(await cancel(studentTokens[0]!, booked.id));
    const before = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });

    const again = await cancel(studentTokens[0]!, booked.id);

    expect(await expectUnchanged(again)).toEqual({ id: booked.id, status: 'cancelled' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });
    expect(after.cancelledAt).toEqual(before.cancelledAt);
    expect(await notices(classId, 'booking_cancelled')).toBe(1);
  });

  it('answers a student who cancelled late and cancels again as unchanged', async () => {
    // A distinct offset: `makeLateCancelClass`'s docblock says why each caller needs one.
    const classId = await makeLateCancelClass(5, 80);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    const booked = (await expectApplied(await post(studentTokens[0]!, { classId }), 201)) as {
      id: string;
    };
    expect(await expectApplied(await cancel(studentTokens[0]!, booked.id))).toEqual({
      id: booked.id,
      status: 'late_cancel',
    });
    const before = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });

    const again = await cancel(studentTokens[0]!, booked.id);

    expect(await expectUnchanged(again)).toEqual({ id: booked.id, status: 'late_cancel' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: booked.id } });
    expect(after.cancelledAt).toEqual(before.cancelledAt);
    expect(await notices(classId, 'booking_cancelled')).toBe(1);
  });

  it("answers a teacher's second cancel as unchanged, and sends no second notice", async () => {
    const classId = await makeClass(5);
    onTestFinished(async () => {
      await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    });
    const booked = (await expectApplied(await post(studentTokens[1]!, { classId }), 201)) as {
      id: string;
    };
    await expectApplied(await cancel(ownerToken, booked.id));

    const again = await cancel(ownerToken, booked.id);

    expect(await expectUnchanged(again)).toEqual({ id: booked.id, status: 'cancelled' });
    expect(await notices(classId, 'booking_removed')).toBe(1);
  });

  /**
   * A teacher's cancel is a free one. A row the student already cancelled late
   * is still charged, so the teacher's request is not what the row says, and
   * is refused rather than reported done.
   */
  it('refuses a teacher cancelling a late cancel for free: the student stays charged', async () => {
    const classId = await makeClass(5);
    const reg = await prisma.registration.create({
      data: {
        classId,
        studentId: studentIds[0]!,
        status: 'late_cancel',
        cancelledAt: new Date(),
        tierAtBooking: 3,
      },
    });

    await expectRefusal(await cancel(ownerToken, reg.id), 'ALREADY_LATE_CANCELLED');

    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('late_cancel');
    expect(after.updatedAt).toEqual(reg.updatedAt);
    expect(await notices(classId, 'booking_removed')).toBe(0);
  });

  it('tells a student their class was cancelled, even when their booking is cancelled too', async () => {
    const classId = await makeClass(5);
    const reg = await prisma.registration.create({
      data: {
        classId,
        studentId: studentIds[0]!,
        status: 'cancelled',
        cancelledAt: new Date(),
        tierAtBooking: 3,
      },
    });
    await cancelClass(classId);

    await expectRefusal(await cancel(studentTokens[0]!, reg.id), 'CLASS_CANCELLED');
  });

  /**
   * The booking check sits above the finished-class refusal: a cancel that
   * already holds is answered as done whatever happened to the class since.
   */
  it('answers a cancelled booking on a class that has since finished as unchanged', async () => {
    const classId = await makeClass(5);
    const reg = await prisma.registration.create({
      data: {
        classId,
        studentId: studentIds[0]!,
        status: 'cancelled',
        cancelledAt: new Date(),
        tierAtBooking: 3,
      },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });

    expect(await expectUnchanged(await cancel(studentTokens[0]!, reg.id))).toEqual({
      id: reg.id,
      status: 'cancelled',
    });
  });

  it('refuses to cancel a live booking on a class that has finished', async () => {
    const classId = await makeClass(5);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });

    await expectRefusal(await cancel(studentTokens[0]!, reg.id), 'CLASS_TERMINAL');

    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('registered');
  });

  it("refuses another teacher's cancel even when the booking is already cancelled", async () => {
    const classId = await makeClass(5);
    const reg = await prisma.registration.create({
      data: {
        classId,
        studentId: studentIds[0]!,
        status: 'cancelled',
        cancelledAt: new Date(),
        tierAtBooking: 3,
      },
    });

    const res = await cancel(otherTeacherToken, reg.id);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { outcome?: unknown };
    expect(body.outcome).toBeUndefined();
  });

  it('answers a booking that does not exist with its code', async () => {
    await expectRefusal(await cancel(studentTokens[0]!, randomUUID()), 'NOT_FOUND');
  });
});
```

**1f. `src/app/api/registrations/route.test.ts` — the booking that already exists, and its P2002 twin.** Replace `:3` with `import { Prisma, PrismaClient } from '@prisma/client';` and after `:9` (`import { POST } from './route';`) add:

```ts
import * as waitlistService from '@/services/waitlist';
import { expectUnchanged } from '../../../../tests/api-assertions';
```

At the end of the file add:

```ts
/**
 * A booking that already exists, found two ways: by the transaction's own
 * check, and by the unique key when a twin request committed first. The twin
 * is staged at `activateRegistration`, the write that would meet the key: the
 * stand-in reactivates the row on this file's own connection — the booking's
 * transaction holds no lock on it — and then raises the violation the real
 * insert would have raised.
 */
describe('POST /api/registrations — a booking that already exists', () => {
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let studentId: string;
  let token: string;
  const accountIds: string[] = [];

  function book(): Promise<Response> {
    return POST(new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    }));
  }

  function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: { target: ['classId', 'studentId'] },
    });
  }

  beforeAll(async () => {
    const teacherEmail = `reg-held-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Reg', lastName: 'Held',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'registrations-route held-booking fixture teacher',
        pageSlug: `reg-held-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Reg Held Studio', address: `${suffix} Held St`, city: 'Amsterdam',
        postcode: '1234RH', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Reg Held Vinyasa',
      date: new Date('2099-08-03'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 8,
      status: 'open',
    });
    classId = cls.id;

    // `tierSelectedAt` stays null: the unchanged answer must not write it.
    const studentEmail = `reg-held-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Held',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);
    token = await seedSession(prisma, studentAccountId);

    await prisma.registration.create({
      data: { classId, studentId, status: 'registered', tierAtBooking: 3 },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  // Runs first: the two below change the row's status.
  it('answers unchanged, and writes neither the tier marker nor a notification', async () => {
    const before = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId } },
    });

    const res = await book();

    expect(await expectUnchanged(res)).toEqual({ id: before.id, status: 'registered' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    const marker = await prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { tierSelectedAt: true },
    });
    expect(marker.tierSelectedAt).toBeNull();
    expect(await prisma.notification.count({ where: { relatedClassId: classId } })).toBe(0);
  });

  it('answers the twin of a booking that committed first as unchanged', async () => {
    const row = await prisma.registration.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const twin = vi
      .spyOn(waitlistService, 'activateRegistration')
      .mockImplementationOnce(async () => {
        await prisma.registration.update({
          where: { id: row.id },
          data: { status: 'registered', cancelledAt: null },
        });
        throw uniqueViolation();
      });
    onTestFinished(() => twin.mockRestore());

    const res = await book();

    expect(twin).toHaveBeenCalledTimes(1);
    expect(await expectUnchanged(res)).toEqual({ id: row.id, status: 'registered' });
    expect(await prisma.notification.count({ where: { relatedClassId: classId } })).toBe(0);
  });

  /**
   * The re-read has to find an ACTIVE row. A twin cancelled again before the
   * re-read proves nothing about this request, so the violation reaches
   * `withErrorHandler` like any other.
   */
  it('lets a unique violation whose twin is no longer active reach the error handler', async () => {
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const twin = vi
      .spyOn(waitlistService, 'activateRegistration')
      .mockRejectedValueOnce(uniqueViolation());
    onTestFinished(() => twin.mockRestore());
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => warn.mockRestore());

    const res = await book();

    expect(twin).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { outcome?: unknown };
    expect(body.outcome).toBeUndefined();
  });
});
```

**1g. `src/app/api/registrations/[id]/route.test.ts` (new).** The missed-write branches that no HTTP test can schedule. The harness copies `promote-after-cancel.test.ts:36-81` (same mocks, same session shape):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';

/**
 * What PUT and DELETE answer when their scoped write matches nothing, decided
 * from the re-read that follows it.
 *
 * Mocked, as `promote-after-cancel.test.ts` beside it is: each case needs the
 * row to change between the write and the re-read, which nothing outside the
 * handler can schedule. The session is a teacher's, so DELETE takes the
 * full-cancel branch; the handler, its ownership check and its answers are
 * real.
 */
const findUnique = vi.fn();
const updateMany = vi.fn();
const handleSpotFreed = vi.fn();
const notificationCreate = vi.fn();

vi.mock('@/services/waitlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/waitlist')>();
  return { ...actual, handleSpotFreed: (...args: unknown[]) => handleSpotFreed(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireSession: async () => ({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    }),
  };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    registration: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
    },
    notification: { create: (...args: unknown[]) => notificationCreate(...args) },
  },
}));

const { PUT, DELETE } = await import('./route');

const params = () => ({ params: Promise.resolve({ id: 'reg-1' }) });

function bookingRow() {
  return {
    id: 'reg-1',
    classId: 'class-1',
    studentId: 'student-1',
    status: 'registered',
    class: {
      id: 'class-1',
      status: 'open',
      maxStudents: 10,
      cancelDeadline: 'HOURS_24',
      calendarEntry: {
        teacherId: 'teacher-1',
        classType: 'Vinyasa',
        date: new Date('2099-06-01T00:00:00Z'),
        startTime: new Date('1970-01-01T10:00:00Z'),
        cancelledAt: null,
        teacher: { defaultTimezone: 'Europe/Amsterdam' },
      },
    },
  };
}

beforeEach(() => {
  findUnique.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 0 });
  handleSpotFreed.mockReset();
  notificationCreate.mockReset();
});

describe('DELETE /api/registrations/[id] — a teacher cancel whose write missed', () => {
  function cancel(): Promise<Response> {
    return DELETE(
      new NextRequest('http://localhost:3000/api/registrations/reg-1', { method: 'DELETE' }),
      params(),
    );
  }

  /** The pre-read sees a live booking; the re-read after the missed write sees `row`. */
  function afterTheWrite(row: { status: string } | null): void {
    findUnique.mockResolvedValueOnce(bookingRow()).mockResolvedValueOnce(row);
  }

  it('answers unchanged when the row is now cancelled', async () => {
    afterTheWrite({ status: 'cancelled' });

    expect(await expectUnchanged(await cancel())).toEqual({ id: 'reg-1', status: 'cancelled' });
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('refuses when the student cancelled late in between: they stay charged', async () => {
    afterTheWrite({ status: 'late_cancel' });

    await expectRefusal(await cancel(), 'ALREADY_LATE_CANCELLED');
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });

  it('answers not found when the row is gone', async () => {
    afterTheWrite(null);

    await expectRefusal(await cancel(), 'NOT_FOUND');
    expect(handleSpotFreed).not.toHaveBeenCalled();
  });

  it('says the booking changed when the row is active again', async () => {
    afterTheWrite({ status: 'registered' });

    await expectRefusal(await cancel(), 'CONCURRENT_MODIFICATION');
    expect(handleSpotFreed).not.toHaveBeenCalled();
    expect(notificationCreate).not.toHaveBeenCalled();
  });
});

describe('PUT /api/registrations/[id] — an attendance write that missed', () => {
  function mark(status: 'attended' | 'no_show' | 'late_cancel'): Promise<Response> {
    return PUT(
      new NextRequest('http://localhost:3000/api/registrations/reg-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
      params(),
    );
  }

  it('says the booking changed when the row now holds another active status', async () => {
    findUnique
      .mockResolvedValueOnce({ ...bookingRow(), class: { calendarEntry: { teacherId: 'teacher-1' } } })
      .mockResolvedValueOnce({
        status: 'attended',
        class: { status: 'open', calendarEntry: { cancelledAt: null } },
      });

    await expectRefusal(await mark('no_show'), 'CONCURRENT_MODIFICATION');
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Rewrite the existing server tests the change breaks**

`tests/integration/registrations-api.test.ts`:

- `:351-352` (two students race for one seat; the loser is a genuine `CLASS_FULL`). After `expect(statuses).toEqual([201, 409]);` add:
  ```ts
      await expectRefusal(a.status === 409 ? a : b, 'CLASS_FULL');
  ```
- `:385` `expect(add.status).toBe(409);` → `await expectRefusal(add, 'CLASS_FULL');`
- `:409-411` (studentTokens[0] already holds a seat in this class since `:390`) →
  ```ts
      // A student already booked into the running class is answered as booked.
      await expectUnchanged(await post(studentTokens[0]!, { classId }));
  ```
- `:604-606` →
  ```ts
      await expectRefusal(res, 'CLASS_CANCELLED');
  ```
- `:648-650` →
  ```ts
      await expectRefusal(res, 'CLASS_FULL');
  ```
- `:1248-1254` (the status line, the four-line comment and the two message lines) →
  ```ts
      // The code, not just the status: the defect this replaced was a refusal
      // whose reason never reached the teacher, and the code is what names it.
      await expectRefusal(res, 'CLASS_NOT_STARTED');
  ```
- `:1275` `expect(res.status).toBe(409);` → `await expectRefusal(res, 'CLASS_NOT_STARTED');`
- `:1334` → `await expectRefusal(res, 'REGISTRATION_CANCELLED');`
- `:1355` → `await expectRefusal(res, 'CLASS_CANCELLED');`
- `:1524-1531` (comment) → 
  ```ts
      // Two plain fetches in Promise.all serialise: the second lands after the
      // first committed and is answered by its PRE-CHECK, not by the guard
      // under test. A holder takes the registration row lock BEFORE either
      // request runs, so both pass the pre-check (uncommitted state is
      // invisible under READ COMMITTED) and both park on the lock at the
      // write — the interleaving a plain Promise.all cannot force.
  ```
- `:1559-1563` (comment) → 
  ```ts
      // The lever is asserted, not assumed. Without this, a slow route compile
      // or a loaded machine lets both requests finish BEFORE the release, the
      // second one is answered off its own pre-check instead of the guard
      // under test, and the whole test goes green against the bug.
  ```
- `:1570-1581` (comment, notification assertion, status pair) →
  ```ts
      // Asserted before the answers, deliberately: the doubled broadcast is
      // the defect — every waiting student notified twice for one freed seat —
      // and this is the assertion whose failure message names it.
      const notifications = await prisma.notification.findMany({
        where: { relatedClassId: classId, recipientId: waiterId, type: 'spot_available' },
      });
      expect(notifications).toHaveLength(1);

      // Either request can win; the other finds the booking already cancelled.
      expect([a.status, b.status]).toEqual([200, 200]);
      const outcomes = await Promise.all(
        [a, b].map(async (r) => ((await r.json()) as { outcome?: unknown }).outcome),
      );
      expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(1);
  ```
- `:1584` title → `it('answers the loser of two racing late cancels as unchanged', async () => {`. In its comment at `:1594`, replace `still produces [200, 409] here` with `still produces one applied and one unchanged answer here` (the rest of the line stays).
- `:1627-1629` →
  ```ts
      // One cancel, one unchanged answer — the contract the full-cancel branch
      // honours, asserted here so the two branches cannot drift apart.
      expect([a.status, b.status]).toEqual([200, 200]);
      const outcomes = await Promise.all(
        [a, b].map(async (r) => ((await r.json()) as { outcome?: unknown }).outcome),
      );
      expect(outcomes.filter((o) => o === 'unchanged')).toHaveLength(1);
  ```
- `:1644`: replace the leading `[200, 409].` with `one applied and one unchanged.` (the rest of the line, `The starting state has to be …`, stays).
- `:1690` `expect(res.status).toBe(409);` →
  ```ts
      // The student's goal — their booking cancelled — holds, and free.
      expect(await expectUnchanged(res)).toEqual({ id: data.id, status: 'cancelled' });
  ```
- `:1693-1705` → 
  ```ts
    it('answers a second cancel of a registration already cancelled as unchanged', async () => {
      const { classId, registrationId } = await makeBroadcastFixture(10);

      const first = await fetch(`${BASE_URL}/api/registrations/${registrationId}`, {
        method: 'DELETE', headers: cookie(cancellerToken),
      });
      await expectApplied(first);

      const second = await fetch(`${BASE_URL}/api/registrations/${registrationId}`, {
        method: 'DELETE', headers: cookie(cancellerToken),
      });
      await expectUnchanged(second);

      // The first cancel's broadcast and notice, once each.
      expect(await prisma.notification.count({
        where: { relatedClassId: classId, recipientId: waiterId, type: 'spot_available' },
      })).toBe(1);
      expect(await prisma.notification.count({
        where: { relatedClassId: classId, recipientId: cancellerId, type: 'booking_cancelled' },
      })).toBe(1);
    });
  ```

`src/app/api/registrations/route.test.ts:387-397` — replace the docblock's first paragraph (`:388-392`) with:

```ts
 * The student's own booking writes `Student.tierSelectedAt` after its
 * transaction has committed, so by then the booking exists. A failure of that
 * write is answered as the booking's success, and logged: the booking holds,
 * and a retry would only be answered as unchanged.
```

`src/app/api/registrations/route-lock-order.test.ts` — assert the code, not the words:

- Delete `:48-49` (`DELETED_MESSAGE`, `GONE_MESSAGE`) and the blank line after them.
- `:51` → `type Settled = { status: number; code: string | null; rejection?: string };`
- `:65-80` (the `settle` function and its docblock) →
  ```ts
  /** A booking as a value: status and error code, never a rejection. */
  function settle(response: Promise<Response>): Promise<Settled> {
    return response.then(
      async (res) => {
        const json: unknown = await res.json().catch(() => null);
        const error =
          typeof json === 'object' && json !== null && 'error' in json ? json.error : null;
        const code =
          typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
            ? error.code
            : null;
        return { status: res.status, code };
      },
      (err: unknown) => ({ status: -1, code: null, rejection: String(err) }),
    );
  }
  ```
- `:375`, `:434`, `:464` (`{ status: 409, message: DELETED_MESSAGE }`) and `:409`, `:495` (`{ status: 409, message: GONE_MESSAGE }`) → `toEqual({ status: 409, code: 'STUDENT_ERASED' })`.
- `:570` `expect(res).toEqual({ status: 409, message: GONE_MESSAGE });` → `expect(res).toEqual({ status: 409, code: 'STUDENT_ERASED' });`
- `:618` `expect(res?.message).not.toBe(DELETED_MESSAGE);` → `expect(res?.code).toBeNull();` (a 503 carries no code).

- [ ] **Step 3: Write the failing client tests**

`src/components/student/cancel-booking-button.test.tsx` (new):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CancelBookingButton } from './cancel-booking-button';
import { routerRefresh } from '../../../tests/setup/components';

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '/api/registrations/reg-1',
    json: async () => body,
  };
}

describe('CancelBookingButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  /** Opens the confirmation, then confirms. */
  function confirmCancel(): void {
    render(<CancelBookingButton registrationId="reg-1" cancelDeadline="HOURS_24" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
  }

  it('cancels the booking and refreshes the page', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { id: 'reg-1', status: 'cancelled' } }));
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/registrations/reg-1', { method: 'DELETE' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a booking the server finds already cancelled as done', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { data: { id: 'reg-1', status: 'cancelled' }, outcome: 'unchanged' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a booking that no longer exists as done', async () => {
    fetchMock.mockResolvedValue(
      reply(404, { error: { message: 'This booking no longer exists.', code: 'NOT_FOUND' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows any other refusal in the server’s words and stays put', async () => {
    fetchMock.mockResolvedValue(
      reply(409, {
        error: {
          message: "This class has finished, so the booking can't be cancelled.",
          code: 'CLASS_TERMINAL',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This class has finished, so the booking can't be cancelled.",
    );
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).not.toBeDisabled();
  });

  it('says so when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
```

`src/components/class/add-walk-in.test.tsx` — `add-walk-in.tsx` needs no change: it keys success on `res.ok`, so an unchanged 200 already closes the picker and refreshes. Fix the mock the server never sends, and pin the unchanged case:

- After `:3` add `import { routerRefresh } from '../../../tests/setup/components';`
- `:204` →
  ```tsx
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: { message: 'This class is full.', code: 'CLASS_FULL' } }),
          };
  ```
- `:216` → `await waitFor(() => expect(screen.getByText('This class is full.')).toBeInTheDocument());`
- After that test closes (`:221`), add:
  ```tsx
    it('closes the picker and refreshes when the student turns out to be booked already', async () => {
      fetchMock.mockImplementation(async (input: string, init?: { method?: string }) => {
        const url = String(input);
        if (url === '/api/students') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { students: [{ id: 's1', displayName: 'Anna Bakker' }] } }),
          };
        }
        if (url === '/api/registrations' && init?.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { id: 'r1', status: 'registered' }, outcome: 'unchanged' }),
          };
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<AddWalkIn classId="c1" registeredStudentIds={[]} />);
      openPicker();
      await waitFor(() => expect(screen.getByText('Anna Bakker')).toBeInTheDocument());

      fireEvent.change(screen.getByLabelText('Walk-in student'), { target: { value: 's1' } });
      fireEvent.click(screen.getByText('Add walk-in'));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByLabelText('Walk-in student')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  ```

`src/components/class/attendance-list.test.tsx` — `attendance-list.tsx` needs no change: success is `response.ok`, so an unchanged 200 records the status locally with no refresh.

- `:125-138` (the mocked refusal; the comment at `:127-130` stays) →
  ```tsx
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        // The shape `respondError` actually emits — `{ error: { message, code } }`,
        // not a bare string. The bare-string branch of `readErrorMessage` exists
        // for defensiveness; mocking it here would exercise a path the server
        // never produces and quietly stop testing the real one.
        json: async () => ({
          error: {
            message:
              'This student cancelled late. Attendance can be recorded once the class has started.',
            code: 'CLASS_NOT_STARTED',
          },
        }),
      });
  ```
  The assertions at `:144-149` stay as they are.
- After that test (`:150`), add:
  ```tsx
    it('marks the student present when the server finds that already recorded', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: 'reg-late', status: 'attended' }, outcome: 'unchanged' }),
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<AttendanceList items={[lateCancel]} />);

      fireEvent.click(screen.getByRole('button', { name: /mark them present/i }));

      await waitFor(() => expect(screen.getByText('Present')).toBeTruthy());
      expect(screen.queryByRole('alert')).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
    });
  ```

`src/components/booking/booking-flow.test.tsx` — `booking-flow.tsx` needs no change: it keys on `res.ok`, so an unchanged 200 shows "You're in". Directly before `  // #389. product-concept.md's booking-flow nudge` (`:141`), add:

```tsx
  describe('what the server answers', () => {
    function stubReply(status: number, body: unknown) {
      fetchMock.mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      });
      vi.stubGlobal('fetch', fetchMock);
    }

    it('shows the booking as confirmed when the server finds it already booked', async () => {
      stubReply(200, { data: { id: 'reg-1', status: 'registered' }, outcome: 'unchanged' });
      renderFlow({ currentTier: 3 });

      fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));

      expect(await screen.findByText("You're in")).toBeInTheDocument();
    });

    it('shows a booking refusal in the server’s words', async () => {
      stubReply(409, { error: { message: 'This class is full.', code: 'CLASS_FULL' } });
      renderFlow({ currentTier: 3 });

      fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('This class is full.');
      expect(screen.queryByText("You're in")).not.toBeInTheDocument();
    });
  });
```

- [ ] **Step 4: Run the tests to see them fail**

With the worktree app up (`pnpm run worktree:up`):

Run: `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: FAIL. The new unchanged tests fail with `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`; the code assertions fail with `expected { status: 409, code: undefined } to deeply equal { status: 409, code: 'CLASS_FULL' }` (and the same shape for `CLASS_CANCELLED`, `CLASS_NOT_BOOKABLE`, `CLASS_NOT_STARTED`, `REGISTRATION_CANCELLED`, `ALREADY_LATE_CANCELLED`, `CLASS_TERMINAL`); the not-found test fails with `{ status: 404, code: undefined }`; the #196 pairs fail with `expected [ 200, 409 ] to deeply equal [ 200, 200 ]`. The three 403 ordering tests and "applies a different status" pass already.

Run: `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts "src/app/api/registrations/[id]/route.test.ts"`
Expected: FAIL — the unchanged and twin tests get 409 without `outcome`; the `[id]` cases get `code: undefined`. "lets a unique violation … reach the error handler" passes already: it pins the new branch's condition.

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/registrations/route-lock-order.test.ts`
Expected: FAIL — six assertions receive `{ status: 409, code: null }`.

Run: `pnpm exec vitest run --project components src/components/student/cancel-booking-button.test.tsx src/components/class/add-walk-in.test.tsx src/components/class/attendance-list.test.tsx src/components/booking/booking-flow.test.tsx`
Expected: FAIL only in `cancel-booking-button.test.tsx`, "treats a booking that no longer exists as done" (an alert renders, `routerRefresh` is not called). The rest pass: those components already key on `res.ok`.

- [ ] **Step 5: Implement `POST /api/registrations`**

In `src/app/api/registrations/route.ts`, replace the imports `:1-11` with:

```ts
import { NextRequest } from 'next/server';
import type { RegistrationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

Replace `:25-47` (the four sentinel classes and `ClassStatusError`) with:

```ts
/** Thrown inside the registration transaction when the class is at capacity. */
class ClassFullError extends Error {}

/** Thrown inside the transaction when the locked class row does not exist. */
class ClassNotFoundError extends Error {}

/** Thrown inside the transaction when the caller does not own the class. */
class NotYourClassError extends Error {}

/**
 * Thrown inside the transaction when the class cannot take this booking.
 * `refusal` names the case, and the `catch` answers each with its own code.
 */
class ClassStatusError extends Error {
  constructor(readonly refusal: 'cancelled' | 'not_bookable') {
    super(`class refuses the booking: ${refusal}`);
  }
}

/** The booking a response names, applied or unchanged. */
type BookingBody = { id: string; status: RegistrationStatus };

/** What the transaction did: wrote the booking, or found it already held. */
type BookingOutcome = {
  readonly outcome: 'applied' | 'unchanged';
  readonly booking: BookingBody;
};
```

`:103` → `    const result = await prisma.$transaction(async (tx): Promise<BookingOutcome> => {`

Replace `:142-196` (from the ownership comment through the `activateRegistration` call) with — the walk-in block `:162-173` is carried over unchanged:

```ts
      // Teachers may only manage registrations for their own classes —
      // registering also locks the class's economic settings.
      if (actingTeacherId && cls.calendarEntry.teacherId !== actingTeacherId) {
        throw new NotYourClassError();
      }

      // A cancelled class keeps whatever status it had (#327), so it is a check
      // of its own. It comes before the booking check below: a booked student
      // retrying on a cancelled class is told the class is off.
      if (cls.calendarEntry.cancelledAt !== null) {
        throw new ClassStatusError('cancelled');
      }

      // The booking this request asks for already exists. Checked before the
      // status and capacity refusals below, so a retry is never refused for a
      // state its own first attempt created. A cancelled registration keeps its
      // row (unique per class+student) and is reactivated further down.
      const existing = await tx.registration.findUnique({
        where: { classId_studentId: { classId: body.classId, studentId } },
        select: { id: true, status: true },
      });
      if (existing && ACTIVE_REGISTRATION_STATUSES.includes(existing.status)) {
        return { outcome: 'unchanged', booking: existing };
      }

      // Students book open classes; the teacher can also add someone who
      // shows up while the class is in progress.
      const allowedStatuses = isTeacher ? ['open', 'in_progress'] : ['open'];
      if (!allowedStatuses.includes(cls.status)) {
        throw new ClassStatusError('not_bookable');
      }

      // Walk-ins are a class-time phenomenon: someone shows up at the door and
      // the teacher lets them in — those may exceed max_students (the teacher
      // rate stays capped at target; extra students lower prices). A teacher
      // adding a student well before class is a normal registration and
      // respects capacity like everyone else.
      const classStart = classStartInstant(
        cls.calendarEntry,
        cls.calendarEntry.teacher.defaultTimezone,
      );
      const isWalkIn =
        isTeacher &&
        (cls.status === 'in_progress' || Date.now() >= classStart.getTime() - WALK_IN_WINDOW_MS);

      const { isFull } = await readSeatCount(tx, body.classId);

      if (isFull && !isWalkIn) {
        throw new ClassFullError();
      }

      const reg = await activateRegistration(tx, {
        classId: body.classId,
        studentId,
        tierAtBooking: student.incomeTier,
        isWalkIn,
      });
```

Replace `:277-278`:

```ts
      return { outcome: 'applied', booking: { id: reg.id, status: reg.status } };
    });

    if (result.outcome === 'unchanged') {
      return respondUnchanged<BookingBody>(result.booking);
    }
    const registration = result.booking;
```

The tier-marker block `:280-312` stays as it is (it reads `registration.id`, which is still in scope, and it now runs only for an applied booking). Replace `:314` with:

```ts
    return respondTyped<BookingBody>(registration, 201);
```

Replace the catch `:315-348` with:

```ts
  } catch (err) {
    if (err instanceof ClassNotFoundError) {
      return respondError('Class not found', 404);
    }
    if (err instanceof StudentErasedError) {
      return respondError(
        isTeacher ? "This student's account no longer exists." : 'This account has been deleted.',
        409,
        'STUDENT_ERASED',
      );
    }
    if (err instanceof NotYourClassError) {
      return respondError('Not your class', 403);
    }
    if (err instanceof ClassStatusError) {
      return err.refusal === 'cancelled'
        ? respondError('This class has been cancelled.', 409, 'CLASS_CANCELLED')
        : respondError("This class isn't taking bookings.", 409, 'CLASS_NOT_BOOKABLE');
    }
    if (err instanceof ClassFullError) {
      return respondError('This class is full.', 409, 'CLASS_FULL');
    }
    // The column set, not a bare `P2002`: `Registration @@unique([classId,
    // studentId])` is the only violation that can mean a twin request booked
    // this student first. Re-read outside the rolled-back transaction; an
    // active row is the booking this request asks for. Anything else — another
    // violation, or a twin no longer active — falls through to
    // `withErrorHandler`.
    if (isUniqueConflictOn(err, ['classId', 'studentId'])) {
      const twin = await prisma.registration.findUnique({
        where: { classId_studentId: { classId: body.classId, studentId } },
        select: { id: true, status: true },
      });
      if (twin && ACTIVE_REGISTRATION_STATUSES.includes(twin.status)) {
        return respondUnchanged<BookingBody>(twin);
      }
    }
    throw err;
  }
});
```

`AlreadyRegisteredError` is gone: the transaction's own check now returns instead of throwing, and nothing else threw it.

- [ ] **Step 6: Implement `PUT` and `DELETE /api/registrations/[id]`**

In `src/app/api/registrations/[id]/route.ts`, replace `:1-10` with:

```ts
import { NextRequest, type NextResponse } from 'next/server';
import type { RegistrationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
```

and after the last import (`:19`) add:

```ts

/** A PUT's response body, applied or unchanged. */
type AttendanceBody = { id: string; status: RegistrationStatus };

/** A DELETE's response body, applied or unchanged. */
type CancelledBooking = { id: string; status: 'cancelled' | 'late_cancel' };
```

**PUT.** Replace `:150-190` (the `updateMany` through `return respondOk({ id, status: parsed.data.status });`) with:

```ts
  const requested = parsed.data.status;
  const updated = await prisma.registration.updateMany({
    where: {
      id,
      // The requested status too: a row already holding it is not rewritten,
      // and the re-read below answers it as unchanged.
      status: { notIn: ['cancelled', requested] },
      // The class's cancellation is an ENTRY column since #327, not a status.
      class: { calendarEntry: { cancelledAt: null } },
      // NOT(late_cancel AND class open), written as its contrapositive so each
      // arm is a plain condition Prisma can compile without a nested relation
      // negation.
      OR: [{ status: { not: 'late_cancel' } }, { class: { status: { not: 'open' } } }],
    },
    data: { status: requested },
  });

  if (updated.count === 0) {
    // The write has already failed, so there is nothing left to protect by not
    // reading — and the snapshot above was taken before `parseBody`'s await,
    // which makes naming a status from it the same staleness the sibling cancel
    // route had to fix separately. Decide from the WHERE, explain from a fresh
    // read.
    const current = await prisma.registration.findUnique({
      where: { id },
      select: {
        status: true,
        class: { select: { status: true, calendarEntry: { select: { cancelledAt: true } } } },
      },
    });
    if (!current) return respondError('Registration not found', 404);
    if (current.class.calendarEntry.cancelledAt !== null) {
      return respondError(
        "This class has been cancelled, so attendance can't be recorded.",
        409,
        'CLASS_CANCELLED',
      );
    }
    if (current.status === requested) {
      return respondUnchanged<AttendanceBody>({ id, status: requested });
    }
    switch (current.status) {
      case 'late_cancel':
        return respondError(
          'This student cancelled late. Attendance can be recorded once the class has started.',
          409,
          'CLASS_NOT_STARTED',
        );
      case 'cancelled':
        return respondError(
          "This booking was cancelled, so attendance can't be recorded.",
          409,
          'REGISTRATION_CANCELLED',
        );
      case 'registered':
      case 'attended':
      case 'no_show':
        // A status the write would have matched: another write moved the row
        // between the two statements.
        return respondError(
          'This booking was just changed elsewhere. Refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION',
        );
      default: {
        const unreachable: never = current.status;
        throw new Error(`unhandled registration status: ${String(unreachable)}`);
      }
    }
  }

  return respondTyped<AttendanceBody>({ id, status: requested });
});
```

**DELETE.** Replace `:223-242` (from `if (!registration) return respondError('Registration not found', 404);` through the already-cancelled pre-check) with:

```ts
  if (!registration) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');

  // Allow cancellation by the student themselves or the class teacher
  const isStudent = registration.studentId === session.studentId;
  const isTeacher = registration.class.calendarEntry.teacherId === session.teacherId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  // A cancelled class makes the request moot, so it is answered before the
  // booking's own state. A cancelled class is an entry column since #327.
  if (registration.class.calendarEntry.cancelledAt !== null) {
    return respondError('This class has been cancelled.', 409, 'CLASS_CANCELLED');
  }

  // Before the finished-class refusal: a cancel that already holds is done,
  // whatever happened to the class since. Branched on `isStudent`, as the
  // notice below is.
  const alreadyCancelled = answerForCancelledRow(id, registration.status, isStudent);
  if (alreadyCancelled) return alreadyCancelled;

  // Cancelling on a completed class would orphan its payment.
  if (registration.class.status === 'completed') {
    return respondError(
      "This class has finished, so the booking can't be cancelled.",
      409,
      'CLASS_TERMINAL',
    );
  }
```

In the late-cancel comment, replace `:268-270` (from `// student for a class the teacher had let them out of. The scope also` through `// branch already gives, instead of a second 200.`) with:

```ts
      // student for a class the teacher had let them out of. The scope also
      // keeps the loser of two concurrent late cancels from writing twice: it
      // re-reads and is answered as unchanged, as the sibling branch's is.
```

Replace `:275-277` and `:300-302` (both `if (updated.count === 0) { return respondError('Registration is already cancelled', 409); }`) with:

```ts
      if (updated.count === 0) {
        return answerMissedCancel(id, isStudent);
      }
```

(indented to each site's depth). Replace `:289` with `      return respondTyped<CancelledBooking>({ id, status: 'late_cancel' });` and `:338` with `  return respondTyped<CancelledBooking>({ id, status: 'cancelled' });`.

After the DELETE handler's closing `});` (`:339`), add:

```ts

/**
 * The answer to a cancel whose registration is already cancelled, or `null`
 * when the cancel still has work to do. Either cancelled status is what a
 * student's cancel asks for. A teacher's cancel is free: a `late_cancel` row
 * is still charged, so it is refused rather than reported done.
 */
function answerForCancelledRow(
  id: string,
  status: RegistrationStatus,
  byStudent: boolean,
): NextResponse | null {
  if (status === 'cancelled' || (byStudent && status === 'late_cancel')) {
    return respondUnchanged<CancelledBooking>({ id, status });
  }
  if (status === 'late_cancel') {
    return respondError(
      'This student already cancelled late, and the late-cancellation charge stands.',
      409,
      'ALREADY_LATE_CANCELLED',
    );
  }
  return null;
}

/**
 * A cancel whose scoped write matched nothing: after the read above, the row
 * left the cancellable statuses or was deleted. Decided from a fresh read.
 */
async function answerMissedCancel(id: string, byStudent: boolean): Promise<NextResponse> {
  const current = await prisma.registration.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!current) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');
  return (
    answerForCancelledRow(id, current.status, byStudent) ??
    // Active again: a rebooking reactivated the row between the two statements.
    respondError(
      'This booking was just changed elsewhere. Refresh and try again.',
      409,
      'CONCURRENT_MODIFICATION',
    )
  );
}
```

Run `pnpm run typecheck`. Expected: clean. (`status` narrows to `'cancelled' | 'late_cancel'` inside the first `if` of `answerForCancelledRow`; if the compiler does not narrow it, the fix is to split the condition into two `if`s, each returning `respondUnchanged` with its literal — not a cast.)

- [ ] **Step 7: Clients**

- `src/components/booking/booking-flow.tsx` — no change: success is `res.ok`, so an unchanged booking shows "You're in"; refusals render through `readErrorMessage` into `role="alert"` (`:254`).
- `src/components/class/add-walk-in.tsx` — no change: success is `res.ok`.
- `src/components/class/attendance-list.tsx` — no change: success is `response.ok`; a refusal (`CONCURRENT_MODIFICATION` included) shows the message and refreshes.
- `src/components/student/cancel-booking-button.tsx` — a `NOT_FOUND` to its own DELETE is done. Replace `:6` with `import { readError } from '@/lib/client-errors';` and `:26-41` with:

```tsx
  async function handleCancel() {
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/registrations/${registrationId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const { code, message } = await readError(res, 'Could not cancel. Try again.');
      // A booking that no longer exists is as cancelled as this button can make it.
      if (code === 'NOT_FOUND') {
        router.refresh();
        return;
      }
      setError(message);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setCancelling(false);
    }
  }
```

The error paragraph at `:65` already has `role="alert"`.

- [ ] **Step 8: Run green**

Run: `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts "src/app/api/registrations/[id]/route.test.ts" "src/app/api/registrations/[id]/promote-after-cancel.test.ts"`
Expected: PASS.

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/registrations/route-lock-order.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project components src/components/student/cancel-booking-button.test.tsx src/components/class/add-walk-in.test.tsx src/components/class/attendance-list.test.tsx src/components/booking/booking-flow.test.tsx`
Expected: PASS.

With the worktree app up:

Run: `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts tests/integration/waitlist-api.test.ts tests/integration/invitations-api.test.ts tests/integration/tier-selected-at.test.ts tests/integration/classes-api.test.ts`
Expected: PASS (the last four book or cancel through these routes as setup).

Run: `pnpm exec playwright test tests/e2e/student-journey.spec.ts`
Expected: PASS (it books and cancels through the UI).

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 8a: Correct the document that quotes these answers**

`docs/lock-order.md`, in the "The `Student` row is the erasure's gate" table, the `POST /api/registrations` row's last cell quotes the erased-student refusal verbatim. Replace

```md
refuses: 409, `This account has been deleted` to the student, `This student's account no longer exists` to the teacher; an absent one is answered 404 `Student not found` before the transaction opens
```

with

```md
refuses: 409 `STUDENT_ERASED`, worded for the student or the teacher; an absent one is answered 404 `Student not found` before the transaction opens
```

Then `rg -n "This account has been deleted|no longer exists" docs --glob '!docs/superpowers/**'` and confirm no remaining hit describes an answer this task changed (Task 9 owns the respond, teacher-links and privacy rows).

- [ ] **Step 9: Commit**

```bash
git add src/app/api/registrations/route.ts src/app/api/registrations/route.test.ts src/app/api/registrations/route-lock-order.test.ts "src/app/api/registrations/[id]/route.ts" "src/app/api/registrations/[id]/route.test.ts" tests/integration/registrations-api.test.ts src/components/student/cancel-booking-button.tsx src/components/student/cancel-booking-button.test.tsx src/components/class/add-walk-in.test.tsx src/components/class/attendance-list.test.tsx src/components/booking/booking-flow.test.tsx docs/lock-order.md
git commit -m "feat(registrations): answer a booking, mark or cancel that already holds as unchanged; code every refusal (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Prove the guards bite**

Each: apply, warm the route with one request (`curl -s -o /dev/null -X POST http://localhost:<port>/api/registrations`, the port `pnpm run worktree:up` printed; for `[id]` use `-X DELETE http://localhost:<port>/api/registrations/x`), run, record the exact failure, `git checkout -- <path>`, re-run green.

1. `src/app/api/registrations/route.ts`: move the `const existing = …` read and its `if (…) { return { outcome: 'unchanged', … }; }` to directly after `if (isFull && !isWalkIn) { throw new ClassFullError(); }`. Run `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts -t "holder of the last seat"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
2. Same file: move that block above the `if (actingTeacherId && cls.calendarEntry.teacherId !== actingTeacherId)` check. Run `-t "even when the student already holds a seat"` → `expected 200 to be 403`.
3. Same file: move that block above `if (cls.calendarEntry.cancelledAt !== null)`. Run `-t "retrying on a cancelled class"` → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'CLASS_CANCELLED' }`.
4. Same file, catch: change `if (twin && ACTIVE_REGISTRATION_STATUSES.includes(twin.status))` to `if (twin)`. Run `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts -t "no longer active"` → `expected 200 to be 409`.
5. Same file, catch: delete the whole `if (isUniqueConflictOn(err, ['classId', 'studentId'])) { … }` block. Run `-t "twin of a booking"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
6. Same file, catch: change `'STUDENT_ERASED'` to `'CLASS_CANCELLED'`. Run `pnpm exec vitest run --project unit-sweeps src/app/api/registrations/route-lock-order.test.ts` → the six erasure cases fail with `code: 'CLASS_CANCELLED'`.
7. `src/app/api/registrations/[id]/route.ts`, PUT: change `status: { notIn: ['cancelled', requested] }` to `status: { not: 'cancelled' }`. Run `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts -t "repeated attendance mark"` → `expected { status: 200, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
8. Same file, PUT: move `if (current.status === requested) { … }` above the `cancelledAt` check in the miss branch. Run `-t "class was cancelled before it compares"` → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'CLASS_CANCELLED' }`.
9. Same file, DELETE: move the two `alreadyCancelled` lines below the `completed` check. Run `-t "since finished as unchanged"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
10. Same file, `answerForCancelledRow`: change `(byStudent && status === 'late_cancel')` to `status === 'late_cancel'`. Run `-t "late cancel for free"` → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'ALREADY_LATE_CANCELLED' }`; and `pnpm exec vitest run --project unit "src/app/api/registrations/[id]/route.test.ts"` → "refuses when the student cancelled late in between" fails the same way.
11. Same file, DELETE: move the two `alreadyCancelled` lines to directly above `if (!isStudent && !isTeacher) return respondError('Access denied', 403);`. Run `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts -t "another teacher's cancel even when"` → `expected 200 to be 403`.
12. Same file, `answerMissedCancel`: replace the `respondError(… 'CONCURRENT_MODIFICATION')` fallback with `respondUnchanged<CancelledBooking>({ id, status: 'cancelled' })`. Run `pnpm exec vitest run --project unit "src/app/api/registrations/[id]/route.test.ts" -t "active again"` → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'CONCURRENT_MODIFICATION' }`.
13. `src/components/student/cancel-booking-button.tsx`: delete the `if (code === 'NOT_FOUND') { … }` block. Run `pnpm exec vitest run --project components src/components/student/cancel-booking-button.test.tsx` → "treats a booking that no longer exists as done" fails (`expected "spy" to be called at least once`).

---

### Task 6: Waitlist — join, claim, leave

**Files:**
- Create: `src/app/api/waitlist/route.test.ts` (unit tier; the erased-student join), `src/components/student/waitlist-entry-actions.test.tsx`
- Modify: `docs/lock-order.md` (the `addToWaitlist` row of the erasure-gate table, Step 7a)
- Modify: `src/services/waitlist.ts:11` (type import), `:41-55` (`WaitlistPromotionError`), `:57-70` (`WaitlistJoinError`), `:232`, `:246-271` (join guards and copy), `:406-411` and `:452-458` (`removeFromWaitlist` result), `:521-528` (`promoteNext`'s split), `:633-741` (`claimSpot`: order, result type, not-found, copy)
- Modify: `src/app/api/waitlist/route.ts:3-12`, `:63-65`; `src/app/api/waitlist/claim/route.ts` (whole file); `src/app/api/waitlist/[id]/route.ts` (whole file)
- Modify: `src/components/student/waitlist-entry-actions.tsx:6`, `:45-60`, `:82`
- Test: `src/services/waitlist.test.ts` (`:367-371` neighbour, `:507`, new tests after `:516`, `:776-778`, `:998-1011`, `:1018`, new tests after `:1038`), `tests/integration/waitlist-api.test.ts` (imports `:1-6`; module state `:11-19`; fixtures in `beforeAll` before `:175`; `afterAll` `:178` and after `:197`; `:156`, `:394`, `:641` comment; `:231-249`; new test before `:251`; `:268-278`; new tests after `:278`; new describe after `:754`), `tests/integration/registrations-api.test.ts` (`describe('DELETE /api/waitlist/[id] — profile-presence authorization')`, `:854-871`, new tests before `:872`), `src/components/booking/booking-flow.test.tsx` (one test in the `what the server answers` describe Task 5 added)

**Interfaces:**
- Consumes (Task 1): `respondUnchanged`, `respondTyped`, `respondError` (`@/lib/api-utils`); `CodeWithStatus` (`@/lib/api-error-codes`); `readError` (`@/lib/client-errors`); `expectRefusal`, `expectUnchanged`, `expectApplied` (`tests/api-assertions.ts`). Codes: `CLASS_CANCELLED`, `CLASS_NOT_BOOKABLE`, `CLASS_NOT_FULL`, `ALREADY_REGISTERED`, `STUDENT_ERASED`, `WAITLIST_FROZEN`, `CLAIM_NOT_OPEN`, `SPOT_TAKEN`, `NOT_ON_WAITLIST`, `WAITLIST_ENTRY_INACTIVE`, `NOT_FOUND` — all already registered.
- Produces (`src/services/waitlist.ts`):
  ```ts
  export class WaitlistPromotionError extends Error {
    readonly reason: 'class_cancelled' | 'class_not_open' | 'class_full' | 'window_frozen' | 'wrong_window' | 'entry_not_waiting';
  }
  export class WaitlistJoinError extends Error {
    readonly reason: 'class_cancelled' | 'class_not_open' | 'class_not_full' | 'already_registered' | 'student_erased';
  }
  export type ClaimResult =
    | { readonly outcome: 'claimed'; readonly entry: WaitlistEntry }
    | { readonly outcome: 'already_registered' }
    | { readonly outcome: 'class_not_found' };
  export async function claimSpot(db: PrismaClient, classId: string, studentId: string, now?: Date): Promise<ClaimResult>;
  export async function removeFromWaitlist(db: PrismaClient, classId: string, studentId: string): Promise<
    | { ok: true }
    | { ok: false; reason: 'NOT_FOUND' }
    | { ok: false; reason: 'NOT_WAITING'; status: WaitlistStatus }
  >;
  ```
- Wire contract: `POST /api/waitlist/claim` unchanged → `200 { data: { classId }, outcome: 'unchanged' }` (spec §5.2; the only reader of the claim body is `waitlist-api.test.ts`'s applied-path assertions — `waitlist-entry-actions.tsx` keys on `res.ok`); unknown class → `404 NOT_FOUND`. `DELETE /api/waitlist/[id]` unchanged → `200 { data: { message: 'Removed from waitlist' }, outcome: 'unchanged' }`, the applied body's type. `POST /api/waitlist` gains codes only; a repeat join by a `waiting` student stays the 201 no-op it is.

**Every other caller, and what happens to it:**

| Symbol | Caller | Effect |
|---|---|---|
| `claimSpot` | `src/app/api/waitlist/claim/route.ts` | rewritten below |
| | `src/services/waitlist.test.ts:960-1018` | rejections unchanged except `:1010`; `:1018` reads `result.entry` (Step 2) |
| | `src/services/waitlist-lock-order.test.ts:467` | maps resolve/reject to `{ ok }` and never reads the value — no change |
| | `src/services/waitlist-reconciliation.test.ts:502` | awaits and discards; `first` holds no registration, so it still claims — no change |
| `removeFromWaitlist` | `src/app/api/waitlist/[id]/route.ts` | rewritten below |
| | `src/services/waitlist.test.ts:381` | discards the result — no change |
| | `src/services/waitlist.test.ts:507` | gains `status: 'expired'` (Step 2) |
| | `src/services/waitlist.test.ts:1584` | `NOT_FOUND` shape unchanged — no change |
| | `src/services/waitlist-lock-order.test.ts:516` | discards the result — no change |
| `WaitlistJoinError['reason']` | `src/services/waitlist.test.ts:358-377`, `:1343`, `:2149`; `src/services/gdpr-lock-order.test.ts:2656` | read `class_not_full`, `class_not_open` (a draft class — still that reason), `already_registered`, `student_erased` — no change |
| `WaitlistPromotionError` | `handleSpotFreed` (`waitlist.ts:863`) | catches every reason, `class_cancelled` included — no change |
| | `promoteNext` (`waitlist.ts:521-547`) | throws `class_cancelled` for a cancelled class (Step 4); its messages are never sent |
| | `src/services/waitlist.test.ts:752-754` | `class_full` — no change |

- [ ] **Step 1: Write the failing tests**

**1a. `src/services/waitlist.test.ts`.**

After the test ending at `:371` (`'rejects joining a class that is not open'`), add:

```ts
  it('rejects joining a cancelled class with a reason of its own', async () => {
    const cancelledClassId = await makeClass('open', 2);
    const { calendarEntryId } = await prisma.class.findUniqueOrThrow({
      where: { id: cancelledClassId },
      select: { calendarEntryId: true },
    });
    await prisma.calendarEntry.update({
      where: { id: calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    await expect(addToWaitlist(prisma, cancelledClassId, studentIds[0]!)).rejects.toMatchObject({
      reason: 'class_cancelled',
    });

    await prisma.calendarEntry.deleteMany({ where: { id: calendarEntryId } });
  });
```

After the test ending at `:516` (`'refuses to overwrite an expired entry …'`), add:

```ts
  it('reports an entry already removed with its status, and writes nothing', async () => {
    const leftClassId = await makeClass('open', 2);
    const left = await prisma.waitlistEntry.create({
      data: { classId: leftClassId, studentId: studentIds[0]!, position: 1, status: 'removed' },
    });

    const result = await removeFromWaitlist(prisma, leftClassId, studentIds[0]!);

    expect(result).toEqual({ ok: false, reason: 'NOT_WAITING', status: 'removed' });
    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: left.id } });
    expect(after.updatedAt).toEqual(left.updatedAt);

    await prisma.waitlistEntry.deleteMany({ where: { classId: leftClassId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: leftClassId } } } });
  });
```

Inside `describe('claimSpot (DB)', …)`, after the success test that ends at `:1038`, add:

```ts
  /** Claims the freed spot for `waiterId`, and returns what the claim wrote. */
  const claimOnce = async (classId: string) => {
    await freeTheSpot(classId);
    const result = await claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW);
    if (result.outcome !== 'claimed') throw new Error(`fixture: expected a claim, got ${result.outcome}`);
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: waiterId } },
    });
    return { entry: result.entry, registration };
  };

  it('answers the claimant’s own second claim as already registered, and writes nothing', async () => {
    const classId = await makeFullClass();
    const first = await claimOnce(classId);

    // The class is full again: the refusal a retry must not meet.
    const again = await claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW);

    expect(again).toEqual({ outcome: 'already_registered' });
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first.entry.id } });
    expect(entry.updatedAt).toEqual(first.entry.updatedAt);
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { id: first.registration.id },
    });
    expect(registration.updatedAt).toEqual(first.registration.updatedAt);
    expect(
      await prisma.notification.count({
        where: { relatedClassId: classId, recipientId: waiterId, type: 'booking_confirmed' },
      }),
    ).toBe(1);
  });

  it('answers a claim retried after the deadline as already registered', async () => {
    const classId = await makeFullClass();
    await claimOnce(classId);

    expect(await claimSpot(prisma, classId, waiterId, AT_DEADLINE)).toEqual({
      outcome: 'already_registered',
    });
  });

  it('answers a claim retried after the class started as already registered', async () => {
    const classId = await makeFullClass();
    await claimOnce(classId);
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    expect(await claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW)).toEqual({
      outcome: 'already_registered',
    });
  });

  it('refuses a claim retried after the class was cancelled', async () => {
    const classId = await makeFullClass();
    await claimOnce(classId);
    await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { cancelledAt: new Date() },
    });

    await expectRejection(
      claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW),
      'class_cancelled',
    );
  });

  it('refuses a claim on a class that has started', async () => {
    const classId = await makeFullClass();
    await freeTheSpot(classId);
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    await expectRejection(
      claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW),
      'class_not_open',
    );
  });

  it('reports a class that does not exist as not found', async () => {
    expect(await claimSpot(prisma, crypto.randomUUID(), waiterId, IN_CLAIM_WINDOW)).toEqual({
      outcome: 'class_not_found',
    });
  });
```

**1b. `tests/integration/waitlist-api.test.ts`.**

Replace `:1` with:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
```

and after `:6` add `import { expectRefusal, expectUnchanged } from '../api-assertions';`.

After `:19` (`let freedSpotClassId: string;`) add:

```ts
let rivalId: string;
let rivalToken: string;
let frozenClassId: string;
let cancelledClassId: string;
let draftClassId: string;
```

In the top-level `beforeAll`, before its closing `});` at `:175`, add:

```ts

  // A second student with a live session, for claims that must come from
  // someone other than the claimant above. No entry: a test that needs one
  // writes it.
  const rival = await prisma.student.create({
    data: {
      firstName: 'Waitlist',
      lastName: 'Rival',
      email: `waitlistapi-rival-${suffix}@test.local`,
      claimedAt: new Date(),
      account: { create: { email: `waitlistapi-rival-${suffix}@test.local` } },
      incomeTier: 3,
    },
  });
  rivalId = rival.id;
  rivalToken = await seedSession(prisma, rival.accountId!);

  // Past its cancellation deadline from the start: five hours out against a
  // six-hour deadline. `HOURS_1` keeps the auto-cancel sweep off it for four
  // hours, and it starts long after the suite ends. One minute long, for the
  // reason the freed-spot fixture above gives.
  const frozenStart = new Date(baseNow.getTime() + 5 * 60 * 60 * 1000);
  const frozenClass = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Waitlist API Frozen',
    date: new Date(
      Date.UTC(frozenStart.getUTCFullYear(), frozenStart.getUTCMonth(), frozenStart.getUTCDate()),
    ),
    startTime: hhmmToTime(
      `${String(frozenStart.getUTCHours()).padStart(2, '0')}:${String(
        frozenStart.getUTCMinutes(),
      ).padStart(2, '0')}`,
    ),
    durationMinutes: 1,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 1,
    cancelDeadline: 'HOURS_6',
    autoCancelCheck: 'HOURS_1',
    status: 'open',
  });
  frozenClassId = frozenClass.id;

  // Cancelled, with the claimant holding a seat in it.
  const cancelledClass = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Waitlist API Cancelled',
    date: new Date('2099-06-04'),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 2,
    status: 'open',
  });
  cancelledClassId = cancelledClass.id;
  await prisma.registration.create({
    data: { classId: cancelledClassId, studentId, status: 'registered', tierAtBooking: 3 },
  });
  await prisma.calendarEntry.update({
    where: { id: cancelledClass.calendarEntry.id },
    data: { cancelledAt: new Date() },
  });

  // Not yet published.
  const draftClass = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Waitlist API Draft',
    date: new Date('2099-06-05'),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents: 2,
    status: 'draft',
  });
  draftClassId = draftClass.id;
```

The frozen fixture is clock-derived, so the three identical comment lines at `:156`, `:394` and `:641` stop being true as written. Replace, in all three (one `Edit` with `replace_all`), `The three clock-derived fixtures in this file sit` with `The claim-window fixtures in this file sit`.

`afterAll`: replace `:178` with

```ts
  const classIds = [farFutureClassId, freedSpotClassId, frozenClassId, cancelledClassId, draftClassId];
```

and after `:197` (the student's account delete) add:

```ts

  const rivalAccount = await prisma.student.findUniqueOrThrow({
    where: { id: rivalId },
    select: { accountId: true, email: true },
  });
  await prisma.notification.deleteMany({ where: { recipientId: rivalId } });
  await prisma.session.deleteMany({ where: { accountId: rivalAccount.accountId! } });
  await prisma.student.delete({ where: { id: rivalId } });
  await prisma.account.deleteMany({ where: { email: rivalAccount.email } });
```

Before the 201 test (insert before `:251`), add — it has to run while the freed spot is still free:

```ts
  it('refuses a claim from a student who is not on the waitlist', async () => {
    // Before the claim below takes the spot: this case needs it free.
    const res = await claim(rivalToken, { classId: freedSpotClassId });

    await expectRefusal(res, 'NOT_ON_WAITLIST');
    expect(
      await prisma.registration.count({ where: { classId: freedSpotClassId, studentId: rivalId } }),
    ).toBe(0);
  });
```

Replace `:268-278` (the second-claim test) with:

```ts
  it('answers the claimant’s own second claim as unchanged, and writes nothing', async () => {
    // freedSpotClassId holds this student's registration from the 201 test
    // above and is still inside the claim window: the seat this retry asks
    // for is already theirs.
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId: freedSpotClassId, studentId } },
    });
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId: freedSpotClassId, studentId } },
    });

    const res = await claim(studentToken, { classId: freedSpotClassId });

    expect(await expectUnchanged(res)).toEqual({ classId: freedSpotClassId });
    const registrationAfter = await prisma.registration.findUniqueOrThrow({
      where: { id: registration.id },
    });
    expect(registrationAfter.updatedAt).toEqual(registration.updatedAt);
    const entryAfter = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfter.updatedAt).toEqual(entry.updatedAt);
    // The first claim's "Spot claimed", and no second one. Typed, because the
    // app's reconciliation sweep may have broadcast `spot_available` to this
    // student while the spot stood free.
    expect(
      await prisma.notification.count({
        where: { relatedClassId: freedSpotClassId, recipientId: studentId, type: 'booking_confirmed' },
      }),
    ).toBe(1);
  });

  it('tells another waiting student the spot is taken', async () => {
    // The claimant's entry is `promoted` now, so position 1 is free.
    await prisma.waitlistEntry.create({
      data: { classId: freedSpotClassId, studentId: rivalId, position: 1, status: 'waiting' },
    });

    const res = await claim(rivalToken, { classId: freedSpotClassId });

    await expectRefusal(res, 'SPOT_TAKEN');
    const rivalEntry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId: freedSpotClassId, studentId: rivalId } },
    });
    expect(rivalEntry.status).toBe('waiting');
    expect(
      await prisma.registration.count({ where: { classId: freedSpotClassId, studentId: rivalId } }),
    ).toBe(0);
  });

  it('refuses a claim once the cancellation deadline has passed', async () => {
    await expectRefusal(await claim(studentToken, { classId: frozenClassId }), 'WAITLIST_FROZEN');
  });

  /**
   * The claimant holds a seat in this class, so the booking check would find
   * it. The cancellation is checked first.
   */
  it('tells a claimant holding a seat in a cancelled class that it was cancelled', async () => {
    await expectRefusal(
      await claim(studentToken, { classId: cancelledClassId }),
      'CLASS_CANCELLED',
    );
  });

  it('refuses a claim on a class that is not taking bookings', async () => {
    await expectRefusal(await claim(studentToken, { classId: draftClassId }), 'CLASS_NOT_BOOKABLE');
    expect(
      await prisma.registration.count({ where: { classId: draftClassId, studentId } }),
    ).toBe(0);
  });

  it('answers a claim on a class that does not exist with its code', async () => {
    await expectRefusal(await claim(studentToken, { classId: randomUUID() }), 'NOT_FOUND');
  });
```

At the end of the file (after `:754`), add:

```ts
describe('POST /api/waitlist — each refusal carries its code', () => {
  let joinerId: string;
  let joinerToken: string;
  let fillerId: string;
  let cancelledJoinClassId: string;
  let draftJoinClassId: string;
  let notFullJoinClassId: string;
  let heldJoinClassId: string;

  const join = (token: string, body: unknown) =>
    fetch(`${BASE_URL}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  /** A far-future class on its own date, so no two share a slot. */
  async function joinClass(date: string, maxStudents: number, status: 'open' | 'draft') {
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Waitlist API Join Refusal',
      date: new Date(date),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents,
      status,
    });
  }

  beforeAll(async () => {
    const joiner = await prisma.student.create({
      data: {
        firstName: 'Join',
        lastName: 'Refused',
        email: `waitlistapi-join-refused-${suffix}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `waitlistapi-join-refused-${suffix}@test.local` } },
        incomeTier: 3,
      },
    });
    joinerId = joiner.id;
    joinerToken = await seedSession(prisma, joiner.accountId!);

    const filler = await prisma.student.create({
      data: {
        firstName: 'Join',
        lastName: 'Filler',
        email: `waitlistapi-join-filler-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    fillerId = filler.id;

    // Full, then cancelled.
    const cancelled = await joinClass('2099-06-10', 1, 'open');
    cancelledJoinClassId = cancelled.id;
    await prisma.registration.create({
      data: { classId: cancelledJoinClassId, studentId: fillerId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.calendarEntry.update({
      where: { id: cancelled.calendarEntry.id },
      data: { cancelledAt: new Date() },
    });

    draftJoinClassId = (await joinClass('2099-06-11', 1, 'draft')).id;
    notFullJoinClassId = (await joinClass('2099-06-12', 5, 'open')).id;

    // Full, and the seat is the joiner's own.
    heldJoinClassId = (await joinClass('2099-06-13', 1, 'open')).id;
    await prisma.registration.create({
      data: { classId: heldJoinClassId, studentId: joinerId, status: 'registered', tierAtBooking: 3 },
    });
  });

  afterAll(async () => {
    const classIds = [cancelledJoinClassId, draftJoinClassId, notFullJoinClassId, heldJoinClassId];
    const studentIds = [joinerId, fillerId];
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });

    const joinerAccount = await prisma.student.findUniqueOrThrow({
      where: { id: joinerId },
      select: { accountId: true, email: true },
    });
    await prisma.session.deleteMany({ where: { accountId: joinerAccount.accountId! } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.account.deleteMany({ where: { email: joinerAccount.email } });
  });

  async function joinedEntries(classId: string): Promise<number> {
    return prisma.waitlistEntry.count({ where: { classId, studentId: joinerId } });
  }

  it('refuses a cancelled class', async () => {
    await expectRefusal(await join(joinerToken, { classId: cancelledJoinClassId }), 'CLASS_CANCELLED');
    expect(await joinedEntries(cancelledJoinClassId)).toBe(0);
  });

  it('refuses a class that is not taking sign-ups', async () => {
    await expectRefusal(await join(joinerToken, { classId: draftJoinClassId }), 'CLASS_NOT_BOOKABLE');
    expect(await joinedEntries(draftJoinClassId)).toBe(0);
  });

  it('refuses a class with a free seat', async () => {
    await expectRefusal(await join(joinerToken, { classId: notFullJoinClassId }), 'CLASS_NOT_FULL');
    expect(await joinedEntries(notFullJoinClassId)).toBe(0);
  });

  it('refuses a student who already holds a seat', async () => {
    await expectRefusal(await join(joinerToken, { classId: heldJoinClassId }), 'ALREADY_REGISTERED');
    expect(await joinedEntries(heldJoinClassId)).toBe(0);
  });
});
```

**1c. `tests/integration/registrations-api.test.ts` — `DELETE /api/waitlist/[id]`.** Inside `describe('DELETE /api/waitlist/[id] — profile-presence authorization', …)`, before its closing `});` at `:872`, add:

```ts
  it('answers leaving a queue already left as unchanged, and renumbers nothing twice', async () => {
    const classId = await makeClass(1);
    const mine = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[0]!, position: 1, status: 'waiting' },
    });
    const theirs = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[1]!, position: 2, status: 'waiting' },
    });

    await expectApplied(await del(studentTokens[0]!, mine.id));
    const renumbered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(renumbered.position).toBe(1);

    const again = await del(studentTokens[0]!, mine.id);

    expect(await expectUnchanged(again)).toEqual({ message: 'Removed from waitlist' });
    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(after.position).toBe(1);
    expect(after.updatedAt).toEqual(renumbered.updatedAt);
    const left = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: mine.id } });
    expect(left.status).toBe('removed');
  });

  it('answers an entry some other path already removed as unchanged', async () => {
    const classId = await makeClass(1);
    const entry = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[0]!, position: 1, status: 'removed' },
    });

    await expectUnchanged(await del(studentTokens[0]!, entry.id));

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.updatedAt).toEqual(entry.updatedAt);
  });

  it('refuses a student leaving someone else’s entry even when it has already been left', async () => {
    const classId = await makeClass(1);
    const entry = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[0]!, position: 1, status: 'removed' },
    });

    const res = await del(studentTokens[1]!, entry.id);

    expect(res.status).toBe(403);
    const body = (await res.json()) as { outcome?: unknown };
    expect(body.outcome).toBeUndefined();
  });

  it('answers an entry that does not exist with its code', async () => {
    await expectRefusal(await del(studentTokens[0]!, randomUUID()), 'NOT_FOUND');
  });
```

(`randomUUID`, `expectApplied`, `expectRefusal`, `expectUnchanged` are imported by Task 5, Step 1a.)

**1d. `src/app/api/waitlist/route.test.ts` (new).** The erased-student join, which no HTTP test reaches: `validateSession` never returns a session for an erased profile.

```ts
import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { createClassFixture } from '../../../../tests/class-fixtures';
import { expectRefusal } from '../../../../tests/api-assertions';
import { POST } from './route';

/**
 * A student erased between the session check and the join's `Student` lock.
 * A live session never belongs to an erased profile, so the erasure is stood
 * in for at the lock; the service and the route that map it are real.
 */
const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('POST /api/waitlist — a student erased under the join', () => {
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let studentId: string;
  let token: string;
  const accountIds: string[] = [];

  beforeAll(async () => {
    const teacherEmail = `wl-erased-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Wl', lastName: 'Erased',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'waitlist-route erased-join fixture teacher',
        pageSlug: `wl-erased-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Wl Erased Studio', address: `${suffix} Erased St`, city: 'Amsterdam',
        postcode: '1234WE', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Wl Erased Vinyasa',
      date: new Date('2099-08-10'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 1,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `wl-erased-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Wl', lastName: 'Erased',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);
    token = await seedSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('is refused with its code, and writes nothing', async () => {
    const gate = vi
      .spyOn(dbLocks, 'lockLiveStudent')
      .mockRejectedValueOnce(new dbLocks.StudentErasedError(studentId));
    onTestFinished(() => gate.mockRestore());

    const res = await POST(new NextRequest('http://localhost:3000/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    }));

    expect(gate).toHaveBeenCalledTimes(1);
    await expectRefusal(res, 'STUDENT_ERASED');
    expect(await prisma.waitlistEntry.count({ where: { studentId } })).toBe(0);
    expect(await prisma.teacherStudent.count({ where: { studentId } })).toBe(0);
  });
});
```

**1e. `src/components/student/waitlist-entry-actions.test.tsx` (new).**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WaitlistEntryActions } from './waitlist-entry-actions';
import { routerRefresh } from '../../../tests/setup/components';

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, url: '/api/waitlist', json: async () => body };
}

describe('WaitlistEntryActions', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function renderActions(canClaim: boolean): void {
    render(<WaitlistEntryActions entryId="entry-1" classId="class-1" canClaim={canClaim} />);
  }

  it('offers the claim only while a spot can be claimed', () => {
    renderActions(false);
    expect(screen.queryByRole('button', { name: 'Claim the spot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave waitlist' })).toBeInTheDocument();
  });

  describe('claim', () => {
    it('claims the spot and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(201, { data: { id: 'entry-1', status: 'promoted' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/waitlist/claim',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ classId: 'class-1' }) }),
      );
    });

    it('treats a spot the student already holds as claimed', async () => {
      fetchMock.mockResolvedValue(reply(200, { data: { classId: 'class-1' }, outcome: 'unchanged' }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a lost spot in the server’s words', async () => {
      fetchMock.mockResolvedValue(
        reply(409, { error: { message: 'Someone else just took the spot.', code: 'SPOT_TAKEN' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Someone else just took the spot.');
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    it('leaves and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(200, { data: { message: 'Removed from waitlist' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith('/api/waitlist/entry-1', { method: 'DELETE' });
    });

    it('treats a queue already left as done', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { data: { message: 'Removed from waitlist' }, outcome: 'unchanged' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('treats a waitlist spot that no longer exists as done', async () => {
      fetchMock.mockResolvedValue(
        reply(404, { error: { message: 'This waitlist spot no longer exists.', code: 'NOT_FOUND' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a spot that is no longer active, and stays put', async () => {
      fetchMock.mockResolvedValue(
        reply(409, {
          error: {
            message: 'That waitlist spot is no longer active — refresh to see the latest.',
            code: 'WAITLIST_ENTRY_INACTIVE',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('no longer active');
      expect(routerRefresh).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Leave waitlist' })).not.toBeDisabled();
    });
  });
});
```

**1f. `src/components/booking/booking-flow.test.tsx` — the join-waitlist button.** `booking-flow.tsx` needs no change (success is `res.ok`; a refusal renders into `role="alert"`). Inside `describe('what the server answers', …)` (Task 5), after its last test, add:

```tsx
    it('shows a waitlist refusal in the server’s words', async () => {
      stubReply(409, {
        error: {
          message: 'The class still has open spots — book directly instead.',
          code: 'CLASS_NOT_FULL',
        },
      });
      renderFlow({ currentTier: 3, isFull: true });

      fireEvent.click(screen.getByRole('button', { name: /join the waitlist/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The class still has open spots — book directly instead.',
      );
      expect(screen.queryByText("You're on the waitlist")).not.toBeInTheDocument();
    });
```

This test passes before and after this task; it pins that the component keeps rendering the server's words for the join.

- [ ] **Step 2: Rewrite the existing tests the change breaks**

`src/services/waitlist.test.ts`:

- `:507` → `expect(result).toEqual({ ok: false, reason: 'NOT_WAITING', status: 'expired' });`
- `:776-778` → 
  ```ts
   * whole matrix can be pinned deterministically here instead — and the guards
   * fire in a fixed order (cancellation → the claimant's own registration →
   * status → window → capacity → entry), so each case below has to satisfy
   * every guard ahead of the one it targets.
  ```
- `:998-1011` →
  ```ts
    it('refuses a claim on a cancelled class', async () => {
      const classId = await makeFullClass();
      await freeTheSpot(classId);
      // Cancelled after the waitlist formed — the cancellation guard runs
      // first, so this fires even though the window and capacity are both fine.
      await prisma.calendarEntry.update({
        where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: classId }, select: { calendarEntryId: true } })).calendarEntryId },
        data: { cancelledAt: new Date() },
      });

      await expectRejection(
        claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW),
        'class_cancelled',
      );
  ```
- `:1018` →
  ```ts
      const result = await claimSpot(prisma, classId, waiterId, IN_CLAIM_WINDOW);
      if (result.outcome !== 'claimed') throw new Error(`expected a claim, got ${result.outcome}`);
      const { entry } = result;
  ```

`tests/integration/waitlist-api.test.ts:231-239` →

```ts
  it('refuses a claim outside the first-come-first-claimed window', async () => {
    const res = await claim(studentToken, { classId: farFutureClassId });

    // The code names the branch; the status alone would pass for any of them.
    await expectRefusal(res, 'CLAIM_NOT_OPEN');
```

(`:241-249` stay.)

`tests/integration/registrations-api.test.ts:854-866` →

```ts
  it('refuses leaving a queue that closed under the student, without denying the entry exists', async () => {
    const classId = await makeClass(1);
    const entry = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[0]!, position: 1, status: 'expired' },
    });

    const res = await del(studentTokens[0]!, entry.id);

    // Inactive, not not-found: the row is there and the student can see it.
    await expectRefusal(res, 'WAITLIST_ENTRY_INACTIVE');
```

(`:867-871` stay.)

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm exec vitest run --project unit src/services/waitlist.test.ts src/app/api/waitlist/route.test.ts`
Expected: FAIL — `reason` is `class_not_open` where `class_cancelled` is expected; `removeFromWaitlist` returns no `status`; the claim tests throw `expected a claim, got undefined` (the service still returns the entry); the retry tests reject with `class_full` / `window_frozen` / `class_not_open`; the unknown class rejects with a P2025 (`No record was found`); the erased join gets `{ status: 409, code: undefined }`.

With the worktree app up:

Run: `pnpm exec vitest run --project integration tests/integration/waitlist-api.test.ts tests/integration/registrations-api.test.ts`
Expected: FAIL — claim and join refusals arrive with `code: undefined`; the retry claim gets `{ status: 409, outcome: undefined }`; the unknown class gets `{ status: 500, code: undefined }`; the DELETE-waitlist unchanged tests get 409; the not-found DELETE gets `{ status: 404, code: undefined }`.

Run: `pnpm exec vitest run --project components src/components/student/waitlist-entry-actions.test.tsx src/components/booking/booking-flow.test.tsx`
Expected: FAIL in `waitlist-entry-actions.test.tsx` — the two SPOT_TAKEN/inactive tests find no `role="alert"`; "no longer exists as done" does not refresh.

- [ ] **Step 4: Implement the service**

`src/services/waitlist.ts:11` → `import type { PrismaClient, CancelDeadline, WaitlistEntry, WaitlistStatus } from '@prisma/client';`

Replace `:41-70` (both error classes) with:

```ts
/**
 * Raised when a promotion/claim is not allowed in the current class state.
 * A claim's message is user-facing copy: the claim route sends it as it is.
 */
export class WaitlistPromotionError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'class_cancelled'
      | 'class_not_open'
      | 'class_full'
      | 'window_frozen'
      | 'wrong_window'
      | 'entry_not_waiting',
  ) {
    super(message);
    this.name = 'WaitlistPromotionError';
  }
}

/**
 * Raised when joining the waitlist is not allowed. The message is user-facing
 * copy: the join route sends it as it is.
 */
export class WaitlistJoinError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'class_cancelled'
      | 'class_not_open'
      | 'class_not_full'
      | 'already_registered'
      | 'student_erased',
  ) {
    super(message);
    this.name = 'WaitlistJoinError';
  }
}

/** What a claim did. A refused claim throws `WaitlistPromotionError` instead. */
export type ClaimResult =
  | { readonly outcome: 'claimed'; readonly entry: WaitlistEntry }
  | { readonly outcome: 'already_registered' }
  | { readonly outcome: 'class_not_found' };
```

`addToWaitlist`: `:232` → `        throw new WaitlistJoinError('This account has been deleted.', 'student_erased');`. Replace `:246-271` with:

```ts
    // Two checks, because a cancelled class keeps whatever status it had
    // (#327); each has a reason of its own.
    if (cls.calendarEntry.cancelledAt !== null) {
      throw new WaitlistJoinError('This class has been cancelled.', 'class_cancelled');
    }
    if (cls.status !== 'open') {
      throw new WaitlistJoinError("This class isn't taking waitlist sign-ups.", 'class_not_open');
    }

    const { isFull } = await readSeatCount(tx, classId);
    if (!isFull) {
      throw new WaitlistJoinError(
        'The class still has open spots — book directly instead.',
        'class_not_full',
      );
    }

    if (await hasActiveRegistration(tx, classId, studentId)) {
      throw new WaitlistJoinError(
        'You are already registered for this class.',
        'already_registered',
      );
    }
```

`removeFromWaitlist`: replace `:410` with

```ts
): Promise<
  | { ok: true }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'NOT_WAITING'; status: WaitlistStatus }
> {
```

and replace `:447-458` with:

```ts
      // Which it was, decided INSIDE the lock so the answer cannot race the
      // thing it is describing. One indexed lookup on a unique key, and only
      // on a path where the write has already failed. The status is what lets
      // the caller tell a student who already left from one whose entry some
      // other path closed.
      const existing = await tx.waitlistEntry.findUnique({
        where: { classId_studentId: { classId, studentId } },
        select: { status: true },
      });
      return existing
        ? ({ ok: false, reason: 'NOT_WAITING', status: existing.status } as const)
        : ({ ok: false, reason: 'NOT_FOUND' } as const);
```

`promoteNext`: replace `:521-528` with:

```ts
    if (cls.calendarEntry.cancelledAt !== null) {
      throw new WaitlistPromotionError('Cannot promote into a cancelled class', 'class_cancelled');
    }
    if (cls.status !== 'open') {
      throw new WaitlistPromotionError(
        `Cannot promote into a class with status "${cls.status}"`,
        'class_not_open',
      );
    }
```

`claimSpot`: replace `:633-695` (its docblock through the `entry_not_waiting` throw) with:

```ts
/**
 * Claims an open spot from the waitlist during the first-come-first-claimed
 * window (final hour before the cancel deadline). The first student whose
 * claim lands gets the spot; everyone else keeps waiting.
 */
export async function claimSpot(
  db: PrismaClient,
  classId: string,
  studentId: string,
  now?: Date,
): Promise<ClaimResult> {
  return db.$transaction(async (tx): Promise<ClaimResult> => {
    await lockClassRow(tx, classId);

    // `findUnique`: the id comes from the request, and archiving a recurring
    // class deletes its future classes, so a claim can arrive for one that is
    // gone.
    const cls = await tx.class.findUnique({
      where: { id: classId },
      include: {
        calendarEntry: {
          include: { teacher: { select: { defaultTimezone: true } } },
        },
      },
    });
    if (!cls) return { outcome: 'class_not_found' };

    if (cls.calendarEntry.cancelledAt !== null) {
      throw new WaitlistPromotionError('This class has been cancelled.', 'class_cancelled');
    }

    // The seat this claim asks for is already the student's. After the
    // cancellation, which makes the claim moot, and before every refusal
    // below, so a retry is never refused for the state its first attempt made.
    if (await hasActiveRegistration(tx, classId, studentId)) {
      return { outcome: 'already_registered' };
    }

    if (cls.status !== 'open') {
      throw new WaitlistPromotionError("This class isn't taking bookings.", 'class_not_open');
    }

    const window = getWaitlistWindow(
      cls.calendarEntry.date,
      cls.calendarEntry.startTime,
      cls.cancelDeadline,
      cls.calendarEntry.teacher.defaultTimezone,
      now,
    );
    if (window === 'frozen') {
      throw new WaitlistPromotionError(
        'The cancellation deadline has passed, so spots can no longer be claimed.',
        'window_frozen',
      );
    }
    if (window !== 'first_come_first_claimed') {
      throw new WaitlistPromotionError(
        'Spots can only be claimed in the final hour before the deadline — before that the queue promotes automatically.',
        'wrong_window',
      );
    }

    // The claimant holds no seat (checked above), so a full class means
    // someone else took it.
    const { isFull } = await readSeatCount(tx, classId);
    if (isFull) {
      throw new WaitlistPromotionError('Someone else just took the spot.', 'class_full');
    }

    const entry = await tx.waitlistEntry.findFirst({
      where: { classId, studentId, status: 'waiting' },
    });
    if (!entry) {
      throw new WaitlistPromotionError('You are not on the waitlist for this class.', 'entry_not_waiting');
    }
```

and replace `:739` (`    return updatedEntry;` inside `claimSpot`) with `    return { outcome: 'claimed', entry: updatedEntry };`. The code between (`:697-737`) is unchanged.

Run `pnpm run typecheck`. Expected: clean. The routes still compile against the new shapes — `respondOk` accepts any payload, so the claim route would now send a `ClaimResult` as its body — which is why Step 5 follows before any test run.

- [ ] **Step 5: Implement the routes**

`src/app/api/waitlist/route.ts` — replace `:3-12` with:

```ts
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodeWithStatus } from '@/lib/api-error-codes';
import { addToWaitlist, WaitlistJoinError } from '@/services/waitlist';
import { createWaitlistSchema } from '@/lib/schemas';

/** The code each join refusal is sent with. The message is the service's own. */
const JOIN_REFUSAL_CODE = {
  class_cancelled: 'CLASS_CANCELLED',
  class_not_open: 'CLASS_NOT_BOOKABLE',
  class_not_full: 'CLASS_NOT_FULL',
  already_registered: 'ALREADY_REGISTERED',
  student_erased: 'STUDENT_ERASED',
} as const satisfies Record<WaitlistJoinError['reason'], CodeWithStatus<409>>;
```

(keep the `isTransientDbError` and `log` imports at `:13-14` after this block), and replace `:63-65` with:

```ts
    if (err instanceof WaitlistJoinError) {
      return respondError(err.message, 409, JOIN_REFUSAL_CODE[err.reason]);
    }
```

`src/app/api/waitlist/claim/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { CodeWithStatus } from '@/lib/api-error-codes';
import { claimWaitlistSchema } from '@/lib/schemas';
import { claimSpot, WaitlistPromotionError } from '@/services/waitlist';

/** The code each claim refusal is sent with. The message is the service's own. */
const CLAIM_REFUSAL_CODE = {
  class_cancelled: 'CLASS_CANCELLED',
  class_not_open: 'CLASS_NOT_BOOKABLE',
  window_frozen: 'WAITLIST_FROZEN',
  wrong_window: 'CLAIM_NOT_OPEN',
  class_full: 'SPOT_TAKEN',
  entry_not_waiting: 'NOT_ON_WAITLIST',
} as const satisfies Record<WaitlistPromotionError['reason'], CodeWithStatus<409>>;

/**
 * An unchanged claim's body. The class, not an entry: the seat the claimant
 * already holds may have no waitlist entry behind it.
 */
type UnchangedClaim = { classId: string };

/**
 * First-come-first-claimed: in the final hour before the cancel deadline a
 * freed spot is broadcast to everyone waiting; the first claim lands it.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (!session.studentId) {
    return respondError('Only students can claim waitlist spots', 403);
  }

  const parsed = await parseBody(request, claimWaitlistSchema);
  if ('error' in parsed) return parsed.error;

  try {
    const result = await claimSpot(prisma, parsed.data.classId, session.studentId);
    switch (result.outcome) {
      case 'claimed':
        return respondOk(result.entry, 201);
      case 'already_registered':
        return respondUnchanged<UnchangedClaim>({ classId: parsed.data.classId });
      case 'class_not_found':
        return respondError('This class no longer exists.', 404, 'NOT_FOUND');
      default: {
        const unreachable: never = result;
        throw new Error(`unhandled claim outcome: ${JSON.stringify(unreachable)}`);
      }
    }
  } catch (err) {
    if (err instanceof WaitlistPromotionError) {
      return respondError(err.message, 409, CLAIM_REFUSAL_CODE[err.reason]);
    }
    throw err;
  }
});
```

`src/app/api/waitlist/[id]/route.ts` (whole file):

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { removeFromWaitlist } from '@/services/waitlist';

/** The body of a leave, applied or unchanged. */
type LeaveBody = { message: string };

const ENTRY_GONE = 'This waitlist spot no longer exists.';

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const entry = await prisma.waitlistEntry.findUnique({ where: { id } });
  if (!entry) return respondError(ENTRY_GONE, 404, 'NOT_FOUND');

  // Only the student themselves or the class teacher can remove
  const isOwnEntry = entry.studentId === session.studentId;
  if (!isOwnEntry) {
    if (!session.teacherId) return respondError('Access denied', 403);
    const cls = await prisma.class.findUnique({
      where: { id: entry.classId },
      include: { calendarEntry: { select: { teacherId: true } } },
    });
    if (!cls || cls.calendarEntry.teacherId !== session.teacherId) {
      return respondError('Access denied', 403);
    }
  }

  // Three answers when the removal writes nothing. The entry read above can be
  // GONE by now — a concurrent `deleteStudentAccount` deletes every
  // `WaitlistEntry` the student holds — and not-found is honest for that. It
  // can be `removed`, which is what leaving writes: the goal holds. Or it can
  // be closed some other way — a stale render when a class starts and
  // `closeQueueOnStart` (#216) flips the row to `expired` — and denying a row
  // the student is looking at would be false, so that is a refusal and a
  // refresh.
  const result = await removeFromWaitlist(prisma, entry.classId, entry.studentId);
  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') {
      return respondError(ENTRY_GONE, 404, 'NOT_FOUND');
    }
    if (result.status === 'removed') {
      return respondUnchanged<LeaveBody>({ message: 'Removed from waitlist' });
    }
    return respondError(
      'That waitlist spot is no longer active — refresh to see the latest.',
      409,
      'WAITLIST_ENTRY_INACTIVE',
    );
  }

  return respondTyped<LeaveBody>({ message: 'Removed from waitlist' });
});
```

- [ ] **Step 6: Clients**

- `src/components/booking/booking-flow.tsx` (the join-waitlist button) — no change: success is `res.ok`, refusals render through `readErrorMessage` into `role="alert"`.
- `src/components/student/waitlist-entry-actions.tsx` — the claim needs no change (`res.ok`, so an unchanged claim refreshes). The leave treats its own `NOT_FOUND` as done, and the error gains `role="alert"` (spec §7.7). Replace `:6` with `import { readError, readErrorMessage } from '@/lib/client-errors';`, replace `handleLeave` (`:45-60`) with:

```tsx
  async function handleLeave() {
    setBusy('leave');
    setError('');
    try {
      const res = await fetch(`/api/waitlist/${entryId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const { code, message } = await readError(res, 'Could not leave the waitlist. Try again.');
      // A waitlist spot that no longer exists is as left as this button can make it.
      if (code === 'NOT_FOUND') {
        router.refresh();
        return;
      }
      setError(message);
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(null);
    }
  }
```

and `:82` with:

```tsx
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
```

- [ ] **Step 7: Run green**

Run: `pnpm exec vitest run --project unit src/services/waitlist.test.ts src/app/api/waitlist/route.test.ts src/services/invitations.gate.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project unit-sweeps src/services/waitlist-lock-order.test.ts src/services/waitlist-reconciliation.test.ts src/services/gdpr-lock-order.test.ts`
Expected: PASS (they call `claimSpot`, `removeFromWaitlist` and `addToWaitlist` without reading the changed shapes).

Run: `pnpm exec vitest run --project components src/components/student/waitlist-entry-actions.test.tsx src/components/booking/booking-flow.test.tsx`
Expected: PASS.

With the worktree app up:

Run: `pnpm exec vitest run --project integration tests/integration/waitlist-api.test.ts tests/integration/registrations-api.test.ts tests/integration/invitations-api.test.ts tests/integration/tier-selected-at.test.ts tests/integration/waitlist-display.test.ts`
Expected: PASS.

Run: `pnpm exec playwright test tests/e2e/student-journey.spec.ts`
Expected: PASS (it leaves a waitlist through the UI).

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 7a: Correct the document that quotes the join answer**

`docs/lock-order.md`, in the "The `Student` row is the erasure's gate" table, the `addToWaitlist` row's last cell ends with a parenthesis naming the join's answer. Replace

```md
(409 from `POST /api/waitlist`)
```

with

```md
(409 `STUDENT_ERASED` from `POST /api/waitlist`)
```

- [ ] **Step 8: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts src/app/api/waitlist/route.ts src/app/api/waitlist/route.test.ts src/app/api/waitlist/claim/route.ts "src/app/api/waitlist/[id]/route.ts" tests/integration/waitlist-api.test.ts tests/integration/registrations-api.test.ts src/components/student/waitlist-entry-actions.tsx src/components/student/waitlist-entry-actions.test.tsx src/components/booking/booking-flow.test.tsx docs/lock-order.md
git commit -m "feat(waitlist): answer a repeated claim or leave as unchanged; code every join, claim and leave refusal (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Prove the guards bite**

Each: apply, warm the route (`curl -s -o /dev/null -X POST http://localhost:<port>/api/waitlist/claim`, the port `pnpm run worktree:up` printed; `-X POST …/api/waitlist` and `-X DELETE …/api/waitlist/x` for the other two), run, record the exact failure, `git checkout -- <path>`, re-run green.

1. `src/services/waitlist.ts`, `claimSpot`: move the `if (await hasActiveRegistration(…)) { return { outcome: 'already_registered' }; }` block to directly after the `class_full` throw. Run `pnpm exec vitest run --project integration tests/integration/waitlist-api.test.ts -t "own second claim"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`; and `pnpm exec vitest run --project unit src/services/waitlist.test.ts -t "own second claim"` → rejects with `class_full`.
2. Same function: move that block above the `cancelledAt` check. Run `-t "holding a seat in a cancelled class"` (integration) → `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'CLASS_CANCELLED' }`.
3. Same function: move that block below the `window !== 'first_come_first_claimed'` check (still above capacity). Run `pnpm exec vitest run --project unit src/services/waitlist.test.ts -t "retried after the deadline"` → rejects with `window_frozen`.
4. Same function: change `tx.class.findUnique(` to `tx.class.findUniqueOrThrow(` and delete `if (!cls) return { outcome: 'class_not_found' };`. Run `pnpm exec vitest run --project integration tests/integration/waitlist-api.test.ts -t "does not exist"` → `expected { status: 500, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
5. `addToWaitlist`: change `'class_cancelled'` in its cancelled throw to `'class_not_open'`. Run `-t "refuses a cancelled class"` → `code: 'CLASS_NOT_BOOKABLE'` where `CLASS_CANCELLED` is expected.
6. `src/app/api/waitlist/route.ts`: swap the values of `class_not_full` and `already_registered` in `JOIN_REFUSAL_CODE`. Run `-t "each refusal carries its code"` → the two tests fail with each other's code.
7. `src/app/api/waitlist/claim/route.ts`: change `class_full: 'SPOT_TAKEN'` to `class_full: 'CLASS_FULL'`. Run `-t "spot is taken"` → `code: 'CLASS_FULL'` where `SPOT_TAKEN` is expected.
8. `src/services/waitlist.ts`, `removeFromWaitlist`: change the re-read's `select: { status: true }` to `select: { id: true }` and `status: existing.status` to `status: 'expired' as const`. Run `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts -t "already left as unchanged"` → `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
9. `src/app/api/waitlist/[id]/route.ts`: move the `removeFromWaitlist` call and its `if (!result.ok) { … }` block above the `// Only the student themselves or the class teacher can remove` check. Run `-t "someone else’s entry even when it has already been left"` → `expected 200 to be 403`.
10. `src/components/student/waitlist-entry-actions.tsx`: delete the `if (code === 'NOT_FOUND') { … }` block. Run `pnpm exec vitest run --project components src/components/student/waitlist-entry-actions.test.tsx` → "treats a waitlist spot that no longer exists as done" fails (`expected "spy" to be called at least once`).
11. Same file: remove `role="alert"` from the error paragraph. Run the same file → the SPOT_TAKEN and inactive tests fail (`Unable to find role="alert"`).

---
### Task 7: Rooms and teacher-rooms

Line numbers are as of `2dcc5b8c`. Tasks 2–6 do not touch these files, with one exception: `vitest.tiers.ts` may have gained entries, so that edit is placed by content, not by line.

**Files:**
- Create: `src/services/teacher-room-attach.ts` (the value comparison), `src/services/teacher-room-attach.test.ts`, `src/app/api/rooms/[id]/route-race.test.ts`, `src/app/api/teacher-rooms/[id]/route-race.test.ts`, `src/components/settings/unlink-room-button.test.tsx`, `src/components/settings/room-settings-step.test.tsx`
- Modify: `src/app/api/rooms/[id]/route.ts:1-32` (imports; the not-found answer) and `:92-112` (P2025 catch)
- Modify: `src/app/api/rooms/[id]/publish/route.ts:1-11` (imports; `ROOM_GONE`), `:29-35` (docblock), `:54` (not-found copy), `:60-62` (site 1), `:90-103` (site 2, with its not-found copy), `:106` (not-found copy)
- Modify: `src/app/api/teacher-rooms/route.ts:1-14` (imports; `answerExistingLink`), `:52` (not-found copy and `NOT_FOUND`), `:58-97` (both already-listed sites)
- Modify: `src/app/api/teacher-rooms/[id]/route.ts:1-20` (imports; `LINK_GONE`), `:52-73` (PUT), `:115-121` (PATCH), `:139-195` (DELETE)
- Modify: `src/services/room-archive.ts:1-5` (import), `:272-273` (P2025 → `not_found`)
- Modify: `src/services/room-deletion.ts:1-2` (import), after `:82` (the unlink message), `:119-120` (codes tethered to the registry)
- Modify: `src/lib/api-error-codes.ts` (remove `ALREADY_SHARED` and `DUPLICATE`)
- Modify: `vitest.tiers.ts` (`LOCK_CONTENTION_TESTS`: two entries)
- Modify: `src/components/settings/delete-room-button.tsx:1-31`, `src/components/settings/unlink-room-button.tsx:6`, `:24-28`, `src/components/settings/share-room-button.tsx:1-9`, `:84-111`
- Test: `src/services/room-archive.test.ts` (after `:196`), `src/services/room-deletion.test.ts:18-24`, `:112-122`
- Test: `tests/integration/teacher-rooms-api.test.ts:20-24`, after `:92`, `:293-309`, `:351-358`, after `:358`, after `:406`, `:529-539`, after `:545`, `:626-634`, `:654-662`, `:667-752`
- Test: `tests/integration/rooms-api.test.ts:24-28`, `:623-641`
- Test: `tests/integration/rooms-publish-api.test.ts:12-21`, `:100-103`, `:117-132`
- Test: `src/components/settings/delete-room-button.test.tsx:1-3`, `:121-139`, `src/components/settings/share-room-button.test.tsx:184-204`, `src/components/settings/archive-room-button.test.tsx:65-80`
- No change, and why:
  - `src/components/settings/room-settings-step.tsx` checks only `res.ok`, so a 200 unchanged calls `onSaved()`. Every refusal renders `json.error.message`.
  - `src/components/settings/archive-room-button.tsx` checks only `res.ok`. PATCH's `NOT_FOUND` and `ROOM_IN_USE` render through `readErrorMessage`. Archiving is not a delete, so `NOT_FOUND` stays an error.
  - `src/components/settings/edit-teacher-room-form.tsx` and `src/components/settings/edit-room-form.tsx` call PUT, which has no unchanged answer. PUT's `NOT_FOUND` is an error there too, and both render the message.

**Interfaces:**
- Consumes (Task 1):
  - `respondUnchanged<T>(data)` from `@/lib/api-utils`
  - `readError(res, fallback)` from `@/lib/client-errors`
  - `type ApiErrorCode` from `@/lib/api-error-codes`
  - `expectRefusal(res, code)`, `expectUnchanged(res)` and `expectApplied(res, status?)` from `tests/api-assertions.ts`
- Consumes (existing): `isRecordNotFound(error)` from `@/lib/api-errors` (`:311`)
- Produces:
  ```ts
  // src/services/teacher-room-attach.ts
  export type ExistingLinkVerdict = 'archived' | 'unchanged' | 'differs';
  export type RequestedLinkValues = { capacityOverride: number; rentalRate: number; equipmentNotes?: string | null };
  export function compareExistingLink(
    existing: Pick<TeacherRoom, 'isArchived' | 'capacityOverride' | 'rentalRate' | 'equipmentNotes'>,
    requested: RequestedLinkValues,
  ): ExistingLinkVerdict;
  // src/services/room-deletion.ts
  export const TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE: string;
  ```
- `ArchiveRoomResult` does not change: the P2025 reuses its existing `not_found` arm. `rg -n "setTeacherRoomArchived" src` finds these callers besides tests: `src/app/api/teacher-rooms/[id]/route.ts:90`, which already maps `not_found`. It also finds `room-archive.test.ts`, `room-archive-lock-order.test.ts` and `class-room-race.test.ts`. None of them asserts a P2025 rejection, and the new catch matches only P2025, so the `55P03` rejection that `room-archive-lock-order.test.ts:152` pins still propagates.

**The value comparison** (spec §5.2; the rule decides both `POST /api/teacher-rooms` sites):

| Stored link | Request | Answer |
|---|---|---|
| `isArchived` | any values | 409 `ROOM_ARCHIVED` |
| live | `capacityOverride ===`, `rentalRate` equal after rounding (below), `equipmentNotes ?? null ===` | 200 unchanged, `data` = the stored row |
| live | anything else | 409 `ROOM_ALREADY_LISTED` |

`rentalRate` arrives as a JS `number` with no bound on decimal places (`createTeacherRoomSchema`, `src/lib/schemas.ts:358-363`). The column is `Decimal @db.Decimal(10, 2)`. The request value is therefore compared the way the column stores it:

```ts
existing.rentalRate.equals(
  new Prisma.Decimal(requested.rentalRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
)
```

`existing.rentalRate` is a `Prisma.Decimal`, and `equals` compares values, so a stored `18.00` equals a request of `18`. decimal.js's `ROUND_HALF_UP` sends ties away from zero, which is how Postgres rounds `numeric`. A retry of `12.344` therefore equals its stored `12.34`. Measured with `node -e` against this repo's `@prisma/client`: `Prisma.Decimal.ROUND_HALF_UP === 4`; `12.344 → 12.34`, `12.345 → 12.35`, `18 → 18`; and `new Decimal('18.00').equals(18) === true`.

**The uncommitted-holder lever.** The race tests copy it from three places.

The holder shape comes from `src/app/api/classes/route.test.ts:77-90`:
```ts
    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(
      async (tx) => {
        // No class exists on this room yet, so nothing RESTRICTs this delete.
        await tx.$executeRaw`DELETE FROM "TeacherRoom" WHERE id = ${teacherRoom.id}`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
```
The form that rejects the park when the holder's own write fails comes from `tests/integration/teacher-rooms-api.test.ts:713-721`:
```ts
    await new Promise<void>((parked, failed) => {
      holding = holder.$transaction(async (tx) => {
        await tx.teacherRoom.create({
          data: { teacherId: ownerId, roomId: raceRoomId, rentalRate: 25, capacityOverride: 10 },
        });
        parked();
        await released;
      }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
    });
```
The copied `waitUntilBlockedBy` and `ownPid` come from `src/services/invitations-lock-order.test.ts:1783-1800`. They replace the fixed one-second sleep with Postgres reporting the wait.

The tests call the handlers directly, in the serial tier. Each new file carries the `@serial-tier lock-contention` marker and has an entry in `LOCK_CONTENTION_TESTS`. `setTeacherRoomArchived` runs under `SET LOCAL lock_timeout = '2s'` (`src/lib/db-locks.ts:90`), and a 2 s hold would turn its answer into a 503. PATCH's vanished-link case therefore uses the `$extends` lever from `src/services/room-archive.test.ts:142-158` instead, which takes no lock.

- [ ] **Step 1: Write the comparison's unit test**

`src/services/teacher-room-attach.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { compareExistingLink } from './teacher-room-attach';

const stored = {
  isArchived: false,
  capacityOverride: 6,
  rentalRate: new Prisma.Decimal('12.34'),
  equipmentNotes: null,
};

describe('compareExistingLink', () => {
  it('answers unchanged for exactly the values the link holds', () => {
    expect(
      compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34, equipmentNotes: null }),
    ).toBe('unchanged');
  });

  // The column keeps two decimals, so a request carrying more is compared as
  // it would have been stored. The cases sit either side of a tie, never on
  // one, so they hold whichever way a tie would round.
  it('compares the rate as the column stores it, to two decimals', () => {
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.344 })).toBe('unchanged');
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.336 })).toBe('unchanged');
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.346 })).toBe('differs');
  });

  it('reads an absent note as null, and an empty note as a value', () => {
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34 })).toBe('unchanged');
    expect(
      compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34, equipmentNotes: '' }),
    ).toBe('differs');
  });

  it.each([
    ['rate', { rentalRate: 12.35 }],
    ['capacity', { capacityOverride: 7 }],
    ['notes', { equipmentNotes: 'Mats provided' }],
  ] as const)('answers differs when the %s differs', (_field, change) => {
    expect(
      compareExistingLink(stored, {
        capacityOverride: 6,
        rentalRate: 12.34,
        equipmentNotes: null,
        ...change,
      }),
    ).toBe('differs');
  });

  it('answers archived for an archived link, even when every value matches', () => {
    expect(
      compareExistingLink({ ...stored, isArchived: true }, { capacityOverride: 6, rentalRate: 12.34 }),
    ).toBe('archived');
  });
});
```

- [ ] **Step 2: Write the service tests**

In `src/services/room-archive.test.ts`, inside `describe('setTeacherRoomArchived — ownership, idempotency, release valve')`, directly after `it('reports not_found for an unknown link', …)` (ends `:196`), add:

```ts
  // A link deleted between the service's read and its write. The extension
  // runs the real read, then deletes the row before handing it back, which is
  // that interleaving without a lock: the write runs under a 2 s lock bound
  // that a held row would turn into a 503.
  it.each(['archived', 'unarchived'] as const)(
    'reports not_found when the link is deleted before the %s write',
    async (target) => {
      const f = await makeFixture();
      if (target === 'unarchived') {
        await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
      }

      let deleted = false;
      const interposing = prisma.$extends({
        query: {
          teacherRoom: {
            async findUnique({ args, query }) {
              const row = await query(args);
              if (!deleted) {
                deleted = true;
                await prisma.teacherRoom.delete({ where: { id: f.linkId } });
              }
              return row;
            },
          },
        },
      }) as unknown as PrismaClient;

      const result = await setTeacherRoomArchived(interposing, f.linkId, f.teacherId, target);

      expect(deleted).toBe(true);
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    },
  );
```

In `src/services/room-deletion.test.ts`, add `TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE` to the import list (`:18-24`). Replace `:112-122`, the comment and the `names one refusal for both blockers` case, with:

```ts
describe('the shared constants', () => {
  // Pins the exact string the room delete returns. The `Class` guard already
  // shipped this wording; a template blocker reuses it deliberately (spec
  // §2.1).
  it('names one refusal for both blockers', () => {
    expect(ROOM_DELETE_BLOCKED_MESSAGE).toBe(
      'This room is still in use and cannot be deleted. Archive it instead.',
    );
  });

  // The door that removes one teacher's link names its own action.
  it('names the unlink refusal by the action it refuses', () => {
    expect(TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE).toBe(
      "This room is used by your classes, so it can't be unlinked. Archive it instead.",
    );
  });
```

(The `describe` line is `:112`. Everything after `:122` stays.)

- [ ] **Step 3: Write the race tests (serial tier)**

`src/app/api/rooms/[id]/route-race.test.ts`:

```ts
/**
 * @serial-tier lock-contention — each case holds an uncommitted write on a
 * room row until this route's own statement is waiting on it, then commits,
 * so the route meets the row as that write left it.
 *
 * The handlers are called directly, as `src/app/api/classes/route.test.ts`
 * does: `getSessionToken` reads the session off the request's own cookie jar,
 * so no Next.js server is involved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';
import { DELETE } from './route';
import { POST as PUBLISH } from './publish/route';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/** Resolves once some backend is waiting on a lock `holderPid` holds. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing waited behind backend ${holderPid} within 1500ms`);
}

/**
 * Runs `write` in a transaction on its own connection, sends `request` once
 * that write is in, and commits only after `request` is waiting on it.
 */
async function behindUncommitted(
  write: (tx: Prisma.TransactionClient) => Promise<unknown>,
  request: () => Promise<Response>,
): Promise<Response> {
  const holder = new PrismaClient();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let holding!: Promise<unknown>;
  let holderPid = 0;
  let pending: Promise<Response> | undefined;
  try {
    await new Promise<void>((parked, failed) => {
      holding = holder
        .$transaction(async (tx) => {
          await write(tx);
          holderPid = await ownPid(tx);
          parked();
          await released;
        }, { timeout: 20_000 })
        .catch((err: unknown) => { failed(err); throw err; });
    });

    pending = request();
    // Asserted, not assumed: a request that answered without waiting raced nothing.
    await waitUntilBlockedBy(holderPid);

    release();
    await holding;
    return await pending;
  } finally {
    release();
    await Promise.allSettled([holding, pending]);
    await holder.$disconnect();
  }
}

describe('rooms/[id] against a write that lands while the request waits on the room', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `room-race-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Room', lastName: 'Race', email, bio: 'room race fixture',
        pageSlug: `room-race-${suffix}`, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /** A private room of this teacher's, linked to them, with nothing else on it. */
  async function makeLinkedRoom(): Promise<string> {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue', address: `${suffix} Room Race St`, city: 'Testville',
        postcode: '1234RR', floor: '1', roomName: `Race ${seq++}`, maxCapacity: 10,
        createdById: teacherId, isPublic: false,
      },
    });
    await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return room.id;
  }

  const deleteRoom = (id: string) =>
    DELETE(
      new NextRequest(`http://localhost:3000/api/rooms/${id}`, {
        method: 'DELETE',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  const shareRoom = (id: string) =>
    PUBLISH(
      new NextRequest(`http://localhost:3000/api/rooms/${id}/publish`, {
        method: 'POST',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  // A double-click: both deletes pass the existence read, and this one waits
  // on the other's row locks until that delete commits.
  it('answers NOT_FOUND to the second of two deletes that both passed the read', async () => {
    const roomId = await makeLinkedRoom();

    const res = await behindUncommitted(
      (tx) => tx.$executeRaw`DELETE FROM "Room" WHERE id = ${roomId}`,
      () => deleteRoom(roomId),
    );

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.room.count({ where: { id: roomId } })).toBe(0);
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(0);
  }, 15_000);

  // The share's second site: its guarded write matches no row because a twin
  // share committed first.
  it('answers unchanged to a share whose write finds the room already shared', async () => {
    const roomId = await makeLinkedRoom();

    const res = await behindUncommitted(
      (tx) => tx.$executeRaw`UPDATE "Room" SET "isPublic" = true WHERE id = ${roomId}`,
      () => shareRoom(roomId),
    );

    const data = (await expectUnchanged(res)) as { id: string; isPublic: boolean };
    expect(data).toMatchObject({ id: roomId, isPublic: true });
  }, 15_000);
});
```

`src/app/api/teacher-rooms/[id]/route-race.test.ts`:

```ts
/**
 * @serial-tier lock-contention — each case holds an uncommitted delete of a
 * teacher's room link until this route's own write is waiting on it, then
 * commits, so the route's write finds the row gone.
 *
 * The handlers are called directly, as `src/app/api/classes/route.test.ts`
 * does: `getSessionToken` reads the session off the request's own cookie jar,
 * so no Next.js server is involved. PATCH is not here: its service bounds
 * every wait at 2 s, and `room-archive.test.ts` stages the same interleaving
 * without a lock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { DELETE, PUT } from './route';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/** Resolves once some backend is waiting on a lock `holderPid` holds. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing waited behind backend ${holderPid} within 1500ms`);
}

/** Deletes `linkId` on its own connection, and commits once `request` waits on it. */
async function behindUncommittedDelete(
  linkId: string,
  request: () => Promise<Response>,
): Promise<Response> {
  const holder = new PrismaClient();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let holding!: Promise<unknown>;
  let holderPid = 0;
  let pending: Promise<Response> | undefined;
  try {
    await new Promise<void>((parked, failed) => {
      holding = holder
        .$transaction(async (tx) => {
          // No class or template is on the link, so nothing RESTRICTs this delete.
          await tx.$executeRaw`DELETE FROM "TeacherRoom" WHERE id = ${linkId}`;
          holderPid = await ownPid(tx);
          parked();
          await released;
        }, { timeout: 20_000 })
        .catch((err: unknown) => { failed(err); throw err; });
    });

    pending = request();
    // Asserted, not assumed: a request that answered without waiting raced nothing.
    await waitUntilBlockedBy(holderPid);

    release();
    await holding;
    return await pending;
  } finally {
    release();
    await Promise.allSettled([holding, pending]);
    await holder.$disconnect();
  }
}

describe('teacher-rooms/[id] on a link deleted while the request waits on it', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `link-race-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Link', lastName: 'Race', email, bio: 'teacher-room race fixture',
        pageSlug: `link-race-${suffix}`, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  async function makeLink(): Promise<string> {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue', address: `${suffix} Link Race St`, city: 'Testville',
        postcode: '1234LR', floor: '1', roomName: `Race ${seq++}`, maxCapacity: 10,
        createdById: teacherId, isPublic: false,
      },
    });
    const link = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return link.id;
  }

  const putLink = (id: string, body: unknown) =>
    PUT(
      new NextRequest(`http://localhost:3000/api/teacher-rooms/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  const deleteLink = (id: string) =>
    DELETE(
      new NextRequest(`http://localhost:3000/api/teacher-rooms/${id}`, {
        method: 'DELETE',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  it('answers NOT_FOUND when an edit finds the link gone at its write', async () => {
    const linkId = await makeLink();

    const res = await behindUncommittedDelete(linkId, () => putLink(linkId, { rentalRate: 20 }));

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: linkId } })).toBe(0);
  }, 15_000);

  // A double-click on Unlink: both requests pass the read and the blocker
  // count, and this one waits on the other's row lock.
  it('answers NOT_FOUND to the second of two deletes that both passed the read', async () => {
    const linkId = await makeLink();

    const res = await behindUncommittedDelete(linkId, () => deleteLink(linkId));

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: linkId } })).toBe(0);
  }, 15_000);
});
```

In `vitest.tiers.ts`, add these lines inside `LOCK_CONTENTION_TESTS`, after its last entry and before `] as const;`:

```ts
  // #197: the `classes/route.test.ts` shape, for the room and teacher-room
  // doors; each file's header carries its reason.
  'src/app/api/rooms/[id]/route-race.test.ts',
  'src/app/api/teacher-rooms/[id]/route-race.test.ts',
```

- [ ] **Step 4: Write the integration tests**

**`tests/integration/teacher-rooms-api.test.ts`**

Replace the vitest import (`:20`) and add the assertions import after `:24`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
```
```ts
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
```

After `send` (ends `:92`), add:

```ts
/**
 * A private room of the owner's with no link on it, one per case, so no
 * create case depends on another's link. `roomName` keeps the private
 * identity key distinct.
 */
async function freshRoom(roomName: string): Promise<string> {
  const room = await prisma.room.create({
    data: {
      venueName: 'Teacher Rooms API Studio',
      address: `${suffix} Retry St`,
      city: 'Testville',
      postcode: '1234TR',
      floor: '1',
      roomName,
      maxCapacity: 10,
      createdById: ownerId,
      isPublic: false,
    },
  });
  return room.id;
}
```

Replace `:293-309`, the test `links a teacher to a room, then refuses a second link for the same pair`, with:

```ts
  it('links a teacher to a room, and answers an identical second request as unchanged', async () => {
    const body = { roomId: freeRoomId, capacityOverride: 6, rentalRate: 18 };

    const created = (await expectApplied(await create(ownerToken, body), 201)) as {
      id: string;
      rentalRate: string;
    };
    expect(created.id).toBeTruthy();
    const before = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });

    // A retry after a lost response: the link it asked for is already there,
    // holding these values.
    const unchanged = (await expectUnchanged(await create(ownerToken, body))) as { id: string };
    expect(unchanged.id).toBe(created.id);

    expect(await prisma.teacherRoom.count({ where: { roomId: freeRoomId } })).toBe(1);
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
```

Replace `:351-358`, the test `404s a room that does not exist, instead of failing on the foreign key`, which asserts the status only:

```ts
  it('404s a room that does not exist, instead of failing on the foreign key', async () => {
    const res = await create(ownerToken, {
      roomId: '00000000-0000-0000-0000-000000000000',
      capacityOverride: 5,
      rentalRate: 10,
    });
    expect(res.status).toBe(404);
  });
```

with

```ts
  it('answers NOT_FOUND for a room that does not exist, instead of failing on the foreign key', async () => {
    const res = await create(ownerToken, {
      roomId: '00000000-0000-0000-0000-000000000000',
      capacityOverride: 5,
      rentalRate: 10,
    });
    await expectRefusal(res, 'NOT_FOUND');
  });
```

After that test, inside the same `describe`, add:

```ts
  it('answers a retry whose rate carries more decimals than the column keeps as unchanged', async () => {
    const roomId = await freshRoom('Retry Decimals');
    const body = { roomId, capacityOverride: 6, rentalRate: 12.344 };

    const created = (await expectApplied(await create(ownerToken, body), 201)) as {
      rentalRate: string;
    };
    // The column is Decimal(10, 2): what it stores is the rounded rate.
    expect(created.rentalRate).toBe('12.34');

    await expectUnchanged(await create(ownerToken, body));
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  it('answers a null note as the same request as an absent one', async () => {
    const roomId = await freshRoom('Retry Null Notes');
    await expectApplied(
      await create(ownerToken, { roomId, capacityOverride: 6, rentalRate: 18 }),
      201,
    );

    await expectUnchanged(
      await create(ownerToken, { roomId, capacityOverride: 6, rentalRate: 18, equipmentNotes: null }),
    );
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  // Not a retry: the teacher typed different values, and answering unchanged
  // would discard them.
  it.each([
    ['rate', { rentalRate: 19 }],
    ['capacity', { capacityOverride: 7 }],
    ['note', { equipmentNotes: 'Bring blocks' }],
  ] as const)('refuses a second request with a different %s, and keeps the stored link', async (field, change) => {
    const roomId = await freshRoom(`Differs ${field}`);
    const body = { roomId, capacityOverride: 6, rentalRate: 18, equipmentNotes: 'Mats provided' };
    const created = (await expectApplied(await create(ownerToken, body), 201)) as { id: string };

    await expectRefusal(await create(ownerToken, { ...body, ...change }), 'ROOM_ALREADY_LISTED');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect({
      capacityOverride: after.capacityOverride,
      rentalRate: Number(after.rentalRate),
      equipmentNotes: after.equipmentNotes,
    }).toEqual({ capacityOverride: 6, rentalRate: 18, equipmentNotes: 'Mats provided' });
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  it('refuses a request for a link the teacher has archived, even with identical values', async () => {
    const roomId = await freshRoom('Retry Archived');
    const body = { roomId, capacityOverride: 6, rentalRate: 18 };
    const created = (await expectApplied(await create(ownerToken, body), 201)) as { id: string };
    await expectApplied(await send('PATCH', ownerToken, `${created.id}?state=archived`));

    await expectRefusal(await create(ownerToken, body), 'ROOM_ARCHIVED');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.isArchived).toBe(true);
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  // THE ORDERING CASE. The unchanged condition holds here (an identical live
  // link exists), so only the room access gate running first keeps this a
  // 403. Such a link can only predate #77; it is written directly because the
  // route refuses to create it.
  it("refuses a link to another teacher's private room even when an identical link already exists", async () => {
    const theirs = await prisma.room.create({
      data: {
        venueName: 'Other Teacher Studio',
        address: `${suffix} Legacy St`,
        city: 'Testville',
        postcode: '5678TR',
        floor: '1',
        roomName: 'Legacy Back Room',
        maxCapacity: 10,
        createdById: otherId,
        isPublic: false,
      },
    });
    await prisma.teacherRoom.create({
      data: { teacherId: ownerId, roomId: theirs.id, capacityOverride: 5, rentalRate: 10 },
    });

    const res = await create(ownerToken, { roomId: theirs.id, capacityOverride: 5, rentalRate: 10 });

    // The access refusal carries no code. Its status is what separates it
    // from the unchanged 200.
    expect(res.status).toBe(403);
    expect(await prisma.teacherRoom.count({ where: { roomId: theirs.id } })).toBe(1);
  });
```

After `it('404s an id that does not exist, …')` (ends `:406`), inside `describe('/api/teacher-rooms/[id] — the ownership chain')`, add:

```ts
  it('answers NOT_FOUND to an edit, archive or delete of a link that does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await expectRefusal(await send('PUT', ownerToken, missing, { rentalRate: 1 }), 'NOT_FOUND');
    await expectRefusal(await send('PATCH', ownerToken, `${missing}?state=archived`), 'NOT_FOUND');
    await expectRefusal(await send('DELETE', ownerToken, missing), 'NOT_FOUND');
  });
```

After `it('deletes a link with no class history', …)` (ends `:545`), add:

```ts
  it('answers NOT_FOUND to a second delete of the same link', async () => {
    const roomId = await freshRoom('Delete Twice');
    const link = await prisma.teacherRoom.create({
      data: { teacherId: ownerId, roomId, capacityOverride: 6, rentalRate: 18 },
    });

    await expectApplied(await send('DELETE', ownerToken, link.id));
    // A retry after a lost response: the link is already gone, which the
    // Unlink button reads as done.
    await expectRefusal(await send('DELETE', ownerToken, link.id), 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: link.id } })).toBe(0);
  });
```

Replace `:667-752` (the #161 docblock and `describe`) with:

```ts
/**
 * The pre-check in `POST /api/teacher-rooms` is a plain `findUnique`, so under
 * READ COMMITTED a concurrent attach to the same (teacher, room) passes it and
 * loses on `TeacherRoom_teacherId_roomId_key` (#161). The loser re-reads the
 * link that won and answers exactly as the pre-check would have for it.
 *
 * The lever is an UNCOMMITTED HOLDER, the one worked out in
 * `signup-api.test.ts` for the same shape: a second client inserts the
 * conflicting row inside an open transaction, the request sails past its
 * pre-check (uncommitted rows are invisible), parks on the pending unique
 * index entry, and the holder commits so the request loses. Deterministic —
 * the interleaving is forced, not raced for.
 */
describe('POST /api/teacher-rooms decides a raced duplicate from the link that won (#161)', () => {
  let raceRoomId: string;

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue',
        address: `${suffix} Race Street 1`,
        city: 'Amsterdam',
        postcode: '1011AB',
        floor: '1',
        roomName: 'Race Room',
        maxCapacity: 10,
        equipment: [],
        isPublic: true,
        createdById: ownerId,
      },
    });
    raceRoomId = room.id;
  });

  afterEach(async () => {
    await prisma.teacherRoom.deleteMany({ where: { roomId: raceRoomId } });
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { roomId: raceRoomId } });
    await prisma.room.deleteMany({ where: { id: raceRoomId } });
  });

  /** Sends `body` while `holderLink` is inserted but uncommitted, and commits it once the request has parked. */
  async function raceAgainst(
    holderLink: { rentalRate: number; capacityOverride: number; isArchived?: boolean },
    body: { capacityOverride: number; rentalRate: number },
  ): Promise<Response> {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    try {
      await new Promise<void>((parked, failed) => {
        holding = holder.$transaction(async (tx) => {
          await tx.teacherRoom.create({
            data: { teacherId: ownerId, roomId: raceRoomId, ...holderLink },
          });
          parked();
          await released;
        }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
      });

      const pending = fetch(`${BASE_URL}/api/teacher-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
        body: JSON.stringify({ roomId: raceRoomId, ...body }),
      });

      // Asserted, not assumed: the holder's insert proves the index entry
      // exists, not that the request reached it. A request that answered inside
      // this second skipped the create on a committed row and raced nothing.
      let settled = false;
      void pending.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled).toBe(false);

      release();
      await holding;
      return await pending;
    } finally {
      release();
      await Promise.allSettled([holding]);
      await holder.$disconnect();
    }
  }

  it('refuses with ROOM_ALREADY_LISTED when the link that won carries a different rate', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10 },
      { capacityOverride: 10, rentalRate: 30 },
    );

    await expectRefusal(res, 'ROOM_ALREADY_LISTED');
    // One link, and it is the holder's — proof the request lost the insert
    // rather than serialising past it.
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => Number(l.rentalRate))).toEqual([25]);
  });

  it('answers unchanged when the link that won is the one this request asked for', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10 },
      { capacityOverride: 10, rentalRate: 25 },
    );

    const data = (await expectUnchanged(res)) as { id: string };
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => l.id)).toEqual([data.id]);
  });

  it('refuses with ROOM_ARCHIVED when the link that won is archived', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10, isArchived: true },
      { capacityOverride: 10, rentalRate: 25 },
    );

    await expectRefusal(res, 'ROOM_ARCHIVED');
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => l.isArchived)).toEqual([true]);
  });
});
```

**`tests/integration/rooms-api.test.ts`**

After `:28` (`import { createClassFixture } from '../class-fixtures';`), add:

```ts
import { expectRefusal } from '../api-assertions';
```

Replace `:623-640`, the test `the creator deletes a private, class-free room -> 200, room and teacher-rooms gone`, with the two tests below. `:641` (`});`, closing the describe) stays.

```ts
  it('the creator deletes a private, class-free room -> 200, room and teacher-rooms gone; a second delete -> NOT_FOUND', async () => {
    // Premise: the room really does carry a teacher-room, or the cleanup
    // assertion below would pass vacuously.
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(1);

    const res = await del(creatorToken, deleteEmptyRoomId);
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { deleted: boolean } };
    expect(json.data.deleted).toBe(true);

    // TeacherRoom.room is declared onDelete: Cascade, so these rows would go
    // with the room even without the handler's explicit deleteMany. This pins
    // the observable outcome — no orphan teacher-rooms survive a room delete —
    // not that specific line of the handler.
    expect(await prisma.room.count({ where: { id: deleteEmptyRoomId } })).toBe(0);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(0);

    // A retry after a lost response: the room is already gone, which the
    // Delete button reads as done.
    await expectRefusal(await del(creatorToken, deleteEmptyRoomId), 'NOT_FOUND');
  });

  it('answers NOT_FOUND for a room that does not exist', async () => {
    await expectRefusal(await del(creatorToken, '00000000-0000-0000-0000-000000000000'), 'NOT_FOUND');
  });
```

**`tests/integration/rooms-publish-api.test.ts`**

In the header, replace `:15-17` with:

```ts
 *   - non-creator on an ALREADY-SHARED room is the only case that separates
 *     them: creator-first answers NOT_ROOM_CREATOR, isPublic-first answers
 *     the unchanged 200 meant for a repeat of the creator's own share.
```

After `:21` (the `../helpers` import), add:

```ts
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
```

Replace `:100-103` (`answers 404 for a room that does not exist`) with:

```ts
  it('answers NOT_FOUND for a room that does not exist', async () => {
    await expectRefusal(
      await publish(creatorToken, '00000000-0000-0000-0000-000000000000'),
      'NOT_FOUND',
    );
  });
```

Replace `:117-132`, the guard-order case and `refuses the creator re-sharing an already-shared room`, with:

```ts
  // GUARD ORDER — the only case that can detect a swap. The unchanged
  // condition holds (the room is shared), so only the creator check running
  // first keeps this a refusal.
  it('answers a non-creator on an already-shared room with NOT_ROOM_CREATOR, not an unchanged answer', async () => {
    const room = await makeRoom('SharedNotYours', true);
    await expectRefusal(await publish(otherToken, room.id), 'NOT_ROOM_CREATOR');
  });

  // A retry after a lost response: the first share committed.
  it('answers a repeat of a share as unchanged, and writes nothing', async () => {
    const room = await makeRoom('Twice', false);
    await expectApplied(await publish(creatorToken, room.id));
    const shared = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(shared.isPublic).toBe(true);

    const data = (await expectUnchanged(await publish(creatorToken, room.id))) as {
      id: string;
      isPublic: boolean;
    };
    expect(data).toMatchObject({ id: room.id, isPublic: true });

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.updatedAt.getTime()).toBe(shared.updatedAt.getTime());
  });

  it('answers the creator sharing a room that was created shared as unchanged', async () => {
    const room = await makeRoom('AlreadyShared', true);
    await expectUnchanged(await publish(creatorToken, room.id));

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(true);
    expect(after.updatedAt.getTime()).toBe(room.updatedAt.getTime());
  });
```

- [ ] **Step 5: Rewrite the existing assertions the change breaks**

Steps 2 and 4 already replaced these:
- `tests/integration/teacher-rooms-api.test.ts:304-306`: 409 `'DUPLICATE'` becomes `expectUnchanged`.
- `tests/integration/teacher-rooms-api.test.ts:357`: the POST unknown-room 404, status only, becomes `expectRefusal(res, 'NOT_FOUND')`.
- `tests/integration/teacher-rooms-api.test.ts:742-745`: `'DUPLICATE'` and `'Teacher-room link already exists'` become `expectRefusal(res, 'ROOM_ALREADY_LISTED')`.
- `tests/integration/rooms-publish-api.test.ts:129-131`: 409 `'ALREADY_SHARED'` becomes `expectUnchanged`.
- `tests/integration/rooms-publish-api.test.ts:102`: status only, becomes `expectRefusal(res, 'NOT_FOUND')`.
- `tests/integration/rooms-publish-api.test.ts:121-123`: becomes `expectRefusal(res, 'NOT_ROOM_CREATOR')`.
- `src/services/room-deletion.test.ts:113-116`: the "both routes" comment.

The rest are prose assertions on the teacher-rooms DELETE row, whose copy changes:

`tests/integration/teacher-rooms-api.test.ts:529-534`:
```ts
  it('refuses to delete a link that still carries class history, and says to archive instead', async () => {
    const res = await send('DELETE', ownerToken, linkWithClassId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Archive it instead');
```
becomes
```ts
  it('refuses to unlink a link that still carries class history', async () => {
    const res = await send('DELETE', ownerToken, linkWithClassId);
    await expectRefusal(res, 'ROOM_IN_USE');
```
(`:535-539` stay.)

`tests/integration/teacher-rooms-api.test.ts:626-634`:
```ts
    const res = await send('DELETE', ownerToken, linkWithArchivedTemplateId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.message).toBe('This room is still in use and cannot be deleted. Archive it instead.');
    // ROOM_IN_USE, not ROOM_IN_USE_RACE: this asserts the PRE-CHECK answered.
    // Disabling it makes the backstop reply with the race code and reddens
    // every case carrying this line — the cheap, deterministic half of the
    // guard the lock-ordering case above pins the expensive half of.
    expect(body.error.code).toBe('ROOM_IN_USE');
```
becomes
```ts
    const res = await send('DELETE', ownerToken, linkWithArchivedTemplateId);
    // ROOM_IN_USE, not ROOM_IN_USE_RACE: this asserts the PRE-CHECK answered.
    // Disabling it makes the backstop reply with the race code and reddens
    // every case carrying this line — the cheap, deterministic half of the
    // guard the lock-ordering case above pins the expensive half of.
    await expectRefusal(res, 'ROOM_IN_USE');
```

`tests/integration/teacher-rooms-api.test.ts:654-662` gets the identical rewrite, with `linkWithLiveTemplateId` in place of `linkWithArchivedTemplateId`.

These stay as they are:
- `tests/integration/teacher-rooms-api.test.ts:485-486`: PATCH `ROOM_IN_USE` and its `describeRoomBlockers` sentence. Neither the copy nor the code changes, and the message line is the only pin on the route's use of `describeRoomBlockers`.
- `:558` (`'Access denied'`).
- `tests/integration/rooms-api.test.ts:460`, `:473`, `:483`, `:493`, `:522`, `:545`, `:612`: the rooms DELETE keeps its 403 sentences and `ROOM_DELETE_BLOCKED_MESSAGE`.

- [ ] **Step 6: Run the new tests to see them fail**

Run: `pnpm exec vitest run --project unit src/services/teacher-room-attach.test.ts src/services/room-archive.test.ts src/services/room-deletion.test.ts src/lib/serial-tier-membership.test.ts`

Expected:
- FAIL `teacher-room-attach.test.ts`: `Failed to resolve import "./teacher-room-attach"`.
- FAIL `room-archive.test.ts`: both `reports not_found when the link is deleted before the … write` cases. The call rejects with `PrismaClientKnownRequestError`, code `P2025`.
- FAIL `room-deletion.test.ts` › `names the unlink refusal by the action it refuses`: `expected undefined to be "This room is used by your classes, …"`.
- PASS `serial-tier-membership.test.ts`: both new files exist and carry the marker.

Run: `pnpm exec vitest run --project unit-sweeps "src/app/api/rooms/[id]/route-race.test.ts" "src/app/api/teacher-rooms/[id]/route-race.test.ts"`

Expected: FAIL on all four cases:
- the rooms DELETE case, and both teacher-rooms cases: `expected { status: 500, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`;
- the share case: `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.

**Stop and report, instead of implementing, if:**
- a DELETE or PUT case shows `status: 200`. The premise under the P2025 catches (spec §5.3, §7.6) is then false: Prisma did not raise P2025 for a row deleted while its statement waited, and the catches would be dead code.
- the share case shows `{ status: 200, outcome: undefined }`. The `updateMany` then did not re-check `isPublic: false` under the row lock, and site 2 is unreachable.
- any case fails with `nothing waited behind backend`. The request answered without contending, so the case raced nothing.

With the worktree app up (Global Constraints):

Run: `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts tests/integration/rooms-api.test.ts tests/integration/rooms-publish-api.test.ts`

Expected FAILs:

`teacher-rooms-api`:
- `answers NOT_FOUND for a room that does not exist, instead of failing on the foreign key`: `{ status: 404, code: undefined }` against `{ status: 404, code: 'NOT_FOUND' }`.
- `…identical second request as unchanged`: `{ status: 409, outcome: undefined }` against `{ status: 200, outcome: 'unchanged' }`. So do `…more decimals…` and `…null note…`.
- the three `…with a different rate|capacity|note…` cases: `code: 'DUPLICATE'` against `code: 'ROOM_ALREADY_LISTED'`.
- `…has archived…`: `code: 'DUPLICATE'` against `code: 'ROOM_ARCHIVED'`.
- `answers NOT_FOUND to an edit, archive or delete…`: `code: undefined` against `code: 'NOT_FOUND'`, on PUT first.
- `…second delete of the same link`: `code: undefined`.
- the three race cases: `code: 'DUPLICATE'` for the two refusals, and `status: 409` for the unchanged one.

`rooms-api`:
- `…a second delete -> NOT_FOUND` and `answers NOT_FOUND for a room that does not exist`: `code: undefined`.

`rooms-publish-api`:
- `answers a repeat of a share as unchanged…` and `…created shared as unchanged`: `status: 409`.

Expected PASSes, because they guard behaviour that exists already:
- the POST ordering case (`…even when an identical link already exists`);
- the three rewritten `ROOM_IN_USE` cases;
- publish's `NOT_FOUND` and `NOT_ROOM_CREATOR` cases.

- [ ] **Step 7: Implement the comparison**

`src/services/teacher-room-attach.ts`:

```ts
import { Prisma, type TeacherRoom } from '@prisma/client';

/**
 * What an attach request finds when the teacher already holds a link to the
 * room: the link is archived, holds exactly the values the request carries,
 * or holds others.
 */
export type ExistingLinkVerdict = 'archived' | 'unchanged' | 'differs';

/** The values an attach request asks the new link to hold. */
export type RequestedLinkValues = {
  capacityOverride: number;
  rentalRate: number;
  equipmentNotes?: string | null;
};

/**
 * Compares the request with the stored link as the request's values would be
 * stored: `rentalRate` rounded to the two decimals `Decimal(10, 2)` keeps,
 * ties away from zero as Postgres rounds them, and an absent `equipmentNotes`
 * read as the `null` it is stored as.
 *
 * Archived first: a link the teacher has archived is refused whatever the
 * request carries, because the room is out of use until it is unarchived.
 */
export function compareExistingLink(
  existing: Pick<TeacherRoom, 'isArchived' | 'capacityOverride' | 'rentalRate' | 'equipmentNotes'>,
  requested: RequestedLinkValues,
): ExistingLinkVerdict {
  if (existing.isArchived) return 'archived';

  const requestedRate = new Prisma.Decimal(requested.rentalRate).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  const same =
    existing.capacityOverride === requested.capacityOverride &&
    existing.rentalRate.equals(requestedRate) &&
    existing.equipmentNotes === (requested.equipmentNotes ?? null);

  return same ? 'unchanged' : 'differs';
}
```

- [ ] **Step 8: Implement the service changes**

`src/services/room-archive.ts`: add to the imports (`:1-5`):

```ts
import { isRecordNotFound } from '@/lib/api-errors';
```

and replace `:272-273` (the close of the CHECK `if` block and `throw e;`):

```ts
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
    throw e;
```

with

```ts
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
    // The link was deleted after the read at the top: the same answer that
    // read gives.
    if (isRecordNotFound(e)) return { ok: false, reason: 'not_found' };
    throw e;
```

`src/services/room-deletion.ts`: add after `:2`:

```ts
import type { ApiErrorCode } from '@/lib/api-error-codes';
```

After `ROOM_DELETE_BLOCKED_MESSAGE` (ends `:82`), add:

```ts

/**
 * The same refusal at the door that removes one teacher's link rather than
 * the room. That door's action is unlinking, so the sentence names it; the
 * reasoning above about naming neither blocker applies unchanged.
 */
export const TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE =
  "This room is used by your classes, so it can't be unlinked. Archive it instead.";
```

Replace `:119-120`:

```ts
export const ROOM_IN_USE_CODE = 'ROOM_IN_USE';
export const ROOM_IN_USE_RACE_CODE = 'ROOM_IN_USE_RACE';
```

with

```ts
export const ROOM_IN_USE_CODE = 'ROOM_IN_USE' satisfies ApiErrorCode;
export const ROOM_IN_USE_RACE_CODE = 'ROOM_IN_USE_RACE' satisfies ApiErrorCode;
```

(`satisfies` checks the literal against the registry and keeps its literal type. An annotation `: ApiErrorCode` would widen it to the whole union.)

- [ ] **Step 9: Implement `DELETE /api/rooms/[id]`**

In `src/app/api/rooms/[id]/route.ts`, add after `:4` (`import { log } from '@/lib/log';`):

```ts
import { isRecordNotFound } from '@/lib/api-errors';
```

Replace `:23` and `:31-32`:

```ts
export const DELETE = withErrorHandler(async (
```
```ts
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);
```

with

```ts
/** The delete's answer for a room that does not exist, including one deleted mid-request. */
const ROOM_GONE = 'This room no longer exists.';

export const DELETE = withErrorHandler(async (
```
```ts
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError(ROOM_GONE, 404, 'NOT_FOUND');
```

Replace `:109-111`:

```ts
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    throw err;
```

with

```ts
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    // A concurrent delete of the same room committed first: the same answer
    // the read above gives.
    if (isRecordNotFound(err)) return respondError(ROOM_GONE, 404, 'NOT_FOUND');
    throw err;
```

Leave GET (`:126`) and PUT (`:144`, `:218`, `:226`) as they are.

- [ ] **Step 10: Implement `POST /api/rooms/[id]/publish`**

In `src/app/api/rooms/[id]/publish/route.ts`, replace `:2`:

```ts
import { Prisma } from '@prisma/client';
```

with

```ts
import { Prisma, type Room } from '@prisma/client';
```

and add `respondUnchanged,` after `respondError,` in the `@/lib/api-utils` import (`:4-10`). After `:11` (`import { isUniqueConflictOn } from '@/lib/unique-conflict';`), add:

```ts

/** The answer for a room that does not exist, including one deleted mid-request. */
const ROOM_GONE = 'This room no longer exists.';
```

This is the same sentence `DELETE /api/rooms/[id]` sends (Step 9), and both controls render on one settings page.

Replace `:54`:

```ts
  if (!room) return respondError('Room not found', 404, 'NOT_FOUND');
```

with

```ts
  if (!room) return respondError(ROOM_GONE, 404, 'NOT_FOUND');
```

Replace `:33-35`:

```ts
 * Reordering these to "match" the neighbours would answer a non-creator's
 * request about an already-shared room with ALREADY_SHARED instead of
 * NOT_ROOM_CREATOR — pinned in tests/integration/rooms-publish-api.test.ts.
```

with

```ts
 * Reordering these to "match" the neighbours would answer a non-creator's
 * request about an already-shared room with the unchanged 200 instead of
 * NOT_ROOM_CREATOR — pinned in tests/integration/rooms-publish-api.test.ts.
```

Replace site 1 (`:60-62`):

```ts
  if (room.isPublic) {
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }
```

with

```ts
  // Already shared: a repeat of a share that succeeded. After the creator
  // check, so a non-creator is refused rather than answered.
  if (room.isPublic) return respondUnchanged<Room>(room);
```

Replace site 2 (`:90-103`):

```ts
  if (result.count === 0) {
    // Check which predicate failed rather than naming one. The order here
    // mirrors the guards above — creator before shared — so a lost race
    // answers the same code the fast path would have.
    const current = await prisma.room.findUnique({
      where: { id },
      select: { isPublic: true, createdById: true },
    });
    if (!current) return respondError('Room not found', 404, 'NOT_FOUND');
    if (current.createdById !== session.teacherId) {
      return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
    }
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }
```

with

```ts
  if (result.count === 0) {
    // Check which predicate failed rather than naming one. The order here
    // mirrors the guards above — creator before shared — so a lost race
    // answers what the fast path would have. The full row, so the unchanged
    // answer carries the shape the applied one does.
    const current = await prisma.room.findUnique({ where: { id } });
    if (!current) return respondError(ROOM_GONE, 404, 'NOT_FOUND');
    if (current.createdById !== session.teacherId) {
      return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
    }
    // The write's one remaining predicate is `isPublic: false`: a twin share
    // committed first.
    return respondUnchanged<Room>(current);
  }
```

Replace `:106`:

```ts
  if (!updated) return respondError('Room not found', 404, 'NOT_FOUND');
```

with

```ts
  if (!updated) return respondError(ROOM_GONE, 404, 'NOT_FOUND');
```

- [ ] **Step 11: Implement `POST /api/teacher-rooms`**

In `src/app/api/teacher-rooms/route.ts`, replace `:1-14`:

```ts
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
import { createTeacherRoomSchema } from '@/lib/schemas';
```

with

```ts
import { NextRequest, type NextResponse } from 'next/server';
import { Prisma, type TeacherRoom } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
import { createTeacherRoomSchema } from '@/lib/schemas';
import { compareExistingLink, type RequestedLinkValues } from '@/services/teacher-room-attach';

/**
 * The answer to an attach request that finds the teacher's link to this room
 * already there, whether at the pre-check or at a create that lost to a twin.
 */
function answerExistingLink(existing: TeacherRoom, requested: RequestedLinkValues): NextResponse {
  const verdict = compareExistingLink(existing, requested);
  switch (verdict) {
    case 'archived':
      return respondError(
        'This room is in your archived rooms. Unarchive it to use it again.',
        409,
        'ROOM_ARCHIVED',
      );
    case 'unchanged':
      return respondUnchanged<TeacherRoom>(existing);
    case 'differs':
      return respondError(
        'This room is already in your rooms. Edit it there to change its details.',
        409,
        'ROOM_ALREADY_LISTED',
      );
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}
```

Replace `:52`:

```ts
  if (!room) return respondError('Room not found', 404);
```

with

```ts
  if (!room) return respondError('This room no longer exists.', 404, 'NOT_FOUND');
```

Replace `:58-82` (the pre-check and the comment above the `try`):

```ts
  // Check for duplicate
  const existing = await prisma.teacherRoom.findUnique({
    where: {
      teacherId_roomId: {
        teacherId: session.teacherId,
        roomId,
      },
    },
  });

  if (existing) {
    return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
  }

  // The pre-check above is a plain read, so a concurrent attach to the same
  // (teacher, room) passes it and one of the two loses here. Answering with
  // the pre-check's own code keeps the two paths indistinguishable to a
  // client, which is the whole point: without it a race reaches
  // `withErrorHandler` and returns 409 with no `code` at all (#161).
  //
```

with

```ts
  // After the room gates above, so an unchanged answer is never given for a
  // room this teacher may not attach to.
  const linkKey = { teacherId_roomId: { teacherId: session.teacherId, roomId } };
  const existing = await prisma.teacherRoom.findUnique({ where: linkKey });
  if (existing) return answerExistingLink(existing, parsed.data);

  // The pre-check above is a plain read, so a concurrent attach to the same
  // (teacher, room) passes it and one of the two loses here. The loser
  // re-reads the link that won and answers as the pre-check would have for
  // it, so a client cannot tell the two paths apart (#161).
  //
```

(The paragraph from `// Matched on the column set …` to `// this one.`, `:78-82`, stays.)

Replace `:95-97`:

```ts
    if (isUniqueConflictOn(err, ['teacherId', 'roomId'])) {
      return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
    }
```

with

```ts
    if (isUniqueConflictOn(err, ['teacherId', 'roomId'])) {
      // The unique violation is raised only once the winner has committed, so
      // this read sees it.
      const winner = await prisma.teacherRoom.findUnique({ where: linkKey });
      if (winner) return answerExistingLink(winner, parsed.data);
      // The winner was removed again before this read. No link exists, and a
      // retry can create one.
      return respondError('The system was busy and could not finish that. Please try again.', 503);
    }
```

- [ ] **Step 12: Implement `/api/teacher-rooms/[id]`**

In `src/app/api/teacher-rooms/[id]/route.ts`, replace `:1-20`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateTeacherRoomSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { setTeacherRoomArchived, describeRoomBlockers } from '@/services/room-archive';
import {
  countTeacherRoomDeleteBlockers,
  isRoomDeleteBlocked,
  ROOM_DELETE_BLOCKED_MESSAGE,
  ROOM_IN_USE_CODE,
  ROOM_IN_USE_RACE_CODE,
} from '@/services/room-deletion';
```

with

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { isRecordNotFound } from '@/lib/api-errors';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateTeacherRoomSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { setTeacherRoomArchived, describeRoomBlockers } from '@/services/room-archive';
import {
  countTeacherRoomDeleteBlockers,
  isRoomDeleteBlocked,
  ROOM_IN_USE_CODE,
  ROOM_IN_USE_RACE_CODE,
  TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE,
} from '@/services/room-deletion';

/**
 * The answer for a link that does not exist, including one deleted
 * mid-request, at every door below except GET.
 */
const LINK_GONE = 'This room is no longer in your rooms.';
```

PUT: replace `:53`:

```ts
  if (!teacherRoom) return respondError('Teacher-room not found', 404);
```

with

```ts
  if (!teacherRoom) return respondError(LINK_GONE, 404, 'NOT_FOUND');
```

and replace `:67-72`:

```ts
  const updated = await prisma.teacherRoom.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
```

with

```ts
  try {
    const updated = await prisma.teacherRoom.update({
      where: { id },
      data: updateData,
    });
    return respondOk(updated);
  } catch (err) {
    // Deleted after the read above: the same answer that read gives.
    if (isRecordNotFound(err)) return respondError(LINK_GONE, 404, 'NOT_FOUND');
    throw err;
  }
```

PATCH: replace `:115`:

```ts
  if (result.reason === 'not_found') return respondError('Teacher-room not found', 404);
```

with

```ts
  if (result.reason === 'not_found') return respondError(LINK_GONE, 404, 'NOT_FOUND');
```

and `:120`:

```ts
    return respondError(describeRoomBlockers(result.blockers), 409, 'ROOM_IN_USE');
```

with

```ts
    return respondError(describeRoomBlockers(result.blockers), 409, ROOM_IN_USE_CODE);
```

DELETE: replace `:140` the same way as `:53`:

```ts
  if (!teacherRoom) return respondError(LINK_GONE, 404, 'NOT_FOUND');
```

Replace `:155`:

```ts
    return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_CODE);
```

with

```ts
    return respondError(TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE, 409, ROOM_IN_USE_CODE);
```

Replace `:178-181`, which claims the backstop sends the pre-check's code (it sends `ROOM_IN_USE_RACE`):

```ts
      // race, or the pre-check's predicate has drifted from the foreign key's
      // — and the second is otherwise completely silent, because this branch
      // answers with the same status, body and code the pre-check does. It is
      // also the branch that reopens the deadlock edge above.
```

with

```ts
      // race, or the pre-check's predicate has drifted from the foreign key's
      // — and the second is otherwise silent to the teacher, because this
      // branch answers with the same status and message the pre-check does.
      // It is also the branch that reopens the deadlock edge above.
```

Replace `:192-194`:

```ts
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    throw err;
```

with

```ts
      return respondError(TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    // A concurrent delete of the same link committed first: the same answer
    // the read above gives.
    if (isRecordNotFound(err)) return respondError(LINK_GONE, 404, 'NOT_FOUND');
    throw err;
```

Leave GET (`:35`) as it is.

- [ ] **Step 13: Retire `ALREADY_SHARED` and `DUPLICATE`**

In `src/lib/api-error-codes.ts`, delete these two lines from `API_ERROR_STATUS`:

```ts
  ALREADY_SHARED: 409,
```
```ts
  DUPLICATE: 409,
```

Run: `pnpm run typecheck`
Expected: clean. Every sender was rewritten in Steps 10–11, and `share-room-button.tsx` still types its code as `string`, so its dead branch compiles until Step 17.

Run: `rg -n "'ALREADY_SHARED'|'DUPLICATE'|Teacher-room not found|Teacher-room link already exists" src tests`
Expected: exactly three hits.
- `src/app/api/teacher-rooms/[id]/route.ts:35`: GET, left alone.
- `src/components/settings/share-room-button.tsx:100`: `json.error?.code === 'ALREADY_SHARED'`, which Step 17 removes.
- `src/components/settings/share-room-button.test.tsx:195`: `code: 'ALREADY_SHARED'`, which Step 16 removes.

A hit anywhere else is a missed site.

Run: `rg -n "Room not found" src tests`
Expected: exactly four hits, all in `src/app/api/rooms/[id]/route.ts`: GET `:126` and PUT `:144`, `:218`, `:226`, which are out of scope. A hit in `publish/route.ts` or `teacher-rooms/route.ts`, or at `rooms/[id]/route.ts:32`, is a missed site.

- [ ] **Step 14: Run the server tests green**

Run: `pnpm exec vitest run --project unit src/services/teacher-room-attach.test.ts src/services/room-archive.test.ts src/services/room-archive-doors.test.ts src/services/room-deletion.test.ts src/lib/serial-tier-membership.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project unit-sweeps "src/app/api/rooms/[id]/route-race.test.ts" "src/app/api/teacher-rooms/[id]/route-race.test.ts" src/services/room-archive-lock-order.test.ts src/services/class-room-race.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project unit "src/app/api/rooms/[id]/route-race.test.ts" "src/app/api/teacher-rooms/[id]/route-race.test.ts"`
Expected: `No test files found`, because the parallel tier excludes both. If this run collects either file, the bracketed path did not match `SERIAL_TESTS`'s exclude. Stop and report.

With the worktree app up:

Run: `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts tests/integration/rooms-api.test.ts tests/integration/rooms-publish-api.test.ts`
Expected: PASS.

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 15: Commit the server half**

```bash
git add src/services/teacher-room-attach.ts src/services/teacher-room-attach.test.ts src/services/room-archive.ts src/services/room-archive.test.ts src/services/room-deletion.ts src/services/room-deletion.test.ts "src/app/api/rooms/[id]/route.ts" "src/app/api/rooms/[id]/route-race.test.ts" "src/app/api/rooms/[id]/publish/route.ts" src/app/api/teacher-rooms/route.ts "src/app/api/teacher-rooms/[id]/route.ts" "src/app/api/teacher-rooms/[id]/route-race.test.ts" src/lib/api-error-codes.ts vitest.tiers.ts tests/integration/teacher-rooms-api.test.ts tests/integration/rooms-api.test.ts tests/integration/rooms-publish-api.test.ts
git commit -m "fix(rooms): answer repeats as unchanged, vanished rows as NOT_FOUND, and code every room refusal (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 16: Write the client tests**

Every client test below uses this helper, declared once per file above its `describe`. It builds a real `Response`, as `template-form.test.tsx` does:

```tsx
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

**`src/components/settings/delete-room-button.test.tsx`.** Add the helper after `stubLocation` (`:25`). Replace `:121-139` (`surfaces the server’s own refusal and does not navigate`, whose mock carries a message this route never sends) with:

```tsx
  it('surfaces the server’s own refusal and does not navigate', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: {
          code: 'ROOM_IN_USE',
          message: 'This room is still in use and cannot be deleted. Archive it instead.',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This room is still in use and cannot be deleted. Archive it instead.',
    );
    expect(assign).not.toHaveBeenCalled();
    // Re-enabled, because the teacher is still on this page and may retry.
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  // A double-click, or a retry after a lost response: the room is gone, which
  // is what this delete asked for.
  it('treats a room that is already gone as deleted, and leaves', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue(
      jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'This room no longer exists.' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<DeleteRoomButton roomId="room-1" roomName="Sunrise Studio" />);
    openConfirm();
    confirmDelete();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/settings/rooms'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
```

**`src/components/settings/unlink-room-button.test.tsx`** (new):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { UnlinkRoomButton } from './unlink-room-button';
import { routerPush } from '../../../tests/setup/components';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('UnlinkRoomButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function confirmUnlink(): void {
    render(<UnlinkRoomButton teacherRoomId="tr-1" roomName="Sunrise Studio" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
  }

  it('asks before unlinking, and asks nothing of the server yet', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<UnlinkRoomButton teacherRoomId="tr-1" roomName="Sunrise Studio" />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink room' }));

    expect(
      screen.getByText(
        'Unlink Sunrise Studio? This removes it from your rooms. Only possible while no classes use it.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes the link and returns to the rooms list', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { deleted: true } }));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/rooms'));
    expect(fetchMock).toHaveBeenCalledWith('/api/teacher-rooms/tr-1', { method: 'DELETE' });
  });

  // A double-click, or a retry after a lost response: the link is gone, which
  // is what this unlink asked for.
  it('treats a link that is already gone as unlinked', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'This room is no longer in your rooms.' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/settings/rooms'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the refusal for a room that classes still use, and stays', async () => {
    const message = "This room is used by your classes, so it can't be unlinked. Archive it instead.";
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'ROOM_IN_USE', message } }));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(routerPush).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink' })).not.toBeDisabled());
  });

  it('reports a network failure rather than falling silent', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    confirmUnlink();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
```

**`src/components/settings/share-room-button.test.tsx`.** Replace `:184-204` (the `ALREADY_SHARED` comment and case) with:

```tsx
  // A repeat of a share whose first response was lost is answered 200
  // unchanged. The button treats it as the success it is.
  it('treats an unchanged answer as a successful share', async () => {
    mockSearchThenPublish([], {
      ok: true,
      body: { data: { id: 'mine', isPublic: true }, outcome: 'unchanged' },
    });
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: /^Share room$/ }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Both mean the page describes a room that no longer looks the way it was
  // rendered: the reason is shown, and the page refreshes so the control stops
  // offering an action that cannot succeed.
  it.each([
    ['NOT_ROOM_CREATOR', 'Only the room creator can share this room'],
    ['NOT_FOUND', 'This room no longer exists.'],
  ])('shows the %s refusal and refreshes the page', async (code, message) => {
    mockSearchThenPublish([], { ok: false, body: { error: { code, message } } });
    render(<ShareRoomButton roomId="mine" identity={identity} postcode="1015DX" />);

    openConfirm();
    fireEvent.click(await screen.findByRole('button', { name: /^Share room$/ }));

    expect(await screen.findByText(message)).toBeDefined();
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });
```

**`src/components/settings/archive-room-button.test.tsx`.** Replace `:65-80` (`shows the server message when the PATCH fails`, whose message no server path produces) with:

```tsx
  it('shows the server message when the PATCH fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'ROOM_IN_USE', message: '1 unfinished class still uses this room.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('1 unfinished class still uses this room.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  // Archiving is not a delete: a link that is gone was not archived, so this
  // stays an error.
  it('shows the server message when the link is gone, and stays', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        error: { code: 'NOT_FOUND', message: 'This room is no longer in your rooms.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ArchiveRoomButton teacherRoomId="tr-1" isArchived={false} />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('This room is no longer in your rooms.')).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });
```

**`src/components/settings/room-settings-step.test.tsx`** (new):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RoomSettingsStep } from './room-settings-step';

const selectedRoom = {
  id: 'room-1',
  venueName: 'De Studio',
  roomName: 'Main Hall',
  address: 'Keizersgracht 1',
  city: 'Amsterdam',
  postcode: '1018 DT',
  floor: '2nd',
  maxCapacity: 20,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('RoomSettingsStep', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function submit(onSaved: () => void): void {
    render(<RoomSettingsStep selectedRoom={selectedRoom} onSaved={onSaved} onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Rental rate'), { target: { value: '15.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add room' }));
  }

  // A retry after a lost response: the link is already there with these
  // values, which is what the teacher asked for.
  it('treats an unchanged answer as saved', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { id: 'tr-1' }, outcome: 'unchanged' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['ROOM_ALREADY_LISTED', 'This room is already in your rooms. Edit it there to change its details.'],
    ['ROOM_ARCHIVED', 'This room is in your archived rooms. Unarchive it to use it again.'],
  ])('shows the %s refusal and stays on this step', async (code, message) => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code, message } }));
    vi.stubGlobal('fetch', fetchMock);
    const onSaved = vi.fn();

    submit(onSaved);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm exec vitest run --project components src/components/settings/delete-room-button.test.tsx src/components/settings/unlink-room-button.test.tsx src/components/settings/share-room-button.test.tsx src/components/settings/archive-room-button.test.tsx src/components/settings/room-settings-step.test.tsx`

Expected FAILs:
- `delete-room-button` › `treats a room that is already gone as deleted, and leaves`: the `waitFor` on `assign` times out, and the alert shows `This room no longer exists.`
- `unlink-room-button` › `treats a link that is already gone as unlinked`: the `waitFor` on `routerPush` times out.

Everything else passes already:
- `room-settings-step` and `archive-room-button` need no code change, so their tests pin current behaviour against real bodies.
- `share-room-button`'s new cases pass on today's code. What guards the `ALREADY_SHARED` removal is the compiler (Step 19, mutation 14).

- [ ] **Step 17: Implement the clients**

`src/components/settings/delete-room-button.tsx`: add after `:4`:

```tsx
import { readError } from '@/lib/client-errors';
```

and replace `:23-28`:

```tsx
      if (res.ok) {
        deleted = true;
      } else {
        const json: { error?: { message?: string } } = await res.json();
        setError(json.error?.message ?? 'Failed to delete room.');
      }
```

with

```tsx
      if (res.ok) {
        deleted = true;
      } else {
        const { code, message } = await readError(res, 'Failed to delete room.');
        // The room being gone is what this delete asked for, whoever removed it.
        if (code === 'NOT_FOUND') deleted = true;
        else setError(message);
      }
```

`src/components/settings/unlink-room-button.tsx`: replace `:6`:

```tsx
import { readErrorMessage } from '@/lib/client-errors';
```

with

```tsx
import { readError } from '@/lib/client-errors';
```

and replace `:24-28`:

```tsx
      if (res.ok) {
        router.push('/settings/rooms');
      } else {
        setError(await readErrorMessage(res, 'Failed to unlink room. Please try again.'));
      }
```

with

```tsx
      if (res.ok) {
        router.push('/settings/rooms');
      } else {
        const { code, message } = await readError(res, 'Failed to unlink room. Please try again.');
        // The link being gone is what this unlink asked for, whoever removed it.
        if (code === 'NOT_FOUND') router.push('/settings/rooms');
        else setError(message);
      }
```

`src/components/settings/share-room-button.tsx`: add after `:9`:

```tsx
import { readError } from '@/lib/client-errors';
```

and replace `:84-111`:

```tsx
      if (res.ok) {
        router.refresh();
        return;
      }

      const json: { error?: { code?: string; message?: string } } = await res.json();

      // ALREADY_SHARED is not a failure — … (the whole comment, :91-99)
      if (json.error?.code === 'ALREADY_SHARED') {
        router.refresh();
        return;
      }

      // NOT_ROOM_CREATOR and NOT_FOUND both mean this page is describing a row
      // that no longer looks the way it was rendered. Show the reason, and
      // refresh so the controls stop offering an action that cannot succeed.
      setError(json.error?.message ?? 'Failed to share this room.');
      if (json.error?.code === 'NOT_ROOM_CREATOR' || json.error?.code === 'NOT_FOUND') {
        router.refresh();
      }
```

with

```tsx
      // Any 2xx is a share that holds, including the `unchanged` answer to a
      // repeat whose first response was lost (docs/technical-architecture.md,
      // The Services Layer → Error responses).
      if (res.ok) {
        router.refresh();
        return;
      }

      const { code, message } = await readError(res, 'Failed to share this room.');

      // NOT_ROOM_CREATOR and NOT_FOUND both mean this page is describing a row
      // that no longer looks the way it was rendered. Show the reason, and
      // refresh so the controls stop offering an action that cannot succeed.
      setError(message);
      if (code === 'NOT_ROOM_CREATOR' || code === 'NOT_FOUND') {
        router.refresh();
      }
```

Run: `pnpm exec vitest run --project components src/components/settings/delete-room-button.test.tsx src/components/settings/unlink-room-button.test.tsx src/components/settings/share-room-button.test.tsx src/components/settings/archive-room-button.test.tsx src/components/settings/room-settings-step.test.tsx src/components/settings/add-room-flow.test.tsx`
Expected: PASS.

Run: `rg -n "ALREADY_SHARED|'DUPLICATE'" src tests`
Expected: no output.

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 18: Commit the client half**

```bash
git add src/components/settings/delete-room-button.tsx src/components/settings/delete-room-button.test.tsx src/components/settings/unlink-room-button.tsx src/components/settings/unlink-room-button.test.tsx src/components/settings/share-room-button.tsx src/components/settings/share-room-button.test.tsx src/components/settings/archive-room-button.test.tsx src/components/settings/room-settings-step.test.tsx
git commit -m "fix(rooms): read a vanished room as deleted and an unchanged share as shared in the room controls (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 19: Prove the guards bite**

For each mutation: apply it, run the command, record the exact failure in the report, then `git checkout -- <path>` and re-run the command green.

For an integration command, first warm the touched route, because `next dev` compiles lazily. Send `curl -s -o /dev/null -X POST <INTEGRATION_BASE_URL>/api/teacher-rooms`, or `/api/rooms/x/publish` for the publish route. `<INTEGRATION_BASE_URL>` is the URL `pnpm run worktree:up` printed; `.env` holds the same value.

1. **The rate rounding.** In `src/services/teacher-room-attach.ts`, replace `new Prisma.Decimal(requested.rentalRate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)` with `new Prisma.Decimal(requested.rentalRate)`.
   - Run `pnpm exec vitest run --project unit src/services/teacher-room-attach.test.ts`. `compares the rate as the column stores it, to two decimals` fails: `expected 'differs' to be 'unchanged'`.
   - Then warm the route and run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "more decimals"`. It fails: `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
2. **The value comparison (spec §8.5).** In `src/services/teacher-room-attach.ts`, delete the line `existing.rentalRate.equals(requestedRate) &&`, and delete the `requestedRate` declaration with it so lint stays quiet.
   - Warm the route and run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "with a different rate"`. It fails: `expected { status: 200, code: undefined } to deeply equal { status: 409, code: 'ROOM_ALREADY_LISTED' }`.
   - `pnpm exec vitest run --project unit src/services/teacher-room-attach.test.ts` fails `answers differs when the rate differs` too.
3. **The absent-note rule.** In `src/services/teacher-room-attach.ts`, replace `(requested.equipmentNotes ?? null)` with `requested.equipmentNotes`. Run `pnpm exec vitest run --project unit src/services/teacher-room-attach.test.ts`. `reads an absent note as null, and an empty note as a value` fails: `expected 'differs' to be 'unchanged'`.
4. **Archived first.** In `src/services/teacher-room-attach.ts`, move `if (existing.isArchived) return 'archived';` below the `const same = …;` statement and change it to `if (!same && existing.isArchived) return 'archived';`.
   - Run the unit file. `answers archived for an archived link, even when every value matches` fails: `expected 'unchanged' to be 'archived'`.
   - Warm the route and run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "has archived"`. It fails on `{ status: 200 }` against `{ status: 409, code: 'ROOM_ARCHIVED' }`.
5. **§5.1 order on POST.** In `src/app/api/teacher-rooms/route.ts`, cut the three statements `const linkKey = …`, `const existing = …` and `if (existing) return answerExistingLink(existing, parsed.data);` and paste them directly above `const room = await prisma.room.findUnique({`. Warm the route and run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "even when an identical link already exists"`. It fails: `expected 200 to be 403`.
6. **The race re-read.** In `src/app/api/teacher-rooms/route.ts`, replace the body of the `isUniqueConflictOn` branch with `return respondError('This room is already in your rooms. Edit it there to change its details.', 409, 'ROOM_ALREADY_LISTED');`. Warm the route and run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "raced duplicate"`. Two cases fail:
   - `answers unchanged when the link that won…` (status 409);
   - `refuses with ROOM_ARCHIVED…` (`code: 'ROOM_ALREADY_LISTED'`).
7. **§5.1 order on publish.** In `src/app/api/rooms/[id]/publish/route.ts`, move `if (room.isPublic) return respondUnchanged<Room>(room);` above `if (room.createdById !== session.teacherId) {`. Warm the route and run `pnpm exec vitest run --project integration tests/integration/rooms-publish-api.test.ts -t "not an unchanged answer"`. It fails: `expected { status: 200, code: undefined } to deeply equal { status: 403, code: 'NOT_ROOM_CREATOR' }`.
8. **Publish site 2.** In `src/app/api/rooms/[id]/publish/route.ts`, replace the last `return respondUnchanged<Room>(current);` with `return respondOk(current);`. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/rooms/[id]/route-race.test.ts"`. `answers unchanged to a share whose write finds the room already shared` fails: `expected { status: 200, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`.
9. **The rooms DELETE twin (spec §8.5).** In `src/app/api/rooms/[id]/route.ts`, delete the line `if (isRecordNotFound(err)) return respondError(ROOM_GONE, 404, 'NOT_FOUND');` and the `isRecordNotFound` import. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/rooms/[id]/route-race.test.ts"`. `answers NOT_FOUND to the second of two deletes…` fails: `expected { status: 500, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.
10. **The teacher-rooms DELETE twin (spec §8.5).** In `src/app/api/teacher-rooms/[id]/route.ts`, delete the `isRecordNotFound` line in DELETE's `catch`. Run `pnpm exec vitest run --project unit-sweeps "src/app/api/teacher-rooms/[id]/route-race.test.ts"`. `answers NOT_FOUND to the second of two deletes…` fails with status 500.
11. **The PUT catch.** In `src/app/api/teacher-rooms/[id]/route.ts`, delete the `isRecordNotFound` line in PUT's `catch`. Run the same unit-sweeps file. `answers NOT_FOUND when an edit finds the link gone at its write` fails with status 500.
12. **The PATCH catch.** In `src/services/room-archive.ts`, delete `if (isRecordNotFound(e)) return { ok: false, reason: 'not_found' };` and its import. Run `pnpm exec vitest run --project unit src/services/room-archive.test.ts`. Both `reports not_found when the link is deleted before the … write` cases fail with a rejected `PrismaClientKnownRequestError` (`P2025`).
13. **The registry tether.** In `src/services/room-deletion.ts`, change `'ROOM_IN_USE' satisfies ApiErrorCode` to `'ROOM_IN_USE_X' satisfies ApiErrorCode`. Run `pnpm run typecheck`. It reports TS1360 at `room-deletion.ts` (`Type '"ROOM_IN_USE_X"' does not satisfy the expected type 'ApiErrorCode'`).
14. **The retired share code.** In `src/components/settings/share-room-button.tsx`, add `if (code === 'ALREADY_SHARED') { router.refresh(); return; }` directly after the `readError` line. Run `pnpm run typecheck`. It reports TS2367 (`… have no overlap`) at that line. This is spec §4.1's compile-time guard, which exists only now that the component reads `code` through `readError`.
15. **Delete button, NOT_FOUND as done.** In `src/components/settings/delete-room-button.tsx`, replace these four lines:

    ```tsx
            const { code, message } = await readError(res, 'Failed to delete room.');
            // The room being gone is what this delete asked for, whoever removed it.
            if (code === 'NOT_FOUND') deleted = true;
            else setError(message);
    ```

    with

    ```tsx
            const { message } = await readError(res, 'Failed to delete room.');
            setError(message);
    ```

    Run `pnpm exec vitest run --project components src/components/settings/delete-room-button.test.tsx`. `treats a room that is already gone as deleted, and leaves` fails on the `assign` wait.
16. **Unlink button, NOT_FOUND as done.** In `src/components/settings/unlink-room-button.tsx`, replace:

    ```tsx
            const { code, message } = await readError(res, 'Failed to unlink room. Please try again.');
            // The link being gone is what this unlink asked for, whoever removed it.
            if (code === 'NOT_FOUND') router.push('/settings/rooms');
            else setError(message);
    ```

    with

    ```tsx
            const { message } = await readError(res, 'Failed to unlink room. Please try again.');
            setError(message);
    ```

    Run `pnpm exec vitest run --project components src/components/settings/unlink-room-button.test.tsx`. `treats a link that is already gone as unlinked` fails on the `routerPush` wait.
17. **POST's not-found code.** In `src/app/api/teacher-rooms/route.ts`, replace `respondError('This room no longer exists.', 404, 'NOT_FOUND')` with `respondError('This room no longer exists.', 404)`. Warm the route, then run `pnpm exec vitest run --project integration tests/integration/teacher-rooms-api.test.ts -t "instead of failing on the foreign key"`. It fails: `expected { status: 404, code: undefined } to deeply equal { status: 404, code: 'NOT_FOUND' }`.

---
### Task 8: Account profiles and sign-in copy

A repeated "join as a student" or "set up my teacher page" stops being a 409 when the account already holds exactly that side: it answers 200 `unchanged`. `ALREADY_STUDENT` is retired. `ALREADY_TEACHER` is narrowed to "your teacher page holds other values". A ticket-path address collision on teacher-profile answers `ACCOUNT_EXISTS`, as student-profile already does. Both page-slug doors send one message, and `PUT /api/teachers/[id]` gains the slug catch it lacks. The two sign-in refusals get product copy.

Line numbers are as on `fix/197-api-error-contract` at `626163de`, before Task 1. Task 1 adds no lines to any file named here except `src/lib/api-utils.ts`.

**Files:**
- Create: `src/app/api/account/teacher-profile/route-lock-order.test.ts`, `src/app/api/teachers/[id]/route-lock-order.test.ts`, `src/components/booking/join-as-student.test.tsx`, `src/components/settings/profile-form.test.tsx`
- Modify:
  - `src/lib/api-error-codes.ts` (delete the `ALREADY_STUDENT: 409,` entry Task 1 created)
  - `src/app/api/account/student-profile/route.ts` (whole file: pre-check and both session catch sites answer `unchanged`)
  - `src/app/api/account/teacher-profile/route.ts` (whole file: value comparison, `ALREADY_TEACHER` copy, ticket-path `ACCOUNT_EXISTS`, slug copy)
  - `src/lib/schemas.ts:193-197` (add `PAGE_SLUG_TAKEN_MESSAGE` after `pageSlugField`)
  - `src/app/api/teachers/[id]/route.ts:1-11` (imports), `:47-66` (slug copy, P2002 catch)
  - `src/app/api/auth/magic-link/verify/route.ts:48` (copy)
  - `src/app/api/auth/passkey/authenticate/verify/route.ts:22` (copy)
  - `vitest.tiers.ts:138-141` (two `LOCK_CONTENTION_TESTS` entries)
  - `src/components/account/set-up-student-side.tsx:6`, `:18-38`
  - `src/components/booking/join-as-student.tsx:22-30`
  - `src/components/signup/profile-setup-form.tsx:1-11`, `:122`, `:266-332`
  - `src/components/settings/profile-form.tsx:1-8`, `:122-126`
- Test (rewritten):
  - `tests/integration/account-api.test.ts:84-90`, `:918-1017`
  - `tests/integration/erased-profile-restart.test.ts:1-4`, `:142-171`
  - `tests/integration/student-profile-ticket.test.ts:1-4`, `:79-110`, `:193-209`
  - `tests/integration/teacher-signup-api.test.ts:1-5`, plus new tests after `:650` and after `:957`
  - `tests/integration/teacher-profile-precedence.test.ts:1-4`, plus a new test after `:103`
  - `tests/integration/teachers-api.test.ts:1-3`, `:121-135`
  - `tests/integration/passkey-api.test.ts:8-14`, `:35-39`
  - `src/components/account/set-up-student-side.test.tsx:20-50`
  - `src/components/signup/profile-setup-form.test.tsx:124-142`, `:189-194`

**Interfaces:**
- Consumes (Task 1): `respondUnchanged<T>(data)` and `respondError(message, status, code?: ApiErrorCode)` from `@/lib/api-utils`; `readError` and `readErrorMessage` from `@/lib/client-errors`; `expectRefusal`, `expectUnchanged` and `expectApplied` from `tests/api-assertions.ts`; the registry entries `ACCOUNT_EXISTS`, `ALREADY_TEACHER`, `SLUG_TAKEN` and `UNIQUE_CONFLICT`.
- Produces (`src/lib/schemas.ts`):
  ```ts
  export const PAGE_SLUG_TAKEN_MESSAGE = 'That page slug is already taken.';
  ```
  Nothing else is exported. The response bodies:
  - `POST /api/account/student-profile` unchanged: `200 { data: { studentId }, outcome: 'unchanged' }`, the same `data` shape as the applied 201.
  - `POST /api/account/teacher-profile` unchanged: `200 { data: { teacherId }, outcome: 'unchanged' }`, likewise.

- [ ] **Step 1: Write the new failing server tests**

Add `import { expectRefusal, expectUnchanged } from '../api-assertions';` below the helpers import in `tests/integration/teacher-signup-api.test.ts` (`:3`), `tests/integration/teacher-profile-precedence.test.ts` (`:4`) and `tests/integration/student-profile-ticket.test.ts` (`:4`).

`tests/integration/student-profile-ticket.test.ts`: insert this test after the `ACCOUNT_EXISTS` test, which ends at `:209`, inside the same describe. It is the §5.1 ordering pin for this route. On the ticket path the caller owns no account, so a live student side at the address belongs to someone else. It must never be read as this request already being done.

```ts
  it('answers ACCOUNT_EXISTS, not unchanged, when the account that took the address already has a student side', async () => {
    const email = `profile-ticket-raced-student-${suffix}@test.local`;
    const ticket = await mintSignupTicket(prisma, email, 'student');
    const holder = await prisma.student.create({
      data: {
        firstName: 'Other', lastName: 'Holder', email, incomeTier: 3,
        claimedAt: new Date(), account: { create: { email } },
      },
      select: { id: true },
    });

    const res = await post(ticket, { firstName: 'Raced', lastName: 'Out' });

    await expectRefusal(res, 'ACCOUNT_EXISTS');
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
    const rows = await prisma.student.findMany({ where: { email }, select: { id: true } });
    expect(rows).toEqual([holder]);
  });
```

`tests/integration/teacher-signup-api.test.ts`: in `describe('POST /api/account/teacher-profile')`, insert this after `it('answers SLUG_TAKEN for an address someone already holds')`, which ends at `:650`. It is the first test of the ticket-path address collision (spec §7.2).

```ts
  // The ticket path creates the account in the same statement, so an address
  // collision there is another account, possibly one with no teacher side at
  // all. It is seeded between minting the ticket and posting, which is how
  // `student-profile-ticket.test.ts` reaches the same branch.
  it('answers ACCOUNT_EXISTS when the address gained an account during the ticket window', async () => {
    const email = `teacher-signup-account-exists-${suffix}@test.local`;
    const slug = `account-exists-${suffix}`;
    let accountId: string | null = null;
    try {
      const ticket = await mintSignupTicket(prisma, email, 'teacher');
      const student = await prisma.student.create({
        data: {
          firstName: 'Student', lastName: 'Only', email, claimedAt: new Date(),
          account: { create: { email } },
        },
        select: { accountId: true },
      });
      accountId = student.accountId;

      const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `fair_yoga_signup=${ticket}`,
          ...freshIp(),
        },
        body: JSON.stringify({ firstName: 'Late', lastName: 'Ticket', bio: '', pageSlug: slug }),
      });

      await expectRefusal(res, 'ACCOUNT_EXISTS');
      expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
      expect(await prisma.teacher.findUnique({ where: { pageSlug: slug } })).toBeNull();
    } finally {
      await prisma.magicLinkToken.deleteMany({ where: { email } });
      if (accountId) {
        await prisma.session.deleteMany({ where: { accountId } });
        await prisma.student.deleteMany({ where: { accountId } });
        await prisma.account.deleteMany({ where: { id: accountId } });
      }
    }
  });
```

Still in `tests/integration/teacher-signup-api.test.ts`: in `describe('POST /api/account/teacher-profile — session mode')`, insert these four tests between `it('creates the teacher on the signed-in account, with no ticket')`, which ends at `:957`, and `it('answers ALREADY_TEACHER for a session that already has one')` at `:959`. They depend on the create above them, as the file's other ordered tests do.

```ts
  it('answers an identical resubmit unchanged, and writes nothing', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({
      where: { pageSlug: sessionModeSlug },
      select: { id: true, updatedAt: true },
    });

    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionModeToken), ...freshIp() },
      // No `defaultTimezone`, the same as the create above. The route's
      // Amsterdam default is part of what gets compared.
      body: JSON.stringify({
        firstName: 'Student', lastName: 'Turned Teacher', bio: '', pageSlug: sessionModeSlug,
      }),
    });

    expect(await expectUnchanged(res)).toEqual({ teacherId: before.id });
    expect(res.headers.get('set-cookie') ?? '').not.toContain('fair_yoga_session=');
    expect(await prisma.teacher.count({ where: { accountId: sessionModeAccountId } })).toBe(1);
    const after = await prisma.teacher.findUniqueOrThrow({
      where: { pageSlug: sessionModeSlug },
      select: { id: true, updatedAt: true },
    });
    expect(after).toEqual(before);
  });

  it('refuses a resubmit whose bio differs with ALREADY_TEACHER, and keeps the stored bio', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionModeToken), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Student', lastName: 'Turned Teacher', bio: 'Changed my mind', pageSlug: sessionModeSlug,
      }),
    });

    await expectRefusal(res, 'ALREADY_TEACHER');
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { pageSlug: sessionModeSlug },
      select: { bio: true },
    });
    expect(teacher.bio).toBe('');
  });

  it('treats a different detected timezone as a different request', async () => {
    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionModeToken), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Student', lastName: 'Turned Teacher', bio: '', pageSlug: sessionModeSlug,
        defaultTimezone: 'America/Los_Angeles',
      }),
    });

    await expectRefusal(res, 'ALREADY_TEACHER');
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { pageSlug: sessionModeSlug },
      select: { defaultTimezone: true },
    });
    expect(teacher.defaultTimezone).toBe('Europe/Amsterdam');
  });

  // The ordering pin (spec §5.1). Authorization is this route's ownership gate,
  // and the unchanged check reads only the CALLER's account. Another account
  // that sends this teacher's exact values is not repeating anything: it
  // collides on the slug and is told so.
  it("answers another account's identical body SLUG_TAKEN, not unchanged", async () => {
    const otherEmail = `teacher-signup-session-other-${suffix}@test.local`;
    const other = await prisma.student.create({
      data: {
        firstName: 'Other', lastName: 'Account', email: otherEmail, claimedAt: new Date(),
        account: { create: { email: otherEmail } },
      },
      select: { accountId: true },
    });
    const otherAccountId = other.accountId;
    if (otherAccountId === null) throw new Error('fixture: student created without an account');
    try {
      const token = await seedSession(prisma, otherAccountId);
      const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
        body: JSON.stringify({
          firstName: 'Student', lastName: 'Turned Teacher', bio: '', pageSlug: sessionModeSlug,
        }),
      });

      await expectRefusal(res, 'SLUG_TAKEN');
      expect(await prisma.teacher.count({ where: { accountId: otherAccountId } })).toBe(0);
    } finally {
      await prisma.session.deleteMany({ where: { accountId: otherAccountId } });
      await prisma.student.deleteMany({ where: { accountId: otherAccountId } });
      await prisma.account.deleteMany({ where: { id: otherAccountId } });
    }
  });
```

`tests/integration/teacher-profile-precedence.test.ts`: insert this after `it('clears the declined ticket cookie on ALREADY_TEACHER, as the success paths do')`, which ends at `:103`. The unchanged answer must pass through `clearDeclinedTicketCookie` like every other exit. The file's `afterAll` sweeps every row whose email contains `suffix`.

```ts
  it('clears the declined ticket cookie on an unchanged resubmit too', async () => {
    const email = `tp-precedence-same-${suffix}@test.local`;
    const slug = `tp-same-${suffix}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Same', lastName: 'Values', email, bio: '', pageSlug: slug,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const sessionToken = await seedSession(prisma, teacher.accountId);
    const ticket = await mintSignupTicket(
      prisma, `tp-precedence-same-ticket-${suffix}@test.local`, 'teacher',
    );

    const res = await post(
      `fair_yoga_session=${sessionToken}; fair_yoga_signup=${ticket}`,
      { firstName: 'Same', lastName: 'Values', bio: '', pageSlug: slug },
    );

    expect(await expectUnchanged(res)).toEqual({ teacherId: teacher.id });
    expect(res.headers.get('set-cookie') ?? '').toContain('fair_yoga_signup=;');
  });
```

- [ ] **Step 2: Write the lost-race tests (unit tier, uncommitted holder)**

These tests follow the pattern of `src/app/api/students/[id]/privacy/route-lock-order.test.ts` (#626). That file calls the handler directly against the test database, finds the holder's backend with `pg_backend_pid()`, and polls `pg_stat_activity` for a backend that `pg_blocking_pids` says is waiting on it. The helpers below are copied from its `:67-91`:

```ts
function latch(): { promise: Promise<void>; open: () => void } { … }
async function ownPid(tx: Prisma.TransactionClient): Promise<number> { … SELECT pg_backend_pid()::int AS pid … }
async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> { … wait_event_type = 'Lock' AND ${holderPid} = ANY(pg_blocking_pids(pid)) … }
```

`src/app/api/account/teacher-profile/route-lock-order.test.ts` (new):

```ts
/**
 * @serial-tier lock-contention — holds an uncommitted `Teacher` insert while
 * this route's own create waits on the same unique keys, and asserts that the
 * waiter parked, via `pg_blocking_pids`. Lock noise from a neighbour in the
 * parallel tier would stretch that wait past the window the assertion allows.
 *
 * `POST` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. What is
 * under test is the route's catch. A create that loses to a twin re-reads the
 * caller's own account and answers as the pre-check would.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';
import { POST } from './route';

const prisma = new PrismaClient();

const WAIT_MS = 1_500;

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Sends `request` while a second connection holds `hold`'s writes
 * uncommitted, and commits them only once `request` is parked behind them.
 */
async function raceBehindHolder(
  hold: (tx: Prisma.TransactionClient) => Promise<void>,
  request: () => Promise<Response>,
): Promise<{ res: Response; parked: boolean }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await hold(tx);
    held.open();
    await release.promise;
  }, { timeout: 20_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const parked = (await waiterOf(holderPid, () => settled)) !== null;
    release.open();
    await holding;
    return { res: await pending, parked };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}

/** A signed-in account with a live student side and no teacher side. */
async function makeStudentAccount(tag: string) {
  const suffix = `tp-race-${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Race', lastName: 'Student', email, claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { accountId: true },
  });
  if (student.accountId === null) throw new Error('fixture student has no account');
  return {
    suffix,
    email,
    accountId: student.accountId,
    token: await seedSession(prisma, student.accountId),
  };
}

type Fixture = Awaited<ReturnType<typeof makeStudentAccount>>;

async function cleanup(fx: Fixture, otherEmail?: string): Promise<void> {
  await prisma.session.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.teacher.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.student.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.account.deleteMany({ where: { id: fx.accountId } });
  if (otherEmail) {
    await prisma.teacher.deleteMany({ where: { email: otherEmail } });
    await prisma.account.deleteMany({ where: { email: otherEmail } });
  }
}

function postProfile(token: string, body: Record<string, string>): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/account/teacher-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/account/teacher-profile answers a lost create by re-reading the account (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers unchanged, naming the twin, when the twin that won holds the same values', async () => {
    const fx = await makeStudentAccount('same');
    try {
      let twinId = '';
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          const twin = await tx.teacher.create({
            data: {
              accountId: fx.accountId, email: fx.email, firstName: 'Race', lastName: 'Twin',
              bio: 'Same bio', pageSlug: fx.suffix, defaultTimezone: 'Europe/Amsterdam',
            },
            select: { id: true },
          });
          twinId = twin.id;
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Same bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ teacherId: twinId });
      expect(await prisma.teacher.count({ where: { accountId: fx.accountId } })).toBe(1);
    } finally {
      await cleanup(fx);
    }
  }, 20_000);

  it('answers ALREADY_TEACHER when the twin that won holds a different bio', async () => {
    const fx = await makeStudentAccount('differs');
    try {
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.create({
            data: {
              accountId: fx.accountId, email: fx.email, firstName: 'Race', lastName: 'Twin',
              bio: 'Holder bio', pageSlug: fx.suffix,
            },
          });
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Request bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'ALREADY_TEACHER');
      const rows = await prisma.teacher.findMany({
        where: { accountId: fx.accountId },
        select: { bio: true },
      });
      expect(rows).toEqual([{ bio: 'Holder bio' }]);
    } finally {
      await cleanup(fx);
    }
  }, 20_000);

  it('answers SLUG_TAKEN when another account took the slug, even with identical values', async () => {
    const fx = await makeStudentAccount('slug');
    const otherEmail = `${fx.suffix}-other@test.local`;
    try {
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.create({
            data: {
              email: otherEmail, firstName: 'Race', lastName: 'Twin',
              bio: 'Same bio', pageSlug: fx.suffix,
              account: { create: { email: otherEmail } },
            },
          });
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Same bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'SLUG_TAKEN');
      expect(await prisma.teacher.count({ where: { accountId: fx.accountId } })).toBe(0);
    } finally {
      await cleanup(fx, otherEmail);
    }
  }, 20_000);
});
```

`src/app/api/teachers/[id]/route-lock-order.test.ts` (new). The header is the same shape. Copy `WAIT_MS`, `latch`, `ownPid`, `waiterOf` and `raceBehindHolder` verbatim from the file above:

```ts
/**
 * @serial-tier lock-contention — holds an uncommitted `pageSlug` change on
 * one teacher while this route's update of another teacher waits on the same
 * unique key, and asserts that the waiter parked, via `pg_blocking_pids`. Lock
 * noise from a neighbour in the parallel tier would stretch that wait past the
 * window the assertion allows.
 *
 * `PUT` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. The
 * route's pre-check is a plain read, so it cannot see the holder's slug. What
 * answers is the update's own catch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { PUT } from './route';

const prisma = new PrismaClient();

// WAIT_MS, latch, ownPid, waiterOf, raceBehindHolder: verbatim from
// src/app/api/account/teacher-profile/route-lock-order.test.ts.

async function makeTeacher(tag: string) {
  const suffix = `slug-race-${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Slug', lastName: 'Race', email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Slug race fixture', pageSlug: suffix,
    },
    select: { id: true, accountId: true, pageSlug: true },
  });
  return { ...teacher, suffix };
}

describe('PUT /api/teachers/[id] answers a slug claimed after its pre-check with SLUG_TAKEN (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses the update with SLUG_TAKEN and leaves both slugs as the holder left them', async () => {
    const caller = await makeTeacher('caller');
    const claimer = await makeTeacher('claimer');
    const wanted = `${caller.suffix}-wanted`;
    try {
      const token = await seedSession(prisma, caller.accountId);
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.update({ where: { id: claimer.id }, data: { pageSlug: wanted } });
        },
        () => PUT(
          new NextRequest(`http://localhost:3000/api/teachers/${caller.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...cookie(token) },
            body: JSON.stringify({ pageSlug: wanted }),
          }),
          { params: Promise.resolve({ id: caller.id }) },
        ),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'SLUG_TAKEN');
      const rows = await prisma.teacher.findMany({
        where: { id: { in: [caller.id, claimer.id] } },
        select: { id: true, pageSlug: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        { id: caller.id, pageSlug: caller.pageSlug },
        { id: claimer.id, pageSlug: wanted },
      ]));
    } finally {
      for (const t of [caller, claimer]) {
        await prisma.session.deleteMany({ where: { accountId: t.accountId } });
        await prisma.teacher.deleteMany({ where: { id: t.id } });
        await prisma.account.deleteMany({ where: { id: t.accountId } });
      }
    }
  }, 20_000);
});
```

In `vitest.tiers.ts`, append to `LOCK_CONTENTION_TESTS` after `'src/app/api/students/[id]/privacy/route-lock-order.test.ts',` (`:140`):

```ts
  // #197: the same shape, for the lost-race answers of the routes these files
  // sit beside. Each header carries its reason.
  'src/app/api/account/teacher-profile/route-lock-order.test.ts',
  'src/app/api/teachers/[id]/route-lock-order.test.ts',
```

- [ ] **Step 3: Write the failing component tests**

`src/components/booking/join-as-student.test.tsx` (new; this component had no test file):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { JoinAsStudent } from './join-as-student';

describe('JoinAsStudent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function join(): void {
    render(<JoinAsStudent firstName="Anna" />);
    fireEvent.click(screen.getByRole('button', { name: 'Join as a student' }));
  }

  it('adds the student side, then refreshes into the booking flow', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201, json: async () => ({ data: { studentId: 's-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    join();

    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/student-profile', { method: 'POST' });
  });

  it('treats a student side that already exists as done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { studentId: 's-1' }, outcome: 'unchanged' }),
    }));
    join();

    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not claim success for a 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'UNIQUE_CONFLICT', message: 'That already exists. Refresh to see the latest.' },
      }),
    }));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That already exists. Refresh to see the latest.',
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to its own message when the server sends none', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not set up your student side. Try again.',
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('reports a thrown fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    join();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
  });
});
```

`src/components/settings/profile-form.test.tsx` (new; this component had no test file):

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { ProfileForm } from './profile-form';

const initial = {
  firstName: 'Anna',
  lastName: 'de Vries',
  email: 'anna@example.com',
  bio: 'Slow flow on Tuesdays.',
  pageSlug: 'anna',
  defaultCurrency: 'EUR',
  defaultTimezone: 'Europe/Amsterdam',
  defaultReminder: 'morning_of',
  bankIban: null,
  bankAccountName: null,
};

describe('ProfileForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderForm(): void {
    render(<ProfileForm teacherId="t-1" initial={initial} />);
  }

  function save(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }

  it('PUTs the profile and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/teachers/t-1',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the server sentence for a page slug another teacher holds, and does not refresh', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'SLUG_TAKEN', message: 'That page slug is already taken.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    fireEvent.change(screen.getByLabelText('Page slug'), { target: { value: 'taken-slug' } });
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('That page slug is already taken.');
    expect(screen.queryByText('Saved')).toBeNull();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to its own message when the error body cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      url: '/api/teachers/t-1',
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to save');
  });

  it('reports a thrown fetch', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    renderForm();
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Please try again.');
  });
});
```

`src/components/signup/profile-setup-form.test.tsx`: add this after `it('creates the profile and hard-navigates to /schedule on success, clearing any draft')`, which ends at `:99`:

```tsx
  it('treats an unchanged answer as success in session mode', async () => {
    const assign = stubLocation();
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { teacherId: 't-1' }, outcome: 'unchanged' }),
    }));
    render(<ProfileSetupForm email="anna@example.com" mode="session" />);

    fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/schedule'));
    expect(window.localStorage.getItem(DRAFT_KEY)).toBeNull();
  });
```

- [ ] **Step 4: Run the new tests to see them fail**

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/account/teacher-profile/route-lock-order.test.ts 'src/app/api/teachers/[id]/route-lock-order.test.ts'`
Expected: FAIL.
- In teacher-profile, the "same values" case gets `expected { status: 409, outcome: undefined } to deeply equal { status: 200, outcome: 'unchanged' }`, and the "different bio" case gets `code: 'ALREADY_TEACHER'` at status 409, which passes. The "SLUG_TAKEN" case passes today.
- In teachers/[id], the case fails with `code: undefined` in place of `'SLUG_TAKEN'` (status 409, `classifyApiError`'s uncoded P2002 fallback).

Run: `pnpm exec vitest run --project components src/components/booking/join-as-student.test.tsx src/components/settings/profile-form.test.tsx src/components/signup/profile-setup-form.test.tsx`
Expected: FAIL.
- join-as-student: "does not claim success for a 409" fails, because `routerRefresh` is called.
- profile-form: "falls back to its own message when the error body cannot be read" fails with `Network error. Please try again.`. The unguarded `res.json()` throws into the outer catch.
- profile-setup-form: the new unchanged test already passes, because it checks `res.ok`. It is a regression pin, not a driver.

With the worktree app up (`pnpm run worktree:up`), run: `pnpm exec vitest run --project integration tests/integration/student-profile-ticket.test.ts tests/integration/teacher-signup-api.test.ts tests/integration/teacher-profile-precedence.test.ts`
Expected: FAIL.
- The new teacher-signup `ACCOUNT_EXISTS` test gets `code: 'ALREADY_TEACHER'`.
- The identical-resubmit test and the precedence test get status 409 where 200 is expected.
- The student-profile ordering test passes today and pins the order the change must keep.

- [ ] **Step 5: Retire `ALREADY_STUDENT`**

In `src/lib/api-error-codes.ts`, delete the line `  ALREADY_STUDENT: 409,`.

Run: `pnpm run typecheck`
Expected: errors at `src/app/api/account/student-profile/route.ts` (three `'ALREADY_STUDENT'` arguments, `not assignable to parameter of type ApiErrorCode`) and at `src/components/account/set-up-student-side.tsx:33` (`This comparison appears to be unintentional because the types '"ACCOUNT_EXISTS" | …' and '"ALREADY_STUDENT"' have no overlap`). Steps 6 and 10 remove both.

- [ ] **Step 6: `POST /api/account/student-profile` answers `unchanged`**

Replace `src/app/api/account/student-profile/route.ts` with the file below. The existing handler docblock is kept verbatim. The route's `NO_PROFILE_SOURCE` guard, CRM-claim path, ticket-path `ACCOUNT_EXISTS` and success tail are unchanged.

```ts
import { NextRequest, type NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { respondOk, respondError, respondUnchanged, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { studentProfileSchema } from '@/lib/schemas';
import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import {
  clearSignupTicketCookie,
  createSession,
  setSessionCookie,
  resolveTicketOnlyProfileAuthorization,
  clearDeclinedTicketCookie,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { liveProfile } from '@/lib/live-profile';
import { log } from '@/lib/log';

/**
 * The answer to a join whose goal already holds: this account's live student
 * side, named the way a first join names the one it creates. The session
 * path posts nothing a stored row could differ from, because its names come
 * from the teacher row, so there is no value to compare.
 */
function studentSideExists(studentId: string): NextResponse {
  return respondUnchanged<{ studentId: string }>({ studentId });
}

/**
 * The account's live student side, or null. `liveProfile` decides liveness;
 * the `where` only bounds the fetch.
 */
async function liveStudentIdOf(accountId: string): Promise<string | null> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      students: { where: { deletedAt: null }, select: { id: true, deletedAt: true } },
    },
  });
  return liveProfile(account.students)?.id ?? null;
}

/**
 * Creates the student profile (#399). Two authorizations, one route: the
 * signup ticket (new booking-page signup, no account yet) or a live session
 * (an existing account adding the student hat — "join as a student", the
 * mirror of `teacher-profile`'s ticket+session shape).
 * `resolveTicketOnlyProfileAuthorization` applies the resolver's shared
 * ticket-vs-session precedence rule (#428) — see `profile-authorization.ts`.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const outcome = await resolveTicketOnlyProfileAuthorization(
    prisma,
    request,
    'student',
    studentProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const authorization = outcome.auth;

  type Authorization =
    | { source: 'ticket'; email: string; firstName: string; lastName: string }
    | { source: 'session'; accountId: string; email: string; firstName: string; lastName: string };
  let auth: Authorization;
  if (authorization.source === 'ticket') {
    auth = {
      source: 'ticket',
      email: authorization.email,
      firstName: authorization.body.firstName,
      lastName: authorization.body.lastName,
    };
  } else {
    const session = authorization.session;
    // After authorization, which is this route's ownership gate:
    // `session.studentId` is the caller's own live student side.
    if (session.studentId) {
      return clearDeclinedTicketCookie(studentSideExists(session.studentId), authorization);
    }
    // A guard whose response is unreachable and whose CHECK is not: this is
    // the narrowing that gives the teacher lookup below a `string` id, and
    // deleting it fails the build. `SessionUser` makes "neither profile"
    // unrepresentable, but narrowing on `studentId`'s truthiness cannot rule
    // out `""`, so the compiler still admits a null `teacherId` here. The 409
    // is what an invariant violation would answer, not a state a caller can
    // reach — which is also why it has no test.
    if (!session.teacherId) {
      return clearDeclinedTicketCookie(
        respondError('Account has no profile to copy from', 409, 'NO_PROFILE_SOURCE'),
        authorization,
      );
    }
    const teacher = await prisma.teacher.findUniqueOrThrow({
      where: { id: session.teacherId },
      select: { firstName: true, lastName: true },
    });

    // A teacher may already exist in someone's CRM as an unclaimed contact
    // under this email — claiming that row keeps their history instead of
    // colliding with its unique email.
    const unclaimed = await prisma.student.findFirst({
      where: { email: authorization.email, claimedAt: null },
      select: { id: true },
    });

    // Scalar accountId, not a relation connect: Prisma splits nested
    // connects into two statements, and the claim/link CHECK constraint
    // requires both fields to change in one.
    if (unclaimed) {
      const student = await prisma.student.update({
        where: { id: unclaimed.id },
        data: { claimedAt: new Date(), accountId: session.accountId },
        select: { id: true },
      });
      return clearDeclinedTicketCookie(respondOk({ studentId: student.id }, 201), authorization);
    }

    auth = {
      source: 'session',
      accountId: session.accountId,
      email: authorization.email,
      firstName: teacher.firstName,
      lastName: teacher.lastName,
    };
  }

  // `session.studentId` above is the pre-check, and it is a plain read, so a
  // second tap of this button passes it and one of the two loses here. The
  // loser answers as the pre-check would: `unchanged`, naming the student
  // side the winner created (#161).
  //
  // On the SESSION path, a double-tap writes the same `accountId` AND the
  // same `email`, so both indexes have a pending entry and Postgres reports
  // whichever it reaches first. The catch below treats either as the same
  // case and re-reads the account's live student side. Under the live-only
  // `Student_account_live_unique`, and with erasure rewriting an erased
  // row's address, either collision means that side exists. Answering it is
  // not an enumeration oracle: the route is authenticated and writes for the
  // caller's own account, and `Account.email @unique` means no other account
  // holds this address.
  //
  // The TICKET path has no session and no "caller's own account". Its
  // `email` collision means a DIFFERENT account appeared for this address
  // during the ticket's one-hour window (a real, if narrow, race — not a
  // double-tap), so the catch below answers it separately, with its own
  // code and a log line. Its `accountId` cannot collide: the account is
  // created in the same statement.
  //
  // Only the `create` is inside: every branch of the catch below names a
  // unique constraint or partial unique index on the student row, so a
  // failure from the session mint that followed would be reported as a
  // collision that never happened.
  let student;
  try {
    student = await prisma.student.create({
      data: {
        firstName: auth.firstName,
        lastName: auth.lastName,
        email: auth.email,
        incomeTier: DEFAULT_INCOME_TIER,
        claimedAt: new Date(),
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session' ? { accountId: auth.accountId } : { account: { create: { email: auth.email } } }),
      },
      select: { id: true, accountId: true },
    });
  } catch (err) {
    if (
      auth.source === 'session' &&
      (isUniqueConflictOn(err, ['accountId']) || isUniqueConflictOn(err, ['email']))
    ) {
      const studentId = await liveStudentIdOf(auth.accountId);
      if (studentId === null) {
        log.error(
          { err, route: 'student-profile' },
          'student profile create collided on its own account key, but the account holds no live student side',
        );
        throw new Error('student profile create: account key collision with no live student side');
      }
      return clearDeclinedTicketCookie(studentSideExists(studentId), authorization);
    }
    if (auth.source === 'ticket' && isUniqueConflictOn(err, ['email'])) {
      // Not the caller's own account — see the comment above this block.
      // Worth a log line: unlike the session path's double-tap, this is
      // not the benign, expected shape of this collision.
      log.warn(
        { route: 'student-profile' },
        'student profile ticket path lost to an email that gained an account during the ticket window',
      );
      return respondError(
        'This email now has an account. Please sign in and add a student profile.',
        409,
        'ACCOUNT_EXISTS',
      );
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // generic conflict, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // `error`, not `warn` as in api-errors.ts's generic P2002 fallback:
      // this route's census of reachable unique keys is exhaustive, so an
      // unrecognised P2002 here means schema drift or a bug, not an
      // ordinary lost race.
      log.error(
        { err, rawTarget: err.meta?.target },
        'student profile create hit a unique constraint its authorization path cannot reach',
      );
      throw new Error('student profile create: unrecognised unique constraint');
    }
    throw err;
  }

  const response = respondOk({ studentId: student.id }, 201);
  if (auth.source === 'ticket') {
    // `accountId` types as nullable — the column predates #166 and stays
    // nullable for those rows — but the create's own nested
    // `account: { create }` just set it, so a null here means that statement
    // silently produced a different row than this one.
    if (!student.accountId) {
      throw new Error('student profile create: ticket-authorized row has no accountId');
    }
    const sessionToken = await createSession(prisma, student.accountId);
    setSessionCookie(response.headers, sessionToken);
    clearSignupTicketCookie(response.headers);
  }
  return clearDeclinedTicketCookie(response, authorization);
});
```

- [ ] **Step 7: `POST /api/account/teacher-profile` compares values; the ticket path answers `ACCOUNT_EXISTS`**

In `src/lib/schemas.ts`, insert this directly after `pageSlugField` (ends `:197`):

```ts
/**
 * The refusal for a page slug another teacher holds. Worded with the label
 * the settings form shows for this field.
 */
export const PAGE_SLUG_TAKEN_MESSAGE = 'That page slug is already taken.';
```

Replace `src/app/api/account/teacher-profile/route.ts` with the file below.

**How the request's values are normalised before they are compared:**
- `firstName` and `lastName` are trimmed by `teacherProfileSchema`, and the create stores them trimmed.
- `bio` is required and stored exactly as sent. The signup form trims it before sending.
- `pageSlug` is validated and not transformed.
- `defaultTimezone` is optional, and an unrecognised zone parses to `undefined`. The value compared is the one the create writes: the parsed zone, or `'Europe/Amsterdam'` when there is none.

`RequestedProfile` is that normalised shape. The create writes it, and the comparison reads it, so the two cannot disagree.

```ts
import { NextRequest, type NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { respondOk, respondError, respondUnchanged, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { teacherProfileSchema, PAGE_SLUG_TAKEN_MESSAGE } from '@/lib/schemas';
import {
  mintSignupTicket,
  clearSignupTicketCookie,
  setSignupTicketCookie,
  createSession,
  setSessionCookie,
  resolveProfileAuthorization,
  clearDeclinedTicketCookie,
} from '@/lib/auth';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { liveProfile } from '@/lib/live-profile';
import { log } from '@/lib/log';

/**
 * What a request asks the teacher row to hold: the parsed body with the
 * route's timezone default applied. The create writes exactly this, and the
 * unchanged check compares exactly this.
 */
type RequestedProfile = Omit<z.infer<typeof teacherProfileSchema>, 'defaultTimezone'> & {
  defaultTimezone: string;
};

/**
 * The columns a live teacher side must already hold for a request to be one
 * that already happened. Keyed by the request's own fields, so a field added
 * to `teacherProfileSchema` fails to compile here until it is compared too.
 */
const COMPARED_COLUMNS = {
  firstName: true,
  lastName: true,
  bio: true,
  pageSlug: true,
  defaultTimezone: true,
} as const satisfies Record<keyof RequestedProfile, true>;

const COMPARED_FIELDS = Object.keys(COMPARED_COLUMNS) as Array<keyof RequestedProfile>;

/**
 * The answer for an account that already holds a live teacher side:
 * `unchanged` when that side holds exactly what this request asks for,
 * `ALREADY_TEACHER` when it holds anything else, and null when the account
 * holds no live teacher side. `liveProfile` decides liveness; the `where`
 * only bounds the fetch.
 */
async function answerForLiveTeacher(
  accountId: string,
  requested: RequestedProfile,
): Promise<NextResponse | null> {
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      teachers: {
        where: { deletedAt: null },
        select: { id: true, deletedAt: true, ...COMPARED_COLUMNS },
      },
    },
  });
  const live = liveProfile(account.teachers);
  if (!live) return null;
  if (COMPARED_FIELDS.every((field) => live[field] === requested[field])) {
    return respondUnchanged<{ teacherId: string }>({ teacherId: live.id });
  }
  return respondError(
    'You already have a teacher page. Edit it in Settings.',
    409,
    'ALREADY_TEACHER',
  );
}

/** A unique key a session-path create can collide on. */
function isSessionCollision(err: unknown): boolean {
  return (
    isUniqueConflictOn(err, ['accountId']) ||
    isUniqueConflictOn(err, ['email']) ||
    isUniqueConflictOn(err, ['pageSlug'])
  );
}

/**
 * Creates the teacher profile (#385). Two authorizations, one route: the
 * signup ticket (new signup, no account yet) or a live session (an existing
 * account adding the teacher hat — the mirror of `student-profile`'s "join
 * as a student"). `resolveProfileAuthorization` applies the resolver's
 * shared ticket-vs-session precedence rule (#428) — see
 * `profile-authorization.ts`.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const outcome = await resolveProfileAuthorization(
    prisma,
    request,
    'teacher',
    teacherProfileSchema,
  );
  if (!outcome.ok) return outcome.response;
  const auth = outcome.auth;
  const requested: RequestedProfile = {
    ...auth.body,
    // Falls back to Amsterdam only when the browser couldn't report one
    // (#258) — never an unconditional overwrite of what the schema carries
    // through from detection. A resubmit from a browser that still reports
    // no zone therefore matches the row it created.
    defaultTimezone: auth.body.defaultTimezone ?? 'Europe/Amsterdam',
  };

  // After authorization, which is this route's ownership gate: the only
  // teacher side this can read is the caller's own.
  if (auth.source === 'session' && auth.session.teacherId) {
    const answer = await answerForLiveTeacher(auth.session.accountId, requested);
    if (answer) return clearDeclinedTicketCookie(answer, auth);
  }

  // Only the `create` is inside: every branch of the catch below names a
  // unique constraint or partial unique index on the teacher row, so a
  // failure from the session mint that followed would be reported as a
  // collision that never happened.
  let teacher;
  try {
    teacher = await prisma.teacher.create({
      data: {
        ...requested,
        email: auth.email,
        defaultCurrency: 'EUR',
        // A ticket has no account yet; a session has one already.
        ...(auth.source === 'session'
          ? { accountId: auth.session.accountId }
          : { account: { create: { email: auth.email } } }),
      },
    });
  } catch (err) {
    if (auth.source === 'session' && isSessionCollision(err)) {
      // A session-path twin writes this account's `accountId`, its address
      // and the same slug, and Postgres reports whichever index it reaches
      // first. So every one of these re-reads the account and answers as the
      // pre-check does. Only a slug collision can find no teacher side there,
      // and then the slug belongs to another teacher.
      const answer = await answerForLiveTeacher(auth.session.accountId, requested);
      if (answer) return clearDeclinedTicketCookie(answer, auth);
      if (isUniqueConflictOn(err, ['pageSlug'])) {
        return clearDeclinedTicketCookie(
          respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN'),
          auth,
        );
      }
      log.error(
        { err, route: 'teacher-profile' },
        'teacher profile create collided on its own account key, but the account holds no live teacher side',
      );
      throw new Error('teacher profile create: account key collision with no live teacher side');
    }
    if (auth.source === 'ticket' && isUniqueConflictOn(err, ['pageSlug'])) {
      const conflict = respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
      // The ticket that got us here is already spent (single-use, consumed
      // above) — without a fresh one the client's cookie now names a dead
      // token, and a retry (even with a different slug) falls through to
      // `requireSession` and 401s. Safe to re-mint: `auth.source === 'ticket'`
      // only holds because THIS request already consumed a ticket proving
      // ownership of it, so minting another proves nothing new.
      const freshTicket = await mintSignupTicket(prisma, auth.email, 'teacher');
      setSignupTicketCookie(conflict.headers, freshTicket);
      return clearDeclinedTicketCookie(conflict, auth);
    }
    if (auth.source === 'ticket' && isUniqueConflictOn(err, ['email'])) {
      // The ticket path creates the account in this same statement, so its
      // address colliding means another account appeared for it during the
      // ticket's window. That account may have no teacher side at all.
      log.warn(
        { route: 'teacher-profile' },
        'teacher profile ticket path lost to an email that gained an account during the ticket window',
      );
      return clearDeclinedTicketCookie(
        respondError(
          'This email now has an account. Please sign in and add a teacher profile.',
          409,
          'ACCOUNT_EXISTS',
        ),
        auth,
      );
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // generic conflict, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher profile create hit a unique constraint its authorization path cannot reach',
      );
      throw new Error('teacher profile create: unrecognised unique constraint');
    }
    throw err;
  }

  const response = respondOk({ teacherId: teacher.id }, 201);
  if (auth.source === 'ticket') {
    const sessionToken = await createSession(prisma, teacher.accountId);
    setSessionCookie(response.headers, sessionToken);
    clearSignupTicketCookie(response.headers);
  }
  return clearDeclinedTicketCookie(response, auth);
});
```

If `tsc` rejects `live[field]`, Prisma did not carry the spread's literal `true`s into the payload type. In that case write the five columns out in the nested `select` (`firstName: true, lastName: true, bio: true, pageSlug: true, defaultTimezone: true`) and leave the rest alone. `live[field]` then still fails to compile for any compared field the select lacks.

- [ ] **Step 8: `PUT /api/teachers/[id]` — one slug message, and the race catch**

In `src/app/api/teachers/[id]/route.ts`, replace the imports (`:1-11`) with:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateTeacherSchema, PAGE_SLUG_TAKEN_MESSAGE } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
```

Replace `:47-66`:

```ts
  // Check for pageSlug conflicts
  if (updateData.pageSlug) {
    const existing = await prisma.teacher.findUnique({
      where: { pageSlug: updateData.pageSlug },
    });
    if (existing && existing.id !== id) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
  }

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const teacher = await prisma.teacher.update({
    where: { id },
    data: updateData,
  });

  return respondOk(teacher);
```

with:

```ts
  // A plain read, so a slug another teacher claims after it reaches the
  // update below instead, whose catch gives the same answer.
  if (updateData.pageSlug) {
    const existing = await prisma.teacher.findUnique({
      where: { pageSlug: updateData.pageSlug },
    });
    if (existing && existing.id !== id) {
      return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
    }
  }

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  let teacher;
  try {
    teacher = await prisma.teacher.update({
      where: { id },
      data: updateData,
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
    }
    throw err;
  }

  return respondOk(teacher);
```

- [ ] **Step 9: Sign-in copy**

`src/app/api/auth/magic-link/verify/route.ts:48`:

```ts
    return respondError('Invalid or expired magic link', MAGIC_LINK_REFUSED_STATUS);
```
→
```ts
    return respondError('This sign-in link has expired or was already used.', MAGIC_LINK_REFUSED_STATUS);
```

`src/app/api/auth/passkey/authenticate/verify/route.ts:22`:

```ts
    return respondError('Invalid or expired challenge', 400);
```
→
```ts
    return respondError('This sign-in attempt expired. Please try again.', 400);
```

Neither route's client reads the body: `verify/page.tsx:626-634` throws on `!res.ok`, and `passkey-sign-in.tsx:41-50` does the same. No client changes.

- [ ] **Step 10: Rewrite the existing server tests this change breaks**

1. `tests/integration/account-api.test.ts:3`: add `import { expectUnchanged } from '../api-assertions';` after the helpers import.

2. `tests/integration/account-api.test.ts:84-90`. Old:
   ```ts
     it('rejects a second join with a machine-readable 409', async () => {
       const res = await authed('/api/account/student-profile', { method: 'POST' });

       expect(res.status).toBe(409);
       const body = (await res.json()) as { error: { code?: string } };
       expect(body.error.code).toBe('ALREADY_STUDENT');
     });
   ```
   New:
   ```ts
     it('answers a second join unchanged, naming the side it already has, and writes nothing', async () => {
       const select = { claimedAt: true, updatedAt: true } as const;
       const before = await prisma.student.findUniqueOrThrow({ where: { id: unclaimedStudentId }, select });
       const sessionsBefore = await prisma.session.count({ where: { accountId } });

       const res = await authed('/api/account/student-profile', { method: 'POST' });

       expect(await expectUnchanged(res)).toEqual({ studentId: unclaimedStudentId });
       expect(await prisma.student.count({ where: { email } })).toBe(1);
       expect(
         await prisma.student.findUniqueOrThrow({ where: { id: unclaimedStudentId }, select }),
       ).toEqual(before);
       expect(await prisma.session.count({ where: { accountId } })).toBe(sessionsBefore);
     });
   ```
   Also update the file docblock at `:12-13`: `the double-join 409` → `the double-join unchanged answer`.

3. `tests/integration/account-api.test.ts:918-936` (the docblock above the race describe). Replace its first paragraph:
   ```ts
    * `session.studentId` is the pre-check, so two concurrent "join as a student"
    * requests both read a session with no student profile, both find no
    * unclaimed row to claim, and both reach the create; the loser collides.
    * Unhandled, that `P2002` answers 409 with NO `code`, so the client cannot
    * tell it apart from any other conflict (#161).
   ```
   with:
   ```ts
    * `session.studentId` is the pre-check, so two concurrent "join as a student"
    * requests both read a session with no student profile, both find no
    * unclaimed row to claim, and both reach the create; the loser collides.
    * It answers as the pre-check would: 200 `unchanged`, naming the student
    * side the winner created (#161, #197).
   ```
   Leave the remaining paragraphs as they are.

4. `tests/integration/account-api.test.ts:937` and `:967`. The describe title `'POST /api/account/student-profile answers a raced join with ALREADY_STUDENT (#161)'` becomes `'POST /api/account/student-profile answers a raced join unchanged (#161, #197)'`. The test title `'returns 409 ALREADY_STUDENT when the create loses to a concurrent join'` becomes `'answers unchanged, naming the winner, when the create loses to a concurrent join'`.

5. `tests/integration/account-api.test.ts:968-986`. Capture the holder's id. Add `let holderStudentId = '';` after `const released = …` (`:971`), and change the holder's create (`:976-983`) from `await tx.student.create({ data: { … } });` to:
   ```ts
           const holderRow = await tx.student.create({
             data: {
               firstName: 'Holder',
               lastName: 'Join',
               email: raceEmail,
               claimedAt: new Date(),
               accountId: raceAccountId,
             },
             select: { id: true },
           });
           holderStudentId = holderRow.id;
   ```
   In the comment at `:997-999`, change `a fast answer means the request 409'd off its own pre-check` to `a fast answer means the request answered off its own pre-check`.

6. `tests/integration/account-api.test.ts:1009-1012`. Old:
   ```ts
       expect(res.status).toBe(409);
       const body = (await res.json()) as { error: { code?: string; message: string } };
       expect(body.error.code).toBe('ALREADY_STUDENT');
       expect(body.error.message).toBe('Account already has a student profile');
   ```
   New:
   ```ts
       expect(await expectUnchanged(res)).toEqual({ studentId: holderStudentId });
   ```

7. `tests/integration/erased-profile-restart.test.ts:4`: add `import { expectUnchanged } from '../api-assertions';`. Replace `:142-171` (`it('still answers ALREADY_STUDENT when the student side is genuinely live', …)`) with:
   ```ts
     it('answers unchanged, naming the live student side, when one genuinely exists beside an erased one', async () => {
       const acct = await account('already-live');
       await liveTeacher(acct, 'already-live-teacher');
       await erasedStudent(acct.id, 'already-live');
       const live = await prisma.student.create({
         data: {
           accountId: acct.id,
           firstName: 'Already', lastName: 'Live',
           email: acct.email,
           claimedAt: new Date(),
         },
         select: { id: true },
       });
       const token = await seedSession(prisma, acct.id);

       const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
         method: 'POST',
         headers: { ...cookie(token), ...freshIp() },
       });

       // This exercises the route's PRE-CHECK (`if (session.studentId)`), which
       // returns before the create is attempted — not the catch. The id it
       // names is the live side's; the erased one beside it is not a student
       // side this account has. The proof that
       // `isUniqueConflictOn(err, ['accountId'])` still matches over a PARTIAL
       // index is in `tests/integration/live-profile-unique.test.ts`, which
       // asserts that predicate on a real violation.
       expect(await expectUnchanged(res)).toEqual({ studentId: live.id });
       expect(
         await prisma.student.count({ where: { accountId: acct.id, deletedAt: null } }),
       ).toBe(1);
     });
   ```

8. `tests/integration/student-profile-ticket.test.ts:79-110`. Rename the test `'clears the declined ticket cookie on ALREADY_STUDENT, as the success paths do'` to `'clears the declined ticket cookie on an unchanged join, as the success paths do'`. In its fixture (`:85-91`), change `select: { accountId: true }` to `select: { id: true, accountId: true }`. Replace `:108` (`expect(res.status).toBe(409);`) with:
   ```ts
       expect(await expectUnchanged(res)).toEqual({ studentId: student.id });
   ```
   Keep `:109` (the cookie assertion).

9. `tests/integration/student-profile-ticket.test.ts:198-208`. Rename `'answers ACCOUNT_EXISTS, not the generic ALREADY_STUDENT, when an account claims the address during the ticket window'` to `'answers ACCOUNT_EXISTS when an account claims the address during the ticket window'`. Replace `:204-207`:
   ```ts
       expect(res.status).toBe(409);
       const body = await res.json();
       expect(body.error.code).toBe('ACCOUNT_EXISTS');
       expect(body.error.code).not.toBe('ALREADY_STUDENT');
   ```
   with:
   ```ts
       await expectRefusal(res, 'ACCOUNT_EXISTS');
   ```
   The import line from Step 1 must name both helpers: `import { expectRefusal, expectUnchanged } from '../api-assertions';`.

10. `tests/integration/teachers-api.test.ts:3`: add `import { expectRefusal } from '../api-assertions';`. Replace `:121-135`:
    ```ts
      it("rejects claiming another teacher's page slug with the SLUG_TAKEN code", async () => {
        const res = await putTeacher(
          teacherId,
          { pageSlug: `settings-other-${suffix}` },
          teacherToken,
        );
        expect(res.status).toBe(409);
        // The code pins the deliberate pre-check: the P2002 fallback also
        // returns 409, but without SLUG_TAKEN the settings form can't render
        // its inline error.
        const json = (await res.json()) as { error: { code?: string } };
        expect(json.error.code).toBe('SLUG_TAKEN');
      });
    ```
    with:
    ```ts
      it("rejects claiming another teacher's page slug with the SLUG_TAKEN code", async () => {
        const res = await putTeacher(
          teacherId,
          { pageSlug: `settings-other-${suffix}` },
          teacherToken,
        );
        // The pre-check's answer. A slug claimed after that read reaches the
        // update's own catch, which answers the same code
        // (`src/app/api/teachers/[id]/route-lock-order.test.ts`).
        await expectRefusal(res, 'SLUG_TAKEN');
      });
    ```

11. `tests/integration/passkey-api.test.ts:8-14`. In the docblock, replace `A bogus challengeId also yields 400, so each assertion checks the error text to pin *which* rejection fired.` with `A bogus challengeId also yields 400, so each assertion pins *which* rejection fired: a validation 400 names the failing field first (`parseBody`), and the challenge refusal is an uncoded 400 that names none.`

12. `tests/integration/passkey-api.test.ts:35-39`. Old:
    ```ts
      it('a safe redirect passes validation and fails only on the challenge', async () => {
        const res = await post({ response: {}, challengeId: 'x', redirect: '/somewhere' });
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('challenge');
      });
    ```
    New:
    ```ts
      it('a safe redirect passes validation and fails only on the challenge', async () => {
        const res = await post({ response: {}, challengeId: 'x', redirect: '/somewhere' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string; code?: string } };
        expect(body.error.message).not.toMatch(/^redirect:/);
        expect(body.error.code).toBeUndefined();
      });
    ```

`tests/integration/teacher-signup-api.test.ts:959-980` and `tests/integration/teacher-profile-precedence.test.ts:81-103` send values that differ from their fixtures, so both still answer 409 `ALREADY_TEACHER` and are left as they are.

- [ ] **Step 11: Clients**

1. **`src/components/account/set-up-student-side.tsx`.** Change `:6` to `import { readErrorMessage } from '@/lib/client-errors';`, and replace `:20-38`:
   ```tsx
         if (!res.ok) {
           // Only `ALREADY_STUDENT` means the student side is already there, and
           // …
           const { code, message } = await readError(
             res,
             'Could not set up your student side. Try again.',
           );
           if (!(res.status === 409 && code === 'ALREADY_STUDENT')) {
             setMessage(message);
             setState('error');
             return;
           }
         }
   ```
   with:
   ```tsx
         // A student side that already exists answers 200 `unchanged`, so every
         // non-2xx here is a refusal, a 409 included.
         if (!res.ok) {
           setMessage(await readErrorMessage(res, 'Could not set up your student side. Try again.'));
           setState('error');
           return;
         }
   ```

   Its test `src/components/account/set-up-student-side.test.tsx`: replace `:20-31` (`it('treats a student side that already exists as done', …)`, which mocks the retired `ALREADY_STUDENT` 409) with:
   ```tsx
     it('treats a student side that already exists as done', async () => {
       vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
         ok: true,
         status: 200,
         json: async () => ({ data: { studentId: 's-1' }, outcome: 'unchanged' }),
       }));
       render(<SetUpStudentSide />);

       fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

       await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
     });
   ```
   Replace `:33-50` (the comment and `it('does not claim success for a 409 that is not ALREADY_STUDENT', …)`) with:
   ```tsx
     // A student side that already exists is a 200, so no 409 is a disguised
     // success. Treating one as success navigated to a page this account cannot
     // open, which bounced it to the schedule saying nothing.
     it('does not claim success for any 409', async () => {
       vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
         ok: false,
         status: 409,
         json: async () => ({
           error: { code: 'UNIQUE_CONFLICT', message: 'That already exists. Refresh to see the latest.' },
         }),
       }));
       render(<SetUpStudentSide />);

       fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

       expect(await screen.findByRole('alert')).toHaveTextContent(/That already exists/);
       expect(routerPush).not.toHaveBeenCalled();
     });
   ```

2. **`src/components/booking/join-as-student.tsx:22-30`.** Old:
   ```tsx
         const res = await fetch('/api/account/student-profile', { method: 'POST' });
         // 409 ALREADY_STUDENT means the profile exists (double tap, earlier
         // half-finished attempt) — that is success from where the user sits.
         if (!res.ok && res.status !== 409) {
   ```
   New:
   ```tsx
         const res = await fetch('/api/account/student-profile', { method: 'POST' });
         // A student side that already exists (double tap, earlier half-finished
         // attempt) answers 200 `unchanged`, so `res.ok` is the whole test.
         if (!res.ok) {
   ```
   Its test is the new file from Step 3.

3. **`src/components/signup/profile-setup-form.tsx`.** After the `AlreadyTeachingPanel` import (`:11`), add:
   ```tsx
   import { readError } from '@/lib/client-errors';
   import { TEACHER_PROFILE_PATH } from '@/lib/schemas';
   ```
   `@/lib/schemas` is already in this bundle through `page-address-field.tsx`'s `pageSlugField`.

   Change `:122`:
   ```tsx
   type Status = 'idle' | 'submitting' | 'expired' | 'expired-stuck' | 'already-teacher';
   ```
   to:
   ```tsx
   type Status =
     | 'idle'
     | 'submitting'
     | 'expired'
     | 'expired-stuck'
     | 'already-teacher'
     | 'account-exists';
   ```

   Delete `:266-268`:
   ```tsx
       const body: { error?: { code?: string; message?: string } } = await res
         .json()
         .catch(() => ({}));
   ```

   Replace `:294-313`, from `// Terminal: this address already has a page…` through the closing `}` of the `SLUG_TAKEN` else, with:
   ```tsx
       const { code, message } = await readError(res, 'Something went wrong. Please try again.');

       // Terminal: this account already has a teacher page, and this form
       // would make a second one.
       if (code === 'ALREADY_TEACHER') {
         forgetDraft();
         setStatus('already-teacher');
         return;
       }

       // Terminal for this ticket, not for the draft: the address has an account
       // now, and signing in with it brings the same address back to this page,
       // where the draft is restored.
       if (code === 'ACCOUNT_EXISTS') {
         setStatus('account-exists');
         return;
       }

       setStatus('idle');
       if (code === 'SLUG_TAKEN') {
         // The route already replaced the ticket it spent on this request, so the
         // retry this message asks for is a plain resubmit. Stamped with the
         // address it is about, so editing a name out from under it retires it.
         setSlugRejection({
           slug: form.pageSlug.trim(),
           message: 'That address is taken — please pick another.',
         });
       } else {
         setFormError(message);
       }
   ```

   Replace `:316-332` (the `already-teacher` render) with:
   ```tsx
     if (status === 'already-teacher') {
       return <AlreadyTeachingPanel email={email} />;
     }

     if (status === 'account-exists') {
       return (
         <div className="py-4">
           <p className="type-subtitle">You already have an account</p>
           <p className="type-body mt-2 max-w-[420px]">
             There is already an account for {email}.{' '}
             <Link
               href={`/login?redirect=${encodeURIComponent(TEACHER_PROFILE_PATH)}`}
               className="text-teal"
             >
               Sign in
             </Link>{' '}
             to add a teacher page to it.
           </p>
         </div>
       );
     }
   ```

   Its test `src/components/signup/profile-setup-form.test.tsx`: replace `:124-142` (`it('shows the terminal ALREADY_TEACHER state and clears the draft', …)`, a ticket-mode `ALREADY_TEACHER` the server no longer sends) with:
   ```tsx
     it('shows the ACCOUNT_EXISTS state in ticket mode, signing in back to this page, and keeps the draft', async () => {
       stubFetch(() => ({
         ok: false,
         status: 409,
         json: async () => ({
           error: {
             code: 'ACCOUNT_EXISTS',
             message: 'This email now has an account. Please sign in and add a teacher profile.',
           },
         }),
       }));
       render(<ProfileSetupForm email="anna@example.com" mode="ticket" />);

       fillForm();
       fireEvent.click(screen.getByRole('button', { name: 'Create my page' }));

       expect(await screen.findByText('You already have an account')).toBeInTheDocument();
       expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
         'href',
         '/login?redirect=%2Fsignup%2Fprofile',
       );
       expect(window.localStorage.getItem(DRAFT_KEY)).not.toBeNull();
     });
   ```
   At `:193`, change the mocked message `'Page address already in use'` to `'That page slug is already taken.'`, which is the body the server now sends. The assertion at `:200` still reads the form's own sentence. `it('shows the ALREADY_TEACHER state with a schedule link and sign-out in session mode')` (`:144-187`) stays as it is.

4. **`src/components/settings/profile-form.tsx`.** Add `import { readErrorMessage } from '@/lib/client-errors';` after the `Button` import (`:7`). Replace `:122-126`:
   ```tsx
         if (!res.ok) {
           const json: { error?: { message?: string } } = await res.json();
           setError(json.error?.message ?? 'Failed to save');
           return;
         }
   ```
   with:
   ```tsx
         if (!res.ok) {
           setError(await readErrorMessage(res, 'Failed to save'));
           return;
         }
   ```
   Its test is the new file from Step 3. The form shows `SLUG_TAKEN`'s message verbatim, and that message uses this form's own field label ("Page slug", `:174`).

5. **`src/components/booking/booking-name-step.tsx`: no change.** It is the ticket-path caller. A ticket-path repeat cannot answer `unchanged`, because the ticket is spent and the retry 401s. `ACCOUNT_EXISTS` already renders through its `readErrorMessage` fallback (`:119-120`).

- [ ] **Step 12: Run everything green**

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

Run: `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts`
Expected: PASS. The two new markers and the two new list entries agree.

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/account/teacher-profile/route-lock-order.test.ts 'src/app/api/teachers/[id]/route-lock-order.test.ts'`
Expected: PASS (4 tests).

Run: `pnpm exec vitest run --project components src/components/account/set-up-student-side.test.tsx src/components/booking/join-as-student.test.tsx src/components/signup/profile-setup-form.test.tsx src/components/settings/profile-form.test.tsx src/components/booking/booking-name-step.test.tsx`
Expected: PASS.

With the worktree app up, run: `pnpm exec vitest run --project integration tests/integration/account-api.test.ts tests/integration/erased-profile-restart.test.ts tests/integration/student-profile-ticket.test.ts tests/integration/teacher-signup-api.test.ts tests/integration/teacher-profile-precedence.test.ts tests/integration/teachers-api.test.ts tests/integration/passkey-api.test.ts tests/integration/live-profile-unique.test.ts tests/integration/student-signup-verify.test.ts`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/lib/api-error-codes.ts src/lib/schemas.ts vitest.tiers.ts src/app/api/account/student-profile/route.ts src/app/api/account/teacher-profile/route.ts src/app/api/account/teacher-profile/route-lock-order.test.ts "src/app/api/teachers/[id]/route.ts" "src/app/api/teachers/[id]/route-lock-order.test.ts" src/app/api/auth/magic-link/verify/route.ts src/app/api/auth/passkey/authenticate/verify/route.ts src/components/account/set-up-student-side.tsx src/components/account/set-up-student-side.test.tsx src/components/booking/join-as-student.tsx src/components/booking/join-as-student.test.tsx src/components/signup/profile-setup-form.tsx src/components/signup/profile-setup-form.test.tsx src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx tests/integration/account-api.test.ts tests/integration/erased-profile-restart.test.ts tests/integration/student-profile-ticket.test.ts tests/integration/teacher-signup-api.test.ts tests/integration/teacher-profile-precedence.test.ts tests/integration/teachers-api.test.ts tests/integration/passkey-api.test.ts
git commit -m "fix(api): an existing profile answers unchanged; ACCOUNT_EXISTS on the teacher ticket path; one slug message (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 14: Prove the guards bite**

For each mutation: apply it; for a route, send one request to that route first; run the named command and record the exact failure; restore with `git checkout -- <path>`; re-run it green. The integration runs need the worktree app up.

1. **Student pre-check.** In `src/app/api/account/student-profile/route.ts`, change the pre-check's `studentSideExists(session.studentId)` to `respondOk({ studentId: session.studentId }, 201)`. Run `pnpm exec vitest run --project integration tests/integration/account-api.test.ts tests/integration/erased-profile-restart.test.ts tests/integration/student-profile-ticket.test.ts`. The unchanged tests fail with `{ status: 201, outcome: undefined }`.
2. **Student catch re-read.** In the same file, change `const studentId = await liveStudentIdOf(auth.accountId);` to `const studentId: string | null = null;`. Run `tests/integration/account-api.test.ts`. The race test fails with status 500.
3. **Student ticket-path ordering.** In the same file, insert at the top of the `auth.source === 'ticket' && isUniqueConflictOn(err, ['email'])` branch:
   ```ts
   const holder = await prisma.student.findUnique({ where: { email: auth.email }, select: { id: true } });
   if (holder) return studentSideExists(holder.id);
   ```
   Run `tests/integration/student-profile-ticket.test.ts`. "answers ACCOUNT_EXISTS, not unchanged, when the account that took the address already has a student side" fails with status 200.
4. **Teacher value comparison.** In `src/app/api/account/teacher-profile/route.ts`, change `COMPARED_FIELDS.every((field) => live[field] === requested[field])` to `true`. Run `pnpm exec vitest run --project integration tests/integration/teacher-signup-api.test.ts`; "refuses a resubmit whose bio differs" and "treats a different detected timezone" fail with status 200. Run `pnpm exec vitest run --project unit-sweeps src/app/api/account/teacher-profile/route-lock-order.test.ts`; "answers ALREADY_TEACHER when the twin that won holds a different bio" fails.
5. **Compile-time tether.** In the same file, delete `bio: true,` from `COMPARED_COLUMNS`. Run `pnpm run typecheck`. It reports a `satisfies` error (`Property 'bio' is missing`).
6. **Effective timezone.** In the same file's pre-check, change `answerForLiveTeacher(auth.session.accountId, requested)` to `answerForLiveTeacher(auth.session.accountId, { ...requested, defaultTimezone: auth.body.defaultTimezone ?? '' })`. Run `tests/integration/teacher-signup-api.test.ts`. "answers an identical resubmit unchanged, and writes nothing" fails with a 409 `ALREADY_TEACHER`.
7. **Teacher ordering at the catch.** In the same file's session catch branch, replace `const answer = await answerForLiveTeacher(auth.session.accountId, requested);` with:
   ```ts
   const slugHolder = await prisma.teacher.findUnique({ where: { pageSlug: requested.pageSlug }, select: { accountId: true } });
   const answer = slugHolder ? await answerForLiveTeacher(slugHolder.accountId, requested) : null;
   ```
   Run `tests/integration/teacher-signup-api.test.ts`; "answers another account's identical body SLUG_TAKEN, not unchanged" fails with status 200. Run `unit-sweeps src/app/api/account/teacher-profile/route-lock-order.test.ts`; the `SLUG_TAKEN` case fails the same way.
8. **Ticket-path code.** In the same file, change `'ACCOUNT_EXISTS'` to `'ALREADY_TEACHER'` in the ticket email branch. Run `tests/integration/teacher-signup-api.test.ts`. "answers ACCOUNT_EXISTS when the address gained an account during the ticket window" fails on `code`.
9. **Slug race catch.** In `src/app/api/teachers/[id]/route.ts`, delete the `try`/`catch` around the update, leaving `teacher = await prisma.teacher.update(…)`. Run `pnpm exec vitest run --project unit-sweeps 'src/app/api/teachers/[id]/route-lock-order.test.ts'`. It fails with `code: undefined`, or with `'UNIQUE_CONFLICT'` once Task 10 has run.
10. **join-as-student.** In `src/components/booking/join-as-student.tsx`, change `if (!res.ok) {` to `if (!res.ok && res.status !== 409) {`. Run `pnpm exec vitest run --project components src/components/booking/join-as-student.test.tsx`. "does not claim success for a 409" fails.
11. **set-up-student-side.** In `src/components/account/set-up-student-side.tsx`, change `if (!res.ok) {` to `if (!res.ok && res.status !== 409) {`. Run `src/components/account/set-up-student-side.test.tsx`. "does not claim success for any 409" fails.
12. **profile-setup-form.** In `src/components/signup/profile-setup-form.tsx`, delete the `if (code === 'ACCOUNT_EXISTS') { … }` block. Run `src/components/signup/profile-setup-form.test.tsx`. The `ACCOUNT_EXISTS` test fails (`Unable to find an element with the text: You already have an account`).
13. **profile-form.** In `src/components/settings/profile-form.tsx`, restore `const json: { error?: { message?: string } } = await res.json(); setError(json.error?.message ?? 'Failed to save');`. Run `src/components/settings/profile-form.test.tsx`. The unreadable-body test fails with `Network error. Please try again.`.
14. **Retired code.** In `src/components/account/set-up-student-side.tsx`, add `if (res.status === 409 && (await readError(res, '')).code === 'ALREADY_STUDENT') return;` inside the `!res.ok` branch, and import `readError`. Run `pnpm run typecheck`. It reports a no-overlap comparison error against `'ALREADY_STUDENT'`.

---

### Task 9: Invitations, contacts and teacher links

What changes:
- **Repeats answer 200 `unchanged` when the stored row proves it.** This covers a repeated invite with the same names, a repeated accept whose link is already standing, and a repeated decline. Invite and accept already answer 200 on some repeats; decline answered 409.
- **Every refusal on these doors gets its §6.2 code and copy:**
  - `NOT_FOUND` for a contact, invitation or teacher link that is gone;
  - `STUDENT_ERASED` for the erased-account answers;
  - `CONTACT_CHANGED` for the post-CAS re-read;
  - `CONTACT_EMAIL_TAKEN` for the edit form's address collision;
  - a per-door `DECLINED_IS_PERMANENT` sentence.
- **The deleting clients treat their own `NOT_FOUND` as done.**
- **The privacy card branches on `TEACHER_NOT_LINKED` rather than on any 403.**

Line numbers are as on `fix/197-api-error-contract` at `626163de`, before Tasks 1–8. None of those tasks edits a file named here, except the shared `vitest.tiers.ts` entry list that Task 8 extends.

**Files:**
- Create:
  - `src/app/api/students/route-lock-order.test.ts`
  - `src/app/api/invitations/[id]/route-lock-order.test.ts`
  - `src/app/api/invitations/[id]/respond/reason-map.test.ts`
  - `src/app/api/teacher-links/[teacherId]/reason-map.test.ts`
- Modify:
  - `src/services/invitations.ts`:
    - `:247-273` (`inviteContact`'s signature, pre-check and helpers);
    - `:342-383` (the create-race catch);
    - `:382` (the success return);
    - `:1129` (a new sentinel class and outcome type after `NotPendingError`);
    - `:1223` (`acceptInvitation`'s return type);
    - `:1292-1369` (the link outcome, CAS-miss re-read and catch);
    - `:1387` and `:1408-1429` (`declineInvitation`'s return type and CAS-miss re-read).
  - `src/app/api/students/route.ts:3` (import), `:98-101` (the unchanged branch)
  - `src/app/api/invitations/[id]/respond/route.ts:3-10` (import), `:45-59`
  - `src/app/api/invitations/[id]/shared.ts:38-72` (copy, codes, per-door `DECLINED`)
  - `src/app/api/invitations/[id]/route.ts`:
    - `:13-14` (imports);
    - `:70-80`, `:82-125` (`casMatchedNothing`);
    - `:158`, `:192-207`, `:253-265` (PUT);
    - `:285-299` (DELETE);
    - `:337-341` (PATCH).
  - `src/app/api/invitations/[id]/resend/route.ts:75`
  - `src/app/api/teacher-links/[teacherId]/route.ts:46-50`
  - `src/app/api/students/[id]/privacy/route.ts:117`
  - `docs/lock-order.md:1127-1129` (the respond, teacher-links and privacy rows quote the answers this task recodes)
  - `vitest.tiers.ts` (two more `LOCK_CONTENTION_TESTS` entries under Task 8's comment)
  - `src/components/students/create-student-form.tsx:9`, `:87-95`
  - `src/components/students/contact-form.tsx:68-72` (comment only)
  - `src/components/students/remove-student-button.tsx:6`, `:29-44`
  - `src/components/student/pending-invitation-card.tsx:42-50` (comment only)
  - `src/components/student/teacher-privacy-card.tsx:10`, `:90-104`, `:124-129`, `:134-146`
- Test (rewritten):
  - `tests/integration/students-api.test.ts`: imports, `:275-297`, `:1429-1431`, `:1504-1509`, `:1542-1543`, `:1647-1692`
  - `tests/integration/invitations-api.test.ts`: imports, `:534-539`, `:1407`, `:1572-1576`, `:1813`, `:1865-1872`, `:2898-2935`, `:3811-3815`, plus new tests
  - `src/app/api/invitations/[id]/cas-scope.test.ts`: the docblock's stale line reference (`:21-23`) and the whole `describe`
  - `src/app/api/students/[id]/privacy/route-lock-order.test.ts`: `:18-19`, `:26-59`, `:213`
  - `src/services/invitations.decline.test.ts`: `:132`, `:169-186`, `:374`, `:462`, plus new tests
  - `src/services/invitations-lock-order.test.ts`: `:515`, `:752`, `:764-800`, `:1595`
  - `src/services/link-consent.test.ts:251-275`
  - Component tests: `create-student-form.test.tsx`, `contact-form.test.tsx`, `remove-student-button.test.tsx`, `pending-invitation-card.test.tsx`, `teacher-privacy-card.test.tsx`

**Interfaces:**
- Consumes (Task 1): `respondUnchanged<T>`; `respondError(message, status, code?)`; `readError` and `readErrorMessage`; `expectRefusal`, `expectUnchanged` and `expectApplied`; the registry entries `NOT_FOUND`, `STUDENT_ERASED`, `ALREADY_ANSWERED`, `ALREADY_INVITED`, `CONCURRENT_MODIFICATION`, `CONTACT_CHANGED`, `CONTACT_EMAIL_TAKEN`, `DECLINED_IS_PERMANENT`, `NOT_PENDING`, `TEACHER_NOT_LINKED` and `UNIQUE_CONFLICT`.
- Consumes (Task 8): the `#197` comment block in `LOCK_CONTENTION_TESTS`.
- Produces (`src/services/invitations.ts`):
  ```ts
  export type InviteOutcome =
    | { ok: true; outcome: 'applied'; value: InviteResult }
    | { ok: true; outcome: 'unchanged'; value: { id: string; delivered: false } }
    | { ok: false; reason: InviteRefusal };
  export async function inviteContact(
    db: PrismaClient,
    input: { teacherId: string; email: string; firstName: string; lastName: string },
  ): Promise<InviteOutcome>;

  export type ResponseOutcome = 'applied' | 'unchanged';
  export async function acceptInvitation(
    db: PrismaClient,
    input: { invitationId: string; studentId: string; accountEmail: string },
  ): Promise<
    | { ok: true; outcome: ResponseOutcome }
    | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'CONCURRENT_MODIFICATION' | 'STUDENT_ERASED' }
  >;
  export async function declineInvitation(
    db: PrismaClient,
    input: { invitationId: string; accountEmail: string },
  ): Promise<
    | { ok: true; outcome: ResponseOutcome }
    | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'CONCURRENT_MODIFICATION' }
  >;
  ```
  `CONCURRENT_MODIFICATION` is the answer to a missed compare-and-swap whose re-read finds the row `pending`, a state the swap would have accepted. This is the answer Tasks 4 and 5 give the same shape: 409 `CONCURRENT_MODIFICATION`, "This invitation was just changed elsewhere. Refresh and try again."
- Produces (`src/app/api/invitations/[id]/shared.ts`):
  ```ts
  export type ContactDoor = 'edit' | 'remove' | 'resend';
  export const DECLINED: (door: ContactDoor) => NextResponse; // was () => NextResponse
  ```
- **Every other caller of the changed services** (`rg -n "inviteContact\(|acceptInvitation\(|declineInvitation\(" src tests`):
  - **`inviteContact`.** Production has one caller, `src/app/api/students/route.ts`, changed below. The test callers are `invitations.gate.test.ts`, `invitations.revive.test.ts`, `invitations.decline.test.ts`, `invitations.notify.test.ts`, `link-consent.test.ts`, `put-readdress-delivered.test.ts`, `src/app/api/registrations/route.test.ts` and `tests/integration/invitations-api.test.ts`. They narrow with `if (!result.ok)` and then read `result.value.id` and `result.value.delivered`, and both arms carry both fields, so they compile unchanged.
  - **`inviteContact` literals that change.** Two `toEqual` literals change meaning because their second probe repeats the first probe's names: `link-consent.test.ts:274` and `invitations-api.test.ts:2935`. Both are rewritten below. Every `{ ok: false, reason: … }` literal stays as it is.
  - **`acceptInvitation` and `declineInvitation`.** Production has one caller, `respond/route.ts`, changed below. Their `{ ok: true }` literals are rewritten below: `invitations.decline.test.ts:132`, `:374`, `:462` and `invitations-lock-order.test.ts:515`, `:752`, `:1595`. The `toMatchObject({ … value: { ok: true } })` at `invitations-lock-order.test.ts:1341` is partial and still holds. `unlinkTeacher`'s result type does not change, so `:379`, `:473` and the `unlinkResult` literals stay.

- [ ] **Step 1: Write the failing server tests**

Add `import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';` after the helpers import in `tests/integration/students-api.test.ts` (`:3`) and `tests/integration/invitations-api.test.ts` (`:11`).

**1a. Invite.** In `tests/integration/students-api.test.ts`, replace `it('returns 409 when the person is already invited', …)` (`:275-297`) with the four tests below. The first is the identical repeat. The second is the values test. The third is the archived-contact test: an archived pending row is not what a fresh invite leaves, so it stays a refusal. The fourth is the §5.1 ordering pin: the pending invitation is keyed on the caller's own teacher id, so another teacher's identical body is a new invitation. Each is one hit on `teacherToken`'s bucket or on a fresh teacher's. Check the describe's own budget rule (`:236-242`) against the file's POSTs before adding.

```ts
  it('answers a repeat with the same names unchanged, and stamps nothing twice', async () => {
    const select = { id: true, firstName: true, lastName: true, lastNotifiedAt: true } as const;
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: newEmail } },
      select,
    });

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'New', lastName: 'Person', email: newEmail }),
    });

    expect(await expectUnchanged(res)).toEqual({ id: before.id });
    expect(await prisma.invitation.count({ where: { teacherId, email: newEmail } })).toBe(1);
    // `lastNotifiedAt` is the route's synchronous stamp before any delivery;
    // it not moving is the route never reaching that write.
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: before.id }, select })).toEqual(before);
  });

  it('refuses a repeat whose names differ with ALREADY_INVITED, and leaves the row as it was', async () => {
    const select = { id: true, firstName: true, lastName: true, lastNotifiedAt: true } as const;
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: newEmail } },
      select,
    });

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Newer', lastName: 'Person', email: newEmail }),
    });

    // ALREADY_INVITED, not ALREADY_LINKED: this refusal is about the
    // teacher's own pending invitation, which is theirs to know about.
    await expectRefusal(res, 'ALREADY_INVITED');
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: before.id }, select })).toEqual(before);
  });

  // An archived pending contact is not what a fresh invite leaves behind (a
  // contact the teacher can see), so the same names do not make it a repeat.
  it('refuses a same-names repeat of an archived contact with ALREADY_INVITED, and leaves it archived', async () => {
    const archivedEmail = `crm-archived-pending-${suffix}@test.local`;
    const select = { id: true, isArchived: true, lastNotifiedAt: true } as const;
    const archived = await prisma.invitation.create({
      data: {
        teacherId, email: archivedEmail, firstName: 'Filed', lastName: 'Away', isArchived: true,
      },
      select,
    });

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Filed', lastName: 'Away', email: archivedEmail }),
    });

    await expectRefusal(res, 'ALREADY_INVITED');
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: archived.id }, select })).toEqual(archived);
  });

  it("creates a separate invitation for another teacher's identical body", async () => {
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other', lastName: 'Inviter',
        email: `crm-other-inviter-${suffix}@test.local`,
        account: { create: { email: `crm-other-inviter-${suffix}@test.local` } },
        bio: 'Second teacher for the repeat-ordering pin',
        pageSlug: `crm-other-inviter-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    try {
      const token = await seedSession(prisma, other.accountId);
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify({ firstName: 'New', lastName: 'Person', email: newEmail }),
      });

      const data = (await expectApplied(res, 201)) as { id: string };
      const row = await prisma.invitation.findUniqueOrThrow({ where: { id: data.id } });
      expect(row.teacherId).toBe(other.id);
      expect(await prisma.invitation.count({ where: { teacherId, email: newEmail } })).toBe(1);
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: other.id } });
      await prisma.session.deleteMany({ where: { accountId: other.accountId } });
      await prisma.teacher.deleteMany({ where: { id: other.id } });
      await prisma.account.deleteMany({ where: { id: other.accountId } });
    }
  });
```

**1b. Invite delivery.** In `tests/integration/invitations-api.test.ts`, insert this in `describe('POST /api/students notifies the invitee (#166 task 8)')`, after `it('creates an in-app notification for a registered invitee')` (ends `:2239`). It uses its own teacher so its three POSTs spend a fresh bucket.

```ts
  it('answers a repeat with the same names unchanged, and sends no second notification', async () => {
    const repeatEmail = `notify-repeat-${suffix}@test.local`;
    const controlEmail = `notify-repeat-control-${suffix}@test.local`;
    const own = await prisma.teacher.create({
      data: {
        firstName: 'Repeat', lastName: 'Inviter',
        email: `notify-repeat-teacher-${suffix}@test.local`,
        account: { create: { email: `notify-repeat-teacher-${suffix}@test.local` } },
        bio: 'Own limiter bucket for the repeat-notification test',
        pageSlug: `notify-repeat-teacher-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    let student: { id: string } | undefined;
    let control: { id: string } | undefined;
    try {
      const token = await seedSession(prisma, own.accountId);
      const post = (email: string) =>
        fetch(`${BASE_URL}/api/students`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(token) },
          body: JSON.stringify({ firstName: 'Repeat', lastName: 'Invitee', email }),
        });
      const notificationFor = (recipientId: string) => () =>
        prisma.notification.findFirst({
          where: { recipientType: 'student', recipientId, type: 'teacher_invitation' },
        });
      student = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Repeat', email: repeatEmail },
        select: { id: true },
      });
      control = await prisma.student.create({
        data: { firstName: 'Notify', lastName: 'Control', email: controlEmail },
        select: { id: true },
      });

      const created = (await expectApplied(await post(repeatEmail), 201)) as { id: string };
      await waitFor(notificationFor(student.id), {
        description: 'first teacher_invitation for the repeated address (#197)',
      });
      const stamped = await prisma.invitation.findUniqueOrThrow({
        where: { id: created.id },
        select: { lastNotifiedAt: true },
      });

      expect(await expectUnchanged(await post(repeatEmail))).toEqual({ id: created.id });

      // Absence is proven with a later control, as the stranger test below
      // does. Delivery runs in order from this one process, so once the
      // control's notification has landed, a second one for the repeated
      // address would have landed too.
      await expectApplied(await post(controlEmail), 201);
      await waitFor(notificationFor(control.id), {
        description: 'control teacher_invitation after the repeat (#197)',
      });

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(1);
      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: created.id },
        select: { lastNotifiedAt: true },
      });
      expect(after.lastNotifiedAt).toEqual(stamped.lastNotifiedAt);
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: own.id } });
      for (const s of [student, control]) {
        if (s) {
          await prisma.notification.deleteMany({ where: { recipientId: s.id } });
          await prisma.student.delete({ where: { id: s.id } });
        }
      }
      await prisma.session.deleteMany({ where: { accountId: own.accountId } });
      await prisma.teacher.deleteMany({ where: { id: own.id } });
      await prisma.account.deleteMany({ where: { id: own.accountId } });
    }
  });
```

**1c. Respond.** In `tests/integration/invitations-api.test.ts`'s `describe('POST /api/invitations/[id]/respond')`, insert these after `it('declining leaves no link and blocks a re-invite')` (ends `:1385`). They are the identical repeats (with their side-effect counts) and the ordering pin. The genuine counterparts already exist: decline of an accepted row (`:1572`) and accept of a declined row (`:1387`), both `ALREADY_ANSWERED`.

```ts
  it('answers a repeated accept unchanged, and stamps nothing twice', async () => {
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { id: inviteId },
      select: { status: true, respondedAt: true },
    });

    const res = await respond(inviteId, respondingToken, 'accept');

    expect(await expectUnchanged(res)).toEqual({ id: inviteId });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { id: inviteId },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.teacherStudent.count({ where: { teacherId, studentId: respondingStudentId } }),
    ).toBe(1);
  });

  it('answers a repeated decline unchanged, and writes nothing twice', async () => {
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { id: declineId },
      select: { status: true, respondedAt: true },
    });

    const res = await respond(declineId, decliningToken, 'decline');

    expect(await expectUnchanged(res)).toEqual({ id: declineId });
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { id: declineId },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual(before);
    expect(await prisma.teacherBlock.count({ where: { teacherId, email: declineEmail } })).toBe(1);
    expect(
      await prisma.teacherStudent.count({ where: { teacherId, studentId: decliningStudentId } }),
    ).toBe(0);
  });

  // The ordering pin (spec §5.1): the address match is the ownership gate,
  // and it runs before the unchanged check. Each row below is already in the
  // state the other student names, which would be `unchanged` for its owner.
  it("answers NOT_FOUND, not unchanged, to a repeat of someone else's answer", async () => {
    await expectRefusal(await respond(inviteId, decliningToken, 'accept'), 'NOT_FOUND');
    await expectRefusal(await respond(declineId, respondingToken, 'decline'), 'NOT_FOUND');
    expect(
      await prisma.teacherStudent.count({ where: { teacherId, studentId: decliningStudentId } }),
    ).toBe(0);
  });
```

**1d. Invitation DELETE and teacher-link DELETE, done twice.**

In `describe('DELETE /api/invitations/[id]')`, insert this after `it('removes a pending contact')` (ends `:292`):

```ts
  it('answers a second delete of the same contact NOT_FOUND', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${pendingId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    await expectRefusal(res, 'NOT_FOUND');
  });
```

In `describe('DELETE /api/teacher-links/[teacherId]')`, insert this after `it('marks an existing invitation honestly declined, and blocks it too')` (ends `:1803`):

```ts
  it('answers a second unlink of the same teacher NOT_FOUND, and writes nothing', async () => {
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
      select: { status: true, respondedAt: true },
    });

    const res = await fetch(`${BASE_URL}/api/teacher-links/${invitingTeacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });

    await expectRefusal(res, 'NOT_FOUND');
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.teacherBlock.count({ where: { teacherId: invitingTeacherId, email: studentEmail } }),
    ).toBe(1);
  });
```

**1e. The invite's lost race (unit tier, uncommitted holder).** `src/app/api/students/route-lock-order.test.ts` (new). Copy `WAIT_MS`, `latch`, `ownPid`, `waiterOf` and `raceBehindHolder` verbatim from Task 8's `src/app/api/account/teacher-profile/route-lock-order.test.ts`, which took the first three from `src/app/api/students/[id]/privacy/route-lock-order.test.ts:67-91`.

```ts
/**
 * @serial-tier lock-contention — holds an uncommitted `Invitation` insert
 * while this route's own create waits on the same `(teacherId, email)` key,
 * and asserts that the waiter parked, via `pg_blocking_pids`. Lock noise from
 * a neighbour in the parallel tier would stretch that wait past the window
 * the assertion allows.
 *
 * `POST` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. A twin
 * with different names is pinned over HTTP by
 * `tests/integration/students-api.test.ts`; this file pins the twin that
 * carries the same ones.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../tests/helpers';
import { expectUnchanged } from '../../../../tests/api-assertions';
import { POST } from './route';

const prisma = new PrismaClient();

// WAIT_MS, latch, ownPid, waiterOf, raceBehindHolder: verbatim from
// src/app/api/account/teacher-profile/route-lock-order.test.ts.

async function makeTeacher() {
  const suffix = `invite-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Inviter', email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Invite race fixture', pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  return {
    suffix,
    teacherId: teacher.id,
    accountId: teacher.accountId,
    token: await seedSession(prisma, teacher.accountId),
  };
}

describe('POST /api/students answers a lost create by re-reading the winner (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers unchanged, naming the winner, when the twin that won carries the same names, and stamps nothing', async () => {
    const fx = await makeTeacher();
    const email = `${fx.suffix}-invitee@test.local`;
    try {
      let winnerId = '';
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          const row = await tx.invitation.create({
            data: { teacherId: fx.teacherId, email, firstName: 'Same', lastName: 'Names' },
            select: { id: true },
          });
          winnerId = row.id;
        },
        () => POST(new NextRequest('http://localhost:3000/api/students', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(fx.token) },
          body: JSON.stringify({ firstName: 'Same', lastName: 'Names', email }),
        })),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ id: winnerId });
      // The holder wrote no marker, and this request must not have either.
      expect(
        await prisma.invitation.findMany({
          where: { teacherId: fx.teacherId, email },
          select: { id: true, lastNotifiedAt: true },
        }),
      ).toEqual([{ id: winnerId, lastNotifiedAt: null }]);
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: fx.teacherId } });
      await prisma.session.deleteMany({ where: { accountId: fx.accountId } });
      await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
      await prisma.account.deleteMany({ where: { id: fx.accountId } });
    }
  }, 20_000);
});
```

**1f. PATCH on a contact deleted mid-request (unit tier, uncommitted holder).** `src/app/api/invitations/[id]/route-lock-order.test.ts` (new). Copy the same helpers verbatim.

```ts
/**
 * @serial-tier lock-contention — holds an uncommitted delete of an
 * `Invitation` row while this route's `update` of the same row waits on its
 * lock, and asserts that the waiter parked, via `pg_blocking_pids`. Lock
 * noise from a neighbour in the parallel tier would stretch that wait past
 * the window the assertion allows.
 *
 * `PATCH` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. PATCH
 * reads the row before it writes, so only this interleaving reaches its
 * write with the row gone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { PATCH } from './route';

const prisma = new PrismaClient();

// WAIT_MS, latch, ownPid, waiterOf, raceBehindHolder: verbatim from
// src/app/api/account/teacher-profile/route-lock-order.test.ts.

describe('PATCH /api/invitations/[id] answers NOT_FOUND for a row deleted mid-request (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers NOT_FOUND, not a 500, when the archive write finds the row gone', async () => {
    const suffix = `patch-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Patch', lastName: 'Race', email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Archive race fixture', pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: {
        teacherId: teacher.id, email: `${suffix}-contact@test.local`,
        firstName: 'Gone', lastName: 'Contact',
      },
      select: { id: true },
    });
    try {
      const token = await seedSession(prisma, teacher.accountId);
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.invitation.delete({ where: { id: invitation.id } });
        },
        () => PATCH(
          new NextRequest(`http://localhost:3000/api/invitations/${invitation.id}?state=archived`, {
            method: 'PATCH',
            headers: cookie(token),
          }),
          { params: Promise.resolve({ id: invitation.id }) },
        ),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'NOT_FOUND');
      expect(await prisma.invitation.findUnique({ where: { id: invitation.id } })).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.session.deleteMany({ where: { accountId: teacher.accountId } });
      await prisma.teacher.deleteMany({ where: { id: teacher.id } });
      await prisma.account.deleteMany({ where: { id: teacher.accountId } });
    }
  }, 20_000);
});
```

In `vitest.tiers.ts`, append these two paths directly after Task 8's two, under the same `#197` comment:

```ts
  'src/app/api/students/route-lock-order.test.ts',
  'src/app/api/invitations/[id]/route-lock-order.test.ts',
```

**1g. Outcome to response, with the services mocked.** HTTP cannot reach `STUDENT_ERASED` on these doors without an erasure racing the request, because an erased student's session is refused first. So the mapping is pinned against mocked services, the way `cas-scope.test.ts` pins `casMatchedNothing`.

`src/app/api/invitations/[id]/respond/reason-map.test.ts` (new):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * What each outcome of `acceptInvitation` and `declineInvitation` answers on
 * the wire. The services are mocked: their own behaviour is pinned in
 * `src/services/invitations.decline.test.ts` and
 * `src/services/invitations-lock-order.test.ts`. Mocking `@/lib/db` keeps
 * this file off the database entirely.
 */
const accept = vi.fn();
const decline = vi.fn();

vi.mock('@/services/invitations', () => ({
  acceptInvitation: (...args: unknown[]) => accept(...args),
  declineInvitation: (...args: unknown[]) => decline(...args),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    account: { findUniqueOrThrow: async () => ({ email: 'student@test.local' }) },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireStudent: async () => ({
      sessionId: 'session-1', accountId: 'acct-1', teacherId: null, studentId: 'student-1',
    }),
  };
});

const { POST } = await import('./route');

function respond(response: 'accept' | 'decline') {
  return POST(
    new NextRequest('http://localhost:3000/api/invitations/inv-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    }),
    { params: Promise.resolve({ id: 'inv-1' }) },
  );
}

beforeEach(() => {
  accept.mockReset();
  decline.mockReset();
});

describe('POST /api/invitations/[id]/respond — service outcome to response (#197)', () => {
  it('answers an applied accept 200 with no outcome', async () => {
    accept.mockResolvedValueOnce({ ok: true, outcome: 'applied' });
    expect(await expectApplied(await respond('accept'))).toEqual({ id: 'inv-1' });
  });

  it('answers an unchanged accept 200 unchanged', async () => {
    accept.mockResolvedValueOnce({ ok: true, outcome: 'unchanged' });
    expect(await expectUnchanged(await respond('accept'))).toEqual({ id: 'inv-1' });
  });

  it('answers an unchanged decline 200 unchanged', async () => {
    decline.mockResolvedValueOnce({ ok: true, outcome: 'unchanged' });
    expect(await expectUnchanged(await respond('decline'))).toEqual({ id: 'inv-1' });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['NOT_PENDING', 'ALREADY_ANSWERED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
    ['STUDENT_ERASED', 'STUDENT_ERASED'],
  ] as const)('answers an accept refused %s with %s', async (reason, code) => {
    accept.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await respond('accept'), code);
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['NOT_PENDING', 'ALREADY_ANSWERED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
  ] as const)('answers a decline refused %s with %s', async (reason, code) => {
    decline.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await respond('decline'), code);
  });
});
```

`src/app/api/teacher-links/[teacherId]/reason-map.test.ts` (new):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectApplied, expectRefusal } from '../../../../../tests/api-assertions';

/**
 * What each outcome of `unlinkTeacher` answers on the wire. The service is
 * mocked: its own behaviour, including the concurrent erasure that turns its
 * delete's `P2025` into `NOT_LINKED`, is pinned in
 * `src/services/invitations-lock-order.test.ts`.
 */
const unlink = vi.fn();

vi.mock('@/services/invitations', () => ({
  unlinkTeacher: (...args: unknown[]) => unlink(...args),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    account: { findUniqueOrThrow: async () => ({ email: 'student@test.local' }) },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireStudent: async () => ({
      sessionId: 'session-1', accountId: 'acct-1', teacherId: null, studentId: 'student-1',
    }),
  };
});

const { DELETE } = await import('./route');

function unlinkRequest() {
  return DELETE(
    new NextRequest('http://localhost:3000/api/teacher-links/teacher-1', { method: 'DELETE' }),
    { params: Promise.resolve({ teacherId: 'teacher-1' }) },
  );
}

beforeEach(() => {
  unlink.mockReset();
});

describe('DELETE /api/teacher-links/[teacherId] — service outcome to response (#197)', () => {
  it('answers a removed link 200 with its teacher id', async () => {
    unlink.mockResolvedValueOnce({ ok: true });
    expect(await expectApplied(await unlinkRequest())).toEqual({ teacherId: 'teacher-1' });
  });

  it.each([
    ['NOT_LINKED', 'NOT_FOUND'],
    ['STUDENT_ERASED', 'STUDENT_ERASED'],
  ] as const)('answers %s with %s', async (reason, code) => {
    unlink.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await unlinkRequest(), code);
  });
});
```

**1h. Service tests.** In `src/services/invitations.decline.test.ts`, replace `it('writes no block when the CAS misses, so a non-pending row cannot silently suppress', …)` (`:169-186`) with:

```ts
  it('answers a repeated decline unchanged, and writes no block', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    const before = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { respondedAt: true },
    });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: teacher.id, email } });

    // The row is already `declined`, so the CAS matches nothing, and the
    // re-read finds this request already done.
    const second = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(second).toEqual({ ok: true, outcome: 'unchanged' });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
    const after = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { respondedAt: true },
    });
    expect(after).toEqual(before);
  });

  it('answers NOT_PENDING to a decline of an accepted row, and writes no block', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    expect(await acceptInvitation(prisma, {
      invitationId: invitation.id,
      studentId: student.id,
      accountEmail: email,
    })).toEqual({ ok: true, outcome: 'applied' });

    const result = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_PENDING' });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row.status).toBe('accepted');
  });

  it('answers NOT_FOUND to a decline whose row is deleted between the read and the write', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    // Deletes the row from another connection just before the CAS runs. The
    // interactive transaction's `tx` inherits the hook, as `failingBlock`
    // below relies on for its own.
    let hookFired = false;
    const deleting = prisma.$extends({
      query: {
        invitation: {
          async updateMany({ args, query }) {
            hookFired = true;
            await prisma.invitation.delete({ where: { id: invitation.id } });
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await declineInvitation(deleting, {
      invitationId: invitation.id,
      accountEmail: email,
    });

    expect(hookFired).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });

  // A swap that missed on a row the re-read finds `pending` again: the row
  // moved away and back between the two statements. The hook stands in for
  // that interleaving by reporting the miss without running the write.
  it('answers CONCURRENT_MODIFICATION when the re-read finds the row pending again, and writes no block', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    let hookFired = false;
    const missing = prisma.$extends({
      query: {
        invitation: {
          async updateMany() {
            hookFired = true;
            return { count: 0 };
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await declineInvitation(missing, {
      invitationId: invitation.id,
      accountEmail: email,
    });

    expect(hookFired).toBe(true);
    expect(result).toEqual({ ok: false, reason: 'CONCURRENT_MODIFICATION' });
    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });
```

In the same file, insert a new nested describe before `describe('listDeclinedTeachers', …)` (`:421`):

```ts
  describe('acceptInvitation on a repeat (#197)', () => {
    it('answers a repeated accept unchanged, and stamps nothing twice', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      const accept = () => acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });

      expect(await accept()).toEqual({ ok: true, outcome: 'applied' });
      const before = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { status: true, respondedAt: true },
      });

      expect(await accept()).toEqual({ ok: true, outcome: 'unchanged' });
      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id },
        select: { status: true, respondedAt: true },
      });
      expect(after).toEqual(before);
      expect(await prisma.teacherStudent.count({
        where: { teacherId: teacher.id, studentId: student.id },
      })).toBe(1);
    });

    // The half of the rule that is not a repeat: an accepted row whose link
    // is missing is restored, and that is an ordinary accept.
    it('answers an accept that restores a missing link as applied', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      const accept = () => acceptInvitation(prisma, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });

      expect(await accept()).toEqual({ ok: true, outcome: 'applied' });
      await prisma.teacherStudent.deleteMany({
        where: { teacherId: teacher.id, studentId: student.id },
      });

      expect(await accept()).toEqual({ ok: true, outcome: 'applied' });
      expect(await prisma.teacherStudent.count({
        where: { teacherId: teacher.id, studentId: student.id },
      })).toBe(1);
    });

    // The same stand-in as the decline test above: the swap reports a miss
    // on a row that is still `pending`. The roster-link write had already
    // run, so the refusal must roll it back.
    it('answers CONCURRENT_MODIFICATION when the re-read finds the row pending again, and commits no link', async () => {
      const { teacher, student, email } = await makeTeacherAndInvitee();
      const invitation = await invite(teacher.id, email);
      let hookFired = false;
      const missing = prisma.$extends({
        query: {
          invitation: {
            async updateMany() {
              hookFired = true;
              return { count: 0 };
            },
          },
        },
      }) as unknown as PrismaClient;

      const result = await acceptInvitation(missing, {
        invitationId: invitation.id,
        studentId: student.id,
        accountEmail: email,
      });

      expect(hookFired).toBe(true);
      expect(result).toEqual({ ok: false, reason: 'CONCURRENT_MODIFICATION' });
      expect(await prisma.teacherStudent.count({
        where: { teacherId: teacher.id, studentId: student.id },
      })).toBe(0);
    });
  });
```

- [ ] **Step 2: Run the new tests to see them fail**

Run: `pnpm exec vitest run --project unit src/app/api/invitations/[id]/respond/reason-map.test.ts src/app/api/teacher-links/[teacherId]/reason-map.test.ts src/services/invitations.decline.test.ts`
Expected: FAIL.
- The unchanged-mapping cases get `outcome: undefined`.
- The `NOT_FOUND` and `STUDENT_ERASED` cases get `code: undefined`.
- `NOT_LINKED` gets `code: undefined`.
- The decline tests get `{ ok: false, reason: 'NOT_PENDING' }` where `{ ok: true, outcome: 'unchanged' }` and `{ ok: false, reason: 'NOT_FOUND' }` are expected.
- The accept tests get `{ ok: true }` where `outcome` is expected.

Run: `pnpm exec vitest run --project unit-sweeps src/app/api/students/route-lock-order.test.ts 'src/app/api/invitations/[id]/route-lock-order.test.ts'`
Expected: FAIL.
- The invite race answers 409 `ALREADY_INVITED`.
- The PATCH race answers 500: `P2025` reaches `classifyApiError`, and the `code` is `undefined`.

With the worktree app up, run: `pnpm exec vitest run --project integration tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts`
Expected: FAIL.
- The identical-repeat tests get 409.
- The repeated decline gets 409 `ALREADY_ANSWERED`.
- The repeated accept gets 200 with no `outcome`.
- The second delete gets a 404 with no code.
- The second unlink gets a 404 with no code.
- The ordering tests get a 404 with no code.
- The other-teacher invite test passes already and pins the key the change must keep.
- The archived-contact test passes already (409 `ALREADY_INVITED`) and pins the condition the change must keep.

- [ ] **Step 3: `inviteContact` answers `unchanged` for its own repeat**

In `src/services/invitations.ts`, replace the signature and pre-check (`:247-273`, from `export async function inviteContact(` through `if (existing?.status === 'pending') return { ok: false, reason: 'ALREADY_INVITED' };`) with the block below. The function's docblock above it (`:207-246`) stays as it is.

```ts
export async function inviteContact(
  db: PrismaClient,
  input: InviteInput,
): Promise<InviteOutcome> {
  const { teacherId, firstName, lastName } = input;

  // The CRM is the one place in this app where one human types ANOTHER
  // human's address, and a case slip here fails silently: the teacher sees a
  // pending invitation, the student never sees anything. The column is
  // lowercase by construction — `createInvitationSchema` normalises `email`
  // at HTTP ingress via `emailField` (src/lib/schemas.ts) — so this asserts
  // that precondition rather than normalising a second time. See
  // `requireNormalised`'s own docblock for why an assertion, not a
  // re-normalisation.
  const email = requireNormalised(input.email);

  const existing = await db.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: REPEAT_SELECT,
  });

  // Every Invitation row left standing is one the teacher typed themselves
  // — the block that used to live in here has moved to `TeacherBlock` — so
  // a 409 here tells them nothing they did not already have, and silence
  // would be cruelty rather than protection.
  if (existing?.status === 'declined') return { ok: false, reason: 'DECLINED' };
  // A visible pending row with these names is this request already done. An
  // archived one, or one with other names, is a different request for an
  // address already invited. This is answered before the roster and block
  // reads below, so a blocked, a gated-linked and a fresh address answer it
  // through the same statements.
  if (existing?.status === 'pending') {
    return isRepeatOf(existing, input)
      ? unchangedInvite(existing.id)
      : { ok: false, reason: 'ALREADY_INVITED' };
  }
```

Insert directly above `inviteContact`'s docblock (`:207`, after `rosterLinkState` ends at `:205`):

```ts
type InviteInput = { teacherId: string; email: string; firstName: string; lastName: string };

/**
 * What `inviteContact` did. `applied`: it created or revived the invitation,
 * and `value.delivered` says whether the caller delivers it. `unchanged`: this
 * teacher's pending, unarchived invitation for the address already carries
 * these names, so nothing was written and there is nothing to deliver —
 * `delivered` is `false` so that a caller reading it alone still sends
 * nothing.
 */
export type InviteOutcome =
  | { ok: true; outcome: 'applied'; value: InviteResult }
  | { ok: true; outcome: 'unchanged'; value: { id: string; delivered: false } }
  | { ok: false; reason: InviteRefusal };

/**
 * The fields a pending invitation must already carry for a repeat to be the
 * same request. Keyed by `InviteInput`'s fields other than the row's own key,
 * so a field added there fails to compile here until it is compared too.
 */
const REPEAT_COMPARED = {
  firstName: true,
  lastName: true,
} as const satisfies Record<Exclude<keyof InviteInput, 'teacherId' | 'email'>, true>;

/**
 * What the pre-check and the create-race re-read both select. `isArchived`
 * is not a request value, so it is not in `REPEAT_COMPARED`; `isRepeatOf`
 * reads it, and both reads select it through this one object.
 */
const REPEAT_SELECT = {
  id: true,
  status: true,
  isArchived: true,
  ...REPEAT_COMPARED,
} as const;

/**
 * Whether `row` is what this request would leave behind: a pending,
 * unarchived invitation carrying the request's own values. An archived
 * pending contact is not — a fresh invite leaves a contact the teacher can
 * see — so it stays `ALREADY_INVITED`.
 */
function isRepeatOf(
  row: { status: string; isArchived: boolean } & Pick<InviteInput, keyof typeof REPEAT_COMPARED>,
  requested: InviteInput,
): boolean {
  return (
    row.status === 'pending' &&
    !row.isArchived &&
    (Object.keys(REPEAT_COMPARED) as Array<keyof typeof REPEAT_COMPARED>).every(
      (field) => row[field] === requested[field],
    )
  );
}

function unchangedInvite(id: string): InviteOutcome {
  return { ok: true, outcome: 'unchanged', value: { id, delivered: false } };
}
```

Replace the create branch's comment and catch (`:343-363`). Old:

```ts
    // The `findUnique` at the top of this function is a plain read, so a
    // concurrent invite of the same address passes it and one of the two
    // loses here. `ALREADY_INVITED` is exact rather than a best guess: this
    // is the only `Invitation` INSERT in this module — every other write to
    // that table is an `updateMany` against a row that already exists — so
    // the row that won was inserted by another `inviteContact` and carries
    // the schema default `pending`, which is what this refusal names. Were
    // any other writer able to INSERT, the winner could be a `declined`
    // tombstone and this answer would be wrong.
    //
    // `PUT /api/invitations/[id]` already answers this same code for this
    // same constraint.
    try {
      const created = await db.invitation.create({
        data: { teacherId, email, firstName, lastName, delivered },
        select: { id: true },
      });
      invitationId = created.id;
    } catch (err) {
      if (isUniqueConflictOn(err, ['teacherId', 'email'])) {
        return { ok: false, reason: 'ALREADY_INVITED' };
      }
```

New:

```ts
    // The `findUnique` at the top of this function is a plain read, so a
    // concurrent invite of the same address passes it and one of the two
    // loses here. This is the only `Invitation` INSERT in this module —
    // every other write to that table is an `updateMany` against a row that
    // already exists — so the row that won was inserted by another
    // `inviteContact` and carries the schema default `pending`. The winner is
    // re-read and answered as the pre-check above answers a pending row:
    // `unchanged` when `isRepeatOf` holds (a double submit), and
    // `ALREADY_INVITED` otherwise, including when the re-read no longer finds
    // it at all.
    try {
      const created = await db.invitation.create({
        data: { teacherId, email, firstName, lastName, delivered },
        select: { id: true },
      });
      invitationId = created.id;
    } catch (err) {
      if (isUniqueConflictOn(err, ['teacherId', 'email'])) {
        const winner = await db.invitation.findUnique({
          where: { teacherId_email: { teacherId, email } },
          select: REPEAT_SELECT,
        });
        return winner !== null && isRepeatOf(winner, input)
          ? unchangedInvite(winner.id)
          : { ok: false, reason: 'ALREADY_INVITED' };
      }
```

Change the final return (`:382`) from `return { ok: true, value: { id: invitationId, delivered } };` to:

```ts
  return { ok: true, outcome: 'applied', value: { id: invitationId, delivered } };
```

- [ ] **Step 4: `POST /api/students` stamps and delivers only an applied invite**

In `src/app/api/students/route.ts`, change `:3` to import `respondUnchanged` as well:

```ts
import { respondOk, respondError, respondUnchanged, requireTeacher, isErrorResponse, parseBody, withErrorHandler } from '@/lib/api-utils';
```

Replace `:98-101`:

```ts
  if (!result.ok) {
    return respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason);
  }
```

with:

```ts
  if (!result.ok) {
    return respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason);
  }
  // This teacher's pending, unarchived invitation already carries these names: the
  // request already happened, so there is nothing to stamp and nothing to
  // deliver. The limiter above has still counted it.
  if (result.outcome === 'unchanged') {
    return respondUnchanged<{ id: string }>({ id: result.value.id });
  }
```

The marker write and the `deliverInvitation` gate below it are unchanged. `result` is narrowed to the `applied` arm there.

- [ ] **Step 5: `acceptInvitation` and `declineInvitation` report their outcome**

In `src/services/invitations.ts`, directly after `class NotPendingError extends Error {}` (`:1129`) and before `acceptInvitation`'s docblock, insert:

```ts

/**
 * Rolls back `acceptInvitation`'s transaction when its compare-and-swap
 * missed on a row that is gone, or that is `pending` again when re-read, and
 * carries the refusal each one earns. It exists for the same reason
 * `NotPendingError` above does: the roster-link write has already run by then.
 */
class AcceptMissError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'CONCURRENT_MODIFICATION') {
    super(reason);
  }
}

/** What answering an invitation did: wrote the answer, or found it already given. */
export type ResponseOutcome = 'applied' | 'unchanged';
```

Change `acceptInvitation`'s return type (`:1223`) to:

```ts
): Promise<
  | { ok: true; outcome: ResponseOutcome }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'CONCURRENT_MODIFICATION' | 'STUDENT_ERASED' }
> {
```

Change `:1240` from `const accepted = await db.$transaction(async (tx) => {` to `const settled = await db.$transaction(async (tx) => {`.

Change `:1292` from `await linkTeacherStudent(tx, { teacherId: invitation.teacherId, studentId: input.studentId });` to:

```ts
    const link = await linkTeacherStudent(tx, {
      teacherId: invitation.teacherId,
      studentId: input.studentId,
    });
```

Replace `:1303-1334`, from `if (updated.count === 0) {` through its closing `}`, with:

```ts
    let outcome: ResponseOutcome = 'applied';
    if (updated.count === 0) {
      // Zero rows: the row is no longer `pending`, and what it is now decides
      // the answer. Gone — the teacher can delete a pending invitation
      // outright (`DELETE /api/invitations/[id]` protects only `declined`
      // rows) — is `NOT_FOUND`, the answer an unknown id gets; `findUnique`
      // rather than `findUniqueOrThrow` keeps that a refusal instead of an
      // unhandled `P2025`. `pending` again means the row moved away and back
      // between the two statements, which is `CONCURRENT_MODIFICATION`: a
      // retry would meet a row it can write. `declined`, from a concurrent
      // decline by this same account, is `NOT_PENDING`, and so is any other
      // status.
      //
      // `accepted` is what this call asks for. This account's own earlier
      // accept can have written it, and so can `resolveInvitationOnLink`
      // (services/link-consent.ts), which resolves this row as a side effect
      // of the same student booking or joining a waitlist with this teacher —
      // for a `pending` row, only when that act created the roster link
      // (`docs/data-model.md`, Invitation). The roster-link write above waits
      // for that transaction to commit (measured, #181 task 1), so its
      // `accepted` can already be visible here. Which hand wrote it does not
      // matter here; the link does. When the write above found the link
      // already standing, nothing this call asks for is missing, and it
      // answers `unchanged`. When the write above created the link, this call
      // restored something, and it answers as an ordinary accept.
      const current = await tx.invitation.findUnique({
        where: { id: invitation.id },
        select: { status: true },
      });
      if (current === null) throw new AcceptMissError('NOT_FOUND');
      if (current.status === 'pending') throw new AcceptMissError('CONCURRENT_MODIFICATION');
      if (current.status !== 'accepted') throw new NotPendingError();
      if (link === 'already-linked') outcome = 'unchanged';
    }
```

Replace `:1361-1368`:

```ts
    return true as const;
  }).catch((err: unknown) => {
    if (err instanceof StudentErasedError) return 'STUDENT_ERASED' as const;
    if (err instanceof NotPendingError) return 'NOT_PENDING' as const;
    throw err;
  });
  if (accepted !== true) return { ok: false, reason: accepted };
  return { ok: true };
```

with:

```ts
    return outcome;
  }).catch((err: unknown): 'NOT_FOUND' | 'NOT_PENDING' | 'CONCURRENT_MODIFICATION' | 'STUDENT_ERASED' => {
    if (err instanceof StudentErasedError) return 'STUDENT_ERASED';
    if (err instanceof AcceptMissError) return err.reason;
    if (err instanceof NotPendingError) return 'NOT_PENDING';
    throw err;
  });
  if (settled === 'applied' || settled === 'unchanged') return { ok: true, outcome: settled };
  return { ok: false, reason: settled };
```

In the comment at `:1286-1290`, replace the sentence `If the `updateMany` below then matches nothing — a concurrent decline or unlink got there first — the transaction rolls back and that write goes with it (see `NotPendingError` above for why that has to be a throw rather than a `return false`).` with `If the `updateMany` below then matches a row that is gone or no longer answerable, the transaction rolls back and that write goes with it (see `NotPendingError` above for why that has to be a throw rather than a `return`).`

Change `declineInvitation`'s return type (`:1387`) to:

```ts
): Promise<
  | { ok: true; outcome: ResponseOutcome }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' | 'CONCURRENT_MODIFICATION' }
> {
```

Replace `:1408-1411`:

```ts
    // No sentinel error, unlike `acceptInvitation`'s `NotPendingError`: that
    // one exists because its roster-link write has already run by this point.
    // Here nothing has been written yet, so returning commits nothing.
    if (updated.count === 0) return { ok: false, reason: 'NOT_PENDING' } as const;
```

with:

```ts
    // No sentinel error, unlike `acceptInvitation`'s: those exist because its
    // roster-link write has already run by this point. Here nothing has been
    // written yet, so returning commits nothing.
    if (updated.count === 0) {
      // No longer pending when the swap ran. Already `declined` is this
      // request done: by this account, the only one the address match
      // admits, or by its own unlink. Gone is an unknown id. `pending` again
      // means the row moved away and back between the two statements, so a
      // retry would meet a row it can write. Anything else was answered the
      // other way.
      const current = await tx.invitation.findUnique({
        where: { id: invitation.id },
        select: { status: true },
      });
      if (current === null) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status === 'declined') return { ok: true, outcome: 'unchanged' } as const;
      if (current.status === 'pending') {
        return { ok: false, reason: 'CONCURRENT_MODIFICATION' } as const;
      }
      return { ok: false, reason: 'NOT_PENDING' } as const;
    }
```

Change the last return inside the transaction (`:1429`) from `return { ok: true } as const;` to:

```ts
    return { ok: true, outcome: 'applied' } as const;
```

- [ ] **Step 6: `POST /api/invitations/[id]/respond`**

In `src/app/api/invitations/[id]/respond/route.ts`, add `respondUnchanged,` to the `@/lib/api-utils` import list (`:3-10`). Replace `:45-59`:

```ts
  if (!result.ok) {
    switch (result.reason) {
      case 'NOT_FOUND':
        return respondError('Invitation not found', 404);
      case 'STUDENT_ERASED':
        return respondError('This account has been deleted', 409);
      case 'NOT_PENDING':
        return respondError('This invitation has already been answered', 409, 'ALREADY_ANSWERED');
      default: {
        const unhandled: never = result.reason;
        throw new Error(`unhandled invitation response reason: ${unhandled}`);
      }
    }
  }
  return respondOk({ id });
```

with:

```ts
  if (!result.ok) {
    switch (result.reason) {
      case 'NOT_FOUND':
        return respondError('This invitation no longer exists.', 404, 'NOT_FOUND');
      case 'STUDENT_ERASED':
        return respondError('This account has been deleted.', 409, 'STUDENT_ERASED');
      case 'NOT_PENDING':
        return respondError('This invitation has already been answered.', 409, 'ALREADY_ANSWERED');
      case 'CONCURRENT_MODIFICATION':
        return respondError(
          'This invitation was just changed elsewhere. Refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION',
        );
      default: {
        const unhandled: never = result.reason;
        throw new Error(`unhandled invitation response reason: ${unhandled}`);
      }
    }
  }
  if (result.outcome === 'unchanged') return respondUnchanged<{ id: string }>({ id });
  return respondOk({ id });
```

- [ ] **Step 7: The contact doors — `shared.ts`, PUT, DELETE, PATCH, resend**

In `src/app/api/invitations/[id]/shared.ts`, replace `:47` through the end of the file (`:72`) with the block below. The `NOT_FOUND` docblock (`:38-46`) and the `NOT_PENDING` docblock stay as they are.

```ts
export const NOT_FOUND = () => respondError('This contact no longer exists.', 404, 'NOT_FOUND');

/** The teacher action a contact refusal answers. */
export type ContactDoor = 'edit' | 'remove' | 'resend';

const DECLINED_MESSAGE = {
  edit: "This person declined, so their details can't be changed. You can archive this contact.",
  remove: 'This person declined. You can archive this contact, but it cannot be removed.',
  resend: "This person declined, so the invitation can't be sent again.",
} as const satisfies Record<ContactDoor, string>;

/**
 * The refusal a declined row earns, in one place. The code is the same at
 * every door; the sentence names the action the teacher just tried.
 */
export const DECLINED = (door: ContactDoor) =>
  respondError(DECLINED_MESSAGE[door], 409, 'DECLINED_IS_PERMANENT');

/**
 * The refusal a row this route may not write to earns — every caller that
 * refuses a non-pending row answers with this, the same "one sentence, one
 * place" reasoning `DECLINED` above follows. It says nothing about the
 * Students list: an accepted row can outlive its link.
 */
export const NOT_PENDING = () =>
  respondError(
    'This person already accepted your invitation. Reload to see the latest.',
    409,
    'NOT_PENDING',
  );
```

Delete the old `DECLINED` docblock (`:49-54`) along with the old factory. The text above replaces both.

In `src/app/api/invitations/[id]/route.ts`:

1. **Imports.** Change `:14` to:
   ```ts
   import { ownedInvitation, NOT_FOUND, DECLINED, NOT_PENDING, type ContactDoor } from './shared';
   ```
   Add `import { isRecordNotFound } from '@/lib/api-errors';` after the `@/lib/log` import (`:13`).

2. **`casMatchedNothing`'s docblock (`:70-80`).** Replace `so it falls all the way through to the generic 409, exactly as it did before #500.` with `so it falls all the way through to the `CONTACT_CHANGED` 409.`. Replace `\`info\`, not \`warn\`, for the branch that still reaches the generic answer:` with `\`info\`, not \`warn\`, for the branch that reaches \`CONTACT_CHANGED\`:`. After the docblock's last paragraph, add a new paragraph: `\`door\` is the caller's action, so a decline found here is worded for it.`

3. **`casMatchedNothing` (`:82-125`).**
   - Signature:
     ```ts
     async function casMatchedNothing(
       teacherId: string,
       id: string,
       cas: InvitationCasScope,
       door: ContactDoor,
     ) {
     ```
   - In the comment at `:83-88`, change `it falls to the neutral 409 below, never to \`DECLINED()\`/\`NOT_PENDING()\`` to `it falls to the \`CONTACT_CHANGED\` 409 below, never to \`DECLINED\`/\`NOT_PENDING\``.
   - `:95`: `if (observed.status === 'declined') return DECLINED();` → `if (observed.status === 'declined') return DECLINED(door);`
   - `:121-124`:
     ```ts
       return respondError(
         'This contact changed while you were working on it. Reload and try again.',
         409,
       );
     ```
     →
     ```ts
       return respondError(
         'This contact changed while you were working on it. Reload and try again.',
         409,
         'CONTACT_CHANGED',
       );
     ```

4. **PUT.**
   - `:158`: `if (invitation.status === 'declined') return DECLINED();` → `if (invitation.status === 'declined') return DECLINED('edit');`
   - In the comment at `:192-207`, replace the last sentence, from `` `ALREADY_INVITED` is this domain's existing name for `` through `can act on.`, with:
     ```ts
     // instead: the same shape `POST /api/registrations` uses for its own
     // unique collision. `CONTACT_EMAIL_TAKEN` names exactly this — another of
     // this teacher's contacts holds the address — and the message is the
     // edit form's, because that is what the teacher standing on this page
     // can act on.
     ```
     This keeps the opening `// A pre-check would leave the race the fallback is for, so this catches` line.
   - `:254-260`:
     ```ts
         if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
           return respondError(
             'Another of your contacts already uses this email address.',
             409,
             'ALREADY_INVITED',
           );
         }
     ```
     →
     ```ts
         if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
           return respondError(
             'Another of your contacts already uses this email address.',
             409,
             'CONTACT_EMAIL_TAKEN',
           );
         }
     ```
   - `:265`: `if (changed.count === 0) return casMatchedNothing(session.teacherId, id, scope);` → `if (changed.count === 0) return casMatchedNothing(session.teacherId, id, scope, 'edit');`

5. **DELETE.**
   - `:285`: `return DECLINED();` → `return DECLINED('remove');`
   - `:291-294`: replace
     ```ts
       // CASes on `status: 'accepted'`. What a count of 0 MEANS is
       // `casMatchedNothing`'s question — a decline is only one of its answers, and
       // "the row is already gone" is the other, which for a DELETE is the retry
       // this route is meant to survive.
     ```
     with:
     ```ts
       // CASes on `status: 'accepted'`. What a count of 0 MEANS is
       // `casMatchedNothing`'s question — a decline is only one of its answers,
       // and "the row is already gone" is another: 404 `NOT_FOUND`, which the
       // client that sent this delete (`remove-student-button.tsx`) treats as
       // done.
     ```
   - `:299`: `if (removed.count === 0) return casMatchedNothing(session.teacherId, id, scope);` → `if (removed.count === 0) return casMatchedNothing(session.teacherId, id, scope, 'remove');`

6. **PATCH (`:337-341`).** Replace
   ```ts
     const updated = await prisma.invitation.update({
       where: { id },
       data: { isArchived: archiving },
       select: { isArchived: true },
     });
   ```
   with:
   ```ts
     let updated: { isArchived: boolean };
     try {
       updated = await prisma.invitation.update({
         where: { id },
         data: { isArchived: archiving },
         select: { isArchived: true },
       });
     } catch (err) {
       // The row was read above and deleted before this write — the teacher's
       // other tab removed the contact. It gets the same answer as an id that
       // is not theirs.
       if (isRecordNotFound(err)) return NOT_FOUND();
       throw err;
     }
   ```

`src/app/api/invitations/[id]/resend/route.ts:75`: `if (invitation.status === 'declined') return DECLINED();` → `if (invitation.status === 'declined') return DECLINED('resend');`

- [ ] **Step 8: Teacher links, privacy, and the lock-order rows that quote them**

`src/app/api/teacher-links/[teacherId]/route.ts:46-50`:

```ts
      case 'STUDENT_ERASED':
        return respondError('This account has been deleted', 409);
      case 'NOT_LINKED':
        return respondError('Teacher link not found', 404);
```
→
```ts
      case 'STUDENT_ERASED':
        return respondError('This account has been deleted.', 409, 'STUDENT_ERASED');
      case 'NOT_LINKED':
        return respondError("You're no longer connected to this teacher.", 404, 'NOT_FOUND');
```

`src/app/api/students/[id]/privacy/route.ts:117`:

```ts
        return respondError('This account has been deleted', 409);
```
→
```ts
        return respondError('This account has been deleted.', 409, 'STUDENT_ERASED');
```

`docs/lock-order.md:1127-1129`: the table rows for `acceptInvitation`, `unlinkTeacher` and `updateStudentPrivacy` quote the answers Steps 6 and 8 recode. They now name codes instead of copy. In each row's last cell, change only the text shown below.

- `:1127` (`acceptInvitation`): `refuses the raced case: 409, \`This account has been deleted\` (\`POST /api/invitations/[id]/respond\`); a fully committed erasure is answered 404 \`Invitation not found\` instead,` → `refuses the raced case: 409 \`STUDENT_ERASED\` (\`POST /api/invitations/[id]/respond\`); a fully committed erasure is answered 404 \`NOT_FOUND\` instead,`
- `:1128` (`unlinkTeacher`): `refuses the raced case: 409, \`This account has been deleted\` (\`DELETE /api/teacher-links/[teacherId]\`); a fully committed erasure is answered 404 \`Teacher link not found\` instead,` → `refuses the raced case: 409 \`STUDENT_ERASED\` (\`DELETE /api/teacher-links/[teacherId]\`); a fully committed erasure is answered 404 \`NOT_FOUND\` instead,`
- `:1129` (`updateStudentPrivacy`): `refuses the raced case: 409, \`This account has been deleted\` (\`PUT /api/students/[id]/privacy\`);` → `refuses the raced case: 409 \`STUDENT_ERASED\` (\`PUT /api/students/[id]/privacy\`);`

Leave `:1126` (`POST /api/registrations`) alone: Task 5 owns that row's answers.

Check that no copy these steps replaced is still quoted in `docs/`:

```bash
rg -n "This account has been deleted|Teacher link not found|Invitation not found|Contact not found" docs --glob '!docs/superpowers/**'
```

Expected: only `docs/lock-order.md:1126`, the registrations row. Name any other hit in the report.

- [ ] **Step 9: Rewrite the existing tests this change breaks**

1. `tests/integration/students-api.test.ts:1429-1431`. In the comment, replace `Repeating one address would now be refused by \`inviteContact\`'s ALREADY_INVITED branch from the second request on, so a run of 409s` with `Repeating one address would now answer \`unchanged\` (same names) or ALREADY_INVITED (different ones) from the second request on, so a run of those`.

2. `tests/integration/students-api.test.ts:1506-1509`. Replace `repeated invites to an address already invited are refused with 409 ALREADY_INVITED by \`inviteContact\`, well after` with `repeated invites to an address already invited, under different names, are refused with 409 ALREADY_INVITED by \`inviteContact\`, well after`.

3. `tests/integration/students-api.test.ts:1542`. Replace `// Hits 2..49: the same address every time, refused as ALREADY_INVITED` with `// Hits 2..49: the same address every time under a different last name, refused as ALREADY_INVITED`.

4. `tests/integration/students-api.test.ts:1647-1692`. Keep the title, and add as the test's first line:
   ```ts
       // The holder's names differ from the request's. A twin with the same
       // names answers unchanged: `src/app/api/students/route-lock-order.test.ts`.
   ```
   Replace `:1682-1687`:
   ```ts
       expect(res.status).toBe(409);
       const body = (await res.json()) as { error: { code?: string; message: string } };
       expect(body.error.code).toBe('ALREADY_INVITED');
       expect(body.error.message).toBe(
         'You have already invited this person — open their contact to resend or update their details.',
       );
   ```
   with:
   ```ts
       await expectRefusal(res, 'ALREADY_INVITED');
   ```

5. `tests/integration/invitations-api.test.ts:534-539`. Old:
   ```ts
         expect(res.status).toBe(409);
         const body = (await res.json()) as { error: { message: string; code?: string } };
         expect(body.error.code).toBe('ALREADY_INVITED');
         expect(body.error.message).toBe('Another of your contacts already uses this email address.');
         // The exact string this test exists to keep off a contact form.
         expect(body.error.message).not.toBe('Resource already exists');
   ```
   New:
   ```ts
         // Its own code, not the escaped-P2002 fallback's.
         await expectRefusal(res, 'CONTACT_EMAIL_TAKEN');
   ```

6. `tests/integration/invitations-api.test.ts:1402-1411` (`it('refuses an invitation addressed to someone else')`). Replace `expect(res.status).toBe(404);` (`:1407`) with `await expectRefusal(res, 'NOT_FOUND');`.

7. `tests/integration/invitations-api.test.ts:1572-1576`. Old:
   ```ts
     it('refuses a second response to the same invitation', async () => {
       const again = await respond(inviteId, respondingToken, 'decline');
       expect(again.status).toBe(409);
       expect((await again.json()).error.code).toBe('ALREADY_ANSWERED');
     });
   ```
   New:
   ```ts
     it('refuses a decline of an invitation this student accepted', async () => {
       const again = await respond(inviteId, respondingToken, 'decline');
       await expectRefusal(again, 'ALREADY_ANSWERED');
     });
   ```

8. `tests/integration/invitations-api.test.ts:1809-1814` (`it('404s when no link exists')`). Replace `expect(res.status).toBe(404);` with `await expectRefusal(res, 'NOT_FOUND');`.

9. `tests/integration/invitations-api.test.ts:1865-1872`. Old:
   ```ts
         // Unlike the design this replaces, the first POST to a blocked address
         // really does create a row — so a second POST to either address now
         // refuses the same way, for the same reason: both are already invited.
         const [blockedAgain, freshAgain] = await Promise.all([post(blockedEmail), post(freshEmail)]);
         expect(blockedAgain.status).toBe(freshAgain.status);
         expect(blockedAgain.status).toBe(409);
         expect((await blockedAgain.json()).error.code).toBe('ALREADY_INVITED');
         expect((await freshAgain.json()).error.code).toBe('ALREADY_INVITED');
   ```
   New:
   ```ts
         // Unlike the design this replaces, the first POST to a blocked address
         // really does create a row, so the same POST again answers the same way
         // for either address: the invitation already stands, unchanged, and
         // neither marker moves.
         const [blockedAgain, freshAgain] = await Promise.all([post(blockedEmail), post(freshEmail)]);
         expect(blockedAgain.status).toBe(freshAgain.status);
         expect(await expectUnchanged(blockedAgain)).toEqual({ id: blockedJson.data.id });
         expect(await expectUnchanged(freshAgain)).toEqual({ id: freshJson.data.id });
         const [blockedAfter, freshAfter] = await Promise.all([
           prisma.invitation.findUniqueOrThrow({ where: { id: blockedJson.data.id } }),
           prisma.invitation.findUniqueOrThrow({ where: { id: freshJson.data.id } }),
         ]);
         expect(blockedAfter.lastNotifiedAt).toEqual(blockedInvitation.lastNotifiedAt);
         expect(freshAfter.lastNotifiedAt).toEqual(freshInvitation.lastNotifiedAt);
   ```

10. `tests/integration/invitations-api.test.ts:2903-2935`. Rename the test to `'a booking by a linked-but-unshared student leaves the decoy pending, so a re-probe answers as a stranger\'s would'`. In the docblock above it (`:2898-2901`), replace the paragraph starting `The second probe's REASON is the assertion` with:
    ```ts
     * The second probe's OUTCOME is the assertion: it repeats the first probe's
     * names, so a stranger's address answers `unchanged`, and only
     * `ALREADY_LINKED` would tell the teacher that the address they guessed
     * belongs to one of their own students.
    ```
    Replace the probe-two comment and assertion (`:2931-2935`):
    ```ts
          // Probe two: the observable. Same refusal an un-accepted stranger's
          // address produces.
          const probeTwo = await inviteContact(prisma, {
            teacherId: resolveTeacherId, email: gatedEmail, firstName: 'Guessed', lastName: 'Address',
          });
          expect(probeTwo).toEqual({ ok: false, reason: 'ALREADY_INVITED' });
    ```
    with:
    ```ts
          // Probe two: the observable. The same answer a stranger's pending
          // invitation gives to the same names.
          const probeTwo = await inviteContact(prisma, {
            teacherId: resolveTeacherId, email: gatedEmail, firstName: 'Guessed', lastName: 'Address',
          });
          expect(probeTwo).toEqual({
            ok: true, outcome: 'unchanged', value: { id: probeOne.value.id, delivered: false },
          });
    ```

11. `tests/integration/invitations-api.test.ts:3811-3815`. Old:
    ```ts
        // The code first: answering DECLINED_IS_PERMANENT here is the defect, and
        // a bare 404-vs-409 check would not say which wrong thing was said.
        const body = (await res.json()) as { error: { code?: string } };
        expect(body.error.code).toBeUndefined();
        expect(res.status).toBe(404);
    ```
    New:
    ```ts
        // The code, not just the status: answering DECLINED_IS_PERMANENT here is
        // the defect, and a bare 404-vs-409 check would not say which wrong
        // thing was said.
        await expectRefusal(res, 'NOT_FOUND');
    ```

12. `src/services/link-consent.test.ts:251-275`.
    - Rename the test to `'a gated address answers a same-names re-probe as a stranger\'s would, after the student books'`.
    - In the docblock (`:248-249`), replace `The reason string is the assertion, not the refusal: both outcomes are \`ok: false\`, and only one of them is the disclosure.` with `The whole result is the assertion: a stranger's pending invitation answers a same-names probe \`unchanged\`, and only \`ALREADY_LINKED\` is the disclosure.`
    - Replace `:274`:
      ```ts
          expect(probeTwo).toEqual({ ok: false, reason: 'ALREADY_INVITED' });
      ```
      with:
      ```ts
          expect(probeTwo).toEqual({
            ok: true, outcome: 'unchanged', value: { id: probeOne.value.id, delivered: false },
          });
      ```

13. `src/services/invitations.decline.test.ts:132`: `expect(declined).toEqual({ ok: true });` → `expect(declined).toEqual({ ok: true, outcome: 'applied' });`. `:374` and `:462` (both `acceptInvitation`): `})).toEqual({ ok: true });` → `})).toEqual({ ok: true, outcome: 'applied' });`. Leave `:379` and `:473` (`unlinkTeacher`) as they are.

14. `src/services/invitations-lock-order.test.ts`:
    - **`:515`.** `expect(result).toEqual({ ok: true });` → `expect(result).toEqual({ ok: true, outcome: 'applied' });`. That fixture has no link, so the accept creates one.
    - **`:752`.** Same replacement, with a line above it:
      ```ts
          // `applied`, not `unchanged`: this student had no link, so the call made one.
      ```
    - **`:764`.** Rename the test to `'a pending invitation deleted mid-accept answers NOT_FOUND, not a bare 500'`. In its docblock (`:755-763`), add as the last sentence: `The row is gone, so the answer is the one an unknown id gets.`
    - **`:799`.** `expect(acceptResult).toEqual({ ok: false, reason: 'NOT_PENDING' });` → `expect(acceptResult).toEqual({ ok: false, reason: 'NOT_FOUND' });`
    - **`:1594-1595`.** `expect(await acceptInvitation(prisma, { invitationId, studentId, accountEmail: email })).toEqual({ ok: true });` → `….toEqual({ ok: true, outcome: 'applied' });`. That first accept moves a pending row.

15. `src/app/api/students/[id]/privacy/route-lock-order.test.ts`.
    - Delete `:26` (`const DELETED_MESSAGE = 'This account has been deleted';`).
    - Replace `:28` with `type Settled = { status: number; code: string | null };`.
    - Replace `settle` (`:45-59`) with:
      ```ts
      function settle(response: Promise<Response>): Promise<Settled> {
        return response.then(
          async (res) => {
            const json: unknown = await res.json().catch(() => null);
            const error =
              typeof json === 'object' && json !== null && 'error' in json ? json.error : null;
            const code =
              typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
                ? error.code
                : null;
            return { status: res.status, code };
          },
          (err: unknown) => ({ status: -1, code: String(err) }),
        );
      }
      ```
    - Replace `:213` (`expect(await writing?.racer).toEqual({ status: 409, message: DELETED_MESSAGE });`) with:
      ```ts
            expect(await writing?.racer).toEqual({ status: 409, code: 'STUDENT_ERASED' });
      ```

16. `src/app/api/invitations/[id]/cas-scope.test.ts`.
    - **Docblock `:21-23`.** The line reference there has gone stale (the test is no longer at `:3474`), so name the test instead. Replace
      ```ts
       * integration suite already runs for DELETE+gone ("404s a delete whose row
       * vanished mid-request...", `tests/integration/invitations-api.test.ts:3474`)
      ```
      with:
      ```ts
       * integration suite already runs for DELETE+gone ("404s a delete whose row
       * vanished mid-request, rather than blaming a decline", in
       * `tests/integration/invitations-api.test.ts`)
      ```
    - Add `import { expectRefusal } from '../../../../../tests/api-assertions';` after the `next/server` import (`:2`).
    - After `const { PUT, DELETE } = await import('./route');` (`:61`), add `const { DECLINED } = await import('./shared');`.
    - After `ACCEPTED_ROW` (`:64`), add:
      ```ts
      const DECLINED_ROW = { id: 'inv-1', status: 'declined', isArchived: false, email: 'contact@test.local' };
      ```
    - In the four existing tests:
      - **`:87` and `:93-95`.** Rename the test to `'PUT answers NOT_FOUND when the post-CAS re-read finds the row gone'`, and replace
        ```ts
            expect(res.status).toBe(404);
            const payload = (await res.json()) as { error: { message: string; code?: string } };
            expect(payload.error.message).toBe('Contact not found');
        ```
        with `await expectRefusal(res, 'NOT_FOUND');`.
      - **`:105` and `:111-116`.** Rename to `"DELETE answers CONTACT_CHANGED when the re-read finds an accepted row, proving cas === 'pending' is what excludes it"`, and replace the `expect(res.status)…` through the message assertion with `await expectRefusal(res, 'CONTACT_CHANGED');`. In the comment at `:117-124`, change `fall through to this same generic 409` to `fall through to this same CONTACT_CHANGED 409`.
      - **`:131` and `:137-142`.** Rename to `"PUT answers CONTACT_CHANGED for the 'unread' arm when the re-read itself rejects"`, and replace the four assertion lines with `await expectRefusal(res, 'CONTACT_CHANGED');`.
      - **`:145` and `:151-156`.** Rename to `"DELETE answers CONTACT_CHANGED for the 'unread' arm when the re-read itself rejects"`, with the same replacement.
    - Append inside the describe:
      ```ts
        it('PUT words a decline found after its CAS for the edit it refused', async () => {
          findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(DECLINED_ROW);
          updateMany.mockResolvedValueOnce({ count: 0 });

          const res = await PUT(put(), { params: params() });

          expect(res.status).toBe(409);
          expect(await res.json()).toEqual(await DECLINED('edit').json());
        });

        it('DELETE words a decline found after its CAS for the removal it refused', async () => {
          findFirst.mockResolvedValueOnce(PENDING_ROW).mockResolvedValueOnce(DECLINED_ROW);
          deleteMany.mockResolvedValueOnce({ count: 0 });

          const res = await DELETE(del(), { params: params() });

          expect(res.status).toBe(409);
          expect(await res.json()).toEqual(await DECLINED('remove').json());
        });
      ```

17. `tests/integration/invitations-api.test.ts:3710-3711` (the #196 delete race) and `:3763-3764` (the put race) assert `DECLINED_IS_PERMANENT` by code, and still hold unchanged. The put race now receives the edit door's sentence, which it does not read.

- [ ] **Step 10: Clients**

Which clients need no code change, because they check only `res.ok` (a 200 `unchanged` is success there):
- `ContactForm`, `ArchiveContactButton` and `ResendInvitationButton` (`src/components/students/contact-form.tsx`).
- `PendingInvitationCard` (`src/components/student/pending-invitation-card.tsx`).

`ArchiveContactButton` and `ResendInvitationButton` do not delete anything, so a `NOT_FOUND` stays an error for both (spec §5.3).

1. **`src/components/students/contact-form.tsx:68-72`, comment only.** Replace
   ```tsx
           // #166: a declined contact's row is a tombstone — the PUT 409s with
           // its own explanation (DECLINED_IS_PERMANENT), which `readErrorMessage`
           // surfaces verbatim instead of a generic retry prompt. Same idiom as
           // `teacher-privacy-card.tsx`'s 403 handling, for the same reason: a
           // retry can't fix a state this specific.
   ```
   with:
   ```tsx
           // #166: a declined contact's row is a tombstone — the PUT 409s with
           // its own explanation (DECLINED_IS_PERMANENT), which `readErrorMessage`
           // surfaces verbatim instead of a generic retry prompt: a retry can't
           // fix a state this specific.
   ```

   Its test `src/components/students/contact-form.test.tsx`:
   - **`:6-13`.** In the docblock, delete the sentence `The precedent is \`teacher-privacy-card.tsx:75-84\`'s own handling of its 403.`
   - **`:94-118`.** The PUT now sends the edit door's sentence. In `stubDeclined` and in the assertion, replace both occurrences of `'This person declined. You can archive this contact, but it cannot be removed.'` with `"This person declined, so their details can't be changed. You can archive this contact."`.
   - **`:185-198`.** This mocks a body the server never sends. Rename the test to `'shows the server message when the PATCH fails, a missing contact included'`, and replace the mock with:
     ```tsx
         fetchMock.mockResolvedValue({
           ok: false,
           status: 404,
           json: async () => ({ error: { code: 'NOT_FOUND', message: 'This contact no longer exists.' } }),
         });
     ```
     and the assertion `findByText('Contact not found')` with `findByText('This contact no longer exists.')`. `expect(routerPush).not.toHaveBeenCalled()` stays: archiving is not a delete.
   - **`:246-258`.** Replace the mock `{ error: { message: 'This invitation is no longer pending.' } }` with:
     ```tsx
           json: async () => ({
             error: {
               code: 'NOT_PENDING',
               message: 'This person already accepted your invitation. Reload to see the latest.',
             },
           }),
     ```
     and the assertion with `expect(await screen.findByText('This person already accepted your invitation. Reload to see the latest.')).toBeInTheDocument();`.

2. **`src/components/students/remove-student-button.tsx`.** Change `:6` to `import { readError } from '@/lib/client-errors';`. Replace `:33-38`:
   ```tsx
         const res = await fetch(`/api/invitations/${invitationId}`, { method: 'DELETE' });
         if (res.ok) {
           router.push('/students');
         } else {
           setError(await readErrorMessage(res, 'Could not remove the contact. Try again.'));
         }
   ```
   with:
   ```tsx
         const res = await fetch(`/api/invitations/${invitationId}`, { method: 'DELETE' });
         if (res.ok) {
           router.push('/students');
           return;
         }
         const { code, message } = await readError(res, 'Could not remove the contact. Try again.');
         // This button asked for the contact to be gone, so a contact that is
         // already gone is the outcome it asked for.
         if (code === 'NOT_FOUND') {
           router.push('/students');
           return;
         }
         setError(message);
   ```
   In the docblock (`:13-22`), change `arrives through \`readErrorMessage\` below unchanged` to `arrives through \`readError\` below unchanged`.

   Its test `src/components/students/remove-student-button.test.tsx`: in the file docblock (`:12-13`), change `through \`readErrorMessage\` unmodified` to `through \`readError\` unmodified`. Append inside the describe:
   ```tsx
     it('treats a contact that is already gone as removed', async () => {
       fetchMock.mockResolvedValue({
         ok: false,
         status: 404,
         json: async () => ({ error: { code: 'NOT_FOUND', message: 'This contact no longer exists.' } }),
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
       clickThroughConfirm();
       await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/students'));
       expect(screen.queryByText('This contact no longer exists.')).toBeNull();
     });

     it('keeps a contact that changed under the request as an error', async () => {
       fetchMock.mockResolvedValue({
         ok: false,
         status: 409,
         json: async () => ({
           error: {
             code: 'CONTACT_CHANGED',
             message: 'This contact changed while you were working on it. Reload and try again.',
           },
         }),
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<RemoveStudentButton invitationId="inv-1" studentName="Lena Visser" />);
       clickThroughConfirm();
       expect(
         await screen.findByText('This contact changed while you were working on it. Reload and try again.'),
       ).toBeInTheDocument();
       expect(routerPush).not.toHaveBeenCalled();
     });
   ```

3. **`src/components/students/create-student-form.tsx`.** Add `import { readErrorMessage } from '@/lib/client-errors';` after `:9`. Replace `:87-95`:
   ```tsx
         if (!res.ok) {
           const json: { error?: { message?: string } } = await res.json();
           // #166: this route no longer creates a student, it sends an
           // invitation. The fallback only shows when the server sent no
           // message of its own — the 409 refusals all carry theirs, from
           // REFUSAL_MESSAGES.
           setSubmitError(json.error?.message ?? 'Failed to send the invitation');
           return;
         }
   ```
   with:
   ```tsx
         // A repeat the server finds already done answers 200 `unchanged`: the
         // invitation stands, so the confirmation below is true for it too.
         if (!res.ok) {
           // #166: this route no longer creates a student, it sends an
           // invitation. The fallback only shows when the server sent no
           // readable message of its own.
           setSubmitError(await readErrorMessage(res, 'Failed to send the invitation'));
           return;
         }
   ```

   Its test `src/components/students/create-student-form.test.tsx` gets its first error-path tests. Append inside the describe, after `:140`:
   ```tsx
     it('confirms in place when the server reports the invitation already stands', async () => {
       fetchMock.mockResolvedValue({
         ok: true,
         status: 200,
         json: async () => ({ data: { id: 'inv-1' }, outcome: 'unchanged' }),
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<CreateStudentForm />);
       fillForm('Ada', 'Lovelace', 'ada@example.com');
       await submit();
       expect(await screen.findByText(/invitation sent/i)).toBeInTheDocument();
     });

     it('shows the refusal the server sends, and stays on the form', async () => {
       fetchMock.mockResolvedValue({
         ok: false,
         status: 409,
         json: async () => ({
           error: {
             code: 'ALREADY_INVITED',
             message: 'You have already invited this person — open their contact to resend or update their details.',
           },
         }),
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<CreateStudentForm />);
       fillForm('Ada', 'Lovelace', 'ada@example.com');
       await submit();
       expect(
         await screen.findByText(
           'You have already invited this person — open their contact to resend or update their details.',
         ),
       ).toBeInTheDocument();
       expect(screen.queryByText(/invitation sent/i)).toBeNull();
     });

     it('falls back to its own message when the error body cannot be read', async () => {
       vi.spyOn(console, 'error').mockImplementation(() => {});
       fetchMock.mockResolvedValue({
         ok: false,
         status: 502,
         url: '/api/students',
         json: async () => {
           throw new SyntaxError('Unexpected token <');
         },
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<CreateStudentForm />);
       fillForm('Ada', 'Lovelace', 'ada@example.com');
       await submit();
       expect(await screen.findByText('Failed to send the invitation')).toBeInTheDocument();
       vi.restoreAllMocks();
     });
   ```

4. **`src/components/student/pending-invitation-card.tsx:42-50`, comment only.** Replace
   ```tsx
           // #40, superseding review F7. F7 was right that a `finally` reset is
           // wrong here — the answer has committed, so a second click risks
           // undoing or misreporting a real outcome over an action that already
           // worked: a second DECLINE earns a 409 (`ALREADY_ANSWERED`) in red,
           // while a second ACCEPT is now idempotent success (#181) rather than
           // a refusal. F7's remedy was to leave `submitting` true, which froze
           // all four controls when the refresh never committed: a student
           // could give neither answer. Settling blocks the second POST the
           // same way and still leaves them somewhere they can act.
   ```
   with:
   ```tsx
           // #40, superseding review F7. F7 was right that a `finally` reset is
           // wrong here — the answer has committed, so a second click risks
           // misreporting an outcome that already happened. F7's remedy was to
           // leave `submitting` true, which froze all four controls when the
           // refresh never committed: a student could give neither answer.
           // Settling blocks the second POST the same way and still leaves them
           // somewhere they can act. A repeated answer that does reach the
           // route is a 200 `unchanged`, and it settles here too.
   ```

   Its test `src/components/student/pending-invitation-card.test.tsx`: after `it('settles to "Declined" after a successful decline')` (ends `:92`), add:
   ```tsx
     it('settles to "Declined" when the server reports the decline was already given', async () => {
       fetchMock.mockResolvedValue({
         ok: true,
         status: 200,
         json: async () => ({ data: { id: 'inv-1' }, outcome: 'unchanged' }),
       });
       vi.stubGlobal('fetch', fetchMock);
       render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
       fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
       fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));

       expect(await screen.findByText(/^Declined/)).toBeInTheDocument();
       expect(routerRefresh).toHaveBeenCalledTimes(1);
     });
   ```
   At `:250-257`, the mock and the assertion both read `'This invitation has already been answered'`. Change both to `'This invitation has already been answered.'`, the body the server now sends.

5. **`src/components/student/teacher-privacy-card.tsx`.**
   - `:10` → `import { readError } from '@/lib/client-errors';`
   - Replace `:90-104`:
     ```tsx
           if (res.ok) {
             setSaved(true);
           } else if (res.status === 403) {
             // The route 403s a teacher this student has no TeacherStudent link to,
             // …
             // this page is signed in and therefore claimed.)
             setError('This teacher is no longer connected to your account, so these settings no longer apply.');
           } else {
             setError('Could not save. Try again.');
           }
     ```
     with:
     ```tsx
           if (res.ok) {
             setSaved(true);
           } else if ((await readError(res, '')).code === 'TEACHER_NOT_LINKED') {
             // The route answers `TEACHER_NOT_LINKED` for a teacher this student
             // has no TeacherStudent link to, and a link can disappear while this
             // card is on screen: `deleteTeacherAccount` (services/gdpr.ts)
             // hard-deletes every link a teacher has, and this student's own
             // unlink in another tab deletes this one. "Try again" would be advice
             // for a state no retry can reach. Keyed on the code, not the status:
             // `NOT_YOUR_PROFILE` is a 403 too, and it is not this state.
             setError('This teacher is no longer connected to your account, so these settings no longer apply.');
           } else {
             setError('Could not save. Try again.');
           }
     ```
   - Replace the docblock paragraph `:124-129` with:
     ```tsx
      * `unlinking` is deliberately not reset on success (review F7): the DELETE
      * has committed, and a second one must not be sent. Leaving the flag true
      * froze this cluster whenever the refresh did not commit, so the card
      * settles instead (`unlinked`, #40), which blocks the second DELETE and
      * still leaves the student a control that works. A DELETE that reaches the
      * route after the link is already gone answers 404 `NOT_FOUND`, and the
      * card settles on that too: gone is what this control asked for.
     ```
   - Replace `:135-143`:
     ```tsx
           const res = await fetch(`/api/teacher-links/${teacherId}`, { method: 'DELETE' });
           if (res.ok) {
             setUnlinked(true);
             router.refresh();
             return;
           }
           setUnlinkError(await readErrorMessage(res, 'Could not remove this teacher. Try again.'));
           setUnlinking(false);
     ```
     with:
     ```tsx
           const res = await fetch(`/api/teacher-links/${teacherId}`, { method: 'DELETE' });
           const failure = res.ok
             ? null
             : await readError(res, 'Could not remove this teacher. Try again.');
           if (failure === null || failure.code === 'NOT_FOUND') {
             setUnlinked(true);
             router.refresh();
             return;
           }
           setUnlinkError(failure.message);
           setUnlinking(false);
     ```

   Its test `src/components/student/teacher-privacy-card.test.tsx`:
   - **`:89-92`.** Replace `stubFailure` with:
     ```tsx
       function stubFailure(status: number, body: unknown = {}) {
         fetchMock.mockResolvedValue({ ok: false, status, json: async () => body });
         vi.stubGlobal('fetch', fetchMock);
       }
     ```
   - **`:105-117`.** Change the comment's `these two pin that only the retryable failure says "try again".` to `these pin that only a lost link says the link is gone.` Rename the test to `'TEACHER_NOT_LINKED says the link is gone, and does not suggest retrying'`, and change its first line to:
     ```tsx
         stubFailure(403, { error: { code: 'TEACHER_NOT_LINKED', message: 'Access denied' } });
     ```
   - **After `:124`**, add:
     ```tsx
       it('does not read every 403 as a lost link', async () => {
         stubFailure(403, { error: { code: 'NOT_YOUR_PROFILE', message: 'Access denied' } });
         renderCard();
         fireEvent.click(screen.getByRole('button', { name: /save/i }));
         await waitFor(() => expect(screen.getByText('Could not save. Try again.')).toBeTruthy());
         expect(screen.queryByText(/no longer connected to your account/i)).toBeNull();
       });
     ```
   - **`:258-274`.** This used an uncoded 404, which is now a success. Replace the mock with:
     ```tsx
           fetchMock.mockResolvedValue({
             ok: false,
             status: 409,
             json: async () => ({
               error: { code: 'STUDENT_ERASED', message: 'This account has been deleted.' },
             }),
           });
     ```
     and change both `'Teacher link not found'` strings in that test to `'This account has been deleted.'`.
   - **`:296-308`.** Same mock replacement, and change the `findByText('Teacher link not found')` to `findByText('This account has been deleted.')`.
   - **After `:308`**, inside `describe('unlinking a teacher')`, add:
     ```tsx
         it('settles as removed when the link is already gone', async () => {
           fetchMock.mockResolvedValue({
             ok: false,
             status: 404,
             json: async () => ({
               error: { code: 'NOT_FOUND', message: "You're no longer connected to this teacher." },
             }),
           });
           vi.stubGlobal('fetch', fetchMock);
           renderCard();
           fireEvent.click(screen.getByRole('button', { name: /remove this teacher/i }));
           fireEvent.click(screen.getByRole('button', { name: /^remove teacher$/i }));

           expect(await screen.findByText(/^Removed/)).toBeInTheDocument();
           expect(routerRefresh).toHaveBeenCalledTimes(1);
           expect(screen.queryByText("You're no longer connected to this teacher.")).toBeNull();
         });
     ```

`DELETE /api/teacher-links/[teacherId]` has no other caller: `rg -n "api/teacher-links" src --glob '!*.test.*' --glob '!src/app/api/**'` finds only `teacher-privacy-card.tsx`.

- [ ] **Step 11: Run everything green**

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean. A `tsc` error at any `inviteContact`, `acceptInvitation` or `declineInvitation` call site this task did not name means the caller census above missed it. Fix it the same way, and name it in the report.

Run: `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts src/app/api/invitations/[id]/cas-scope.test.ts src/app/api/invitations/[id]/put-readdress-delivered.test.ts src/app/api/invitations/[id]/respond/reason-map.test.ts src/app/api/teacher-links/[teacherId]/reason-map.test.ts src/app/api/students/dispatch-threading.test.ts src/services/invitations.decline.test.ts src/services/invitations.gate.test.ts src/services/invitations.revive.test.ts src/services/invitations.notify.test.ts src/services/link-consent.test.ts src/app/api/registrations/route.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts src/app/api/students/route-lock-order.test.ts 'src/app/api/invitations/[id]/route-lock-order.test.ts' 'src/app/api/students/[id]/privacy/route-lock-order.test.ts'`
Expected: PASS.

Run: `pnpm exec vitest run --project components src/components/students/create-student-form.test.tsx src/components/students/contact-form.test.tsx src/components/students/remove-student-button.test.tsx src/components/student/pending-invitation-card.test.tsx src/components/student/teacher-privacy-card.test.tsx`
Expected: PASS.

With the worktree app up, run: `pnpm exec vitest run --project integration tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts tests/integration/privacy-api.test.ts tests/integration/notifications-stream.test.ts`
Expected: PASS.

With the worktree app up, run: `pnpm exec playwright test tests/e2e/invitations.spec.ts`
Expected: PASS. It adds, accepts and declines once each, and reads no refusal copy.

- [ ] **Step 12: Commit**

```bash
git add src/services/invitations.ts src/app/api/students/route.ts src/app/api/students/route-lock-order.test.ts "src/app/api/invitations/[id]/respond/route.ts" "src/app/api/invitations/[id]/respond/reason-map.test.ts" "src/app/api/invitations/[id]/shared.ts" "src/app/api/invitations/[id]/route.ts" "src/app/api/invitations/[id]/route-lock-order.test.ts" "src/app/api/invitations/[id]/resend/route.ts" "src/app/api/invitations/[id]/cas-scope.test.ts" "src/app/api/teacher-links/[teacherId]/route.ts" "src/app/api/teacher-links/[teacherId]/reason-map.test.ts" "src/app/api/students/[id]/privacy/route.ts" "src/app/api/students/[id]/privacy/route-lock-order.test.ts" docs/lock-order.md vitest.tiers.ts src/services/invitations.decline.test.ts src/services/invitations-lock-order.test.ts src/services/link-consent.test.ts src/components/students/create-student-form.tsx src/components/students/create-student-form.test.tsx src/components/students/contact-form.tsx src/components/students/contact-form.test.tsx src/components/students/remove-student-button.tsx src/components/students/remove-student-button.test.tsx src/components/student/pending-invitation-card.tsx src/components/student/pending-invitation-card.test.tsx src/components/student/teacher-privacy-card.tsx src/components/student/teacher-privacy-card.test.tsx tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts
git commit -m "fix(api): repeated invites and answers are unchanged; contact and link refusals carry codes (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 13: Prove the guards bite**

For each mutation: apply it; for a route, send one request to that route first; run the named command and record the exact failure; restore with `git checkout -- <path>`; re-run it green. The integration runs need the worktree app up.

1. **Invite name comparison.** In `src/services/invitations.ts`, in `isRepeatOf`, change the `(Object.keys(REPEAT_COMPARED) …).every(…)` operand to `true`. Run `pnpm exec vitest run --project integration tests/integration/students-api.test.ts`. "refuses a repeat whose names differ with ALREADY_INVITED" fails with status 200.
1a. **Archived pending row.** In `isRepeatOf`, delete `!row.isArchived &&`. Run `tests/integration/students-api.test.ts`. "refuses a same-names repeat of an archived contact with ALREADY_INVITED, and leaves it archived" fails with status 200 `unchanged`.
2. **Compile-time tether.** Delete `lastName: true,` from `REPEAT_COMPARED`. Run `pnpm run typecheck`. It reports a `satisfies` error (`Property 'lastName' is missing`).
3. **Invite ordering.** Change the pre-check read to `db.invitation.findFirst({ where: { email }, select: REPEAT_SELECT })`. Run `tests/integration/students-api.test.ts`. "creates a separate invitation for another teacher's identical body" fails: status 200 `unchanged`, not 201.
4. **Invite race re-read.** In the create catch, replace the re-read and ternary with `return { ok: false, reason: 'ALREADY_INVITED' };`. Run `pnpm exec vitest run --project unit-sweeps src/app/api/students/route-lock-order.test.ts`. It fails with 409 `ALREADY_INVITED`.
5. **Route stamps an unchanged invite.** In `src/app/api/students/route.ts`, delete the `if (result.outcome === 'unchanged') { … }` block. Run `pnpm run typecheck`; it passes, because both arms carry `value.id` and `value.delivered`. Then run `tests/integration/students-api.test.ts` and `pnpm exec vitest run --project unit-sweeps src/app/api/students/route-lock-order.test.ts`. The identical-repeat tests fail with status 201 and a moved `lastNotifiedAt`; the race test fails on `lastNotifiedAt: null`.
6. **Accept ignores the link outcome.** In `src/services/invitations.ts`, change `if (link === 'already-linked') outcome = 'unchanged';` to `outcome = 'unchanged';`. Run `pnpm exec vitest run --project unit src/services/invitations.decline.test.ts`; "answers an accept that restores a missing link as applied" fails. Run `unit-sweeps src/services/invitations-lock-order.test.ts`; "an invitation already accepted by a different writer…" fails on `outcome`.
7. **Accept never unchanged.** Delete the line `if (link === 'already-linked') outcome = 'unchanged';`. Run `tests/integration/invitations-api.test.ts` and `unit src/services/invitations.decline.test.ts`. "answers a repeated accept unchanged" fails in both: the route answers `outcome: undefined`, the service `'applied'`.
8. **Accept's gone row.** Change `if (current === null) throw new AcceptMissError('NOT_FOUND');` to `if (current === null) throw new NotPendingError();`. Run `unit-sweeps src/services/invitations-lock-order.test.ts`. "a pending invitation deleted mid-accept answers NOT_FOUND" fails with `'NOT_PENDING'`.
8a. **Accept's moved-back row.** Delete `if (current.status === 'pending') throw new AcceptMissError('CONCURRENT_MODIFICATION');`. Run `unit src/services/invitations.decline.test.ts`. The accept `CONCURRENT_MODIFICATION` test fails with `'NOT_PENDING'`. Then delete `if (current.status === 'pending') { return { ok: false, reason: 'CONCURRENT_MODIFICATION' } as const; }` in `declineInvitation` and run the same file: the decline `CONCURRENT_MODIFICATION` test fails the same way. Restore both.
9. **Decline's re-read.** In `declineInvitation`, change `if (current.status === 'declined') return { ok: true, outcome: 'unchanged' } as const;` to `if (current.status === 'declined') return { ok: false, reason: 'NOT_PENDING' } as const;`. Run `unit src/services/invitations.decline.test.ts`; "answers a repeated decline unchanged" fails. Run `integration tests/integration/invitations-api.test.ts`; its repeated-decline test fails with 409 `ALREADY_ANSWERED`.
10. **Decline's gone row.** Change `if (current === null) return { ok: false, reason: 'NOT_FOUND' } as const;` to `…reason: 'NOT_PENDING'…`. Run `unit src/services/invitations.decline.test.ts`. The deleted-row decline test fails.
11. **Respond ownership.** In `declineInvitation`'s read, change `where: { id: input.invitationId, email }` to `where: { id: input.invitationId }`. Run `tests/integration/invitations-api.test.ts`. "answers NOT_FOUND, not unchanged, to a repeat of someone else's answer" fails with status 200, as does the existing "refuses to decline an invitation addressed to someone else".
12. **Respond mapping.** In `respond/route.ts`, change `if (result.outcome === 'unchanged') return respondUnchanged<{ id: string }>({ id });` to `if (result.outcome === 'unchanged') return respondOk({ id });`. Run `unit 'src/app/api/invitations/[id]/respond/reason-map.test.ts'`. Both unchanged cases fail with `outcome: undefined`.
13. **`NOT_FOUND()` code.** In `shared.ts`, drop `, 'NOT_FOUND'` from `NOT_FOUND`. Run `unit 'src/app/api/invitations/[id]/cas-scope.test.ts'` and `tests/integration/invitations-api.test.ts`. The `NOT_FOUND` cases fail with `code: undefined`.
14. **`CONTACT_CHANGED` code.** In `route.ts`, drop `'CONTACT_CHANGED'` from `casMatchedNothing`'s last `respondError`. Run `unit 'src/app/api/invitations/[id]/cas-scope.test.ts'`. The three `CONTACT_CHANGED` cases fail.
15. **Door wording.** In `casMatchedNothing`, change `return DECLINED(door);` to `return DECLINED('remove');`. Run `unit 'src/app/api/invitations/[id]/cas-scope.test.ts'`. "PUT words a decline found after its CAS for the edit it refused" fails.
16. **PUT's P2002 code.** Change `'CONTACT_EMAIL_TAKEN'` back to `'ALREADY_INVITED'`. Run `tests/integration/invitations-api.test.ts`. The occupied-address test fails on `code`.
17. **PATCH's P2025 catch.** Remove the `try`/`catch` around PATCH's update. Run `unit-sweeps 'src/app/api/invitations/[id]/route-lock-order.test.ts'`. It fails with status 500.
18. **Teacher-link mapping.** In `teacher-links/[teacherId]/route.ts`, drop `, 'NOT_FOUND'`. Run `unit 'src/app/api/teacher-links/[teacherId]/reason-map.test.ts'` and `tests/integration/invitations-api.test.ts`. The `NOT_LINKED` case and both teacher-link 404 tests fail on `code`.
19. **Privacy mapping.** In `privacy/route.ts`, drop `, 'STUDENT_ERASED'`. Run `unit-sweeps 'src/app/api/students/[id]/privacy/route-lock-order.test.ts'`. It fails with `code: null`.
20. **Deleting client, contact.** In `remove-student-button.tsx`, delete the `if (code === 'NOT_FOUND') { … }` block. Run `pnpm exec vitest run --project components src/components/students/remove-student-button.test.tsx`. "treats a contact that is already gone as removed" fails.
21. **Deleting client, link.** In `teacher-privacy-card.tsx`, change `if (failure === null || failure.code === 'NOT_FOUND') {` to `if (failure === null) {`. Run `components src/components/student/teacher-privacy-card.test.tsx`. "settles as removed when the link is already gone" fails.
22. **Privacy card's 403 branch.** In `teacher-privacy-card.tsx`, change `} else if ((await readError(res, '')).code === 'TEACHER_NOT_LINKED') {` to `} else if (res.status === 403) {`. Run `components src/components/student/teacher-privacy-card.test.tsx`. "does not read every 403 as a lost link" fails.
23. **Create form's body read.** In `create-student-form.tsx`, restore `const json: { error?: { message?: string } } = await res.json(); setSubmitError(json.error?.message ?? 'Failed to send the invitation');`. Run `components src/components/students/create-student-form.test.tsx`. The unreadable-body test fails with `Network error. Please try again.`.

---
### Task 10: Tighten the contract, code the classifier's fallbacks, write the rules down

**Must run last** (see File Structure). By now Tasks 2–9 have coded every 409 they touched; this task makes a missed one a compile error and fixes whatever the compiler still finds.

**Files:**
- Modify: `src/lib/api-utils.ts` (`respondError` → overloads over an unexported `sendError`; `withErrorHandler` calls `sendError`), `src/lib/api-utils.test.ts` (`describe('respondError')`, the escaped-P2002 test at `:417-458`), `src/lib/api-errors.ts` (`ApiFailure` at `:49-55`; the four 409 returns in `classifyApiError`), `src/lib/api-errors.test.ts` (`:238-345`), `src/app/api/registrations/route.test.ts` (the escaped-twin test Task 5 left status-only), `docs/technical-architecture.md` (new subsection between `:141` and `:143`), `CLAUDE.md` (new paragraph after `:28`)
- Modify as the compiler directs: any `respondError` call site still passing an uncoded 409 or a `number` status

**Interfaces:**
- Consumes: `ApiErrorCode`, `StatusOf`, `CodeWithStatus` (Task 1)
- Produces:
  ```ts
  export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;
  export function respondError<C extends ApiErrorCode>(message: string, status: StatusOf<C>, code: C): NextResponse;
  export function respondError(message: string, status: Exclude<ErrorStatus, 409>): NextResponse;
  export type ApiFailure =
    | (ApiFailureBase & { readonly status: 409; readonly code: CodeWithStatus<409> })
    | (ApiFailureBase & { readonly status: 500 | 503; readonly code?: CodeWithStatus<500 | 503> });
  ```

- [ ] **Step 1: Write the compile-time pins**

In `src/lib/api-utils.test.ts`, inside `describe('respondError')`, add:

```ts
  /**
   * The `@ts-expect-error` lines are verified by `pnpm run typecheck` only.
   * Each is a guard: loosen the overloads and the directive it sits on
   * becomes unused, which is itself a compile error.
   */
  it('ties a code to its status, and a conflict to a code, at compile time', () => {
    expect(respondError('This class no longer exists.', 404, 'NOT_FOUND').status).toBe(404);
    expect(respondError('Teacher access required', 403).status).toBe(403);

    // @ts-expect-error — a 409 must carry a code
    respondError('A conflict with no code.', 409);

    // @ts-expect-error — NOT_FOUND is registered at 404, not 409
    respondError('Wrong status.', 409, 'NOT_FOUND');

    // @ts-expect-error — PAYMENT_WAIVED is registered at 409, not 404
    respondError('Wrong status.', 404, 'PAYMENT_WAIVED');

    // @ts-expect-error — not a registered code
    respondError('Unknown code.', 409, 'NOT_A_REGISTERED_CODE');

    // @ts-expect-error — a status the app never sends
    respondError('Teapot.', 418);
  });
```

In `src/lib/api-errors.test.ts`, add `type ApiFailure` to the import from `./api-errors` and, as the first `it` inside `describe('classifyApiError')`:

```ts
  it('requires a registered 409 code on every 409 classification, at compile time', () => {
    const coded: ApiFailure = {
      status: 409,
      code: 'UNIQUE_CONFLICT',
      message: 'm',
      logMessage: 'l',
      level: 'warn',
    };
    expect(coded.code).toBe('UNIQUE_CONFLICT');

    // @ts-expect-error — a 409 classification without a code
    const uncoded: ApiFailure = { status: 409, message: 'm', logMessage: 'l', level: 'warn' };

    // @ts-expect-error — a 404 code on a 409 classification
    const misfiled: ApiFailure = { status: 409, code: 'NOT_FOUND', message: 'm', logMessage: 'l', level: 'warn' };

    void [uncoded, misfiled];
  });
```

- [ ] **Step 2: Assert the fallbacks' codes**

In `src/lib/api-errors.test.ts`:
- `:238-245` (P2002): replace `expect(failure.message).toBe('Resource already exists');` with `expect(failure.code).toBe('UNIQUE_CONFLICT');`. In the docblock above the next test (`:247-251`), replace the quoted `"Resource already exists"` with `"That already exists."`, the new client message, and leave the rest.
- `:267-275` (ScheduleRule slot): add `expect(failure.code).toBe('RULE_SLOT_TAKEN');`.
- `:284-294` (CalendarEntry slot): add `expect(failure.code).toBe('ENTRY_SLOT_TAKEN');`.
- `:312-330` (terminal `it.each`): add `expect(failure.code).toBe('CLASS_FROZEN');`.

In `src/lib/api-utils.test.ts:446-447`, replace

```ts
    expect(await res.json()).toEqual({ error: { message: 'Resource already exists' } });
```

with

```ts
    expect(await res.json()).toEqual({
      error: { message: expect.any(String), code: 'UNIQUE_CONFLICT' },
    });
```

In `src/app/api/registrations/route.test.ts`, the test "lets a unique violation whose twin is no longer active reach the error handler" (Task 5 left it asserting status 409 and no `outcome`) now asserts `await expectRefusal(res, 'UNIQUE_CONFLICT');` (import from `../../../../tests/api-assertions`, matching how that file already imports test helpers).

- [ ] **Step 3: See it fail**

Run: `pnpm run typecheck`
Expected: `Unused '@ts-expect-error' directive` at the 409-with-no-code, NOT_FOUND-at-409, PAYMENT_WAIVED-at-404 and status-418 lines in `api-utils.test.ts`, and at both lines in the `ApiFailure` pin. (The unregistered-code line already errors since Task 1.)

Run: `pnpm exec vitest run --project unit src/lib/api-errors.test.ts src/lib/api-utils.test.ts`
Expected: FAIL — `expected undefined to be 'UNIQUE_CONFLICT'` and the three other code assertions.

- [ ] **Step 4: Tighten `respondError`**

In `src/lib/api-utils.ts`, change the registry import to `import type { ApiErrorCode, StatusOf } from './api-error-codes';` and replace `respondError` with:

```ts
/** Every error status the app sends. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

/**
 * A refusal. A code fixes its status (`src/lib/api-error-codes.ts`), so a code
 * sent at another status does not compile; a 409 must name its code, because
 * a conflict is exactly what a client has to tell apart. The rules are in
 * `docs/technical-architecture.md` (The Services Layer → Error responses).
 */
export function respondError<C extends ApiErrorCode>(
  message: string,
  status: StatusOf<C>,
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

function sendError(message: string, status: ErrorStatus, code?: ApiErrorCode): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}
```

In `withErrorHandler`, replace `return respondError(failure.message, failure.status);` with `return sendError(failure.message, failure.status, failure.code);` — its argument is a union no single overload accepts, which is why the implementation is shared rather than reached through the overloads.

- [ ] **Step 5: Code the classifier's 409s**

In `src/lib/api-errors.ts`, add `import type { CodeWithStatus } from './api-error-codes';` and replace `ApiFailure` (`:49-55`), keeping its docblock and adding one sentence to it — "A 409 names its code; a 500 or 503 may." — with:

```ts
type ApiFailureBase = {
  readonly message: string;
  readonly logMessage: string;
  readonly level: 'warn' | 'error';
  readonly detail?: ApiLogDetail;
};

export type ApiFailure =
  | (ApiFailureBase & { readonly status: 409; readonly code: CodeWithStatus<409> })
  | (ApiFailureBase & { readonly status: 500 | 503; readonly code?: CodeWithStatus<500 | 503> });
```

Add a `code` to each 409 return in `classifyApiError`:
- the terminal-trigger branch (`message: 'That class can no longer be changed'`): `code: 'CLASS_FROZEN',`
- the P2002 branch: `code: 'UNIQUE_CONFLICT',` and change its `message` to `'That already exists. Refresh to see the latest.'`
- the `ScheduleRule_teacher_slot_excl` branch: `code: 'RULE_SLOT_TAKEN',`
- the `CalendarEntry_teacher_slot_excl` branch: `code: 'ENTRY_SLOT_TAKEN',`

Search the file for any comment quoting `Resource already exists` (`rg -n "Resource already exists" src`) and replace the quotation with the new message; a comment explaining why the log and client strings differ still holds.

- [ ] **Step 6: Let the compiler find what is left**

Run: `pnpm run typecheck`

Expected: the pins from Step 1 now pass (no unused directives). Any other error is a call site Tasks 2–9 left uncoded or typed loosely. For each:
- an uncoded 409 → give it the code its meaning names, adding a registry entry at 409 if none fits, and keep its wording (spec §6.2's last paragraph);
- a `number` status or `string` code from a map → type the map's values `CodedRefusal` (Task 1) or its status as a literal union;
- a helper that forwards a status (`status: number`) → narrow its parameter to `ErrorStatus` or to the literals it is called with.

List every such site, what you gave it, and why, in the task report. `rg -n "respondError\(" src | wc -l` before and after shows nothing was deleted to silence the compiler.

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

- [ ] **Step 7: Run the suites**

Run: `pnpm exec vitest run --project unit src/lib/api-errors.test.ts src/lib/api-utils.test.ts`
Expected: PASS.

With the worktree app up (`pnpm run worktree:up`), run `pnpm run verify`.
Expected: green. It runs typecheck, lint, every vitest project and the repo checks. State the per-project file counts from its output in the report.

Run: `pnpm run build`
Expected: success. CI also builds, and a build-only defect can pass `verify`.

- [ ] **Step 8: Write the rules down**

In `docs/technical-architecture.md`, insert between the end of "### Work that must not be awaited" (`:141`) and "### Pricing Engine" (`:143`):

```md
### Error responses

A refusal is `respondError(message, status, code)`. The code comes from
`src/lib/api-error-codes.ts`, which fixes one status per code: a 409 without
a code, or a code at another status, does not compile. Clients branch on the
code through `readError` (`src/lib/client-errors.ts`), never on the status —
two refusals can share a status and mean different things — and tests assert
it with `expectRefusal` (`tests/api-assertions.ts`), never the message, so
copy can change without touching a test.

**Already done is not an error.** A request whose goal the server can prove
already holds answers `respondUnchanged(data)`: 200, `{ data, outcome:
'unchanged' }`, no write, no side effect. "Prove" means the stored state
equals what the request asks for, including every value the request carries;
a request carrying values the stored row lacks is not a retry of the request
that made it. In a handler the check sits:

1. after authentication and ownership — before them, "unchanged versus 404"
   would answer whether something exists;
2. after refusals that make the goal moot — the class is cancelled, the
   payment is settled;
3. before every other status, window or capacity refusal, so a retry is never
   refused for a state its own first attempt created.

A delete of a row that is already gone cannot be proven a retry, so it stays
404 `NOT_FOUND`, and the component that issued the delete treats that code as
done. A create that meets its twin stays a refusal naming the conflicting
row.

**Copy.** A refusal message:

- uses the user's terms — never a model or table name, a status literal, an
  id, or a list of valid values;
- says what is true, then the next step when there is one;
- says "someone else" only when the server knows it was not this user;
- is a full sentence in sentence case with a closing period — no "Invalid…",
  "Cannot…: …" or "Must be…", and no apology;
- may vary with the action or the row it names, while its code keeps one
  meaning;
- names anything in the UI by the label the UI shows.

**Adding a code:** one registry entry at its status; the route sends it; a
test asserts it with `expectRefusal`. A reason → response map types its
values `CodedRefusal`, so each entry's status is checked against its own code.
`classifyApiError`'s fallbacks (`src/lib/api-errors.ts`) carry codes too.
```

In `CLAUDE.md`, directly after the `FireAndForget` paragraph (ends at `:28`), add a blank line and:

```md
**Refusals carry a registered code; "already done" answers 200.** Every 409
from `respondError` names a code from `src/lib/api-error-codes.ts`, which fixes
its status, and tests assert the code rather than the message. A request whose
goal already holds answers `respondUnchanged` instead of a red error, with the
check placed after ownership and after any refusal that makes the goal moot.
The rules and the copy register are in `docs/technical-architecture.md` (The
Services Layer → Error responses).
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/api-utils.ts src/lib/api-utils.test.ts src/lib/api-errors.ts src/lib/api-errors.test.ts src/app/api/registrations/route.test.ts docs/technical-architecture.md CLAUDE.md
# plus every call site Step 6 changed, each path quoted
git commit -m "feat(api): a code fixes its status and a 409 needs one; code the classifier's fallbacks (#197)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Prove the guards bite**

Each: apply, run `pnpm run typecheck` (or the named test), record the exact output, `git checkout -- <path>`, re-run clean.

1. In `respondError`'s uncoded overload, change `Exclude<ErrorStatus, 409>` to `ErrorStatus` → `Unused '@ts-expect-error' directive` at "a 409 must carry a code".
2. In the coded overload, change `status: StatusOf<C>` to `status: ErrorStatus` → unused directives at the NOT_FOUND-at-409 and PAYMENT_WAIVED-at-404 pins.
3. In `ApiFailure`'s 409 arm, change `readonly code: CodeWithStatus<409>` to `readonly code?: CodeWithStatus<409>` → unused directive at "a 409 classification without a code".
4. In `ApiFailure`'s 409 arm, change `CodeWithStatus<409>` to `ApiErrorCode` (import it) → unused directive at "a 404 code on a 409 classification".
5. Delete `code: 'UNIQUE_CONFLICT',` from the P2002 branch → `tsc` error there, and `api-errors.test.ts`'s P2002 test fails when run.
6. In `withErrorHandler`, drop `failure.code` from the `sendError` call → `api-utils.test.ts`'s escaped-P2002 test fails (`code` missing from the body).

---

## After Task 10

1. **Whole-branch review** (spec: `solve-issue` §5), on the most capable model: cross-task consistency, above all the §5.1 ordering applied the same way in every route; one code, one meaning across doors; no prose assertion added on the server side; no count or roster in a comment. Then one fix wave and one scoped re-review.
2. `pnpm run verify` (worktree app up) and `pnpm run build`, both green, before pushing.
3. **File the one out-of-scope defect** named in spec §10 (`booking-sign-in.tsx` ignoring `delivered`), with a `--body-file`, before opening the PR so the PR body can link it.
4. **Open the PR** from a `--body-file`:
   - the measured premise (spec §1–§2) with its arithmetic;
   - the corrections made while planning, including this plan's own: the 22/53 count, and `NoInfer` being decoration on `respondError`;
   - which integration files changed, by path;
   - the verify run's per-project counts;
   - "closes #197" and "closes #307".

   Never write a negated closing keyword.
