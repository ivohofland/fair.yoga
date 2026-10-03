# Allowlist What an Error Puts in a Log Line — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No error logged through `@/lib/log` can carry a Prisma error's row values or an error's arbitrary enumerable properties into a log line, through any of pino's channels (#739).

**Architecture:** A pure `serializeErr` in `src/lib/log-serializers.ts` builds an allowlisted plain object from an error, withholding a Prisma query error's message text and lifting only identifiers out of it. `src/lib/log.ts` installs it as both a `hooks.logMethod` rewrite (which runs before pino's `msg` fallback and covers every top-level key) and the `err` serializer, and is built by a `createLogger(destination?)` factory so tests read the real configuration's output. Two call sites adjust: the erasure route logs `strays` explicitly, and the degradation digest redacts the failure message it copies.

**Tech Stack:** TypeScript strict, pino 10.3.1, Prisma 6.19.3, vitest.

**Spec:** `docs/superpowers/specs/2026-10-03-err-serializer-allowlist-design.md` — read it first; it carries the measurements and the reasons behind every rule below.

## Global Constraints

- TypeScript `strict: true`; no `any`. A cast is acceptable only where pino's or Prisma's types force it, with a one-line reason.
- Comment Discipline (CLAUDE.md): a comment annotates the code it sits on. No counts or rosters of other files in comments; membership is tethered with `satisfies Record<keyof T, …>`.
- Never `git add -A` / `git add .`; stage exact paths. Quote paths containing parentheses.
- Node 24 is required: prefix shell commands with `PATH="/Users/ivohofland/.nvm/versions/node/v24.21.0/bin:/Users/ivohofland/.nvm/versions/node/v22.22.2/bin:$PATH"` (pnpm lives in the v22 bin).
- Integration tests run against this worktree's own app (`pnpm run worktree:up` is already done; `INTEGRATION_BASE_URL` is read automatically). Never touch a server on :3000.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Fake-PII tokens used in every test: `Alicepii`, `Surnamepii`, and an email containing `pii`. A test asserts their **absence** from the whole JSON line, not from one field.

## Review Focus

1. **A raw-query value containing a newline and `    at `** — must not survive as a stack frame (Task 1 test "forged frame").
2. **A value shaped like `violates check constraint "X"` in a non-integrity error** — must not be lifted as `constraint` (Task 1 test "class-23 gate").
3. **A Prisma error pino receives through `log.error({ err })` with no message string** — `msg` must be the redacted message (Task 2 test "msg fallback").
4. **The non-production Prisma header form (`tx.student.create()` … `in <file>`)** — the header must still parse (Task 1 unit test with the dev form, Task 2 integration test with real thrown errors).
5. **A logged object the caller keeps using** — the hook must not mutate it (Task 2 test "no mutation").

---

### Task 1: `serializeErr` — the allowlist

**Files:**
- Create: `src/lib/log-serializers.ts`
- Test: `src/lib/log-serializers.test.ts`

**Interfaces:**
- Produces:
  - `export interface SerializedErr { type: string; name?: string; message: string; stack?: string; code?: string | number; meta?: SerializedPrismaMeta; sqlState?: string; constraint?: string; cause?: SerializedErr; aggregateErrors?: SerializedErr[] }`
  - `export interface SerializedPrismaMeta { target?: string | string[]; constraint?: string | string[]; modelName?: string | string[]; connection_limit?: number; timeout?: number }`
  - `export function serializeErr(value: Error): SerializedErr;` and `export function serializeErr(value: unknown): unknown;` (overloads). Non-error-like values and values this function itself produced are returned unchanged.

