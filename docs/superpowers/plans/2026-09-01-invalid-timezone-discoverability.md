# Invalid Stored Timezone: Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an unresolvable `Teacher.defaultTimezone` discoverable — a red `/api/health` and a `log.error` — instead of silently degrading every teacher-facing calendar boundary to UTC.

**Architecture:** Four changes, none of which alters what a correct install does. A new client-safe leaf module owns the IANA construct-probe so both the write-side validator and a new read-side auditor can reach it. `timezone.ts`'s two fallbacks become `log.error` and stop misattributing an unreadable *instant* as an invalid *zone*. A new read-only service probes every live teacher's stored zone and throws when one fails; folding it into the existing `daily-cleanup` job makes the existing `JobHealth` → `/api/health` `degraded` path carry the signal, with no new infrastructure and no new public field.

**Tech Stack:** TypeScript (strict), Prisma, Vitest, pino.

**Spec:** None — this was classified **bounded** during brainstorming (one file's two functions plus an existing job to extend; no data-model change, no changed invariant, no second reasonable design). The design of record is GitHub issue #145 *as corrected by the premise verification below*, plus the design notes in each task.

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types.
- Services are framework-agnostic: typed in, typed out, no HTTP concerns, no framework imports.
- Test-first. Write the failing test, see it fail with the expected message, implement, see it pass.
- **Every guard gets mutation-proofed**: break it, record the exact error text in the commit body or PR body, restore, re-verify. A pin that compiles but cannot fail certifies nothing.
- **`@/lib/log` is pino and server-only.** Check the whole transitive import chain before it can reach a `'use client'` component. This constraint is the reason Task 1 exists in the shape it does.
- Never `git add -A` or `git add .` — stage exact paths.
- Quote paths containing parentheses when staging: `'src/app/api/cron/daily-cleanup/route.ts'` is safe, but any `(teacher)`/`(public)` path must be quoted.
- In this worktree the `integration` and `e2e` tiers cannot run locally (both need the app live on `:3000` and the shared dev DB). Scope local verification to `typecheck`, `lint`, `--project unit`, `--project unit-sweeps`, `--project components`. CI is the signal for the other two tiers; cite the CI run, not a local `verify`, in the PR body.
- **Never restart or kill a dev server on `:3000`** — check first; if one is running it is the user's.

---

## Premise verification (measured 2026-09-01, before any code was written)

This section is the plan's most load-bearing content, because it moves the issue's own priorities. Task 3 exists *despite* the issue's stated reason for it, not because of it.

### What held

| Claim | Verdict |
|---|---|
| Two catches in `timezone.ts` swallow an invalid zone → UTC | ✅ `:97`, `:242` |
| The only HTTP write path validates | ✅ `updateTeacherSchema`, gating `PUT /api/teachers/[id]` |
| Teacher creation hardcodes `Europe/Amsterdam` | ✅ `src/app/api/teachers/route.ts:49`, and the column default (`schema.prisma:135`) |
| GDPR erasure does not touch the column | ✅ `gdpr.ts:1412` writes twelve fields; `defaultTimezone` is not among them |
| `SessionUser` carries it on every authenticated teacher request | ✅ `session.ts:104` |
| The column is a bare `String` with no enum or check | ✅ `schema.prisma:135` |
| No `logError`, no `constants/errorIds.ts`, no error-reporting service | ✅ there is no `src/constants/` **directory** at all |

### What was stale

Line references drifted: `schemas.ts:117` → **`:196`**; `isValidTimeZone` at `:78-85` → **`:157-164`**.

### What was tighter than the issue claimed

`grep -rn "Intl\." src/` outside tests and comments returns **5 hits**: 3 constructions + 2 `Intl.DateTimeFormatPartTypes` type annotations. Of the 3 constructions, **2** consume a stored zone (`timezone.ts:39` inside `classStartInstant`'s `try`, `:83` inside `startOfLocalDay`'s) and **1** is the validator itself (`schemas.ts:159`). `toLocale*` outside comments: **zero** — `format.ts` formats by hand with UTC accessors.

So there is no third consumer that throws uncaught, and `startOfLocalWeek` inherits the fallback through `startOfLocalDay`. The two catches are the entire surface. Re-derive with:

```bash
grep -rn "Intl\." --include='*.ts' --include='*.tsx' src/ | grep -v '\.test\.' | grep -vE ':\s*(\*|//)'
grep -rn "toLocale" --include='*.ts' --include='*.tsx' src/ | grep -v '\.test\.'
```

### What was WEAKER than the issue claimed — the correction that matters

The issue calls tzdata renames "the realistic path, and it needs no mistake by anyone", and selects its option 4 as "the one that catches the realistic cause". **I could not reproduce it.** On Node v22.22.2 with full ICU, every renamed or deprecated identifier probed still resolves:

`Europe/Kiev`, `Asia/Calcutta`, `US/Eastern`, `Australia/Canberra`, `America/Godthab`, `Pacific/Enderbury`, `Asia/Rangoon`, `Europe/Uzhgorod`, `Europe/Zaporozhye`, `America/Santa_Isabel`, `CET` — all `OK`.

ICU ships IANA's `backward` links, and `Intl.supportedValuesOf('timeZone')` (418 entries) *includes* `Europe/Kiev`. **No identifier is known that ICU accepted at one version and rejects at this one.** Task 3 is therefore justified by the *other* two paths, not this one, and the plan says so rather than inheriting the issue's reasoning.

### What was STRONGER than the issue claimed

"A second write path that forgets it — a bulk import, an admin tool, a seed script" is written as hypothetical. It is not: `prisma/seed.ts` writes `defaultTimezone` at `:171`, `:188`, `:216` straight through Prisma with the schema nowhere in the path, as does every test fixture. All those values are valid today, so the hole is **demonstrated rather than exploited**. Together with a direct DB edit on the VPS — a normal operation on a single-box install — these are the two live paths Task 3 actually covers.

### A defect the issue did not name

`startOfLocalDay`'s catch **misattributes**. `formatToParts` on an Invalid Date throws `RangeError: Invalid time value` (measured), so an unreadable *instant* is logged as `'invalid timezone'` naming a zone that was fine. This is precisely the bug `classStartInstant` already fixed — its own comment calls it "the original defect" and pre-checks its inputs for it. `startOfLocalDay` never got the same treatment. Task 2 closes it.

### Options from the issue that this plan deliberately does NOT take

- **Option 2 (fail fast at the session boundary).** Collapses into Tasks 2+3 with an extra UX decision attached. Refusing the session locks a teacher out of their own tool over data they cannot fix without logging in; substituting a default loudly is what the fallback already does minus the loudness, which Task 2 supplies.
- **Option 3 (Prisma enum or check constraint).** Cannot be done well. A Postgres `CHECK` cannot do the lookup, and a trigger against `pg_timezone_names` validates against *Postgres's* zone list rather than ICU's — a second validator that can disagree with the first is worse than one.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `src/lib/iana-timezone.ts` | **create** | The IANA construct-probe, and nothing else. Zero imports, so it is safe on both sides of the client boundary. |
| `src/lib/iana-timezone.test.ts` | **create** | Direct unit tests for the probe. |
| `src/lib/schemas.ts` | modify | Delete the local `isValidTimeZone`; import it from the leaf. Behaviour unchanged. |
| `src/lib/timezone.ts` | modify | Honest attribution in `startOfLocalDay`; both fallbacks escalate to `log.error`. |
| `src/lib/timezone.test.ts` | modify | Pin the new attribution and the new severity. |
| `src/services/timezone-audit.ts` | **create** | The read-only sweep: probe every live teacher's stored zone, throw when any fails. |
| `src/services/timezone-audit.test.ts` | **create** | Fixture-scoped tests for the sweep. |
| `src/lib/scheduler.ts` | modify | Add the sweep to `SchedulerSweeps`, the imports, and the `daily-cleanup` job. |
| `src/lib/scheduler.test.ts` | modify | Extend `SWEEP_NAMES` and the job-routing map. |
| `src/app/api/cron/daily-cleanup/route.ts` | modify | Run the third sweep, so the documented `CRON_SCHEDULER=off` + systemd mode also gets the check. |
| `src/app/api/cron/daily-cleanup/route.test.ts` | modify | Extend the status-contract tests to three sweeps. |

**Task order is load-bearing.** Task 4 imports `auditTeacherTimezones` from Task 3, and Task 1 must precede Task 3 (the sweep imports the probe). Tasks 1 and 2 are independent of each other.

---

### Task 1: A client-safe home for the IANA probe

**Why this shape, and not the obvious one.** The natural move is to put `isValidTimeZone` in `timezone.ts` beside the two functions whose tolerance it describes. **That breaks the build's client boundary.** `timezone.ts` imports `@/lib/log` (pino, server-only), and `@/lib/schemas` is imported by at least twelve `'use client'` components — `class-edit-form.tsx`, `studio-template-form.tsx`, `contact-form.tsx`, `tier-form.tsx`, `app/(teacher)/class/new/page.tsx`, and more. Making `schemas.ts` import `timezone.ts` would drag pino into the client bundle.

The repo has already solved this exact shape once: `src/lib/tiers.ts` (client-safe) versus `src/lib/tiers.server.ts` (imports `log`). This task follows that precedent with a leaf module that imports nothing at all.

**Files:**
- Create: `src/lib/iana-timezone.ts`
- Create: `src/lib/iana-timezone.test.ts`
- Modify: `src/lib/schemas.ts` (delete `isValidTimeZone` at `:155-164`; add an import at the top)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isValidTimeZone(tz: string): boolean` from `@/lib/iana-timezone`. Tasks 3 and 4 depend on this exact name and signature.

- [ ] **Step 1: Write the failing test**

Create `src/lib/iana-timezone.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isValidTimeZone } from './iana-timezone';

