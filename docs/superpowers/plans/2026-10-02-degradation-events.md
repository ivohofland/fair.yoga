# Degradation Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fallback that substitutes a wrong-but-safe value is recorded in the database and emailed to the operator in a daily digest, so "the log line is what would tell you" becomes true.

**Architecture:** A typed registry of degradation codes (each with an allowlist of context keys) feeds `logDegraded`, which keeps emitting today's log line and records a coalesced per-code row in a new `DegradationEvent` table. A new sweep in the existing `daily-cleanup` job claims due rows and emails them through `sendHtmlEmail`; `/api/health` gains one aggregate count.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, pino, Resend via `sendHtmlEmail`, Vitest (unit tier).

**Spec:** `docs/superpowers/specs/2026-10-02-degradation-events-design.md`

## Global Constraints

- Shell: `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` before any `pnpm`/`node` (the agent shell defaults to Node 22; the repo needs 24).
- Run from `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-157`; never `git -C`, never compound loops around git.
- TypeScript `strict: true`; no `any`, no implicit types.
- Tests first for every behaviour: write the test, see it fail for the stated reason, implement, see it pass.
- `log` is `@/lib/log` (server-only); never import it from a `'use client'` module.
- A function whose work must not be awaited returns `FireAndForget` (`@/lib/fire-and-forget`), never `Promise<void>`.
- Context values recorded for an event are ids, enums, numbers or IANA zone strings — never a name, email, phone, free text or an `err` object.
- A migration is immutable once applied, comments included; its comments describe only its own SQL.
- Comments annotate the code they sit on. No counts or member rosters in prose; name the type. What a comment "used to say" goes in the PR body.
- Stage exact paths; never `git add -A` / `git add .`. Quote paths containing parentheses.
- Every commit message ends with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Fast inner loop: `pnpm exec vitest run --project unit <path>`. Before the PR: `pnpm run verify`. In a worktree, integration needs `pnpm run worktree:setup` once and `pnpm run worktree:up`.

## Review Focus

The inputs and conditions the spec implies but no happy-path test exercises, most likely first. Each has a pinning test in the task that owns the code.

1. **An event lands between the digest's read and its claim, or between its claim and its send** — must be emailed next run, never lost, never double-sent. (Task 4)
2. **Resend refuses, or production has no key** — the claim is released and the job goes unhealthy; the event is not marked told. (Task 4)
3. **Two digests overlap** (scheduler tick plus a manual `/api/cron/daily-cleanup`) — exactly one email. (Task 4)
4. **A caller casts a context carrying a name or email, or a 5 000-character stored zone string** — only allowlisted keys survive, strings are truncated. (Task 2)
5. **The database is down while a public page records an event** — the page is unaffected and the failure is logged once. (Task 2)
6. **An occurrence arrives just after a flush and nothing follows it** — the trailing flush still writes it. (Task 2)
7. **The public health body** must carry the aggregate and never a code, sample or timestamp. (Task 5)
8. **A new `logDegraded` call with a variable code, or a registered code with no call site.** (Task 3)

---

### Task 1: The `DegradationEvent` table and its writer

**Files:**
- Modify: `prisma/schema.prisma` (add the model after `Notification`)
- Create: `prisma/migrations/20261002120000_degradation_event/migration.sql`
- Create: `src/lib/degradation-store.ts`
- Test: `src/lib/degradation-store.test.ts`

**Interfaces:**
- Produces: `interface DegradationWrite { code: string; count: number; at: Date; sample: Record<string, string | number> }` and `writeDegradationEvent(db: Pick<PrismaClient, 'degradationEvent'>, write: DegradationWrite): Promise<void>` from `@/lib/degradation-store`.
- Produces: the Prisma model `DegradationEvent` (`code` primary key, `occurrences`, `firstSeenAt`, `lastSeenAt`, `lastNotifiedAt`, `sample`).

- [ ] **Step 1: Add the model to the schema**

Insert directly after the `Notification` model's closing brace in `prisma/schema.prisma`:

```prisma
model DegradationEvent {
  code           String    @id
  occurrences    Int       @default(1)
  firstSeenAt    DateTime  @default(now())
  lastSeenAt     DateTime  @default(now())
  lastNotifiedAt DateTime?
  sample         Json
}
```

- [ ] **Step 2: Generate the migration SQL**

`prisma migrate dev` refuses a non-interactive shell, so derive the SQL and hand-write the directory.

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
pnpm run worktree:setup
pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script
```

Expected: a single `CREATE TABLE "DegradationEvent"` statement with a `DegradationEvent_pkey` constraint. Create `prisma/migrations/20261002120000_degradation_event/migration.sql` with that statement followed by the CHECK Prisma cannot express:

```sql
-- CreateTable
CREATE TABLE "DegradationEvent" (
    "code" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "sample" JSONB NOT NULL,

    CONSTRAINT "DegradationEvent_pkey" PRIMARY KEY ("code")
);

-- A row exists only because an event happened at least once.
ALTER TABLE "DegradationEvent"
    ADD CONSTRAINT "DegradationEvent_occurrences_check" CHECK ("occurrences" > 0);
```

If the diff's column definitions differ from the above, the diff wins and the CHECK is appended.

- [ ] **Step 3: Apply it and regenerate the client**

```bash
pnpm exec prisma migrate deploy
pnpm exec prisma generate
pnpm exec prisma migrate status
```

Expected: `Database schema is up to date!`

- [ ] **Step 4: Write the failing test**

Create `src/lib/degradation-store.test.ts`. The unit tier stubs this module globally (Task 2 adds that stub), so the real module is loaded with `importActual`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const PREFIX = 'test-store-';
const code = `${PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const { writeDegradationEvent } = await vi.importActual<typeof import('./degradation-store')>(
  './degradation-store',
);

beforeEach(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code } });
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code } });
  await prisma.$disconnect();
});

describe('writeDegradationEvent', () => {
  it('creates the row with the count, both timestamps and the sample', async () => {
    const at = new Date('2026-10-02T10:00:00.000Z');
    await writeDegradationEvent(prisma, { code, count: 3, at, sample: { tier: 9 } });

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(3);
    expect(row.firstSeenAt).toEqual(at);
    expect(row.lastSeenAt).toEqual(at);
    expect(row.lastNotifiedAt).toBeNull();
    expect(row.sample).toEqual({ tier: 9 });
  });

  it('adds to the count, advances lastSeenAt, keeps firstSeenAt and replaces the sample', async () => {
    const first = new Date('2026-10-02T10:00:00.000Z');
    const second = new Date('2026-10-02T10:05:00.000Z');
    await writeDegradationEvent(prisma, { code, count: 2, at: first, sample: { tier: 9 } });
    await writeDegradationEvent(prisma, { code, count: 4, at: second, sample: { tier: 7 } });

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(6);
    expect(row.firstSeenAt).toEqual(first);
    expect(row.lastSeenAt).toEqual(second);
    expect(row.sample).toEqual({ tier: 7 });
  });

  it('survives two writers racing on a code that has no row yet', async () => {
    const at = new Date('2026-10-02T10:00:00.000Z');
    await Promise.all([
      writeDegradationEvent(prisma, { code, count: 1, at, sample: {} }),
      writeDegradationEvent(prisma, { code, count: 1, at, sample: {} }),
    ]);

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code } });
    expect(row.occurrences).toBe(2);
  });

  it('is refused by the database for a count of zero', async () => {
    await expect(
      writeDegradationEvent(prisma, { code, count: 0, at: new Date(), sample: {} }),
    ).rejects.toThrow();
    expect(await prisma.degradationEvent.count({ where: { code } })).toBe(0);
  });
});
```

- [ ] **Step 5: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/degradation-store.test.ts`
Expected: FAIL — the module `./degradation-store` does not exist.

- [ ] **Step 6: Write the writer**

Create `src/lib/degradation-store.ts`:

```ts
import 'server-only';
import type { PrismaClient } from '@prisma/client';

export interface DegradationWrite {
  readonly code: string;
  /** Occurrences this write accounts for; the database refuses anything below 1. */
  readonly count: number;
  /** When the latest of those occurrences happened. */
  readonly at: Date;
  readonly sample: Readonly<Record<string, string | number>>;
}

/**
 * Records `count` occurrences of one degradation code: creates its row, or
 * adds to the existing one. A single `upsert` keyed on the primary key, which
 * Prisma runs as one `INSERT … ON CONFLICT` statement, so two writers racing
 * on a code with no row yet both land.
 */
export async function writeDegradationEvent(
  db: Pick<PrismaClient, 'degradationEvent'>,
  write: DegradationWrite,
): Promise<void> {
  await db.degradationEvent.upsert({
    where: { code: write.code },
    create: {
      code: write.code,
      occurrences: write.count,
      firstSeenAt: write.at,
      lastSeenAt: write.at,
      sample: { ...write.sample },
    },
    update: {
      occurrences: { increment: write.count },
      lastSeenAt: write.at,
      sample: { ...write.sample },
    },
  });
}
```