- [ ] **Step 1: Write the failing tests** in `src/lib/log-serializers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { serializeErr } from './log-serializers';

const PII = ['Alicepii', 'Surnamepii', 'pii.test@example.com'];
const V = { clientVersion: '6.19.3' };

function expectNoPii(value: unknown): void {
  const json = JSON.stringify(value);
  for (const token of PII) expect(json).not.toContain(token);
}

// Messages as Prisma 6.19.3 rendered them under NODE_ENV=production (spec, "measured").
const VALIDATION_MSG =
  '\nInvalid `prisma.student.create()` invocation:\n\n{\n  data: {\n    firstName: "Alicepii",\n    lastName: "Surnamepii",\n    email: "pii.test@example.com",\n    bogus: 1,\n    ~~~~~\n  }\n}\n\nUnknown argument `bogus`. Available options are marked with ?.';
const CHECK_MSG =
  '\nInvalid `prisma.student.update()` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"Student\\" violates check constraint \\"Student_income_tier_check\\"", severity: "ERROR", detail: Some("Failing row contains (4ad7b519, Alicepii, Surnamepii, pii.test@example.com, 9)."), column: None, hint: None }), transient: false })';
const rawCast = (value: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`prisma.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`22P02\`. Message: \`ERROR: invalid input syntax for type integer: "${value}"\``,
    {
      ...V,
      code: 'P2010',
      meta: { type: 'Object', message: `ERROR: invalid input syntax for type integer: "${value}"`, stack: '', code: '22P02' },
    },
  );

