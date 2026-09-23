# Transient DB Failure Kinds Implementation Plan (#232)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every transient database failure is logged with the kind it was and at the level that kind deserves, so a drained connection pool or a deadlock logs at `error` and no line names a lock race it has not established.

**Architecture:** `src/lib/api-errors.ts` gains `transientDbFailure(err)`, returning `{ kind, level } | null` from one compiler-tethered table; `isTransientDbError` becomes `transientDbFailure(err) !== null`, so every retry/503/`busy`/escalation decision is untouched. Each logging consumer takes its level from the result, logs a `transientKind` field, and drops "lock race" from its message.

**Tech Stack:** TypeScript strict, Prisma 6 (`Prisma.PrismaClientKnownRequestError`), pino (`@/lib/log`), vitest.

**Spec:** `docs/superpowers/specs/2026-09-23-transient-kind-design.md` — read it first; §1 carries the measured premise and the call-site census command, §2 the table, §6 the mutations.

## Global Constraints

- The two axes stay separate: `transient` (and `isTransientDbError`) means *a retry can win* and must return exactly what it returns today for every input. Only log level, log fields and log messages change.
- Level table, verbatim: `lock_timeout` warn · `deadlock` error · `serialization` warn · `pool_exhausted` error · `tx_budget` warn.
- Code → kind, verbatim: `55P03` lock_timeout · `40P01` deadlock · `40001` serialization · `P2024` pool_exhausted · `P2028` tx_budget · `P2034` deadlock.
- Prisma codes are checked before SQLSTATEs; SQLSTATEs match only inside their framing (`code: "…"` or `` Code: `…` ``), never as a bare substring. The `Error.cause` walk bounded by `MAX_CAUSE_DEPTH` applies to the kind.
- Message wording: "lost a lock race" / "lost the template lock race" → "hit a transient database failure"; the rest of each message unchanged. Messages stay static strings (template-literal nouns and the `spotFreedLoss(window)` tail are the existing exceptions and stay).
- `isLockTimeout` is not touched; the generators' "lock race" lines stay (they are genuinely `55P03`-only).
- No 503 body, API error code, `busy` arm, `/api/health` field or escalation rule changes.
- *Comment Discipline* (CLAUDE.md): no counts or rosters in comments; correct a comment by replacing it, never "this previously read".
- Worktree: run `pnpm install --frozen-lockfile`, `pnpm run worktree:setup` once, then `pnpm run worktree:up` before any DB-backed or integration test. Never touch the dev server on `:3000`. `pnpm run worktree:down` when finished.
- Stage exact paths; quote paths containing brackets (`'src/app/api/registrations/[id]/route.ts'`). Never `git add -A`.

## Task order is load-bearing

Task 1 produces the interface Tasks 2 and 3 consume. Task 3's final phrase sweep assumes Task 2 has landed. Run 1 → 2 → 3.

## A hazard every task shares: fixtures that change meaning

`P2024` is this repo's habitual "generic transient" test fixture (re-derive: `git grep -n "code: 'P2024'" -- '*.test.ts'`). Task 1 alone changes no consumer's level — the sites still read the boolean. But once a site takes its level from the kind (Tasks 2 and 3), a `P2024` there logs at `error`, so a test that uses it to mean "a transient that does not page" goes red — not because anything broke, but because the fixture now means something else. Rule for every such test:

- If the test's intent is **"transient, and therefore `warn` / tolerated"** — switch the fixture to `P2028` (`tx_budget`, still `warn`) and correct any comment that calls it a pool timeout or a `55P03`.
- If its intent is **"classifiable as transient"** only (asserts `isTransientDbError`, a 503, or a `busy` return, not a level) — keep `P2024`; that is still true.
- Never keep `P2024` and flip the expected level to `error` just to go green, unless the test is *about* pool exhaustion.

The same applies to `40P01`/`P2034` fixtures asserting `warn`.

## A second shared hazard: negative assertions on old messages