- [ ] **Step 7: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/lib/degradation-store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Prove the CHECK and the upsert bite**

Mutation A — drop the CHECK, record the failure, restore:

```bash
psql "$DATABASE_URL_TEST" -c 'ALTER TABLE "DegradationEvent" DROP CONSTRAINT "DegradationEvent_occurrences_check"'
pnpm exec vitest run --project unit src/lib/degradation-store.test.ts
```
Expected: the `count of zero` test FAILS (the promise resolves). Record the assertion text in the commit body. Restore:

```bash
psql "$DATABASE_URL_TEST" -c 'ALTER TABLE "DegradationEvent" ADD CONSTRAINT "DegradationEvent_occurrences_check" CHECK ("occurrences" > 0)'
```

Mutation B — in `degradation-store.ts` replace `occurrences: { increment: write.count }` with `occurrences: write.count`; the `adds to the count` test must FAIL (`expected 4 to be 6`). Revert it. Finish with `git status --short` showing only the intended files (no orphaned mutation).

If `DATABASE_URL_TEST` is unset in this shell, read the test database URL the unit tier uses from `tests/setup/unit-db.ts` and `.env`.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261002120000_degradation_event/migration.sql src/lib/degradation-store.ts src/lib/degradation-store.test.ts
git commit -m "$(cat <<'EOF'
feat: DegradationEvent table and its writer (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Registry, coalescer and `logDegraded`

**Files:**
- Create: `src/lib/degradation-codes.ts`
- Create: `src/lib/degradation-coalescer.ts`
- Create: `src/lib/degradation.ts`
- Create: `tests/setup/degradation-store.ts`
- Modify: `vitest.config.ts` (add the setup file to the `unit` and `unit-sweeps` projects)
- Test: `src/lib/degradation-codes.test.ts`, `src/lib/degradation-coalescer.test.ts`, `src/lib/degradation.test.ts`

**Interfaces:**
- Consumes: `writeDegradationEvent`, `DegradationWrite` (Task 1); `FireAndForget`; `log`.
- Produces from `@/lib/degradation-codes`: `DEGRADATION_CODES`, `type DegradationCode`, `type DegradationContext<C extends DegradationCode>`.
- Produces from `@/lib/degradation-coalescer`: `PendingDegradation`, `CoalescerDeps`, `createCoalescer(deps)` returning `{ record(code: string, sample: PendingDegradation['sample']): void }`.
- Produces from `@/lib/degradation`: `logDegraded<C extends DegradationCode>(code: C, context: DegradationContext<C>, message: string, err?: unknown): FireAndForget`, `COALESCE_WINDOW_MS`, `MAX_CONTEXT_VALUE_LENGTH`.

- [ ] **Step 1: Write the failing registry test**

Create `src/lib/degradation-codes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DEGRADATION_CODES } from './degradation-codes';

const PERSONAL_DATA_KEY = /name|email|phone|address|birth|note|message|text/i;

describe('DEGRADATION_CODES', () => {
  const entries = Object.entries(DEGRADATION_CODES);

  it.each(entries)('%s has a description and a level', (_code, entry) => {
    expect(entry.description.length).toBeGreaterThan(20);
    expect(['warn', 'error']).toContain(entry.level);
  });

  it.each(entries)('%s lists each context key once', (_code, entry) => {
    expect(new Set(entry.contextKeys).size).toBe(entry.contextKeys.length);
  });

  it.each(entries)('%s allowlists no key that could carry personal data', (_code, entry) => {
    for (const key of entry.contextKeys) {
      expect(key, `context key "${key}"`).not.toMatch(PERSONAL_DATA_KEY);
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/degradation-codes.test.ts`
Expected: FAIL — cannot resolve `./degradation-codes`.

- [ ] **Step 3: Write the registry**

Create `src/lib/degradation-codes.ts`:

```ts
/**
 * Every degradation the app records, each with the severity its log line has
 * and the context keys it may carry. Imports nothing, so a test or a doc
 * generator can read it without pulling in the database.
 *
 * A code names one intentional fallback: a place that substitutes or withholds
 * a value because data that should have been impossible turned up. Which sites
 * qualify, and why the rest do not, is `docs/degradation-sites.md`.
 *
 * `contextKeys` is the allowlist `logDegraded` enforces at runtime as well as
 * in the types. Every key holds an id, an enum, a number or an IANA zone
 * string; a key that could hold something a person typed does not belong here.
 */
export const DEGRADATION_CODES = {
  INCOME_TIER_OUT_OF_RANGE: {
    level: 'warn',
    description:
      'A stored income tier was outside 1–5 although a CHECK constraint forbids it. The median tier was substituted, or the claim about this person was withheld.',
    contextKeys: ['tier', 'studentId', 'registrationId'],
  },
  TIMEZONE_INVALID_FALLBACK_UTC: {
    level: 'error',
    description:
      'A stored timezone would not resolve. A calendar day, a time label or a wall-clock instant was computed in UTC instead.',
    contextKeys: ['timeZone', 'site'],
  },
} as const satisfies Record<
  string,
  { level: 'warn' | 'error'; description: string; contextKeys: readonly string[] }
>;

export type DegradationCode = keyof typeof DEGRADATION_CODES;

/** The context a call site may pass for `C`; every key optional. */
export type DegradationContext<C extends DegradationCode> = {
  [K in (typeof DEGRADATION_CODES)[C]['contextKeys'][number]]?: string | number;
};
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/lib/degradation-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing coalescer test**

Create `src/lib/degradation-coalescer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCoalescer, type PendingDegradation } from './degradation-coalescer';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function make() {
  const write = vi.fn(async (_code: string, _pending: PendingDegradation) => undefined);
  const onWriteError = vi.fn();
  const coalescer = createCoalescer({
    write,
    windowMs: 60_000,
    now: () => new Date(),
    onWriteError,
  });
  return { coalescer, write, onWriteError };
}