describe('isValidTimeZone', () => {
  it('accepts a current IANA identifier', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  /**
   * The construct-probe accepts aliases, and that is the point: it must accept
   * exactly what `classStartInstant` can interpret, not the narrower set
   * `Intl.supportedValuesOf` happens to enumerate. Measured 2026-09-01 on Node
   * v22.22.2 (full ICU): ICU ships IANA's `backward` links, so every one of
   * these still resolves.
   */
  it('accepts renamed and deprecated identifiers, because Intl still resolves them', () => {
    for (const alias of ['Europe/Kiev', 'Asia/Calcutta', 'US/Eastern', 'CET']) {
      expect(isValidTimeZone(alias)).toBe(true);
    }
  });

  it('rejects an identifier Intl cannot resolve', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  /**
   * `Invalid/` is not one of IANA's ten areas (Africa, America, Antarctica,
   * Arctic, Asia, Atlantic, Australia, Europe, Indian, Pacific), so this
   * sentinel can never become valid under a future tzdata release. Re-derive
   * the area list with:
   *   [...new Set(Intl.supportedValuesOf('timeZone').map(z => z.split('/')[0]))]
   */
  it('rejects the reserved test sentinel, which no tzdata release can make valid', () => {
    expect(isValidTimeZone('Invalid/Test_Zone_145')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/lib/iana-timezone.test.ts`
Expected: FAIL — `Failed to resolve import "./iana-timezone"`.

- [ ] **Step 3: Create the leaf module**

Create `src/lib/iana-timezone.ts`:

```ts
/**
 * Whether `Intl` can resolve an IANA timezone identifier.
 *
 * A construct-probe rather than `Intl.supportedValuesOf`, because the question
 * this answers is "can the calendar functions interpret this string", and the
 * probe accepts exactly what they accept — aliases and `backward` links
 * included, which `supportedValuesOf` does not promise to enumerate.
 *
 * ITS OWN MODULE, WITH NO IMPORTS, and that is the whole reason this file
 * exists rather than the function living beside its consumers in
 * `timezone.ts`. Two callers need it from opposite sides of the client
 * boundary: `schemas.ts`, which many `'use client'` components import, and the
 * server-only audit sweep. `timezone.ts` imports `@/lib/log` (pino), so
 * hosting the probe there would pull a server-only logger into the client
 * bundle. Same split, same reason, as `tiers.ts` against `tiers.server.ts`.
 *
 * Keep this file dependency-free. An import added here is an import added to
 * every client bundle that reaches `schemas.ts`.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/lib/iana-timezone.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Point `schemas.ts` at the leaf**

In `src/lib/schemas.ts`, delete the local definition and its comment (currently `:155-164`):

```ts
// Construct-probe rather than Intl.supportedValuesOf: the probe accepts
// exactly what classStartInstant can handle, aliases included.
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
```

Add to the import block at the top of the file (which currently holds only `zod` and `@/lib/tiers`):

```ts
import { isValidTimeZone } from '@/lib/iana-timezone';
```

Leave `updateTeacherSchema`'s `.refine(isValidTimeZone, 'Unknown timezone')` exactly as it is.

- [ ] **Step 6: Verify the existing schema tests still pass unedited**

Run: `npx vitest run --project unit src/lib/schemas.test.ts`
Expected: PASS — including `updateTeacherSchema.defaultTimezone`'s four cases at `:314-326`. They must pass **without being edited**; the behaviour is unchanged, only the definition moved.

- [ ] **Step 7: Mutation-proof the wiring**

The risk this proves against: the schema silently stops routing through the probe (a botched import, a stray local shadow).

Temporarily edit `src/lib/iana-timezone.ts` to `return true;` unconditionally. Run:

`npx vitest run --project unit src/lib/schemas.test.ts src/lib/iana-timezone.test.ts`

Expected: RED in **both** files — `schemas.test.ts:325` (`{ defaultTimezone: 'Not/AZone' }` should be `false`, got `true`) and the leaf's own rejection cases. Record the exact assertion text for the PR body, then restore the file and re-run to confirm GREEN.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/iana-timezone.ts src/lib/iana-timezone.test.ts src/lib/schemas.ts
git commit -m "refactor(timezone): give the IANA probe a client-safe module of its own (#145)"
```

---

### Task 2: Honest and loud timezone fallbacks

Two changes to the same four log lines, so they are one task: a reviewer reading the diff sees both, and splitting them would put two commits in conflict over the same lines.

**(a) Severity.** Both fallbacks become `log.error`. On a pino-to-stdout single-VPS stack, `error` is the only severity signal available, and it costs nothing.

**(b) Attribution.** `startOfLocalDay`'s catch cannot currently tell an invalid *zone* from an unreadable *instant*, because `formatToParts` throws `RangeError: Invalid time value` for the latter. `classStartInstant` fixed this same defect for itself — see its 15-line comment beginning "THREE WAYS TO FAIL, THREE MESSAGES" — by pre-checking its inputs before the `try`. `startOfLocalDay` gets the same treatment.

**This change is return-value-neutral, verified.** Today an Invalid instant reaches the catch, and `new Date(NaN)` with `setUTCHours(0,0,0,0)` applied is still `NaN`. The early return produces the identical `Date(NaN)`. Only the log line changes.

**Files:**
- Modify: `src/lib/timezone.ts` (`startOfLocalDay` at `:81-103`; `classStartInstant`'s catch at `:241-243`)
- Modify: `src/lib/timezone.test.ts` (the `startOfLocalDay` describe at `:13-68`; the `classStartInstant` describe from `:73`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no new exports. Signatures of `startOfLocalDay` and `classStartInstant` are unchanged.

- [ ] **Step 1: Write the failing tests**

In `src/lib/timezone.test.ts`, inside the existing `describe('startOfLocalDay', …)` block, **replace** the existing test at `:60-67`:

```ts
  it('warns when falling back so the bad zone is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'Not/AZone');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });
```

with these three:

```ts
  /**
   * `error`, not `warn`. On a pino-to-stdout single-VPS install the severity
   * is the only signal available, and a stored zone that stopped resolving
   * silently degrades every teacher-facing calendar boundary to UTC (#145).
   */
  it('logs at error level when falling back, so the bad zone is findable', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    startOfLocalDay(new Date('2026-07-26T13:45:00Z'), 'Not/AZone');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC'),
    );
  });

  /**
   * `formatToParts` throws `RangeError: Invalid time value` on an Invalid
   * Date, so before #145 an unreadable INSTANT arrived at the catch and was
   * logged as "invalid timezone" naming a zone that was perfectly fine. Same
   * defect `classStartInstant` fixed for itself; this is the assertion that
   * keeps it fixed here.
   */
  it('blames the instant, not the timezone, when the instant is unreadable', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    startOfLocalDay(new Date(NaN), 'Europe/Amsterdam');
    expect(error).toHaveBeenCalledTimes(1);
    const [, msg] = error.mock.calls[0] as [unknown, string];
    expect(msg).toContain('unreadable instant');
    expect(msg).not.toContain('invalid timezone');
  });

  /**
   * Pins today's return value across the attribution fix. The old path reached
   * the catch and returned `new Date(NaN)` with `setUTCHours` applied — still
   * NaN. The early return must produce the same thing, so no caller changes.
   */
  it('still returns an Invalid Date for an unreadable instant', () => {
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    expect(Number.isNaN(startOfLocalDay(new Date(NaN), 'Europe/Amsterdam').getTime())).toBe(true);
  });
```

Then, inside the existing `describe('classStartInstant', …)` block, add:

```ts
  it('logs at error level when falling back to UTC interpretation (#145)', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    classStartInstant({ date: day('2026-07-26'), startTime: hhmmToTime('09:00') }, 'Not/AZone');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Not/AZone' }),
      expect.stringContaining('falling back to UTC interpretation'),
    );
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`
Expected: FAIL, four tests. The `log.error` spies record zero calls (the code still calls `log.warn`), and the attribution test fails on `expect(msg).toContain('unreadable instant')`.

- [ ] **Step 3: Implement in `startOfLocalDay`**

Replace the body of `startOfLocalDay` (`src/lib/timezone.ts:81-103`) with:

```ts
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  // CHECKED BEFORE THE `try`, for the reason `classStartInstant` sets out at
  // length: `formatToParts` throws a RangeError on an Invalid Date, so an
  // unreadable instant would otherwise arrive at the catch below and be logged
  // as an invalid timezone, naming a zone that was never the problem.
  //
  // Returns the same Invalid Date the catch already produced for this input —
  // `setUTCHours` on a NaN date leaves it NaN — so no caller's behaviour
  // changes. What changes is that the cause is greppable.
  if (Number.isNaN(instant.getTime())) {
    log.error({ timeZone }, 'unreadable instant, cannot compute a local calendar date');
    return new Date(NaN);
  }

  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
    for (const { type, value } of dtf.formatToParts(instant)) {
      if (type !== 'literal') parts[type] = Number(value);
    }

    return new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!));
  } catch {
    log.error({ timeZone }, 'invalid timezone, falling back to UTC calendar date');
    const utc = new Date(instant);
    utc.setUTCHours(0, 0, 0, 0);
    return utc;
  }
}
```

- [ ] **Step 4: Implement in `classStartInstant`**

At `src/lib/timezone.ts:242`, change the one word:

```ts
    log.error({ timeZone }, 'invalid timezone, falling back to UTC interpretation');