Several tests assert that a message was **not** logged (e.g. `studio-class-template-lifecycle.test.ts` asserts the "lost the template lock race" line is absent to prove a `busy` came from another producer). Renaming the source line makes such an assertion pass forever. Every test string that names an old message — positive or negative — must move to the new message in the same commit as the source line. Re-derive: `git grep -n "lock race" -- '*.test.ts'`.

---

### Task 1: The classifier and `classifyApiError`

**Files:**
- Modify: `src/lib/api-errors.ts` — replace `TRANSIENT_SQLSTATES`/`TRANSIENT_PRISMA_CODES` and `isTransientDbErrorShallow` with the kind tables and `transientDbFailure`; rewrite the two sets' docblocks as one docblock stating the alerting contract; transient branch of `classifyApiError`.
- Modify: `src/lib/api-errors.test.ts`
- Modify (comment references to the removed set names only): every file `git grep -lE "TRANSIENT_PRISMA_CODES|TRANSIENT_SQLSTATES" -- src tests docs/*.md` lists, other than `api-errors.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type TransientKind = 'lock_timeout' | 'deadlock' | 'serialization' | 'pool_exhausted' | 'tx_budget';
  export interface TransientDbFailure { readonly kind: TransientKind; readonly level: 'warn' | 'error'; }
  export function transientDbFailure(error: unknown): TransientDbFailure | null;
  export function isTransientDbError(error: unknown): boolean; // unchanged signature and answers
  ```