describe('createCoalescer', () => {
  it('writes the first occurrence of a code at once', () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('A', {
      count: 1,
      at: new Date('2026-10-02T10:00:00.000Z'),
      sample: { n: 1 },
    });
  });

  it('holds later occurrences in the window and flushes them, batched, when it ends', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    coalescer.record('A', { n: 2 });
    coalescer.record('A', { n: 3 });
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(write).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('A', {
      count: 2,
      at: new Date('2026-10-02T10:00:00.000Z'),
      sample: { n: 3 },
    });
  });

  it('still writes a single occurrence that lands just after a flush and is followed by nothing', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(30_000);
    coalescer.record('A', { n: 2 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('A', expect.objectContaining({ count: 1, sample: { n: 2 } }));
  });

  it('writes again at once for an occurrence after a quiet window', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    coalescer.record('A', { n: 2 });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('sets no timer and writes nothing more when nothing is pending', async () => {
    const { coalescer, write } = make();
    coalescer.record('A', { n: 1 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps codes independent', () => {
    const { coalescer, write } = make();
    coalescer.record('A', {});
    coalescer.record('B', {});
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected write to onWriteError and never throws from record', async () => {
    const { coalescer, write, onWriteError } = make();
    const boom = new Error('db down');
    write.mockRejectedValueOnce(boom);

    expect(() => coalescer.record('A', {})).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(onWriteError).toHaveBeenCalledWith(boom, 'A');
  });

  it('reports a write that throws synchronously the same way', () => {
    const { coalescer, write, onWriteError } = make();
    const boom = new Error('sync');
    write.mockImplementationOnce(() => {
      throw boom;
    });

    expect(() => coalescer.record('A', {})).not.toThrow();
    expect(onWriteError).toHaveBeenCalledWith(boom, 'A');
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/degradation-coalescer.test.ts`
Expected: FAIL — cannot resolve `./degradation-coalescer`.

- [ ] **Step 7: Write the coalescer**

Create `src/lib/degradation-coalescer.ts`:

```ts
/**
 * Turns a stream of occurrences into at most one write per code per window.
 *
 * The first occurrence after a quiet window writes at once. Later ones inside
 * the window are held as a count plus the latest sample, and an `unref`'d timer
 * writes them when the window ends — without that trailing write, an
 * occurrence landing just after a flush and followed by nothing would never
 * reach the row, and the digest's "fired again since last told" test could not
 * see it. Occurrences still held when the process exits are lost, so the count
 * is approximate by construction.
 *
 * Pure: the clock, the write and the error sink are injected, so it is tested
 * with fake timers and no database.
 */

export interface PendingDegradation {
  readonly count: number;
  /** When the latest held occurrence happened. */
  readonly at: Date;
  readonly sample: Readonly<Record<string, string | number>>;
}

export interface CoalescerDeps {
  write: (code: string, pending: PendingDegradation) => Promise<void>;
  windowMs: number;
  now: () => Date;
  onWriteError: (err: unknown, code: string) => void;
}

interface CodeState {
  lastFlushAtMs: number | null;
  pending: PendingDegradation | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createCoalescer(deps: CoalescerDeps): {
  record(code: string, sample: PendingDegradation['sample']): void;
} {
  const states = new Map<string, CodeState>();

  function flush(code: string, state: CodeState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const pending = state.pending;
    if (pending === null) return;
    state.pending = null;
    state.lastFlushAtMs = deps.now().getTime();
    try {
      deps.write(code, pending).catch((err: unknown) => deps.onWriteError(err, code));
    } catch (err) {
      deps.onWriteError(err, code);
    }
  }

  return {
    record(code, sample) {
      const at = deps.now();
      let state = states.get(code);
      if (state === undefined) {
        state = { lastFlushAtMs: null, pending: null, timer: null };
        states.set(code, state);
      }
      state.pending = { count: (state.pending?.count ?? 0) + 1, at, sample };

      const sinceFlushMs =
        state.lastFlushAtMs === null ? Number.POSITIVE_INFINITY : at.getTime() - state.lastFlushAtMs;
      if (sinceFlushMs >= deps.windowMs) {
        flush(code, state);
        return;
      }
      if (state.timer === null) {
        const held = state;
        held.timer = setTimeout(() => flush(code, held), deps.windowMs - sinceFlushMs);
        held.timer.unref?.();
      }
    },
  };
}
```

- [ ] **Step 8: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/lib/degradation-coalescer.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Write the unit-tier stub for the store**

Any unit test that trips a fallback (an invalid zone, a bad tier) must not write to a real table. Create `tests/setup/degradation-store.ts`:

```ts
import { vi } from 'vitest';

// A fallback tripped inside an unrelated unit test must not write to the test
// database. The store's own test loads the real module with `importActual`.
vi.mock('@/lib/degradation-store', () => ({
  writeDegradationEvent: vi.fn(async () => undefined),
}));
```

In `vitest.config.ts`, add `setupFiles: ['./tests/setup/degradation-store.ts']` to the `unit` project and to the `unit-sweeps` project, beside each one's existing `globalSetup: ['./tests/setup/unit-db.ts']`. Do not add it to `integration` (it talks to a real app) or `components`.

- [ ] **Step 10: Write the failing helper test**

Create `src/lib/degradation.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import type { DegradationContext } from './degradation-codes';

vi.mock('@/lib/db', () => ({ prisma: { marker: 'db' } }));

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh module graph per test, so the helper's coalescer state starts empty. */
async function load() {
  vi.resetModules();
  const { logDegraded } = await import('./degradation');
  const store = await import('@/lib/degradation-store');
  return { logDegraded, write: vi.mocked(store.writeDegradationEvent) };
}

describe('logDegraded', () => {
  it('emits the code\'s log line at the code\'s level, with the code and the allowlisted context', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { logDegraded } = await load();

    logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9, studentId: 's1' }, 'tier outside 1-5');

    expect(warn).toHaveBeenCalledWith(
      { tier: 9, studentId: 's1', code: 'INCOME_TIER_OUT_OF_RANGE' },
      'tier outside 1-5',
    );
  });

  it('logs at error for a code whose level is error, with the err it was given', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { logDegraded } = await load();
    const err = new RangeError('bad zone');

    logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', { timeZone: 'Not/AZone', site: 'format' }, 'falling back', err);

    expect(error).toHaveBeenCalledWith(
      { timeZone: 'Not/AZone', site: 'format', code: 'TIMEZONE_INVALID_FALLBACK_UTC', err },
      'falling back',
    );
  });

  it('records the event through the store with only the allowlisted sample', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { logDegraded, write } = await load();

    logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9, studentId: 's1' }, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith(
      { marker: 'db' },
      {
        code: 'INCOME_TIER_OUT_OF_RANGE',
        count: 1,
        at: expect.any(Date),
        sample: { tier: 9, studentId: 's1' },
      },
    );
  });

  it('drops a key that is not on the code\'s allowlist, from the log line and the sample, even when a cast smuggles it in', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { logDegraded, write } = await load();
    const smuggled = {
      tier: 9,
      email: 'maria@example.com',
      studentName: 'Maria',
    } as unknown as DegradationContext<'INCOME_TIER_OUT_OF_RANGE'>;

    logDegraded('INCOME_TIER_OUT_OF_RANGE', smuggled, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0]![1].sample).toEqual({ tier: 9 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('maria');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Maria');
  });

  it('truncates a long string value and drops a value that is neither a string nor a finite number', async () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { logDegraded, write } = await load();
    const odd = {
      timeZone: 'x'.repeat(5_000),
      site: { nested: true },
    } as unknown as DegradationContext<'TIMEZONE_INVALID_FALLBACK_UTC'>;

    logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', odd, 'm');

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const { sample } = write.mock.calls[0]![1];
    expect(sample.timeZone).toBe('x'.repeat(200));
    expect(sample).not.toHaveProperty('site');
  });

  it('returns nothing, and logs once, when the store rejects', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { logDegraded, write } = await load();
    write.mockRejectedValueOnce(new Error('db down'));

    const returned = logDegraded('INCOME_TIER_OUT_OF_RANGE', { tier: 9 }, 'm');

    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INCOME_TIER_OUT_OF_RANGE', err: expect.any(Error) }),
      expect.stringContaining('could not record'),
    );
  });

  it('refuses a context key that is not on the allowlist at compile time', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { logDegraded } = await load();

    // @ts-expect-error — `email` is not a context key of this code
    logDegraded('INCOME_TIER_OUT_OF_RANGE', { email: 'x' }, 'm');
  });
});
```

- [ ] **Step 11: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/degradation.test.ts`
Expected: FAIL — cannot resolve `./degradation`.

- [ ] **Step 12: Write the helper**

Create `src/lib/degradation.ts`:

```ts
import 'server-only';
import { log } from '@/lib/log';
import type { FireAndForget } from '@/lib/fire-and-forget';
import {
  DEGRADATION_CODES,
  type DegradationCode,
  type DegradationContext,
} from '@/lib/degradation-codes';
import { createCoalescer } from '@/lib/degradation-coalescer';

export const COALESCE_WINDOW_MS = 60_000;
export const MAX_CONTEXT_VALUE_LENGTH = 200;

/**
 * Keeps only the keys the code allows, as strings (truncated) or finite
 * numbers. A runtime filter on top of the types, because a cast passes every
 * type check and the context of a fallback can include a value read from a
 * corrupt row.
 */
function allowlisted(
  code: DegradationCode,
  context: Readonly<Record<string, unknown>>,
): Record<string, string | number> {
  const kept: Record<string, string | number> = {};
  for (const key of DEGRADATION_CODES[code].contextKeys) {
    const value = context[key];
    if (typeof value === 'string') kept[key] = value.slice(0, MAX_CONTEXT_VALUE_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) kept[key] = value;
  }
  return kept;
}

const coalescer = createCoalescer({
  windowMs: COALESCE_WINDOW_MS,
  now: () => new Date(),
  write: async (code, pending) => {
    // Imported on use: a module that only needs to log a fallback should not
    // open a database client at load.
    const [{ prisma }, { writeDegradationEvent }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/degradation-store'),
    ]);
    await writeDegradationEvent(prisma, {
      code,
      count: pending.count,
      at: pending.at,
      sample: pending.sample,
    });
  },
  onWriteError: (err, code) => {
    log.error({ err, code }, 'could not record a degradation event; the log line is all there is');
  },
});

/**
 * Reports an intentional fallback: logs it exactly as the site did before, and
 * records it so the operator is told (`docs/degradation-sites.md`).
 *
 * `FireAndForget`: recording must never delay, fail or reveal anything about
 * the page that tripped the fallback, so there is no promise to await. If the
 * write fails, the failure is logged and the log line above is all that
 * remains.
 */
export function logDegraded<C extends DegradationCode>(
  code: C,
  context: DegradationContext<C>,
  message: string,
  err?: unknown,
): FireAndForget {
  const safe = allowlisted(code, context);
  log[DEGRADATION_CODES[code].level](
    { ...safe, code, ...(err === undefined ? {} : { err }) },
    message,
  );
  coalescer.record(code, safe);
}
```