describe('serializeErr: Prisma query errors withhold their message', () => {
  it('a validation error keeps the operation header and drops the argument tree', () => {
    const out = serializeErr(new Prisma.PrismaClientValidationError(VALIDATION_MSG, V));
    expectNoPii(out);
    expect(out.type).toBe('PrismaClientValidationError');
    expect(out.message).toBe('Invalid `prisma.student.create()` invocation (detail withheld from the log)');
    expect(out.stack).toMatch(/^PrismaClientValidationError: Invalid `prisma\.student\.create\(\)` invocation \(detail withheld from the log\)\n\s+at /);
  });

  it('a CHECK violation lifts its SQLSTATE and constraint, never the failing row', () => {
    const out = serializeErr(new Prisma.PrismaClientUnknownRequestError(CHECK_MSG, V));
    expectNoPii(out);
    expect(out.sqlState).toBe('23514');
    expect(out.constraint).toBe('Student_income_tier_check');
  });

  it('a P2010 drops meta.message and lifts meta.code as its SQLSTATE', () => {
    const out = serializeErr(rawCast('Alicepii pii.test@example.com'));
    expectNoPii(out);
    expect(out.code).toBe('P2010');
    expect(out.sqlState).toBe('22P02');
    expect(out.message).toBe('Invalid `prisma.$queryRawUnsafe()` invocation (detail withheld from the log)');
  });

  it('forged frame: a newline in a raw-query value cannot pass as a stack frame', () => {
    const out = serializeErr(rawCast('Alicepii\n    at evil3 (x)'));
    expectNoPii(out);
    expect(out.stack).not.toContain('evil3');
  });

  it('class-23 gate: a non-integrity error quoting the constraint sentence lifts no constraint', () => {
    const out = serializeErr(rawCast('x violates check constraint "Alicepii"'));
    expectNoPii(out);
    expect(out.constraint).toBeUndefined();
  });

  it('a known request error keeps its code and identifier meta', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.student.create()` invocation:\n\n\nUnique constraint failed on the fields: (`email`)', {
        ...V,
        code: 'P2002',
        meta: { modelName: 'Student', target: ['email'], cause: 'Alicepii' },
      }),
    );
    expectNoPii(out);
    expect(out.code).toBe('P2002');
    expect(out.meta).toEqual({ modelName: 'Student', target: ['email'] });
  });

  it('a pool timeout keeps its numeric meta', () => {
    const out = serializeErr(
      new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
        ...V,
        code: 'P2024',
        meta: { modelName: 'Class', connection_limit: 5, timeout: 10 },
      }),
    );
    expect(out.meta).toEqual({ modelName: 'Class', connection_limit: 5, timeout: 10 });
  });

  it('parses the non-production header form, any receiver, and $-identifiers', () => {
    const dev = serializeErr(
      new Prisma.PrismaClientValidationError(
        '\nInvalid `tx.student.create()` invocation in\n/app/src/services/x.ts:12:3\n\n   9 const a = 1\n→ 12 await tx.student.create({ data: { firstName: "Alicepii" } })',
        V,
      ),
    );
    expectNoPii(dev);
    expect(dev.message).toBe('Invalid `tx.student.create()` invocation (detail withheld from the log)');
  });

  it('withholds the whole message when no header parses', () => {
    const out = serializeErr(new Prisma.PrismaClientRustPanicError('panicked at Alicepii', '6.19.3'));
    expectNoPii(out);
    expect(out.message).toBe('Prisma error (detail withheld from the log)');
  });

  it('fails closed: an error named like a Prisma error is withheld without instanceof', () => {
    class Lookalike extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'PrismaClientValidationError';
      }
    }
    const out = serializeErr(new Lookalike(VALIDATION_MSG));
    expectNoPii(out);
  });

  it('an initialization error keeps its message: it is about the connection', () => {
    const msg = "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `db:5432`";
    const out = serializeErr(new Prisma.PrismaClientInitializationError(msg, '6.19.3', 'P1001'));
    expect(out.message).toBe(msg);
    expect(out.code).toBe('P1001');
  });
});

describe('serializeErr: the shape', () => {
  it('a plain error keeps message and stack, and drops other enumerable props', () => {
    const e = Object.assign(new Error('class 42 failed'), { code: 'E_X', extra: 'Alicepii' });
    const out = serializeErr(e);
    expectNoPii(out);
    expect(out.message).toBe('class 42 failed');
    expect(out.stack).toBe(e.stack);
    expect(out.code).toBe('E_X');
  });

  it("a URL error loses the input it refused", () => {
    let caught: unknown;
    try {
      new URL('not a url Alicepii');
    } catch (err) {
      caught = err;
    }
    const out = serializeErr(caught);
    expectNoPii(out);
    expect(out).toMatchObject({ type: 'TypeError', code: 'ERR_INVALID_URL' });
  });

  it('keeps an explicitly set name', () => {
    const e = new Error('m');
    e.name = 'SpotFreedError';
    expect(serializeErr(e).name).toBe('SpotFreedError');
  });

  it('redacts a Prisma error at depth in a cause chain', () => {
    const inner = new Prisma.PrismaClientValidationError(VALIDATION_MSG, V);
    const outer = new Error('spot freed but promotion failed', { cause: new Error('wrapper', { cause: inner }) });
    const out = serializeErr(outer);
    expectNoPii(out);
    expect(out.cause?.cause?.type).toBe('PrismaClientValidationError');
  });

  it('terminates on a cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.defineProperty(a, 'cause', { value: b });
    const out = serializeErr(a);
    expect(out.cause?.message).toBe('b');
    expect(out.cause?.cause).toBeUndefined();
  });

  it('stops at a depth bound on a long chain', () => {
    let e = new Error('0');
    for (let i = 1; i < 50; i++) e = new Error(String(i), { cause: e });
    let depth = 0;
    let node: { cause?: unknown } | undefined = serializeErr(e);
    while (node?.cause) {
      depth++;
      node = node.cause as { cause?: unknown };
    }
    expect(depth).toBeLessThan(49);
  });

  it('serializes an AggregateError through the same allowlist', () => {
    const agg = new AggregateError([new Prisma.PrismaClientValidationError(VALIDATION_MSG, V)], 'two failed');
    const out = serializeErr(agg);
    expectNoPii(out);
    expect(out.aggregateErrors?.[0]?.type).toBe('PrismaClientValidationError');
  });

  it('is idempotent on its own output', () => {
    const e = new AggregateError([new Error('x')], 'agg', { cause: new Error('c') });
    const once = serializeErr(e);
    expect(serializeErr(once)).toBe(once);
    expect(serializeErr(once)).toEqual(serializeErr(e));
  });

  it('allowlists an error-like object that is not an Error instance', () => {
    const out = serializeErr({ name: 'application_error', message: 'm', statusCode: 500, to: 'pii.test@example.com' });
    expectNoPii(out);
  });

  it('returns a value that is not error-like unchanged', () => {
    const obj = { a: 1 };
    expect(serializeErr(obj)).toBe(obj);
    expect(serializeErr('text')).toBe('text');
    expect(serializeErr(undefined)).toBeUndefined();
  });
});
```

Note on `Lookalike`'s stack: whether its header reads `Error:` or `PrismaClientValidationError:` depends on when V8 formats it, and the test does not care. Either the prefix matches and only frames follow it, or it does not and no frame is kept. No PII survives in either case.

- [ ] **Step 2: Run, expect FAIL** (module not found):

`pnpm exec vitest run --project unit src/lib/log-serializers.test.ts`

- [ ] **Step 3: Implement `src/lib/log-serializers.ts`:**

```ts
/**
 * What an error is allowed to put in a log line (#739). The reasons, and the
 * measurements behind them, are in
 * `docs/superpowers/specs/2026-10-03-err-serializer-allowlist-design.md`.
 *
 * `serializeErr` builds a plain object from named fields only, so a property
 * nobody listed here never reaches a log. A Prisma query error's message is
 * withheld outright: Prisma renders the call's arguments and Postgres's
 * `DETAIL` into it, and both carry row values. What survives of it is the
 * operation and the identifiers lifted below.
 */
import { Prisma } from '@prisma/client';

export interface SerializedPrismaMeta {
  target?: string | string[];
  constraint?: string | string[];
  modelName?: string | string[];
  connection_limit?: number;
  timeout?: number;
}

export interface SerializedErr {
  type: string;
  name?: string;
  message: string;
  stack?: string;
  code?: string | number;
  meta?: SerializedPrismaMeta;
  sqlState?: string;
  constraint?: string;
  cause?: SerializedErr;
  aggregateErrors?: SerializedErr[];
}

/** Which `meta` keys survive, and as what. */
const META_KEYS = {
  target: 'identifiers',
  constraint: 'identifiers',
  modelName: 'identifiers',
  connection_limit: 'number',
  timeout: 'number',
} as const satisfies Record<keyof SerializedPrismaMeta, 'identifiers' | 'number'>;

/** Cause and aggregate nesting share this budget. */
const MAX_DEPTH = 8;

const WITHHELD = '(detail withheld from the log)';
const PRISMA_ERROR_NAME = /^PrismaClient\w+Error$/;
const IDENTIFIER = /^[\w.]+$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
// Anchored at the start: a value inside the message cannot be taken for it.
const HEADER = /^\s*Invalid `([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\))` invocation/;
const PG_CODE = /PostgresError \{ code: "([0-9A-Z]{5})"/;
// Postgres writes this sentence before its DETAIL; on the Unknown path its
// quotes arrive backslash-escaped.
const CONSTRAINT = /violates (?:check|exclusion|foreign key|unique) constraint \\?"([A-Za-z0-9_]+)\\?"/;

/** Outputs of this module, so a second pass returns them unchanged. */
const produced = new WeakSet<object>();

type ErrorLike = object & { message: string };

function isErrorLike(value: unknown): value is ErrorLike {
  return typeof value === 'object' && value !== null && typeof (value as { message?: unknown }).message === 'string';
}

function field(source: object, key: string): unknown {
  return (source as Record<string, unknown>)[key];
}

function typeOf(err: object): string {
  const ctor = field(err, 'constructor');
  if (typeof ctor === 'function' && ctor.name) return ctor.name;
  const name = field(err, 'name');
  return typeof name === 'string' ? name : 'Error';
}

function prismaClass(err: object): string | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return 'PrismaClientKnownRequestError';
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return 'PrismaClientUnknownRequestError';
  if (err instanceof Prisma.PrismaClientValidationError) return 'PrismaClientValidationError';
  if (err instanceof Prisma.PrismaClientRustPanicError) return 'PrismaClientRustPanicError';
  if (err instanceof Prisma.PrismaClientInitializationError) return 'PrismaClientInitializationError';
  // By name too, so a duplicate package instance or an unknown future class
  // fails closed rather than logging its message verbatim.
  const name = field(err, 'name');
  if (typeof name === 'string' && PRISMA_ERROR_NAME.test(name)) return name;
  const type = typeOf(err);
  return PRISMA_ERROR_NAME.test(type) ? type : null;
}

function identifiers(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return IDENTIFIER.test(value) ? value : undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && IDENTIFIER.test(v))) {
    return value as string[];
  }
  return undefined;
}

function allowedMeta(meta: unknown): SerializedPrismaMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const out: SerializedPrismaMeta = {};
  for (const key of Object.keys(META_KEYS) as (keyof SerializedPrismaMeta)[]) {
    const value = field(meta, key);
    if (META_KEYS[key] === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) Object.assign(out, { [key]: value });
    } else {
      const kept = identifiers(value);
      if (kept !== undefined) Object.assign(out, { [key]: kept });
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function liftSqlState(cls: string, err: object, original: string): string | undefined {
  if (cls === 'PrismaClientUnknownRequestError') return PG_CODE.exec(original)?.[1];
  if (field(err, 'code') === 'P2010') {
    const meta = field(err, 'meta');
    const code = typeof meta === 'object' && meta !== null ? field(meta, 'code') : undefined;
    return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
  }
  return undefined;
}

function withheld(cls: string, err: ErrorLike, type: string): SerializedErr {
  const original = err.message;
  const header = HEADER.exec(original);
  const message = header ? `Invalid \`${header[1]}\` invocation ${WITHHELD}` : `Prisma error ${WITHHELD}`;

  // Frames are what follows the exact original header. Never filter lines by
  // shape: a raw-query value can hold a newline and a line that looks like a
  // frame. When the prefix does not match, no frame is kept.
  const stack = field(err, 'stack');
  const name = field(err, 'name');
  const prefix = `${String(name)}: ${original}`;
  const frames = typeof stack === 'string' && stack.startsWith(prefix) ? stack.slice(prefix.length) : '';

  const out: SerializedErr = { type, message, stack: `${type}: ${message}${frames}` };
  const sqlState = liftSqlState(cls, err, original);
  if (sqlState !== undefined) {
    out.sqlState = sqlState;
    // Class 23 only: its message is Postgres's own template, so the first
    // match is the constraint's name and never a quoted value.
    if (sqlState.startsWith('23')) {
      const constraint = CONSTRAINT.exec(original)?.[1];
      if (constraint !== undefined) out.constraint = constraint;
    }
  }
  const meta = allowedMeta(field(err, 'meta'));
  if (meta !== undefined) out.meta = meta;
  return out;
}

function serialize(err: ErrorLike, seen: Set<object>, depth: number): SerializedErr {
  seen.add(err);
  const type = typeOf(err);
  const cls = prismaClass(err);

  let out: SerializedErr;
  if (cls !== null && cls !== 'PrismaClientInitializationError') {
    out = withheld(cls, err, type);
  } else {
    out = { type, message: err.message };
    const stack = field(err, 'stack');
    if (typeof stack === 'string') out.stack = stack;
  }

  if (Object.prototype.hasOwnProperty.call(err, 'name')) {
    const name = field(err, 'name');
    if (typeof name === 'string') out.name = name;
  }
  const code = cls === 'PrismaClientInitializationError' ? field(err, 'errorCode') : field(err, 'code');
  if (typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))) out.code = code;

  if (depth < MAX_DEPTH) {
    const cause = field(err, 'cause');
    if (isErrorLike(cause) && !seen.has(cause)) out.cause = toSerialized(cause, seen, depth + 1);
    const errors = field(err, 'errors');
    if (Array.isArray(errors)) {
      out.aggregateErrors = errors
        .filter((e): e is ErrorLike => isErrorLike(e) && !seen.has(e))
        .map((e) => toSerialized(e, seen, depth + 1));
    }
  }

  produced.add(out);
  return out;
}