- [ ] **Step 1: Write the failing unit tests** in `src/lib/api-errors.test.ts`, in a new `describe('transientDbFailure', …)` beside `describe('isTransientDbError', …)`. Reuse the file's `prismaError(code)` helper and the measured message fixtures already in the file (the `55P03` model-write string, the `P2010` raw string, the measured `40P01` string near the `classifyApiError` deadlock test).

  ```ts
  describe('transientDbFailure', () => {
    const modelWrite = (state: string) =>
      new Prisma.PrismaClientUnknownRequestError(
        `Invalid \`prisma.class.updateMany()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${state}", message: "m", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
        { clientVersion: Prisma.prismaVersion.client },
      );
    const rawQuery = (state: string) =>
      new Prisma.PrismaClientKnownRequestError(
        `Invalid \`prisma.$queryRaw()\` invocation:\n\n\nRaw query failed. Code: \`${state}\`. Message: \`ERROR: m\``,
        { code: 'P2010', clientVersion: Prisma.prismaVersion.client },
      );

    it.each<[string, unknown, TransientKind, 'warn' | 'error']>([
      ['55P03 model write', modelWrite('55P03'), 'lock_timeout', 'warn'],
      ['55P03 raw query (P2010)', rawQuery('55P03'), 'lock_timeout', 'warn'],
      ['40P01 model write', modelWrite('40P01'), 'deadlock', 'error'],
      ['40P01 raw query (P2010)', rawQuery('40P01'), 'deadlock', 'error'],
      ['40001 model write', modelWrite('40001'), 'serialization', 'warn'],
      ['P2024', prismaError('P2024'), 'pool_exhausted', 'error'],
      ['P2028', prismaError('P2028'), 'tx_budget', 'warn'],
      ['P2034', prismaError('P2034'), 'deadlock', 'error'],
    ])('classifies %s', (_label, error, kind, level) => {
      expect(transientDbFailure(error)).toEqual({ kind, level });
      expect(isTransientDbError(error)).toBe(true);
    });

    it('finds the kind through a cause chain', () => {
      const wrapped = new Error('spot-freed hook failed', { cause: prismaError('P2024') });
      expect(transientDbFailure(wrapped)).toEqual({ kind: 'pool_exhausted', level: 'error' });
    });

    it.each<[string, unknown]>([
      ['a bare digit string with no framing', new Error('postcode 40P01 and 55P03 Lock Street')],
      ['a non-transient Prisma code', prismaError('P2002')],
      ['a non-error', 'code: "55P03"'],
    ])('returns null for %s', (_label, error) => {
      expect(transientDbFailure(error)).toBeNull();
      expect(isTransientDbError(error)).toBe(false);
    });
  });
  ```

  Also change the existing expectations that this plan makes false, and only those: the `it.each` "maps %s to a 503 at warn" over `P2028`/`P2024`/`P2034` becomes per-code levels (`P2028` warn, `P2024` error, `P2034` error) with the title "maps %s to a 503 at its kind's level"; any `classifyApiError` assertion of `level: 'warn'` on a `40P01` fixture becomes `'error'`; each transient `classifyApiError` case additionally asserts `failure.detail` equals `{ transientKind: <kind> }` and `failure.status` is still 503 with the unchanged user message.

- [ ] **Step 2: Run and see it fail**

  Run: `pnpm exec vitest run src/lib/api-errors.test.ts`
  Expected: FAIL — `transientDbFailure` / `TransientKind` are not exported (import error), and the changed level expectations fail.

- [ ] **Step 3: Implement** in `src/lib/api-errors.ts`. Use `Map`s, not object-literal lookups, so an arbitrary `error.code` such as `'constructor'` cannot hit a prototype key.

  ```ts
  export type TransientKind = 'lock_timeout' | 'deadlock' | 'serialization' | 'pool_exhausted' | 'tx_budget';

  export interface TransientDbFailure {
    readonly kind: TransientKind;
    readonly level: 'warn' | 'error';
  }

  const TRANSIENT_KIND_LEVEL = {
    lock_timeout: 'warn',
    deadlock: 'error',
    serialization: 'warn',
    pool_exhausted: 'error',
    tx_budget: 'warn',
  } as const satisfies Record<TransientKind, 'warn' | 'error'>;

  const TRANSIENT_SQLSTATE_KIND: ReadonlyMap<string, TransientKind> = new Map([
    ['55P03', 'lock_timeout'],
    ['40P01', 'deadlock'],
    ['40001', 'serialization'],
  ]);

  const TRANSIENT_PRISMA_CODE_KIND: ReadonlyMap<string, TransientKind> = new Map([
    ['P2024', 'pool_exhausted'],
    ['P2028', 'tx_budget'],
    ['P2034', 'deadlock'],
  ]);

  function transientKindShallow(error: unknown): TransientKind | null {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const kind = TRANSIENT_PRISMA_CODE_KIND.get(error.code);
      if (kind) return kind;
    }
    if (!(error instanceof Error)) return null;
    for (const [state, kind] of TRANSIENT_SQLSTATE_KIND) {
      if (error.message.includes(`code: "${state}"`) || error.message.includes(`Code: \`${state}\``)) {
        return kind;
      }
    }
    return null;
  }

  export function transientDbFailure(error: unknown): TransientDbFailure | null {
    let current = error;
    for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
      const kind = transientKindShallow(current);
      if (kind) return { kind, level: TRANSIENT_KIND_LEVEL[kind] };
      if (!(current instanceof Error)) return null;
      current = current.cause;
    }
    return null;
  }

  export function isTransientDbError(error: unknown): boolean {
    return transientDbFailure(error) !== null;
  }
  ```

  Docblocks: move each existing per-SQLSTATE and per-Prisma-code calibration onto the new tables — reword, don't drop (the `40P01` reachability paragraph, the `40001` "cannot fire" paragraph, the `P2028` 20s-budget note). Add, beside `TRANSIENT_KIND_LEVEL`, the alerting contract from spec §2: why each level is what it is; that `P2034` is `deadlock` only because nothing runs a serializable or repeatable-read transaction; that the known `updateClass` × `updateClass` slot-key deadlock (`docs/lock-order.md`, "The slot key is a wait edge") now logs at `error` when it fires, by decision. The existing `isTransientDbError` docblock (two error shapes, framing rule, cause walk) moves to `transientDbFailure`; `isTransientDbError` gets a one-line docblock saying it is the retry axis and never the severity.

  `classifyApiError`'s transient branch:

  ```ts
  const transient = transientDbFailure(error);
  if (transient) {
    return {
      status: 503,
      message: 'The system was busy and could not finish that. Please try again.',
      logMessage: 'transient database failure surfaced to a client',
      level: transient.level,
      detail: { transientKind: transient.kind },
    };
  }
  ```

  Reread the comment block above that branch whole: it argues why a lock timeout must not be `error`. Keep that argument, and make it say it holds per kind, with the table as the authority.

- [ ] **Step 4: Sweep the removed names.** Run `git grep -nE "TRANSIENT_PRISMA_CODES|TRANSIENT_SQLSTATES|isTransientDbErrorShallow" -- src tests docs/*.md CLAUDE.md`. Every hit gets a verdict; each is a comment or doc reference to rename to the new table names (`TRANSIENT_PRISMA_CODE_KIND`, `TRANSIENT_SQLSTATE_KIND`, `TRANSIENT_KIND_LEVEL`) or to reword. Read each surrounding paragraph: where it claims every member is "contention" or all land at `warn`, correct the claim, not just the name. Expected end state: zero hits.

- [ ] **Step 5: Run and see it pass**

  Run: `pnpm exec vitest run src/lib/api-errors.test.ts src/lib/api-utils.test.ts` then `pnpm run typecheck`
  Expected: PASS; typecheck clean.

- [ ] **Step 6: Prove the guards bite.** Commit first (so restoring a mutation cannot eat other edits), then apply each mutation alone, run `pnpm exec vitest run src/lib/api-errors.test.ts`, record the exact failure text, restore with `git checkout -- src/lib/api-errors.ts`, confirm `git status` is clean:
  1. `pool_exhausted: 'warn'` in `TRANSIENT_KIND_LEVEL` → the `P2024` case goes red.
  2. `deadlock: 'warn'` → the `40P01` and `P2034` cases go red.
  3. `['P2024', 'lock_timeout']` → the `P2024` kind assertion goes red.
  4. In `transientDbFailure`, return after the first iteration (`return null` in place of `current = current.cause`) → the cause-chain case goes red.
  5. `level: 'warn'` hard-coded in `classifyApiError`'s transient branch → its `P2024` case goes red.
  6. Delete the `tx_budget` row from `TRANSIENT_KIND_LEVEL` and run `pnpm run typecheck` → record the TS error the `satisfies Record<TransientKind, …>` tether raises.

- [ ] **Step 7: Commit**

  ```bash
  git add src/lib/api-errors.ts src/lib/api-errors.test.ts   # plus every file Step 4 touched, by exact path
  git commit -m "feat(api-errors): classify transient DB failures by kind and level (#232)"
  ```

---

### Task 2: The template lifecycle sites

**Files:**
- Modify: `src/services/rule-lifecycle.ts` — the three `isTransientDbError` branches (archive, pause/resume, edit) and the `busy` arm docblock (`ArchiveTemplateResult`'s, near the text "Reading a `busy` in the logs").
- Modify: `src/services/class-template-lifecycle.ts` — the create's transient branch.
- Modify: `src/services/studio-class-template-lifecycle.ts` — the create's transient branch.
- Modify: `src/services/entry-generation.ts` — the `EditLogNoun` docblock's re-derivation grep.
- Test: the tests that already exercise these branches — find them with `git grep -n "lock race\|reason: 'busy'" -- 'src/services/*.test.ts'` — plus new cases where a site has none.

**Interfaces:**
- Consumes: `transientDbFailure(error: unknown): TransientDbFailure | null` from Task 1.
- Produces: new message strings, verbatim:
  - `` `${family.logNoun} archive hit a transient database failure` ``
  - `` `${family.logNoun} pause/resume hit a transient database failure` ``
  - `` `${family.editNoun} edit hit a transient database failure — nothing committed` ``
  - `'recurring class create hit a transient database failure — nothing committed'`
  - `'recurring studio class create hit a transient database failure — nothing committed'`

- [ ] **Step 1: Write the failing tests.** For each of the five sites, one `it.each` over two fixtures — `P2028` (expect `log.warn`, `transientKind: 'tx_budget'`) and `P2024` (expect `log.error`, `transientKind: 'pool_exhausted'`) — asserting the call returns `{ ok: false, reason: 'busy' }`, the right spy received the new message, the fields include `transientKind`, and the other spy did not receive it. Inject the failure the way the neighbouring tests in the same file already do (a `prisma.$extends` query hook throwing `new Prisma.PrismaClientKnownRequestError('…', { code, clientVersion: Prisma.prismaVersion.client })` inside the transaction). Shape, for the studio pause/resume site:

  ```ts
  it.each<[string, 'warn' | 'error', TransientKind]>([
    ['P2028', 'warn', 'tx_budget'],
    ['P2024', 'error', 'pool_exhausted'],
  ])('a %s during pause/resume answers busy and logs at %s with its kind', async (code, level, kind) => {
    const failing = prisma.$extends({
      query: {
        scheduleRule: {
          updateMany() {
            throw new Prisma.PrismaClientKnownRequestError('injected', {
              code,
              clientVersion: Prisma.prismaVersion.client,
            });
          },
        },
      },
    }) as unknown as PrismaClient;
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const result = await pauseOrResumeStudioTemplate(failing, t.id, teacherId, 'paused');
      expect(result).toEqual({ ok: false, reason: 'busy' });
      const message = 'studio class pause/resume hit a transient database failure';
      const hit = (level === 'warn' ? warn : error).mock.calls.find((c) => c[1] === message);
      expect(hit?.[0]).toMatchObject({ templateId: t.id, teacherId, transientKind: kind });
      const miss = (level === 'warn' ? error : warn).mock.calls.find((c) => c[1] === message);
      expect(miss).toBeUndefined();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
  ```

  The query hook must target a statement the site actually issues inside its transaction — read the function, don't assume `updateMany`. Also move every existing test string naming an old message to the new one (positive and negative assertions — see the shared hazard above).

- [ ] **Step 2: Run and see it fail**

  Run: `pnpm exec vitest run` on each touched test file.
  Expected: FAIL — the new message is never logged; `transientKind` absent; the `P2024` case logs at `warn`.

- [ ] **Step 3: Implement.** At each of the five sites, replace the boolean branch with the kind:

  ```ts
  const transient = transientDbFailure(err);
  if (transient) {
    log[transient.level](
      { err, templateId, teacherId, target, transientKind: transient.kind },
      `${family.logNoun} archive hit a transient database failure`,
    );
    return { ok: false, reason: 'busy' };
  }
  ```

  keeping each site's existing fields (`target` only where it is there today; the creates keep `classType`, `dayOfWeek`, `startTime`). Update the imports (`transientDbFailure` in, `isTransientDbError` out where it becomes unused). Keep every existing comment about branch ordering; reread each for claims that the branch is a lock race and correct those.

- [ ] **Step 4: Rewrite the `busy` docblock** in `rule-lifecycle.ts`: reread it whole. It must say the arm is produced by `transientDbFailure`, that the log line carries `transientKind` so a `busy` is never read as a lock wait without evidence, and point at `TRANSIENT_KIND_LEVEL` (`src/lib/api-errors.ts`) as the owner of which kinds page. Remove the sentence the issue quotes only if the new text makes it redundant; its warning stays true.

- [ ] **Step 5: Update the `EditLogNoun` grep** in `src/services/entry-generation.ts` to `grep -rhn "edit refused\|edit hit a transient database failure\|edit saved" src/services/*.ts`, run it, and confirm it still returns the sibling edit lines from both families.

- [ ] **Step 6: Run and see it pass**

  Run: `pnpm exec vitest run` on each touched test file, then `pnpm run typecheck && pnpm run lint`.
  Expected: PASS.

- [ ] **Step 7: Prove the guards bite.** Commit first. Then, one at a time, record the failure text, restore, confirm `git status` clean:
  1. Drop `transientKind` from the edit site's log fields → its test goes red.
  2. Hard-code `log.warn` at the archive site → its `P2024` case goes red.
  3. Restore the old message at the studio create site → its test goes red.

- [ ] **Step 8: Commit**

  ```bash
  git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts src/services/entry-generation.ts   # plus each touched test file by exact path
  git commit -m "fix(templates): log a transient failure's kind and level, not a lock race (#232)"
  ```

---

### Task 3: The waitlist, erasure and booking sites, and the phrase sweep

**Files:**
- Modify: `'src/app/api/registrations/[id]/route.ts'` (spot-freed hook after cancel)
- Modify: `src/services/gdpr.ts` (spot-freed hook after erasure)
- Modify: `src/services/waitlist-reconciliation.ts` (per-class failure)
- Modify: `src/services/waitlist-retention.ts` (per-class failure)
- Modify: `src/app/api/registrations/route.ts` and `src/app/api/waitlist/route.ts` (`tierSelectedAt` writes)
- Modify: `src/app/api/account/route.ts` (the two logging sites; `erasureFailure` stays on the boolean)
- Test: the existing tests for each (`'src/app/api/registrations/[id]/promote-after-cancel.test.ts'`, `src/services/gdpr.test.ts`, `src/services/waitlist-reconciliation.test.ts`, `src/services/waitlist-retention.test.ts`, `src/app/api/registrations/route.test.ts`, `src/services/waitlist.test.ts`, `tests/integration/account-api.test.ts`), and new cases where a site has no level assertion today.

**Interfaces:**
- Consumes: `transientDbFailure` from Task 1.
- Produces: new message strings, verbatim:
  - `` `waitlist spot-freed hook hit a transient database failure after cancel — ${spotFreedLoss(window)}` ``
  - `` `gdpr: spot-freed hook hit a transient database failure after erasure — ${spotFreedLoss(window)}` ``
  - `` `waitlist reconciliation hit a transient database failure for one class — ${spotFreedLoss(window)}, retrying next tick` ``
  - `'waitlist retention hit a transient database failure for one class — retrying next run'`
  - Every other message at these sites is unchanged.

- [ ] **Step 1: Re-fixture first, per the shared hazard.** Run `git grep -n "code: 'P2024'" -- '*.test.ts'` and `git grep -n "lock race" -- '*.test.ts'`. For each hit, decide by the rule at the top of this plan and record the verdict (file:line → kept / switched to `P2028` / message moved) in the task report. `promote-after-cancel.test.ts`'s `transientCause()` is a known case: its docblock calls a `P2024` "A `55P03`-class failure" — switch it to `P2028` and make the docblock true. `waitlist.test.ts`'s "stays classifiable as transient through the wrapper" asserts only `isTransientDbError` — keep `P2024`, but its docblock says a misclassified pool timeout "would log at `error`", which is now the intended behaviour for a correctly classified one; reword so it states what the test guards (the wrapper does not hide transience).

- [ ] **Step 2: Write the failing tests.** For each logging site, one `it.each` over `P2028` → `warn` / `tx_budget` and `P2024` → `error` / `pool_exhausted`, asserting the spy, the (new or unchanged) message, and `{ transient: true, transientKind }` in the fields. For the non-transient branch of each site that has one, assert `transientKind: null`. For reconciliation additionally:

  ```ts
  // A P2024 before the streak limit logs at error (its kind's level) but is
  // still returned transient, so decideEscalation's tolerance is unchanged.
  expect(outcome).toEqual({ kind: 'failed', transient: true });
  ```

  and keep the existing stuck-at-limit test: with a `P2028` at `MAX_CONSECUTIVE_CONTENDED_TICKS` it still logs at `error`.

- [ ] **Step 3: Run and see it fail**

  Run: `pnpm exec vitest run` on each touched test file (integration files after `pnpm run worktree:up`).
  Expected: FAIL — no `transientKind`, `P2024` at `warn`, old messages.

- [ ] **Step 4: Implement.** At each site:

  ```ts
  const failure = transientDbFailure(err);
  const transient = failure !== null;
  log[failure?.level ?? 'error'](
    { err, classId, waiting, transient, transientKind: failure?.kind ?? null, branch: window ?? 'unknown' },
    transient
      ? `waitlist spot-freed hook hit a transient database failure after cancel — ${spotFreedLoss(window)}`
      : `waitlist spot-freed hook failed after cancel — ${spotFreedLoss(window)}`,
  );
  ```

  Reconciliation keeps `stuck` authoritative:

  ```ts
  const failure = transientDbFailure(err);
  const transient = failure !== null;
  // …streak bookkeeping unchanged…
  const stuck = transient && classStreak >= MAX_CONSECUTIVE_CONTENDED_TICKS;
  log[failure === null || stuck ? 'error' : failure.level](
    { err, classId: cls.id, transient, transientKind: failure?.kind ?? null, classStreak, branch: window ?? 'unknown' },
    …
  );
  return { kind: 'failed', transient };
  ```

  Account route: the two `log[transient ? 'warn' : 'error']` sites become `log[failure?.level ?? 'error']` with `transientKind` in the fields; `erasureFailure` keeps `isTransientDbError`. Reread the comment above the student half (it says "a lost lock race is not an outage and must not page anyone") and correct it: per kind, with the table as the authority.

  At every site reread the adjacent comments for "lock race" and "must not page" claims and correct them to the per-kind reality.

- [ ] **Step 5: Run and see it pass**

  Run: `pnpm exec vitest run` on each touched file, then `pnpm run typecheck && pnpm run lint`.
  Expected: PASS.

- [ ] **Step 6: Prove the guards bite.** Commit first. One at a time, record the failure text, restore, confirm `git status` clean:
  1. Reconciliation: `log[failure === null ? 'error' : failure.level]` (kind overrides `stuck`) → the stuck-at-limit test with a `P2028` goes red.
  2. Reconciliation: return `transient: failure?.level === 'warn'` → the "P2024 still returned transient" assertion goes red.
  3. Retention: drop `transientKind` from the fields → its test goes red.
  4. Spot-freed after cancel: hard-code `log.warn` for the transient branch → its `P2024` case goes red.

- [ ] **Step 7: The phrase sweep (acceptance 4).** Run `git grep -n "lock race" -- src tests docs/*.md CLAUDE.md` (excluding `docs/superpowers/`, which are records). Give every hit a verdict in the task report. Legitimate survivors: lines and comments whose producer is `isLockTimeout` (the two generators and their tests), the lock-order tests' prose about genuine `55P03` waits, and prose in `docs/` that is genuinely about `55P03`. Every other hit — a comment asserting that a `transientDbFailure`/`isTransientDbError` branch is a lock race — is reworded. Also grep `"must not page"` and `"contention surfaced"` across `src` and give each hit a verdict.

- [ ] **Step 8: Full verification**

  Run: `pnpm run verify` (with the worktree app up). Record the per-project counts it prints and show that `unit + components + unit-sweeps + integration` sums to the total. If anything earlier in `pnpm test` is red, run `pnpm exec vitest run --project integration` directly rather than reading the red run as evidence about that tier.

- [ ] **Step 9: Commit**

  ```bash
  git add 'src/app/api/registrations/[id]/route.ts' src/services/gdpr.ts src/services/waitlist-reconciliation.ts src/services/waitlist-retention.ts src/app/api/registrations/route.ts src/app/api/waitlist/route.ts src/app/api/account/route.ts   # plus each touched test and doc file by exact path
  git commit -m "fix(waitlist,erasure): log a transient failure's kind and level, not a lock race (#232)"
  ```

---

## After the tasks

Three tasks, so one whole-branch review on the most capable model, one fix wave, one scoped re-review (solve-issue §5). The cross-task risk to hand that reviewer: a site whose level follows the table but whose comment still says "must not page", and a test whose fixture changed meaning in Task 1 but was only touched in Task 3.