- [ ] **Step 13: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/lib/degradation.test.ts src/lib/degradation-codes.test.ts src/lib/degradation-coalescer.test.ts src/lib/degradation-store.test.ts`
Expected: PASS. Then `pnpm run typecheck` — expected clean, including the `@ts-expect-error` line (an unused directive is itself an error, so a loosened `DegradationContext` fails here).

- [ ] **Step 14: Prove every guard bites**

Apply each mutation, run `pnpm exec vitest run --project unit src/lib/degradation.test.ts src/lib/degradation-coalescer.test.ts`, record the failing test name and message, then revert it exactly:

1. In `allowlisted`, loop over `Object.keys(context)` instead of the code's `contextKeys` → `drops a key that is not on the code's allowlist` FAILS.
2. Remove `.slice(0, MAX_CONTEXT_VALUE_LENGTH)` → `truncates a long string value` FAILS.
3. In the coalescer remove the `setTimeout` branch → `still writes a single occurrence that lands just after a flush` FAILS.
4. In the coalescer `flush`, delete the `.catch(...)` → `reports a rejected write` FAILS (or surfaces an unhandled rejection).
5. In `logDegraded` delete the `coalescer.record(code, safe)` line → `records the event through the store` FAILS.
6. In `degradation-codes.ts` add `'studentEmail'` to a `contextKeys` tuple → `allowlists no key that could carry personal data` FAILS.

End with `git status --short` showing only this task's files.

- [ ] **Step 15: Run the neighbouring unit tests the stub could disturb**

Run: `pnpm exec vitest run --project unit src/lib/timezone.test.ts src/lib/log.server-only.test.ts`
Expected: PASS (nothing imports the helper yet; this proves the new setup file loads cleanly).

- [ ] **Step 16: Commit**

```bash
git add src/lib/degradation-codes.ts src/lib/degradation-coalescer.ts src/lib/degradation.ts tests/setup/degradation-store.ts vitest.config.ts src/lib/degradation-codes.test.ts src/lib/degradation-coalescer.test.ts src/lib/degradation.test.ts
git commit -m "$(cat <<'EOF'
feat: degradation registry, coalescer and logDegraded (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Convert the seeded sites and tether the registry to its call sites

**Files:**
- Modify: `src/lib/tiers.server.ts` (`readIncomeTier`, `toIncomeTier`, their docblocks)
- Modify: `src/lib/timezone.ts` (three fallbacks), `src/lib/finish-window.ts` (one fallback)
- Modify: `src/lib/degradation-codes.test.ts` (call-site tether)
- Test: existing `src/lib/timezone.test.ts`, `src/lib/tiers.server.test.ts` (extended); the finish-window test

**Interfaces:**
- Consumes: `logDegraded` (Task 2).
- Produces: `interface TierReadContext { studentId?: string; registrationId?: string }` exported from `@/lib/tiers.server`.

- [ ] **Step 1: Locate the tier test and the finish-window test**

```bash
ls src/lib | grep -E "tiers.server|finish-window"
```

Open the tier test and the finish-window test. If no tier test asserts the warn today, create `src/lib/tiers.server.test.ts` in the next step.

- [ ] **Step 2: Write the failing tests**

Add to the tier test (create it if absent, with `import { describe, it, expect, vi, afterEach } from 'vitest'; import { log } from '@/lib/log'; import { readIncomeTier, toIncomeTier } from './tiers.server';` and `afterEach(() => vi.restoreAllMocks())`):

```ts
describe('readIncomeTier degradation', () => {
  it('reports INCOME_TIER_OUT_OF_RANGE with the tier and the id it was handed, and answers null', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(readIncomeTier(9, { studentId: 'student-1' })).toBeNull();

    expect(warn).toHaveBeenCalledWith(
      { tier: 9, studentId: 'student-1', code: 'INCOME_TIER_OUT_OF_RANGE' },
      expect.stringContaining('income tier outside 1-5'),
    );
  });

  it('toIncomeTier substitutes the median and reports the same code', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    expect(toIncomeTier(9, { registrationId: 'reg-1' })).toBe(3);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INCOME_TIER_OUT_OF_RANGE', registrationId: 'reg-1' }),
      expect.any(String),
    );
  });

  it('is silent for a valid tier', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(readIncomeTier(2)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
```

Add to `src/lib/timezone.test.ts`, beside the existing fallback tests (reuse its `log` import and spy style):

```ts
it('reports TIMEZONE_INVALID_FALLBACK_UTC from startOfLocalDay, naming its site', () => {
  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'Not/AZone');
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      code: 'TIMEZONE_INVALID_FALLBACK_UTC',
      site: 'local-day',
      timeZone: 'Not/AZone',
      err: expect.any(Error),
    }),
    expect.stringContaining('falling back to UTC'),
  );
});
```

Add the same shape for the other two `timezone.ts` fallbacks, driving each through the exported function the existing tests at `timezone.test.ts` lines ~70–160 already call (the formatting one and the interpretation one), asserting `site: 'format'` and `site: 'interpret'` respectively. For the finish-window fallback, add a test in its test file asserting `site: 'finish-window'` through the exported function that contains the `try { return format(timeZone); }` at `finish-window.ts:57`.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm exec vitest run --project unit src/lib/tiers.server.test.ts src/lib/timezone.test.ts src/lib/finish-window.test.ts`
Expected: FAIL — the log objects carry no `code` or `site`.

- [ ] **Step 4: Convert the tier site**

In `src/lib/tiers.server.ts`, replace `import { log } from '@/lib/log';` with `import { logDegraded } from '@/lib/degradation';` (the file uses `log` nowhere else), add the context type, and change both signatures and the one warn:

```ts
/** The ids a tier read may name, so a warning points at the row. */
export interface TierReadContext {
  studentId?: string;
  registrationId?: string;
}

export function readIncomeTier(n: number, context?: TierReadContext): IncomeTier | null {
  if (isIncomeTier(n)) return n;
  logDegraded(
    'INCOME_TIER_OUT_OF_RANGE',
    { tier: n, ...context },
    'income tier outside 1-5; DB constraint bypassed',
  );
  return null;
}

export function toIncomeTier(n: number, context?: TierReadContext): IncomeTier {
  return readIncomeTier(n, context) ?? DEFAULT_INCOME_TIER;
}
```

Replace the sentence "If this ever warns, the constraint was circumvented. That is the bug to chase, and the log line is the only thing that would tell you." in `readIncomeTier`'s docblock with: "If this ever fires, the constraint was circumvented. That is the bug to chase; it is recorded as `INCOME_TIER_OUT_OF_RANGE` and emailed to the operator (`docs/degradation-sites.md`)." Replace the `context` paragraph's "is merged into the log payload" with "names the row in the recorded event". Remove the old `Record<string, string>` annotations.

- [ ] **Step 5: Convert the four timezone sites**

In `src/lib/timezone.ts`, add `import { logDegraded } from '@/lib/degradation';` and replace each `log.error({ timeZone, err }, '<message>')` with the matching call, keeping the message text byte-for-byte:

```ts
// startOfLocalDay catch
logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', { timeZone, site: 'local-day' }, 'invalid timezone, falling back to UTC calendar date', err);
// the formatting catch (message: 'invalid timezone, falling back to UTC formatting')
logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', { timeZone, site: 'format' }, 'invalid timezone, falling back to UTC formatting', err);
// the interpretation catch
logDegraded('TIMEZONE_INVALID_FALLBACK_UTC', { timeZone, site: 'interpret' }, 'invalid timezone, falling back to UTC interpretation', err);
```

In `src/lib/finish-window.ts`, add the same import and replace its `log.error({ timeZone, err }, 'invalid timezone, falling back to UTC formatting')` with the `site: 'finish-window'` call. Leave the other `log.*` calls in both files (the unreadable-date branches) untouched here — Task 6 classifies them. Remove the `log` import from a file only if nothing else in it uses `log`.

Update the docblocks that describe these fallbacks (`timezone.ts` lines ~78–80, ~187–190, ~250, ~366) where they say the fallback "logs at `error`" or is "findable" by log: replace the sentence with a pointer to the code, e.g. "…falls back to UTC and is recorded as `TIMEZONE_INVALID_FALLBACK_UTC`, which reaches the operator by email (`docs/degradation-sites.md`)." Keep each docblock's other content.

- [ ] **Step 6: Run the tests and see them pass**

Run: `pnpm exec vitest run --project unit src/lib/tiers.server.test.ts src/lib/timezone.test.ts src/lib/finish-window.test.ts`
Expected: PASS, including the pre-existing `stringContaining('falling back to UTC')` assertions.

Run: `pnpm run typecheck`
Expected: clean. Every caller passing `{ studentId }` or `{ registrationId }` still compiles.

- [ ] **Step 7: Write the failing tether test**

Append to `src/lib/degradation-codes.test.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const DEFINITION = path.join(SRC, 'lib', 'degradation.ts');
const files = sourceFiles(SRC).filter((f) => f !== DEFINITION);
const LITERAL_CALL = /logDegraded\(\s*'([A-Z0-9_]+)'/g;
const ANY_CALL = /logDegraded\(/g;

describe('logDegraded call sites', () => {
  const used = new Set<string>();
  let literalCalls = 0;
  let anyCalls = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(LITERAL_CALL)) {
      used.add(m[1]!);
      literalCalls += 1;
    }
    anyCalls += [...text.matchAll(ANY_CALL)].length;
  }

  it('names its code as a literal at every call, never through a variable', () => {
    expect(anyCalls).toBe(literalCalls);
  });

  it.each(Object.keys(DEGRADATION_CODES))('%s has at least one call site', (code) => {
    expect(used.has(code)).toBe(true);
  });

  it('calls only registered codes', () => {
    for (const code of used) expect(Object.keys(DEGRADATION_CODES)).toContain(code);
  });
});
```