function toSerialized(err: ErrorLike, seen: Set<object>, depth: number): SerializedErr {
  return produced.has(err) ? (err as SerializedErr) : serialize(err, seen, depth);
}

export function serializeErr(value: Error): SerializedErr;
export function serializeErr(value: unknown): unknown;
export function serializeErr(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && produced.has(value)) return value;
  if (!isErrorLike(value)) return value;
  return serialize(value, new Set(), 0);
}
```

The tests call `serializeErr(x).message` where `x` is typed `unknown` (the URL test, the error-like object test). Where TypeScript picks the `unknown` overload, narrow in the test with `as SerializedErr` imported from the module, or restructure to keep the assertion; do not widen the production overloads to make the test compile.

- [ ] **Step 4: Run, expect PASS:** `pnpm exec vitest run --project unit src/lib/log-serializers.test.ts`, then `pnpm exec tsc --noEmit` and `pnpm exec eslint src/lib/log-serializers.ts src/lib/log-serializers.test.ts`.

- [ ] **Step 5: Mutation proof.** Commit first (Step 6), then apply each mutation, run the file, record the failing test's name and assertion text, and restore with `git checkout -- src/lib/log-serializers.ts`. End with `git status --short` showing nothing. Each must redden at least one test:
  1. `withheld` builds `frames` by keeping `stack.split('\n').filter((l) => /^\s+at /.test(l))` instead of the prefix slice → "forged frame".
  2. Delete the `if (sqlState.startsWith('23'))` gate (always lift) → "class-23 gate".
  3. Delete the two name-based lines in `prismaClass` (return `null` after the `instanceof` chain) → "fails closed".
  4. `out.meta = field(err, 'meta') as SerializedPrismaMeta` (meta kept whole) → "a known request error keeps its code and identifier meta".
  5. Delete the `cause` line in `serialize` → "redacts a Prisma error at depth".
  6. Delete `produced.add(out)` → "is idempotent".
  7. Treat `PrismaClientInitializationError` like the others (drop `&& cls !== 'PrismaClientInitializationError'`) → "an initialization error keeps its message".
  8. Remove `$` from `HEADER`'s character classes → "a P2010 drops meta.message".

  Record the eight results in the task report.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/log-serializers.ts src/lib/log-serializers.test.ts
git commit -m "feat(log): serializeErr allowlists what an error puts in a log line (#739)"
```