```

- [ ] **Step 5: Update the two docblocks that describe the old behaviour**

Comments state what is true now — replace, never annotate with "this previously read". Two sentences reach the changed lines:

In `startOfLocalDay`'s docblock, replace:

```
 * Unknown timezones fall back to the UTC calendar date rather than throwing,
 * matching `classStartInstant`.
```

with:

```
 * Unknown timezones fall back to the UTC calendar date rather than throwing,
 * matching `classStartInstant`, and log at `error` — the fallback is a
 * wrong-but-bounded answer that nothing else would report (#145). An
 * unreadable instant is a different fault and says so.
```

In `classStartInstant`'s docblock, replace:

```
 * Unknown timezones fall back to UTC interpretation rather than throwing —
 * a wrong-but-bounded answer beats a crashed cron run.
```

with:

```
 * Unknown timezones fall back to UTC interpretation rather than throwing —
 * a wrong-but-bounded answer beats a crashed cron run — and log at `error`,
 * because nothing else reports that the answer is the wrong one (#145).
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`
Expected: PASS, whole file.

Note for the implementer: `startsInPast`'s existing test at `:324-338` asserts on a `log.warn` spy and `not.toContain('invalid timezone')`. It covers the unreadable-`startTime` path, which still logs `warn` — it should pass unedited. If it reddens, that is a real finding about the change; report it rather than editing the assertion.

- [ ] **Step 7: Mutation-proof both guards**

Two separate mutations, each restored before the next:

1. **Attribution.** Delete the `Number.isNaN(instant.getTime())` pre-check from `startOfLocalDay`. Run the file.
   Expected: RED on `blames the instant, not the timezone` — `expect(msg).toContain('unreadable instant')` fails, and `not.toContain('invalid timezone')` fails too, which is the original defect reappearing. Record both strings. Restore.
2. **Severity.** Change `log.error` back to `log.warn` at `:97`. Run the file.
   Expected: RED on `logs at error level when falling back` — the `log.error` spy records zero calls. Record it. Restore.

Re-run the file after restoring to confirm GREEN.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/timezone.ts src/lib/timezone.test.ts
git commit -m "fix(timezone): log fallbacks at error and stop blaming the zone for a bad instant (#145)"
```

---

### Task 3: The stored-timezone audit sweep

**What this covers, and what it does not.** The issue's stated justification for a sweep is tzdata renames; the premise verification above could not reproduce that path on this Node, and this task does **not** claim to address it. What it does address are the two paths that were verified: a direct database edit on the single VPS, and a second write path that bypasses `updateTeacherSchema` — of which `prisma/seed.ts` (`:171`, `:188`, `:216`) is already one, writing the column straight through Prisma with the schema nowhere in the path.

**Why it throws.** `log.error` alone still requires someone to be reading logs. Throwing makes the existing machinery carry the signal for free: `isolatedSweeps` logs it with the sweep name, `makeTick` records `lastError` and withholds `lastSuccessAt`, and `/api/health` turns that into `healthy: false` + `status: 'degraded'` — the field `docs/DEPLOYMENT.md` tells operators to monitor — while the detail stays in the server log, which is the split that route's own docblock argues for.

**The cost, stated rather than glossed:** the job will report unhealthy *indefinitely* for a data problem rather than a code problem, and `/api/cron/daily-cleanup` will answer 500 nightly until the row is fixed. That is the intent — the alternative is the silence the issue is about — and it matches the precedent `RetentionFailedError` set in `waitlist-retention.ts`. A reviewer who disagrees should reject this task, not soften it into a `log.error` that changes nothing observable.

**Scoped to live teachers.** `deletedAt: null`. Erasure does not touch `defaultTimezone` (verified), so an erased teacher's stale zone would otherwise flag forever with nothing to fix and no surface reading it — `validateSession` will not return them.

**Rejected, and recorded so a reviewer sees it was considered:** reporting the affected teacher *ids* on the failure path. An operator does not need them — the fix is `UPDATE "Teacher" SET "defaultTimezone" = '<good>' WHERE "defaultTimezone" = '<bad>'`, which needs only the string the summary already carries. Adding ids would cost a second query, a cap constant, the reasoning for that cap, and a test. YAGNI.

**Files:**
- Create: `src/services/timezone-audit.ts`
- Create: `src/services/timezone-audit.test.ts`

**Interfaces:**
- Consumes: `isValidTimeZone` from `@/lib/iana-timezone` (Task 1).
- Produces, all relied on by Task 4:
  - `export async function auditTeacherTimezones(db: PrismaClient): Promise<TimezoneAuditSummary>`
  - `export interface TimezoneAuditSummary { readonly checked: number; readonly teachers: number; readonly invalid: readonly string[] }`
  - `export class InvalidTimezoneError extends Error { readonly zones: readonly string[] }`

- [ ] **Step 1: Write the failing test**

Create `src/services/timezone-audit.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, onTestFinished } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { auditTeacherTimezones, InvalidTimezoneError } from './timezone-audit';

const prisma = new PrismaClient();
const uniqueSuffix = `tza-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * `Invalid/` is not one of IANA's ten areas, so no tzdata release can turn
 * this into a resolvable zone — the reserved-value rule, applied to timezones.
 * A plausible-looking string such as `Europe/Atlantis` would be a worse
 * choice for the same reason RFC 5737 addresses beat made-up ones.
 */
const SENTINEL = 'Invalid/Test_Zone_145';

/**
 * THIS FILE RUNS IN THE PARALLEL `unit` TIER, so every assertion below is
 * scoped to its own fixture. It must never assert that the database holds
 * ZERO bad zones, nor an exact `checked` count: concurrent files create
 * teachers freely, and a global assertion would be measuring them.
 *
 * It stays out of `SWEEP_TESTS` because that list's membership rule is
 * "a sweep that WRITES rows it was never handed" (vitest.config.ts) and this
 * sweep writes nothing at all. What it does do is READ database-wide, which
 * is why the containment-only discipline above is load-bearing rather than
 * stylistic.
 */
beforeAll(async () => {
  // Defence against a previous crashed run leaving a sentinel teacher behind:
  // one would make every later run of this file's clean case throw.
  const stale = await prisma.teacher.findMany({
    where: { defaultTimezone: SENTINEL },
    select: { id: true, accountId: true },
  });
  for (const t of stale) {
    await prisma.teacher.delete({ where: { id: t.id } });
    await prisma.account.delete({ where: { id: t.accountId } });
  }
});

async function seedTeacher(label: string, defaultTimezone: string): Promise<string> {
  const email = `${uniqueSuffix}-${label}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `timezone audit fixture ${label}`,
      pageSlug: `${uniqueSuffix}-${label}`,
      defaultTimezone,
    },
  });
  // Account too — an orphaned Account row is what #177 cleaned up across the
  // suite's fixtures.
  onTestFinished(async () => {
    await prisma.teacher.delete({ where: { id: teacher.id } }).catch(() => {});
    await prisma.account.delete({ where: { id: teacher.accountId } }).catch(() => {});
  });
  return teacher.id;
}

describe('auditTeacherTimezones', () => {
  it('returns a summary and does not throw when every live zone resolves', async () => {
    await seedTeacher('good', 'America/Los_Angeles');
    const summary = await auditTeacherTimezones(prisma);
    expect(summary.invalid).toEqual([]);
    expect(summary.teachers).toBe(0);
    // `checked` counts distinct zones across the whole database, so only a
    // lower bound is assertable here.
    expect(summary.checked).toBeGreaterThanOrEqual(1);
  });

  it('names an unresolvable stored zone and throws', async () => {
    await seedTeacher('bad', SENTINEL);
    await vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toThrow(InvalidTimezoneError);
    vi.restoreAllMocks();
  });

  it('carries the offending zone on the error, so the log line names it', async () => {
    await seedTeacher('named', SENTINEL);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toMatchObject({
      zones: expect.arrayContaining([SENTINEL]),
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ invalid: expect.arrayContaining([SENTINEL]) }),
      expect.stringContaining('unresolvable'),
    );
    vi.restoreAllMocks();
  });

  /**
   * Erasure soft-deletes and leaves `defaultTimezone` untouched
   * (`gdpr.ts`'s teacher `updateMany` writes twelve fields and not this one),
   * so a soft-deleted teacher's stale zone must not flag: nothing reads it —
   * `validateSession` resolves only live profiles — and there is nothing an
   * operator could do about it.
   */
  it('ignores soft-deleted teachers', async () => {
    const id = await seedTeacher('erased', SENTINEL);
    await prisma.teacher.update({ where: { id }, data: { deletedAt: new Date() } });
    const summary = await auditTeacherTimezones(prisma);
    expect(summary.invalid).not.toContain(SENTINEL);
  });

  it('counts every live teacher holding a bad zone, not just the distinct zones', async () => {
    await seedTeacher('dup-a', SENTINEL);
    await seedTeacher('dup-b', SENTINEL);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    await expect(auditTeacherTimezones(prisma)).rejects.toThrow(InvalidTimezoneError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ teachers: 2, invalid: [SENTINEL] }),
      expect.anything(),
    );
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/services/timezone-audit.test.ts`
Expected: FAIL — `Failed to resolve import "./timezone-audit"`.

- [ ] **Step 3: Implement the service**

Create `src/services/timezone-audit.ts`:

```ts
/**
 * Stored-timezone audit (#145) — a daily read-only sweep that asks whether
 * every live teacher's `defaultTimezone` still resolves.
 *
 * WHY IT EXISTS. `startOfLocalDay` and `classStartInstant` (`lib/timezone.ts`)
 * both fall back to UTC when a zone will not resolve, rather than throwing —
 * a crashed cron run is a worse failure than a wrong date. The cost of that
 * choice is that every teacher-facing calendar boundary silently becomes UTC:
 * the schedule window, the past/upcoming split, the auto-cancel check, the
 * reporting month cutoff. West of UTC each is wrong for part of every day.
 * Those two fallbacks now log at `error`; this sweep is what finds the bad
 * value without anyone having to be reading logs at the moment it is used.
 *
 * WHAT CAN PUT A BAD VALUE THERE. `updateTeacherSchema` refines the column
 * through `isValidTimeZone`, and that schema gates the only HTTP write path,
 * so validated traffic cannot. Two things can: a direct database edit, which
 * is a normal operation on the single VPS this project targets, and a writer
 * that bypasses the schema — `prisma/seed.ts` already writes the column
 * straight through Prisma, so that is a demonstrated shape rather than a
 * hypothetical one. The column is a bare `String`, so neither gets a
 * compile-time signal.
 *
 * NOT tzdata renames, despite that being the motivating story on the issue.
 * Measured 2026-09-01 on Node v22.22.2 with full ICU: every renamed and
 * deprecated identifier probed still resolves, because ICU ships IANA's
 * `backward` links — `Europe/Kiev` is even present in
 * `Intl.supportedValuesOf('timeZone')`. No identifier is known that ICU
 * accepted once and rejects now. This sweep would catch such a value if one
 * ever appeared; that is not why it is here.
 *
 * WHY IT THROWS rather than only logging. Throwing is what makes the existing
 * machinery carry the signal: `isolatedSweeps` logs it under the sweep name,
 * `makeTick` records `lastError` and withholds `lastSuccessAt`, and
 * `/api/health` reports `healthy: false` with `status: 'degraded'`. The cost
 * is that this job then reports unhealthy indefinitely for a data problem
 * rather than a code one, and `/api/cron/daily-cleanup` answers 500 nightly
 * until the row is fixed. That is deliberate, and the same trade
 * `RetentionFailedError` makes in `waitlist-retention.ts`.
 *
 * LIVE TEACHERS ONLY. Erasure soft-deletes and does not touch this column, so
 * an erased teacher's stale zone would flag forever with nothing to fix and no
 * surface reading it.
 */

import type { PrismaClient } from '@prisma/client';
import { isValidTimeZone } from '@/lib/iana-timezone';
import { log } from '@/lib/log';

/** One run's outcome. All `readonly`, constructed once. */
export interface TimezoneAuditSummary {
  /** Distinct stored zones probed across all live teachers. */
  readonly checked: number;
  /** Live teachers holding one of the `invalid` zones. */
  readonly teachers: number;
  /** The distinct unresolvable zone strings, sorted for a stable log line. */
  readonly invalid: readonly string[];
}

/**
 * Thrown when at least one live teacher holds a zone `Intl` cannot resolve.
 *
 * Carries the zone strings rather than teacher ids: the repair is
 * `UPDATE "Teacher" SET "defaultTimezone" = '<good>' WHERE
 * "defaultTimezone" = '<bad>'`, which needs only these.
 */
export class InvalidTimezoneError extends Error {
  constructor(public readonly zones: readonly string[]) {
    super(`stored teacher timezones no longer resolve: ${zones.join(', ')}`);
    this.name = 'InvalidTimezoneError';
  }
}

export async function auditTeacherTimezones(
  db: PrismaClient,
): Promise<TimezoneAuditSummary> {
  // `groupBy`, not `findMany({ distinct })`, for the reason
  // `waitlist-retention.ts` records at its own opening statement: Prisma does
  // not compile `distinct` into SQL, so that shape would select one row per
  // TEACHER and dedupe in the query engine. The `_count` rides along free and
  // is what lets the summary report affected teachers as well as zones.
  const rows = await db.teacher.groupBy({
    by: ['defaultTimezone'],
    where: { deletedAt: null },
    _count: { _all: true },
  });

  const bad = rows.filter((r) => !isValidTimeZone(r.defaultTimezone));

  const summary: TimezoneAuditSummary = {
    checked: rows.length,
    teachers: bad.reduce((n, r) => n + r._count._all, 0),
    invalid: bad.map((r) => r.defaultTimezone).sort(),
  };

  if (summary.invalid.length > 0) {
    log.error(
      summary,
      'stored teacher timezones are unresolvable — every calendar boundary for these teachers is silently UTC',
    );
    throw new InvalidTimezoneError(summary.invalid);
  }

  log.info(summary, 'teacher timezone audit: every stored zone resolves');
  return summary;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/services/timezone-audit.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-proof the sweep**

Three mutations, each restored before the next. Record the exact failing assertion text for each.

1. **The probe is actually consulted.** Change the filter to `rows.filter(() => false)`.
   Expected: RED on `names an unresolvable stored zone and throws` — `promise resolved instead of rejecting`.
2. **The liveness scope bites.** Delete `where: { deletedAt: null }`.
   Expected: RED on `ignores soft-deleted teachers` — `expected [ 'Invalid/Test_Zone_145' ] not to contain 'Invalid/Test_Zone_145'`.
3. **The teacher count is a real count.** Change `teachers` to `bad.length`.
   Expected: RED on `counts every live teacher holding a bad zone` — the `log.error` spy was called with `teachers: 1`, not `2`.

Restore and re-run to confirm GREEN.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/services/timezone-audit.ts src/services/timezone-audit.test.ts
git commit -m "feat(timezone): audit stored teacher timezones and fail loudly (#145)"
```

---

### Task 4: Wire the audit into `daily-cleanup`

Both triggers, not one. The in-process scheduler is what runs these sweeps in production, but `docs/DEPLOYMENT.md` documents `CRON_SCHEDULER=off` plus systemd timers as a supported mode, and in that mode the HTTP route is the *only* trigger. Wiring only the scheduler would leave the check dead on a supported deployment — the same trap the route's own docblock records for retention.

**Placement within the job: last.** `isolatedSweeps` runs its sweeps sequentially and rethrows the *first* error, so putting the audit last means a real failure in `cleanupExpiredAuth` or `reapClosedWaitlistEntries` still surfaces as the job's `lastError` rather than being masked by a standing data problem. Not load-bearing — every sweep runs regardless — but it is the better default and worth stating.

**Files:**
- Modify: `src/lib/scheduler.ts` (`SchedulerSweeps`; the dynamic imports and `buildJobs` call in `startScheduler`; the `daily-cleanup` entry in `buildJobs`)
- Modify: `src/lib/scheduler.test.ts` (`SWEEP_NAMES` at `:24-34`; the routing map at `:162`)
- Modify: `src/app/api/cron/daily-cleanup/route.ts`
- Modify: `src/app/api/cron/daily-cleanup/route.test.ts`

**Interfaces:**
- Consumes: `auditTeacherTimezones` and `InvalidTimezoneError` from `@/services/timezone-audit` (Task 3).
- Produces: `SchedulerSweeps` gains an eleventh member, `auditTeacherTimezones`. The route's JSON body gains a third key, `timezoneAudit`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/scheduler.test.ts`, append to `SWEEP_NAMES` (`:24-34`):

```ts
  'auditTeacherTimezones',
] as const;
```

and update its docblock, which currently opens "The ten sweeps, written once." — it is eleven now.

In the same file, update the `daily-cleanup` entry of the routing map at `:162`:

```ts
      'daily-cleanup': [
        'cleanupExpiredAuth',
        'reapClosedWaitlistEntries',
        // Last, so a real failure in either sweep above still surfaces as the
        // job's `lastError` rather than being masked by a standing data
        // problem this one reports every run until someone fixes the row.
        'auditTeacherTimezones',
      ],
```

In `src/app/api/cron/daily-cleanup/route.test.ts`, four edits.

**(a)** Beside the two existing `vi.fn()` handles and their `vi.mock` calls, add a third:

```ts
const auditTeacherTimezones = vi.fn();

vi.mock('@/services/timezone-audit', () => ({
  auditTeacherTimezones: (...args: unknown[]) => auditTeacherTimezones(...args),
}));
```

**(b)** Extend the `Body` interface, which exists so a caller reading the JSON is what the assertions describe:

```ts
interface Body {
  data: {
    auth: { ok: boolean; error?: string };
    waitlistRetention: { ok: boolean; error?: string };
    timezoneAudit: { ok: boolean; error?: string };
  };
}
```

**(c)** Extend `beforeEach`, giving the audit a clean default so every existing case keeps asserting the contract it was written for without being edited:

```ts
beforeEach(() => {
  cleanupExpiredAuth.mockReset();
  reapClosedWaitlistEntries.mockReset();
  auditTeacherTimezones.mockReset();
  // A clean audit by default. Without this an unmocked `vi.fn()` returns
  // `undefined`, which `settle` reports as a SUCCESS — so the audit would
  // appear to pass in every case here for the wrong reason, and the failure
  // case below would be the only one actually exercising it.
  auditTeacherTimezones.mockResolvedValue({ checked: 3, teachers: 0, invalid: [] });
});
```

**(d)** Add the new case, and rename the first existing test — `answers 200 only when both sweeps ran` — to `answers 200 only when every sweep ran`, adding `expect(body.data.timezoneAudit.ok).toBe(true);` to its assertions:

```ts
  /**
   * The audit is the third sweep, and a failing one must reach the status.
   * 500 and not 503: `InvalidTimezoneError` matches no branch in
   * `classifyApiError`, so it falls to the generic 500 — which is the right
   * answer, because 503 tells a systemd timer to back off and retry, and a
   * stored zone that will not resolve does not clear on the next tick.
   */
  it('answers 500 when only the timezone audit fails', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
    reapClosedWaitlistEntries.mockResolvedValue({ deleted: 0, classes: 0 });
    auditTeacherTimezones.mockRejectedValue(
      new Error('stored teacher timezones no longer resolve: Invalid/Test_Zone_145'),
    );

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.data.auth.ok).toBe(true);
    expect(body.data.waitlistRetention.ok).toBe(true);
    expect(body.data.timezoneAudit.ok).toBe(false);
    expect(body.data.timezoneAudit.error).toContain('Invalid/Test_Zone_145');
  });
```

Note the mock rejects with a plain `Error` carrying the real message rather than importing `InvalidTimezoneError`: this file mocks the whole `@/services/timezone-audit` module, so importing a value from it here would be importing the mock.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/scheduler.test.ts && npx vitest run --project unit src/app/api/cron/daily-cleanup/route.test.ts`

Expected, and the first one is a **compile-time** failure by design — `scheduler.test.ts` carries two `NoneOf` type pins (`_stubsCoverSweeps`, `_stubsHaveNoExtras`) precisely so a stub list that disagrees with `SchedulerSweeps` fails by name:

```
Type 'true' is not assignable to type '"auditTeacherTimezones"'.
```

That error is the pin doing its job — the free mutation proof for this task's wiring. Record the exact text.

- [ ] **Step 3: Add the sweep to `SchedulerSweeps`**

In `src/lib/scheduler.ts`, add to the interface:

```ts
  auditTeacherTimezones: (db: PrismaClient) => Promise<unknown>;
```

- [ ] **Step 4: Import and pass it in `startScheduler`**

Add beside the other dynamic imports:

```ts
  const { auditTeacherTimezones } = await import('@/services/timezone-audit');
```

and add `auditTeacherTimezones,` to the object passed to `buildJobs`.

- [ ] **Step 5: Destructure it and add it to the job**

In `buildJobs`, add `auditTeacherTimezones,` to the destructuring, and extend the `daily-cleanup` entry:

```ts
      name: 'daily-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      run: isolatedSweeps('daily-cleanup', [
        cleanupExpiredAuth,
        reapClosedWaitlistEntries,
        // LAST, and the position is a default rather than a guarantee.
        // `isolatedSweeps` runs every sweep and rethrows the FIRST error, so a
        // standing bad timezone — which reports every run until a row is
        // fixed — would otherwise mask a real failure in either sweep above.
        auditTeacherTimezones,
      ]),
```

Extend the `daily-cleanup` entry's existing comment, which records that the job reports one `lastRunAt` for the sweeps it holds, to say it now holds three.

- [ ] **Step 6: Wire the HTTP route**

In `src/app/api/cron/daily-cleanup/route.ts`, add the import:

```ts
import { auditTeacherTimezones } from '@/services/timezone-audit';
```

Add the third settled call after the existing two, and widen the response:

```ts
  const auth = await settle(() => cleanupExpiredAuth(prisma));
  const waitlistRetention = await settle(() => reapClosedWaitlistEntries(prisma));
  // Third, matching the scheduler job this route mirrors — and reaching this
  // route at all matters: under the `CRON_SCHEDULER=off` + systemd mode
  // `DEPLOYMENT.md` documents, this is the ONLY trigger for these sweeps, so a
  // check wired to the scheduler alone would be dead there.
  const timezoneAudit = await settle(() => auditTeacherTimezones(prisma));

  return respondOk(
    { auth, waitlistRetention, timezoneAudit },
    worstStatus([auth, waitlistRetention, timezoneAudit]),
  );
```

`worstStatus` needs no change: `InvalidTimezoneError` matches no branch in `classifyApiError`, so it falls to the generic 500, and `worstStatus` returns 503 only when *every* failure is transient.

- [ ] **Step 7: Run tests to verify they pass**

```bash
npx vitest run --project unit src/lib/scheduler.test.ts
npx vitest run --project unit src/app/api/cron/daily-cleanup/route.test.ts
```

Expected: PASS both.

- [ ] **Step 8: Sweep for what this change invalidated**

Grep for the names and claims the wiring made stale — a sweep keyed on changed call sites would miss these:

```bash
grep -rn "ten sweeps\|the two sweeps\|both sweeps" src/ docs/
grep -rn "daily-cleanup" src/ docs/
```

Give every hit a verdict; expect legitimate survivors. Known targets: `scheduler.test.ts`'s `SWEEP_NAMES` docblock ("The ten sweeps"), the `daily-cleanup` job comment in `scheduler.ts`, and the route docblock's "A 2xx FROM THIS ROUTE MEANS BOTH SWEEPS RAN" — which must become three, and its `grep -rn "daily-cleanup\|auth-cleanup" tests/` claim should be re-run rather than trusted. Check `docs/DEPLOYMENT.md` for any enumeration of what `daily-cleanup` does.

- [ ] **Step 9: Full local verification**

```bash
npm run typecheck && npm run lint
npx vitest run --project unit
npx vitest run --project unit-sweeps
npx vitest run --project components
```

Do **not** run `--project integration` from this worktree — it will hang on `ECONNREFUSED`. CI is the signal for the integration and e2e tiers.

- [ ] **Step 10: Commit**

```bash
npm run typecheck && npm run lint
git add src/lib/scheduler.ts src/lib/scheduler.test.ts 'src/app/api/cron/daily-cleanup/route.ts' 'src/app/api/cron/daily-cleanup/route.test.ts'
git commit -m "feat(timezone): run the stored-timezone audit in daily-cleanup (#145)"
```

---

## After the tasks

- **Whole-branch review.** The plan has four tasks, so `superpowers:subagent-driven-development` §5's whole-branch review applies: one review on the most capable model, one fix wave, one scoped re-review. The cross-task risk it exists to catch here is real — Task 1 moves a function that Task 3 imports and a schema many client components import, and no single task's reviewer sees both ends of that.
- **PR review.** `/pr-review-toolkit:review-pr <N>`. Give the comments reviewer the specific risk: this branch edits four docblocks that make claims about *other* files (`iana-timezone.ts` on `tiers.ts`, `timezone-audit.ts` on `gdpr.ts` and `seed.ts`, the route on `DEPLOYMENT.md`). Skip the type-design reviewer — the only new type is a two-field summary interface, not the PR's subject.
- **The PR body must carry:** the premise corrections above with their measurements (the tzdata probe result especially, since it contradicts the issue's own recommendation); the `Intl.` arithmetic (5 hits = 3 constructions + 2 type annotations; of the 3, 2 consume a stored zone and 1 is the validator); the exact error text from every mutation; the statement that **no `tests/integration/` file was touched by this branch**, with CI cited as the signal for that tier rather than a local `verify`; and the two docblock sentences replaced in Task 2, since the before-and-after belongs there and not beside the code.
- **Update the issue.** #145's option 4 is recorded as "the one that catches the realistic cause". Post the tzdata measurement as a comment so the correction lives on the issue too, not only in this plan — a claim gets fixed in every artifact or it is not fixed.