- [ ] **Step 8: Run it**

Run: `pnpm exec vitest run --project unit src/lib/degradation-codes.test.ts`
Expected: PASS now that both seeded codes have call sites. Then prove it bites: temporarily rename `'INCOME_TIER_OUT_OF_RANGE'` in `tiers.server.ts`'s call to a variable (`const c = 'INCOME_TIER_OUT_OF_RANGE'; logDegraded(c, …)`) → the first test FAILS (`expected 5 to be 4` style); revert. Temporarily delete the `finish-window.ts` call and the three `timezone.ts` calls → `TIMEZONE_INVALID_FALLBACK_UTC has at least one call site` FAILS; revert. `git status --short` shows only this task's files.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tiers.server.ts src/lib/timezone.ts src/lib/finish-window.ts src/lib/degradation-codes.test.ts src/lib/tiers.server.test.ts src/lib/timezone.test.ts src/lib/finish-window.test.ts
git commit -m "$(cat <<'EOF'
feat: report the tier and timezone fallbacks as degradation events (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

(Stage only the test files that actually changed or were created.)

---

### Task 4: The digest sweep, its email, and `OPERATOR_EMAIL`

**Files:**
- Create: `src/services/degradation-digest.ts`
- Modify: `src/lib/email-templates.ts` (add `renderDegradationDigestEmail`)
- Modify: `src/lib/scheduler.ts` (interface, imports, `buildJobs`, boot guard)
- Modify: `src/app/api/cron/daily-cleanup/route.ts`
- Modify: `.env.example`
- Test: `src/services/degradation-digest.test.ts`, `src/lib/email-templates.test.ts` (extend), `src/lib/scheduler.test.ts` (extend), `src/app/api/cron/daily-cleanup/route.test.ts` (extend)

**Interfaces:**
- Consumes: `DEGRADATION_CODES` (Task 2); the `DegradationEvent` model (Task 1); `sendHtmlEmail` from `@/lib/email`.
- Produces: `notifyOperatorOfDegradations(db: PrismaClient, operatorEmail?: string): Promise<DegradationDigestSummary>` with `interface DegradationDigestSummary { readonly emailed: number }`; `class DegradationDigestError extends Error`; `renderDegradationDigestEmail(entries: readonly DegradationDigestEntry[]): { subject: string; html: string }`; the `SchedulerSweeps` member `notifyOperatorOfDegradations: (db: PrismaClient) => Promise<unknown>`.

- [ ] **Step 1: Write the failing template test**

Add to `src/lib/email-templates.test.ts` (create it with the vitest imports if absent):

```ts
import { renderDegradationDigestEmail } from './email-templates';

describe('renderDegradationDigestEmail', () => {
  const entry = {
    code: 'INCOME_TIER_OUT_OF_RANGE',
    description: 'A stored income tier was outside 1–5.',
    firstSeenAt: new Date('2026-10-01T08:00:00.000Z'),
    lastSeenAt: new Date('2026-10-02T09:30:00.000Z'),
    occurrences: 12,
    sample: { tier: 9, studentId: 's-1' },
  };

  it('names the code in the subject for one event and the number for several', () => {
    expect(renderDegradationDigestEmail([entry]).subject).toContain('INCOME_TIER_OUT_OF_RANGE');
    expect(renderDegradationDigestEmail([entry, { ...entry, code: 'B' }]).subject).toContain('2');
  });

  it('shows the code, description, both times, the count and the sample', () => {
    const { html } = renderDegradationDigestEmail([entry]);
    expect(html).toContain('INCOME_TIER_OUT_OF_RANGE');
    expect(html).toContain('A stored income tier was outside 1–5.');
    expect(html).toContain('2026-10-01T08:00:00.000Z');
    expect(html).toContain('2026-10-02T09:30:00.000Z');
    expect(html).toContain('12');
    expect(html).toContain('studentId');
    expect(html).toContain('s-1');
  });

  it('escapes every interpolated value', () => {
    const { html } = renderDegradationDigestEmail([
      { ...entry, description: '<script>x</script>', sample: { timeZone: '"><img src=x>' } },
    ]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
Expected: FAIL — `renderDegradationDigestEmail` is not exported.

- [ ] **Step 3: Write the template**

Append to `src/lib/email-templates.ts`:

```ts
export interface DegradationDigestEntry {
  code: string;
  description: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrences: number;
  sample: Readonly<Record<string, unknown>>;
}

const DEGRADATION_DIGEST_FOOTER =
  'You get this because OPERATOR_EMAIL is set on this server. What each code means: docs/degradation-sites.md.';

/** The operator's digest: one block per degradation that fired since they were last told. */
export function renderDegradationDigestEmail(entries: readonly DegradationDigestEntry[]): {
  subject: string;
  html: string;
} {
  const subject =
    entries.length === 1
      ? `fair.yoga: ${entries[0]!.code} fired`
      : `fair.yoga: ${entries.length} degradations fired`;

  const blocks = entries
    .map((e) => {
      const sample = Object.entries(e.sample)
        .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(String(v))}`)
        .join(' · ');
      return `<div style="margin:0 0 16px;">
        <p style="margin:0;font-weight:700;color:#1A5653;">${escapeHtml(e.code)}</p>
        <p style="margin:4px 0;">${escapeHtml(e.description)}</p>
        <p style="margin:0;color:#71645A;font-size:13px;">First seen ${escapeHtml(e.firstSeenAt.toISOString())} · last seen ${escapeHtml(e.lastSeenAt.toISOString())} · about ${e.occurrences} times</p>
        ${sample ? `<p style="margin:4px 0 0;color:#71645A;font-size:13px;">Latest: ${sample}</p>` : ''}
      </div>`;
    })
    .join('');

  return {
    subject,
    html: wrapEmail('A fallback fired', blocks, DEGRADATION_DIGEST_FOOTER),
  };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing digest test**

Create `src/services/degradation-digest.test.ts`. The sweep reads and claims every row in the table, so the test hands it a client scoped to this file's own codes (the way `timezone-audit.test.ts` does with `scopeSweep`) and stays in the parallel tier:

```ts
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const sendHtmlEmail = vi.fn();
vi.mock('@/lib/email', () => ({ sendHtmlEmail: (...a: unknown[]) => sendHtmlEmail(...a) }));

const { notifyOperatorOfDegradations, DegradationDigestError } = await import('./degradation-digest');

const prisma = new PrismaClient();
const PREFIX = 'test-digest-';
const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const A = `${PREFIX}${run}-A`;
const B = `${PREFIX}${run}-B`;
const OPERATOR = 'operator@example.com';

const T1 = new Date('2026-10-01T10:00:00.000Z');
const T2 = new Date('2026-10-02T10:00:00.000Z');

type Hook = (delegate: PrismaClient['degradationEvent']) => Promise<void>;

/**
 * A client that sees only this file's rows. `afterRead` runs after the sweep's
 * read and `afterClaim` after each of its claims, which is where a concurrent
 * event would land.
 */
function scoped(hooks: { afterRead?: Hook; afterClaim?: Hook } = {}): PrismaClient {
  const real = prisma.degradationEvent;
  return {
    degradationEvent: {
      findMany: async (args: object) => {
        const rows = await real.findMany({
          ...args,
          where: { code: { startsWith: `${PREFIX}${run}` } },
        });
        await hooks.afterRead?.(real);
        return rows;
      },
      updateMany: async (args: Parameters<typeof real.updateMany>[0]) => {
        const result = await real.updateMany(args);
        if (result.count === 1 && (args as { data: { lastNotifiedAt?: unknown } }).data.lastNotifiedAt) {
          await hooks.afterClaim?.(real);
        }
        return result;
      },
    },
  } as unknown as PrismaClient;
}

async function seed(code: string, lastSeenAt: Date, lastNotifiedAt: Date | null = null) {
  await prisma.degradationEvent.create({
    data: { code, occurrences: 4, firstSeenAt: T1, lastSeenAt, lastNotifiedAt, sample: { tier: 9 } },
  });
}

beforeEach(async () => {
  sendHtmlEmail.mockReset();
  sendHtmlEmail.mockResolvedValue({ ok: true });
  await prisma.degradationEvent.deleteMany({ where: { code: { startsWith: `${PREFIX}${run}` } } });
});

afterAll(async () => {
  await prisma.degradationEvent.deleteMany({ where: { code: { startsWith: `${PREFIX}${run}` } } });
  await prisma.$disconnect();
});

describe('notifyOperatorOfDegradations', () => {
  it('emails a new event once, to the operator, and marks it told', async () => {
    await seed(A, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(1);
    expect(sendHtmlEmail).toHaveBeenCalledTimes(1);
    expect(sendHtmlEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: OPERATOR, subject: expect.stringContaining(A) }),
    );
    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T2);
  });

  it('does not repeat an event that has not fired since it was told', async () => {
    await seed(A, T2, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(0);
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('emails again once the event fires after it was told, and only that one', async () => {
    await seed(A, T2, T1);
    await seed(B, T2, T2);

    const summary = await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(summary.emailed).toBe(1);
    expect(JSON.stringify(sendHtmlEmail.mock.calls)).toContain(A);
    expect(JSON.stringify(sendHtmlEmail.mock.calls)).not.toContain(B);
  });

  it('sends nothing, and needs no operator address, when nothing is due', async () => {
    await expect(notifyOperatorOfDegradations(scoped(), undefined)).resolves.toEqual({ emailed: 0 });
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('throws, and marks nothing told, when something is due and there is no operator address', async () => {
    await seed(A, T2);

    await expect(notifyOperatorOfDegradations(scoped(), undefined)).rejects.toBeInstanceOf(
      DegradationDigestError,
    );

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toBeNull();
    expect(sendHtmlEmail).not.toHaveBeenCalled();
  });

  it('releases its claim and throws when the provider refuses', async () => {
    await seed(A, T2, T1);
    sendHtmlEmail.mockResolvedValue({ ok: false, reason: 'RESEND_API_KEY is not configured' });

    await expect(notifyOperatorOfDegradations(scoped(), OPERATOR)).rejects.toThrow(
      /RESEND_API_KEY is not configured/,
    );

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T1);
  });

  it('releases its claim and throws when the send itself throws', async () => {
    await seed(A, T2);
    sendHtmlEmail.mockRejectedValue(new Error('network'));

    await expect(notifyOperatorOfDegradations(scoped(), OPERATOR)).rejects.toThrow(/network/);

    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toBeNull();
  });

  it('does not claim an event that fires between the read and the claim, and tells it next run', async () => {
    await seed(A, T2);
    const T3 = new Date('2026-10-02T11:00:00.000Z');

    const first = await notifyOperatorOfDegradations(
      scoped({
        afterRead: async (real) => {
          await real.update({ where: { code: A }, data: { lastSeenAt: T3 } });
        },
      }),
      OPERATOR,
    );
    expect(first.emailed).toBe(0);
    expect(sendHtmlEmail).not.toHaveBeenCalled();

    const second = await notifyOperatorOfDegradations(scoped(), OPERATOR);
    expect(second.emailed).toBe(1);
    const row = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(row.lastNotifiedAt).toEqual(T3);
  });

  it('keeps an event that fires after the claim but before the send due for the next run', async () => {
    await seed(A, T2);
    const T3 = new Date('2026-10-02T11:00:00.000Z');

    const first = await notifyOperatorOfDegradations(
      scoped({
        afterClaim: async (real) => {
          await real.update({ where: { code: A }, data: { lastSeenAt: T3 } });
        },
      }),
      OPERATOR,
    );
    expect(first.emailed).toBe(1);
    const claimed = await prisma.degradationEvent.findUniqueOrThrow({ where: { code: A } });
    expect(claimed.lastNotifiedAt).toEqual(T2);

    const second = await notifyOperatorOfDegradations(scoped(), OPERATOR);
    expect(second.emailed).toBe(1);
  });

  it('sends exactly one email when two runs read the same due rows', async () => {
    await seed(A, T2);
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const barrier = {
      afterRead: async () => {
        arrived += 1;
        if (arrived === 2) open();
        await gate;
      },
    };

    const [one, two] = await Promise.all([
      notifyOperatorOfDegradations(scoped(barrier), OPERATOR),
      notifyOperatorOfDegradations(scoped(barrier), OPERATOR),
    ]);

    expect(sendHtmlEmail).toHaveBeenCalledTimes(1);
    expect([one.emailed, two.emailed].sort()).toEqual([0, 1]);
  });

  it('describes a code the registry no longer knows without failing', async () => {
    await seed(A, T2);

    await notifyOperatorOfDegradations(scoped(), OPERATOR);

    expect(JSON.stringify(sendHtmlEmail.mock.calls)).toContain('no longer registered');
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/services/degradation-digest.test.ts`
Expected: FAIL — cannot resolve `./degradation-digest`.

- [ ] **Step 7: Write the sweep**

Create `src/services/degradation-digest.ts`:

```ts
/**
 * The operator's digest (#157): emails the degradation events that are new, or
 * that have fired again since the operator was last told. Runs inside the
 * `daily-cleanup` job; the mechanism is `docs/technical-architecture.md`
 * (Cron Jobs → Degradation events).
 *
 * CLAIM BEFORE SEND, the shape `email-fallback.ts` and `payment-reminders.ts`
 * use against a manual `/api/cron/daily-cleanup` overlapping a scheduled tick:
 * each row is claimed with a conditional `updateMany` keyed on the
 * `lastSeenAt` this run read, and a claim count other than 1 means another run
 * or a newer event got there first.
 *
 * The claim stamps `lastNotifiedAt` with the `lastSeenAt` it read, never with
 * the clock. An event landing after the stamp leaves `lastSeenAt` ahead of it,
 * so that row is due again next run instead of being swallowed.
 *
 * A failed send puts every claim back and throws, which flips the job unhealthy
 * on the verdict `/api/health` already publishes.
 */

import type { PrismaClient } from '@prisma/client';
import { DEGRADATION_CODES } from '@/lib/degradation-codes';
import { sendHtmlEmail } from '@/lib/email';
import { renderDegradationDigestEmail, type DegradationDigestEntry } from '@/lib/email-templates';
import { log } from '@/lib/log';

export interface DegradationDigestSummary {
  /** Events included in the email this run sent. */
  readonly emailed: number;
}

/** The digest could not reach the operator. The job reports unhealthy until it can. */
export class DegradationDigestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DegradationDigestError';
  }
}

const UNREGISTERED_DESCRIPTION = 'This code is no longer registered; see the code history in git.';

function describeCode(code: string): string {
  return code in DEGRADATION_CODES
    ? DEGRADATION_CODES[code as keyof typeof DEGRADATION_CODES].description
    : UNREGISTERED_DESCRIPTION;
}

export async function notifyOperatorOfDegradations(
  db: PrismaClient,
  operatorEmail: string | undefined = process.env.OPERATOR_EMAIL,
): Promise<DegradationDigestSummary> {
  const rows = await db.degradationEvent.findMany();
  const due = rows.filter((r) => r.lastNotifiedAt === null || r.lastNotifiedAt < r.lastSeenAt);
  if (due.length === 0) return { emailed: 0 };

  if (!operatorEmail) {
    log.error(
      { codes: due.map((r) => r.code) },
      'degradation events are due but OPERATOR_EMAIL is not set; nobody is being told',
    );
    throw new DegradationDigestError(
      'degradation events are due but OPERATOR_EMAIL is not set',
    );
  }

  const claimed: typeof due = [];
  for (const row of due) {
    const { count } = await db.degradationEvent.updateMany({
      where: {
        code: row.code,
        lastSeenAt: row.lastSeenAt,
        OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: row.lastSeenAt } }],
      },
      data: { lastNotifiedAt: row.lastSeenAt },
    });
    if (count === 1) claimed.push(row);
  }
  if (claimed.length === 0) return { emailed: 0 };

  const entries: DegradationDigestEntry[] = claimed.map((r) => ({
    code: r.code,
    description: describeCode(r.code),
    firstSeenAt: r.firstSeenAt,
    lastSeenAt: r.lastSeenAt,
    occurrences: r.occurrences,
    sample: (r.sample ?? {}) as Record<string, unknown>,
  }));
  const { subject, html } = renderDegradationDigestEmail(entries);

  let failure: unknown = null;
  try {
    const sent = await sendHtmlEmail({ to: operatorEmail, subject, html });
    if (!sent.ok) failure = new Error(sent.reason);
  } catch (err) {
    failure = err;
  }
  if (failure === null) return { emailed: claimed.length };

  let stranded = 0;
  for (const row of claimed) {
    try {
      await db.degradationEvent.updateMany({
        where: { code: row.code, lastNotifiedAt: row.lastSeenAt },
        data: { lastNotifiedAt: row.lastNotifiedAt },
      });
    } catch (err) {
      stranded += 1;
      log.error({ err, code: row.code }, 'could not release a degradation digest claim');
    }
  }
  const reason = failure instanceof Error ? failure.message : String(failure);
  throw new DegradationDigestError(
    `degradation digest not delivered: ${reason}${stranded > 0 ? ` (${stranded} claim(s) could not be released)` : ''}`,
    { cause: failure },
  );
}
```

- [ ] **Step 8: Run it and see it pass**

Run: `pnpm exec vitest run --project unit src/services/degradation-digest.test.ts`
Expected: PASS, 11 tests. If the barrier test hangs, a run never reached `findMany` — that is a failure of the test's premise, not a flake; fix the sweep to read before claiming, never add a sleep.

- [ ] **Step 9: Prove every guard bites**

Mutate, run the file, record the failing test and message, revert exactly:

1. Replace the conditional `updateMany` claim with `db.degradationEvent.update({ where: { code: row.code }, data: { lastNotifiedAt: row.lastSeenAt } }); claimed.push(row);` → the overlap test FAILS (`expected 1 call, got 2`) and `does not claim an event that fires between the read and the claim` FAILS.
2. Change the claim's `data` to `{ lastNotifiedAt: new Date() }` → `keeps an event that fires after the claim … due` FAILS.
3. Delete the release loop → `releases its claim and throws when the provider refuses` FAILS (`expected null to equal …`).
4. Delete the `if (!sent.ok)` line → the provider-refusal test FAILS (it resolves).
5. Delete the `!operatorEmail` branch → `throws, and marks nothing told, when … no operator address` FAILS.

`git status --short` shows only this task's files.

- [ ] **Step 10: Wire the sweep into the scheduler**

In `src/lib/scheduler.ts`:

1. Add to `SchedulerSweeps`: `notifyOperatorOfDegradations: (db: PrismaClient) => Promise<unknown>;`
2. In `startScheduler`, add `const { notifyOperatorOfDegradations } = await import('@/services/degradation-digest');` beside the other sweep imports and pass it in the `buildJobs({...})` argument.
3. In `buildJobs`, destructure it and insert it in `daily-cleanup`'s `isolatedSweeps` list **immediately before** `auditTeacherTimezones`, with the comment: `// Before the audit, which stays last (see below): a standing bad zone reports every run and would otherwise be the first error this job rethrows.`
4. Add the boot guard in `startScheduler`, after `globalThis.__fairYogaSchedulerStarted = true;`:

```ts
  if (process.env.NODE_ENV === 'production' && !process.env.OPERATOR_EMAIL) {
    log.error(
      'OPERATOR_EMAIL is not set — a degradation event will fail the daily-cleanup job instead of reaching a person (DEPLOYMENT.md §7)',
    );
  }
```

Add `'notifyOperatorOfDegradations',` to `SWEEP_NAMES` in `src/lib/scheduler.test.ts` (before `'auditTeacherTimezones'`), and update the `'daily-cleanup'` expectation in the job-to-sweep map to `['cleanupExpiredAuth', 'reapClosedWaitlistEntries', 'reapExpiredNotifications', 'notifyOperatorOfDegradations', 'auditTeacherTimezones']`. Add a test beside `registers nothing, and warns, when CRON_SCHEDULER=off`, copying its stubbing and cleanup, that stubs `NODE_ENV` to `production` and `OPERATOR_EMAIL` to `''`, calls `startScheduler()`, and expects `log.error` to have been called once with a string containing `OPERATOR_EMAIL`; and a second that stubs `OPERATOR_EMAIL` to `ops@example.com` and expects `log.error` not to have been called with that string.

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
Expected: PASS. Mutation: delete the boot `log.error` → the first new test FAILS; swap the digest and audit positions in `buildJobs` → the job-to-sweep map test FAILS. Revert both.

- [ ] **Step 11: Wire the sweep into the manual cron route**

In `src/app/api/cron/daily-cleanup/route.ts`: import `notifyOperatorOfDegradations` from `@/services/degradation-digest`; add `const degradationDigest = await settle(() => notifyOperatorOfDegradations(prisma));` after `notificationRetention` and before `timezoneAudit`; add `degradationDigest` to the body object and to the `worstStatus([...])` array. In its docblock sentence naming the body fields (`data.auth.ok`, `data.waitlistRetention.ok`, …) add `data.degradationDigest.ok`.

In `route.test.ts`, add `const notifyOperatorOfDegradations = vi.fn();` beside the other mocks, `vi.mock('@/services/degradation-digest', () => ({ notifyOperatorOfDegradations: (...args: unknown[]) => notifyOperatorOfDegradations(...args) }));`, default it to resolve in the file's existing `beforeEach` the way the other sweeps are defaulted, and add one test: when `notifyOperatorOfDegradations` rejects, the response status is 500 and the body's `degradationDigest.ok` is `false` while `timezoneAudit` still ran.

Run: `pnpm exec vitest run --project unit src/app/api/cron/daily-cleanup/route.test.ts`
Expected: PASS.

- [ ] **Step 12: Document the variable and run the broader suite**

In `.env.example`, after the `EMAIL_FROM=""` line, add:

```
# Where the daily degradation digest goes (#157). Required in production: with it unset,
# a degradation event fails the daily-cleanup job instead of reaching a person.
OPERATOR_EMAIL=""
```

Run: `pnpm run typecheck && pnpm run lint && pnpm exec vitest run --project unit src/services src/lib/scheduler.test.ts src/lib/email-templates.test.ts src/app/api/cron`
Expected: all green.

- [ ] **Step 13: Commit**

```bash
git add src/services/degradation-digest.ts src/services/degradation-digest.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts src/lib/scheduler.ts src/lib/scheduler.test.ts src/app/api/cron/daily-cleanup/route.ts src/app/api/cron/daily-cleanup/route.test.ts .env.example
git commit -m "$(cat <<'EOF'
feat: daily digest of degradation events to OPERATOR_EMAIL (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The aggregate on `/api/health`

**Files:**
- Modify: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts`

**Interfaces:**
- Consumes: the `DegradationEvent` model (Task 1).
- Produces: a `degradations: { open: number }` member in the 200 body. The 503 body is unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/health/route.test.ts`, change the db mock to carry a count and widen `HealthBody`:

```ts
const { queryRaw, count } = vi.hoisted(() => ({
  queryRaw: vi.fn(async () => [{ ok: 1 }]),
  count: vi.fn(async (_args: unknown) => 0),
}));
vi.mock('@/lib/db', () => ({
  prisma: { $queryRaw: queryRaw, degradationEvent: { count } },
}));
```

Add `degradations?: { open: number };` to `HealthBody`, and add to the `describe`:

```ts
  it('reports how many degradation events were seen in the last 24 hours, and leaves status alone', async () => {
    count.mockResolvedValueOnce(2);
    const before = Date.now();

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.degradations).toEqual({ open: 2 });
    const where = (count.mock.calls[0]![0] as { where: { lastSeenAt: { gte: Date } } }).where;
    const cutoff = where.lastSeenAt.gte.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5000);
  });

  it('carries no code, sample or timestamp from the degradation table', async () => {
    count.mockResolvedValueOnce(3);

    const { body } = await read();

    expect(Object.keys(body.degradations ?? {})).toEqual(['open']);
    expect(JSON.stringify(body)).not.toMatch(/INCOME_TIER|TIMEZONE|sample|lastSeen/);
  });

  it('omits the block when the database probe fails', async () => {
    queryRaw.mockRejectedValueOnce(new Error('down'));

    const { status, body } = await read();

    expect(status).toBe(503);
    expect(body.degradations).toBeUndefined();
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run --project unit src/app/api/health/route.test.ts`
Expected: FAIL — `body.degradations` is `undefined`.

- [ ] **Step 3: Add the aggregate**

In `src/app/api/health/route.ts`, add above `GET`:

```ts
/** A degradation event is "open" while it has fired within this window. */
const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000;
```

Inside the `try`, after the `SELECT 1` probe and before the `return`, add:

```ts
    const open = await prisma.degradationEvent.count({
      where: { lastSeenAt: { gte: new Date(Date.now() - OPEN_WINDOW_MS) } },
    });
```

and add `degradations: { open },` to the 200 body, after `jobs`. Replace the route's docblock with:

```ts
/**
 * Health check for the reverse proxy / uptime monitor.
 * Public by design; reveals liveness, DB reachability, per-job scheduler state
 * (timestamps + `isJobHealthy`'s verdict — error text stays in the server log),
 * and how many degradation events fired in the last day, as a bare number. Which
 * ones, and what they carried, reach only the operator's inbox
 * (`docs/technical-architecture.md`, Cron Jobs → Degradation events). Nothing
 * else.
 */
```

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run --project unit src/app/api/health/route.test.ts`
Expected: PASS. Existing tests that assert the whole body with `toEqual` need `degradations: { open: 0 }` added; update them, no other change.

- [ ] **Step 5: Prove the guards bite**

Mutation 1: change the window to `60 * 1000` → the first test FAILS (`expected … to be greater than or equal to 86399000`). Mutation 2: spread the whole row into the block (`degradations: { open, codes: ['X'] }`) → the second test FAILS. Revert both; `git status --short` shows only this task's files.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/health/route.test.ts
git commit -m "$(cat <<'EOF'
feat: /api/health reports how many degradation events fired in a day (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Audit the remaining log sites and record the classification

This task's output is `docs/degradation-sites.md` and whatever conversions the rule produces. The conversion recipe is Task 3's; this task decides which sites it applies to.

**Files:**
- Create: `docs/degradation-sites.md`
- Modify: `src/lib/degradation-codes.ts` and the call sites the audit converts
- Test: the converted sites' existing tests, plus one assertion per new code

**Interfaces:**
- Consumes: `logDegraded`, `DEGRADATION_CODES` (Tasks 2–3).
- Produces: `docs/degradation-sites.md`, linked from `DEGRADATION_CODES`' docblock and from every converted site's docblock.

- [ ] **Step 1: Derive the surface**

```bash
grep -rnE "log\.(warn|error)\(" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' > "$TMPDIR/degradation-sites.txt"
wc -l "$TMPDIR/degradation-sites.txt"
```

`$TMPDIR` is a scratch location outside the repo. Expected: one line per call. Record the two per-level counts as arithmetic in the doc (`warn lines + error lines = total`), each from its own `grep -c`.

- [ ] **Step 2: Apply the rule to every site**

Read each site with 15 lines of context. **The rule:** a site is a *degradation* iff it substitutes, or withholds, a value a user will see, because data that should have been impossible turned up. It is *routine* otherwise. Work through the surface in file batches and write a verdict for every line, none skipped. Calibration, fixed by the spec:

- Lock contention (`isLockTimeout` branches), rate-limit throttles, 4xx refusals, and documented races such as the `session.studentId` hard-delete race on the public page are **routine**.
- A caught exception that the user sees as an error is a **failure**, not a degradation (it substitutes nothing); record it as routine with the reason "failure, surfaced as an error".
- The sites to examine first, because the issue or this plan's research flagged them: the unreadable-date branches in `timezone.ts`, the `log.warn` sites in `entry-generation.ts`, `rule-slot-holder.ts`, `entry-conflict.ts`, `(student)/bookings/page.tsx`, and the unresolved-IP warning in `rate-limit.ts`. Decide each on the rule; do not assume.

When a verdict is not obvious from the code, say what was unclear in the doc rather than guessing.

- [ ] **Step 3: Write `docs/degradation-sites.md`**

Structure: the rule (verbatim from Step 2); a table with columns `site (file:line)`, `level`, `verdict` (`degradation` | `routine`), `code or reason`; and a section "Re-deriving this list" holding the exact commands from Step 1 with the arithmetic. Then a section per registered code stating what to do when it arrives in the digest: where the bad value lives, how to confirm it, how to correct it.

- [ ] **Step 4: Convert each site the audit classified as a degradation**

For each: add a registry entry (`level`, `description`, `contextKeys` per the registry docblock's rules), change the call to `logDegraded('<CODE>', {…}, '<existing message unchanged>', err?)`, keep the message text so existing assertions pass, and add a test asserting `expect.objectContaining({ code: '<CODE>' })` on the log spy at that site. Update the site's docblock to name the code and link `docs/degradation-sites.md` (no counts, no rosters). Run that file's test after each conversion.

- [ ] **Step 5: Run the tether and the full unit tier**

Run: `pnpm exec vitest run --project unit src/lib/degradation-codes.test.ts` then `pnpm exec vitest run --project unit --project components`
Expected: PASS; every new code has a call site and no call uses a variable code.

- [ ] **Step 6: Prove the doc's re-derivation command bites**

Add one throwaway `log.warn('x')` to a source file, re-run Step 1's command, confirm the total rises by exactly one and the line appears; delete it. Record the check in the commit body.

- [ ] **Step 7: Commit**

```bash
git add docs/degradation-sites.md src/lib/degradation-codes.ts
git add <each converted source file and its test, by exact path>
git commit -m "$(cat <<'EOF'
feat: classify every log site and report the degradations among them (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Documentation, written last against the final code

**Files:**
- Modify: `docs/technical-architecture.md`, `DEPLOYMENT.md`, `docs/data-model.md`
- Modify: the docblocks the sweep below finds

**Interfaces:**
- Consumes: everything above. Nothing downstream.

- [ ] **Step 1: Architecture doc**

In `docs/technical-architecture.md`:

1. Replace the line beginning `- **Monitoring / observability.** Simple logging first…` with a paragraph stating that fallbacks that substitute a value are recorded as `DegradationEvent` rows by `logDegraded` and emailed to `OPERATOR_EMAIL` in a daily digest, that `/api/health` carries the aggregate, and that a log backend (Grafana/Loki or similar) remains deferred until logs leave the box, at which point `#739` (the `err` serializer) is a prerequisite.
2. In the Cron Jobs table, extend the Daily cleanup row's "What it does" with "emails the operator the degradation events that are new or have fired again".
3. Under Cron Jobs add a `### Degradation events` subsection covering: the registry, the allowlist, coalescing and its approximate count, the claim-before-send digest, why `lastNotifiedAt` takes the `lastSeenAt` value, and what an unset `OPERATOR_EMAIL` does. Add the digest to the **Overlapping triggers** list as a fourth job whose send is guarded, with the claim as its mechanism.
4. In the two `.env` / compose examples that list `RESEND_API_KEY`, add `OPERATOR_EMAIL` beside it.

- [ ] **Step 2: Deployment doc**

In `DEPLOYMENT.md`: add `OPERATOR_EMAIL` to the environment table next to `RESEND_API_KEY` / `EMAIL_FROM` ("required in production; the daily degradation digest goes here"); in §7 replace the clause "no automated alerting on log level exists yet (issue #157)" with a statement of what is alerted (degradation events, by email, daily) and what is not (other log lines), and describe the `degradations.open` field on `/api/health`.

- [ ] **Step 3: Data model doc**

In `docs/data-model.md`, add `### DegradationEvent (operator-facing fallbacks, #157)` under `## Communication`, after `Announcement`: the columns, one row per code, no foreign keys, no personal data by construction, not a node in `docs/lock-order.md`.

- [ ] **Step 4: Sweep for what was invalidated**

```bash
grep -rn '#157' src docs DEPLOYMENT.md CLAUDE.md --include='*.ts' --include='*.tsx' --include='*.md'
grep -rniE "only thing that would tell you|no automated alerting|log line is what" src docs DEPLOYMENT.md CLAUDE.md --include='*.ts' --include='*.tsx' --include='*.md'
grep -rniE "added when there's something to monitor" docs DEPLOYMENT.md CLAUDE.md
```

Give every hit a verdict (corrected, still true, or history in a spec/plan that stays as written). Specs and plans for other issues are records and stay unedited.

- [ ] **Step 5: Read the touched docblocks whole**

A grep finds a stale name, never a stale description. Open each docblock this branch changed (`tiers.server.ts`, `timezone.ts`, `finish-window.ts`, `scheduler.ts`, the health route, and every Task 6 site) and read it end to end for any sentence about how a fallback is observed.

- [ ] **Step 6: Full verification**

```bash
pnpm run worktree:up
pnpm run verify
```

Expected: green. Report the arithmetic of the suite (`N = unit + components + integration`) in the PR body rather than the word "green" alone.

- [ ] **Step 7: Commit**

```bash
git add docs/technical-architecture.md DEPLOYMENT.md docs/data-model.md
git add <each docblock file touched by the sweep, by exact path>
git commit -m "$(cat <<'EOF'
docs: name the degradation digest and correct the docblocks that promised it (#157)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review against the spec

- **Registry, allowlist, helper, `FireAndForget`, coalescing with trailing flush** — Task 2.
- **Table, no FKs, `CHECK`, migration via `prisma`** — Task 1.
- **Digest: due selection, claim-before-send with `lastSeenAt` stamp, release on failure, dry-run and no-key behaviour, no operator address, `isolatedSweeps` placement** — Task 4. Production without a key: the digest claims, receives `{ ok: false }` from `sendHtmlEmail`, releases and throws, so no guard is duplicated here (spec §4).
- **Health aggregate only, no codes** — Task 5.
- **Seeded sites** (tier, four timezone fallbacks) — Task 3; **audit and further conversions, classification doc** — Task 6.
- **Docs, docblocks, `OPERATOR_EMAIL`, the sweep for invalidated claims** — Task 7 (and `.env.example` in Task 4).
- **Boot-time `error` when `OPERATOR_EMAIL` is unset** — Task 4, Step 10.
- **Unit-tier safety** (a tripped fallback must not write to a table) — Task 2, Step 9.
- Type names are consistent across tasks: `DegradationWrite`, `PendingDegradation`, `DegradationContext<C>`, `TierReadContext`, `DegradationDigestEntry`, `DegradationDigestSummary`, `DegradationDigestError`.