---

### Task 2: Install it on every pino channel

**Files:**
- Modify: `src/lib/log.ts`
- Test: `src/lib/log.test.ts` (new)
- Test: `tests/integration/log-redaction.test.ts` (new)

**Interfaces:**
- Consumes: `serializeErr` from Task 1.
- Produces: `export function createLogger(destination?: pino.DestinationStream): pino.Logger` and `export function redactLogArgs(args: readonly unknown[]): unknown[]` in `src/lib/log.ts`; `log` remains `export const log = createLogger()`.

- [ ] **Step 1: Write the failing unit test** `src/lib/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { createLogger } from './log';

const VALIDATION_MSG =
  '\nInvalid `prisma.student.create()` invocation:\n\n{\n  data: {\n    firstName: "Alicepii",\n    email: "pii.test@example.com"\n  }\n}\n\nUnknown argument `bogus`.';
const PII = ['Alicepii', 'pii.test@example.com'];

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  return { logger, lines };
}

function expectNoPii(line: string | undefined): void {
  expect(line).toBeDefined();
  for (const token of PII) expect(line).not.toContain(token);
}

const prismaErr = () => new Prisma.PrismaClientValidationError(VALIDATION_MSG, { clientVersion: '6.19.3' });

describe('the logger redacts errors on every channel', () => {
  it('msg fallback: { err } with no message string', () => {
    const { logger, lines } = capture();
    logger.error({ err: prismaErr() });
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').msg).toBe('Invalid `prisma.student.create()` invocation (detail withheld from the log)');
  });

  it('an Error as the first argument', () => {
    const { logger, lines } = capture();
    logger.error(prismaErr());
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').err.type).toBe('PrismaClientValidationError');
  });

  it('an Error under a key other than err', () => {
    const { logger, lines } = capture();
    logger.warn({ err: new Error('first'), probeErr: prismaErr() }, 'probe failed');
    expectNoPii(lines[0]);
    expect(JSON.parse(lines[0] ?? '{}').probeErr.type).toBe('PrismaClientValidationError');
  });

  it('an error-like object under err that is not an Error', () => {
    const { logger, lines } = capture();
    logger.error({ err: { name: 'application_error', message: 'm', to: 'pii.test@example.com' } }, 'send failed');
    expectNoPii(lines[0]);
  });

  it('no mutation: the caller keeps its own object', () => {
    const { logger } = capture();
    const e = prismaErr();
    const obj = { err: e, classId: 'c1' };
    logger.error(obj, 'failed');
    expect(obj.err).toBe(e);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`createLogger` is not exported): `pnpm exec vitest run --project unit src/lib/log.test.ts`

- [ ] **Step 3: Implement in `src/lib/log.ts`.** Keep the existing header docblock and add one paragraph after its `Usage:` paragraph:

```
 * Every error reaching a log line is allowlisted by `serializeErr`
 * (`log-serializers.ts`), on every channel pino has: the `err` key, any
 * other top-level key, an error passed as the first argument, and the `msg`
 * pino falls back to when a call passes no message string. `logMethod` runs
 * before that fallback, which is why the rewrite lives there and not only
 * in `serializers`.
```

Replace the body below the imports with:

```ts
import 'server-only';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { serializeErr } from './log-serializers';

/**
 * The log call's arguments with every top-level `Error` in the first one
 * serialized. A shallow copy, because callers keep using what they logged.
 */
export function redactLogArgs(args: readonly unknown[]): unknown[] {
  const [first, ...rest] = args;
  if (first instanceof Error) return [{ err: serializeErr(first) }, ...rest];
  if (typeof first !== 'object' || first === null) return [...args];
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(first)) {
    if (value instanceof Error) {
      copy ??= { ...first };
      copy[key] = serializeErr(value);
    }
  }
  return copy === null ? [...args] : [copy, ...rest];
}

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // drop pid/hostname noise — single process, single host
  serializers: { err: serializeErr },
  hooks: {
    logMethod(args, method) {
      // pino types the hook's args as one overload's parameters; the
      // rewritten list keeps their shape.
      method.apply(this, redactLogArgs(args) as Parameters<typeof method>);
    },
  },
};

/**
 * A destination replaces the transport: pino refuses both at once. Tests pass
 * one to read what the real configuration writes.
 */
export function createLogger(destination?: DestinationStream): Logger {
  if (destination) return pino(options, destination);
  return pino({
    ...options,
    ...(process.env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}

export const log = createLogger();
```

If `Parameters<typeof method>` does not typecheck against pino 10's `LogFn` overloads, use the narrowest cast that does and keep the one-line reason.

- [ ] **Step 4: Run, expect PASS:** `pnpm exec vitest run --project unit src/lib/log.test.ts src/lib/log.server-only.test.ts`

- [ ] **Step 5: Write the integration test** `tests/integration/log-redaction.test.ts`. It drives real Prisma errors against the test database (outside `NODE_ENV=production`, so the header is the non-production form) and logs them through the real configuration:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createLogger } from '@/lib/log';

const prisma = new PrismaClient();
const suffix = `logredact-${Date.now()}`;
const email = `pii-${suffix}@test.local`;
const PII = ['Alicepii', 'Surnamepii', email];
const studentIds: string[] = [];

beforeAll(async () => {
  const s = await prisma.student.create({ data: { firstName: 'Alicepii', lastName: 'Surnamepii', email } });
  studentIds.push(s.id);
});

afterAll(async () => {
  // `in` over an array that may be empty deletes nothing; never a scalar id
  // that an early beforeAll failure would leave undefined.
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.$disconnect();
});

async function logged(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const logger = createLogger({ write: (s: string) => void lines.push(s) });
  let thrown: unknown = null;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).not.toBeNull();
  logger.error({ err: thrown });
  const line = lines[0] ?? '';
  for (const token of PII) expect(line).not.toContain(token);
  return JSON.parse(line) as Record<string, unknown>;
}

describe('real Prisma errors reach the log without row values', () => {
  it('a validation error', async () => {
    const out = await logged(() =>
      prisma.student.update({ where: { email }, data: { incomeTier: 'Alicepii' as never } }),
    );
    expect((out.err as { message: string }).message).toMatch(/^Invalid `prisma\.student\.update\(\)` invocation \(detail withheld/);
  });

  it('a CHECK violation names its constraint', async () => {
    const out = await logged(() => prisma.student.update({ where: { email }, data: { incomeTier: 9 } }));
    expect(out.err).toMatchObject({ sqlState: '23514', constraint: 'Student_income_tier_check' });
  });

  it('a raw-query error', async () => {
    const out = await logged(() => prisma.$queryRawUnsafe('SELECT $1::int', `Alicepii ${email}`));
    expect(out.err).toMatchObject({ code: 'P2010', sqlState: '22P02' });
  });
});
```

Run: `pnpm exec vitest run --project integration tests/integration/log-redaction.test.ts`. Expect PASS. If the CHECK case reports a different error class or SQLSTATE than the spec measured, stop and report it rather than loosening the assertion.

- [ ] **Step 6: Commit**, then mutation proof (restore with `git checkout -- src/lib/log.ts`; end with a clean `git status --short`):
  1. Remove `hooks` from `options` → "msg fallback" and "an Error under a key other than err" redden.
  2. Remove `serializers` from `options` → "an error-like object under err that is not an Error" reddens.
  3. In `redactLogArgs`, assign into `first` instead of a copy → "no mutation" reddens.

```bash
git add src/lib/log.ts src/lib/log.test.ts tests/integration/log-redaction.test.ts
git commit -m "feat(log): every pino channel redacts errors through serializeErr (#739)"
```

---

### Task 3: The two call sites and the docs

**Files:**
- Modify: `src/app/api/account/route.ts` (the `ErasureLockSetError` branch)
- Modify: `src/services/degradation-digest.ts` (the `reason` line)
- Test: `src/services/degradation-digest.test.ts`
- Modify: `docs/technical-architecture.md` (What's Intentionally Left Out → the log-monitoring bullet)

**Interfaces:**
- Consumes: `serializeErr` (Task 1).

- [ ] **Step 1: Failing digest test.** In `src/services/degradation-digest.test.ts`, next to the existing case that does `sendHtmlEmail.mockRejectedValue(new Error('network'))`, add a case in the same style where the send rejects with
  `new Prisma.PrismaClientValidationError('\nInvalid \`prisma.degradationEvent.updateMany()\` invocation:\n\n{ where: { code: "Alicepii" } }', { clientVersion: '6.19.3' })`
  and assert the rejection is a `DegradationDigestError` whose `message` does not contain `Alicepii` and does contain ``Invalid `prisma.degradationEvent.updateMany()` invocation``. Run the file; expect FAIL on the `Alicepii` assertion.

- [ ] **Step 2: Implement.** In `degradation-digest.ts` replace
  `const reason = failure instanceof Error ? failure.message : String(failure);`
  with
  `const reason = failure instanceof Error ? serializeErr(failure).message : String(failure);`
  and import `serializeErr` from `@/lib/log-serializers`. Run the file; expect PASS. Mutation: revert the line → the new test reddens.

- [ ] **Step 3: The erasure log line.** In `src/app/api/account/route.ts`, the `ErasureLockSetError` branch logs `{ err, accountId }`. Add `strays: err.strays` to that object. Its comment ends "`err` carries the entries it found." — replace that sentence with "`strays` carries the entries it found." Read `ErasureLockSetError`'s docblock in `src/services/gdpr.ts` and confirm its claim that `strays` is the only record still holds as written; change it only if it now says something false.
  Find the test that covers this branch (`grep -rn "ErasureLockSetError" src tests --include='*.ts'`). If one spies on `log.error` for this branch, extend its assertion to `expect.objectContaining({ strays: … })`; if none does, add the assertion to the closest existing test of that branch. Mutation: drop `strays` from the log object → that assertion reddens.

- [ ] **Step 4: Docs.** In `docs/technical-architecture.md`, the What's Intentionally Left Out bullet beginning "**Log-based monitoring / observability.**" currently ends with "the `err` serializer (#739) is a prerequisite for that, because a shipped log line must not carry an unredacted error." Replace that final sentence with:

  > Errors logged through `@/lib/log` are allowlisted on every pino channel (`src/lib/log-serializers.ts`, #739): a Prisma query error's message is withheld, since it renders row values, and only named fields survive. Shipping logs still needs three more things. Next prints an error a page or route throws outside `withErrorHandler` with its full message through `console.error`, and `src/instrumentation.ts` registers no `onRequestError` to stop it. A `reason: error.message` string and the push service's response body are logged as strings, which no serializer sees. And an error nested below the top level of a log object, or passed in the message position, is stringified by pino.

- [ ] **Step 5: Verify and commit.** `pnpm exec tsc --noEmit`, `pnpm exec eslint` on the touched files, and the touched test files. Then:

```bash
git add "src/app/api/account/route.ts" src/services/degradation-digest.ts src/services/degradation-digest.test.ts docs/technical-architecture.md
# plus whichever test file Step 3 touched
git commit -m "fix(log): the erasure line logs its strays, the digest redacts the failure it copies, and the docs say what log shipping still needs (#739)"
```

---

## After the tasks

`pnpm run verify` on the whole branch (needs the worktree app up; it already is), then the whole-branch review, PR, CI, PR toolkit review, rebase-merge.
