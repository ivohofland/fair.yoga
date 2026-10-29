# Process-wide server state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server state that every caller in the process must share lives on
`globalThis`. Everything else carries a written `per-instance:` reason, and a
syntax-tree census enforces the rule. This fixes #933 (a dev hot reload
splits passkey challenges and rate-limit buckets) and #935 (scheduler
notifications never reach SSE in production), and gives production one
Prisma pool.

**Architecture:** Each process-wide holder uses the existing idiom:
`declare global { var __fairYogaX: T | undefined }`, then
`const s = (globalThis.__fairYogaX ??= init)`. Only data goes on `globalThis`
(maps, arrays, plain objects, a bare `EventEmitter`). Functions stay at
module level, so a dev edit still takes effect. A census test under
`src/lib/` walks `src/` with the TypeScript parser and fails on an unmarked
holder.

**Tech Stack:** TypeScript strict, Next.js 16 (Turbopack), Vitest
(`unit`, `unit-sweeps`, `integration` projects), the `typescript` compiler
API for the census.

**Spec:** `docs/superpowers/specs/2026-10-29-process-singletons-design.md`.
Read its *The rule*, *Decisions* 2–7, and the verdict table before any task.

## Global Constraints

- The global key is `__fairYoga<PascalName>`, declared with `declare global { var … }` in the module that owns it, with a one-line comment saying why it is process-wide. Never `globalThis as unknown as`.
- A process-wide value is never an instance of a class defined in this repo (spec Decision 2).
- A per-instance holder's leading comment starts `// per-instance: ` followed by a non-empty reason.
- No prose counts or member lists in comments (CLAUDE.md, *Comment Discipline*). Counts go in the PR body.
- Each process-wide holder's test is broken once by reverting the holder to a module-level `const`. The exact failure text goes in the task report, then the change is restored (`.claude/skills/solve-issue/SKILL.md` §3).
- Integration and e2e run against the worktree's own server (`pnpm run worktree:up`, port in `.env`). Never touch `:3000`.
- Stage exact paths; never `git add -A`.

## Review Focus

1. **A test file that relied on module re-evaluation for a clean slate.** It now shares state between tests within the file. Expected: the existing reset (`_resetChallengeStores`, `resetRateLimits`, `__resetDispatchFailureTrackingForTests`) clears the global state, not a fresh local. Pinned in Tasks 2–4: each reset test runs against a second module copy.
2. **A dev edit to passkey's eviction-flush logic.** Expected: the next backstop tick runs the edited function, not the first evaluation's. Pinned in Task 2: the tick calls whatever function the latest evaluation installed.
3. **Many module evaluations against one bus.** Expected: `setMaxListeners(100)` is applied once, and evaluating again neither resets the cap nor drops the listeners already on the bus. Pinned in Task 1.
4. **Two modules declaring the same `__fairYoga*` key with different types.** Expected: a compile error, not a silent collision. TypeScript refuses a `var` redeclared with a different type in `declare global`. Task 6 records that error once, from a scratch file, in its report.
5. **The shutdown path with one shared Prisma client.** Expected: whatever disconnects the client at shutdown still runs once, and nothing disconnects a client another bundle entry is using. Task 5 reads `src/lib/shutdown.ts` and every `$disconnect` call in `src/`, and records a verdict for each.

---

### Task 1: `notificationBus` is process-wide (#935)

**Files:**
- Modify: `src/lib/event-bus.ts`
- Test: `src/lib/event-bus.test.ts`

**Interfaces:**
- Produces: `notificationBus` keeps its name and the three methods its callers use (`emitNotification`, `onNotification`, `offNotification`), plus `listenerCount(): number`. It becomes a plain object literal whose methods delegate to the process-wide emitter `globalThis.__fairYogaNotificationBus: EventEmitter`. Call sites (`src/services/notifications.ts`, the SSE route, tests) change only where they called `notificationBus.listenerCount('notification')`, which becomes `notificationBus.listenerCount()`. `vi.spyOn(notificationBus, 'offNotification')` in `src/app/api/notifications/stream/route.test.ts` must keep working, so the object is not frozen.
- `NotificationEvent` is unchanged.

- [ ] **Step 1: Write the failing tests** in `src/lib/event-bus.test.ts`:
  - `'a listener on one module copy hears an emit from a fresh copy'`: import, `onNotification(handler)`, `vi.resetModules()`, re-import, `emitNotification(event)` on the second copy, then `expect(handler).toHaveBeenCalledWith(event)`. Clean up with `offNotification` in `finally`.
  - `'the listener cap is applied once and survives re-evaluation'`: after two evaluations, `globalThis.__fairYogaNotificationBus?.getMaxListeners()` is `100`, and a listener added before the second evaluation is still counted by the second copy's `listenerCount()`.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit src/lib/event-bus.test.ts`. Expected: the first test FAILS (handler not called) and the second fails on `undefined`.
- [ ] **Step 3: Implement.** Hold the emitter with `??=`, and call `setMaxListeners(100)` inside the initialiser only, with its existing comment. Delete the `NotificationBus` class.
- [ ] **Step 4: Run** the file, then `src/app/api/notifications/stream/route.test.ts` and `src/services/walk-ins.test.ts`. Expected: PASS.
- [ ] **Step 5: Prove the guard bites.** Swap the `??=` holder for a module-level `new EventEmitter()`, run Step 2's command, and record the failure text. Restore and re-run green.
- [ ] **Step 6: Commit**, with `src/lib/event-bus.ts`, `src/lib/event-bus.test.ts` and any call-site file changed. The message is `fix: the notification bus is process-wide, so scheduler notifications reach the live stream (#935)`.

### Task 2: passkey challenge state and its backstop timer are process-wide (#933)

**Files:**
- Modify: `src/lib/auth/passkey.ts` (the challenge-store section: `challengeStores`, `evictionLogState`, `_getChallengeStore`, `_resetChallengeStores`, and the backstop `setInterval`)
- Test: the existing passkey unit test file. Find it with `ls src/lib/auth/passkey*.test.ts`. Add a new `src/lib/auth/passkey-process-state.test.ts` only if the existing file mocks something that blocks `vi.resetModules()`.

**Interfaces:**
- Produces: `globalThis.__fairYogaPasskeyChallenges` with this shape:
  ```ts
  interface PasskeyChallengeState {
    stores: Record<ChallengePurpose, Map<string, StoredChallenge>>;
    evictionLog: Record<ChallengePurpose, { lastLogTime: number; suppressed: number }>;
    /** Rebound by every evaluation, so the timer runs the newest code. */
    flushAll: (now: number) => void;
    backstopStarted: boolean;
  }
  ```
  The exported functions keep their signatures (`storeChallenge`, `getAndDeleteChallenge`, `_getChallengeStore`, `_resetChallengeStores`, `CHALLENGE_CAPACITIES`).

- [ ] **Step 1: Write the failing tests:**
  - `'a challenge stored by one module copy is read by a fresh copy'`: `storeChallenge('registration', key, 'c1')`, then `vi.resetModules()`, re-import, then `expect(getAndDeleteChallenge('registration', key)).toBe('c1')`.
  - `'the backstop interval starts once across evaluations'`: spy on `globalThis.setInterval` and reset `globalThis.__fairYogaPasskeyChallenges` to `undefined` first. Over two evaluations, the spy sees one call with `60_000`.
  - `'the backstop tick runs the latest evaluation's flush'`: with fake timers, over two evaluations, replace the second copy's `flushAll` with a spy via the global, advance 60 s, and expect the spy to have been called.
  - `'_resetChallengeStores on a fresh copy empties what the first copy stored'`.
- [ ] **Step 2: Run** the file in `--project unit`. Expected: all four FAIL. The interval test sees 2 calls.
- [ ] **Step 3: Implement.** One `??=` initialiser creates `stores`, `evictionLog` and `backstopStarted: false`. Each evaluation then assigns `state.flushAll = (now) => …` over the module's own `flushPendingEvictionLog`. If `!state.backstopStarted`, start `setInterval(() => state.flushAll(Date.now()), EVICTION_LOG_THROTTLE_MS).unref()` and set the flag. Rewrite every read of `challengeStores` and `evictionLogState` to go through `state`. Keep the backstop docblock, but correct it to say the timer is started once per process.
- [ ] **Step 4: Run** the file, then `pnpm exec vitest run --project unit src/lib/auth`. Expected: PASS.
- [ ] **Step 5: Prove the guard bites.** Revert `stores` to a module-level literal, record the failure, then restore.
- [ ] **Step 6: Commit**: `fix: passkey challenges and their backstop timer are process-wide (#933)`.

### Task 3: rate-limit state is process-wide (#933)

**Files:**
- Modify: `src/lib/rate-limit.ts` (`prefixStates`, `lastUnresolvedIpLogTime`, `resetRateLimits`)
- Test: `src/lib/rate-limit.test.ts` (confirm the name with `ls src/lib/rate-limit*.test.ts`)

**Interfaces:**
- Produces: `globalThis.__fairYogaRateLimits: { prefixes: Map<string, PrefixState>; lastUnresolvedIpLogTime: number }`. The exported API is unchanged.

- [ ] **Step 1: Write the failing tests:**
  - `'the students budget is shared across module copies'`: on copy A, spend `checkStudentWriteLimit(teacherId)` up to its limit. Then `vi.resetModules()`, and copy B's next call answers not-allowed.
  - `'resetRateLimits on a fresh copy clears buckets the first copy filled'`.
- [ ] **Step 2: Run** in `--project unit`. Expected: FAIL, because copy B allows the call.
- [ ] **Step 3: Implement.** Use one `??=` holder, and route every `prefixStates` and `lastUnresolvedIpLogTime` read and write through it. The module docblock's sentence "state does not survive restarts and is not shared across instances" stays true (it means processes). Add one clause saying the state is process-wide within one process.
- [ ] **Step 4: Run** the file, then `pnpm exec vitest run --project unit src/lib`. Expected: PASS.
- [ ] **Step 5: Prove the guard bites**: revert `prefixes` and record the failure.
- [ ] **Step 6: Commit**: `fix: rate-limit buckets are process-wide, so routes sharing a prefix share its budget (#933)`.

### Task 4: the remaining must-share holders

**Files:**
- Modify: `src/lib/notify-health.ts`, `src/services/processor-token.ts`, `src/services/processor-methods-cache.ts`
- Test: `src/lib/notify-health.test.ts` and the existing tests of the other two. Find them with `ls src/services/processor-token*.test.ts src/services/processor-methods*.test.ts`, and add a test file per module only where none exists.

**Interfaces:**
- Produces:
  - `globalThis.__fairYogaNotifyHealth: { recentFailures: number[] }`. `recordDispatchFailure` reassigns `state.recentFailures`. `__resetDispatchFailureTrackingForTests` keeps its name. Its docblock currently says Vitest isolates module state per file. Rewrite it to say what is true now: the state is process-wide, and Vitest isolates `globalThis` per file.
  - `globalThis.__fairYogaProcessorTokenInflight: Map<string, Promise<TokenLookup>>`.
  - `globalThis.__fairYogaOfferCache: Map<string, { at: number; value: CachedOffer }>`. `offerCache` stays an export bound to that map.

- [ ] **Step 1: Write the failing tests**, one per module, each across `vi.resetModules()`:
  - `'dispatch failures recorded by two module copies count toward one threshold'`: two calls on copy A and one on copy B give `looksSystemic: true`.
  - `'a refresh in flight on one copy is joined by a fresh copy'`: start `getAccessToken` on copy A with a Mollie refresh stub that stays pending until released, call it on copy B, release, and assert the stub was called once. Do not seed the global's map directly. Use the existing test file's Mollie stub shape.
  - `'forgetOfferedMethods on a fresh copy drops what the first copy cached'`.
- [ ] **Step 2: Run** each in `--project unit`. Expected: FAIL.
- [ ] **Step 3: Implement** the three holders with `??=`.
- [ ] **Step 4: Run** the three files. Expected: PASS.
- [ ] **Step 5: Prove each guard bites**: three reverts, three recorded failures.
- [ ] **Step 6: Commit**: `fix: the invitation-failure window, the Mollie refresh dedupe and the methods cache are process-wide (#933)`.

### Task 5: one Prisma pool for the whole process

**Files:**
- Modify: `src/lib/db.ts`, and `docs/technical-architecture.md` ("Where Prisma comes from", the `DEFAULT_POOL_MAX` / production bullets)
- Test: `src/lib/db.test.ts` (create it if it is absent)

**Interfaces:**
- Produces: `globalThis.__fairYogaPrisma: PrismaClient | undefined`, set unconditionally. `export const prisma` is unchanged for every importer.

- [ ] **Step 1: Write the failing test** `'production re-evaluation reuses the process client'`: `vi.stubEnv('NODE_ENV', 'production')`, import, `vi.resetModules()`, re-import, then `expect(second.prisma).toBe(first.prisma)`. No query runs, because the client connects lazily.
- [ ] **Step 2: Run** it in `--project unit`. Expected: FAIL (two clients).
- [ ] **Step 3: Implement.** Replace the `globalForPrisma` cast and the `NODE_ENV` branch with the `declare global` idiom.
- [ ] **Step 4: Run** it. Expected: PASS. Then **prove it bites**: restore the `NODE_ENV` branch, record the failure, revert.
- [ ] **Step 5: Review Focus 5.** Read `src/lib/shutdown.ts` and `grep -rn '\$disconnect' src`, and write a verdict for each hit in the task report.
- [ ] **Step 6: Measure.** Run a production build (`pnpm run worktree:down`, `pnpm run build`, then `next start` on the worktree port with `.env` loaded) with a temporary evaluation log in `db.ts`. Record, before and after this task's change:
  - how many times `db.ts` evaluates, and whether each reuses the client;
  - `pg_stat_activity` connections to the worktree database after `notifications-stream` and `passkey-api` plus three page loads;
  - the contention check, which must load the server's own pool (a separate `tsx` process has a pool of its own and measures nothing): fire 20 concurrent requests at `src/app/api/cron/` routes (`transition-classes`, `generate-classes`, `email-fallback`, using the auth those routes require), and meanwhile time 10 sequential `GET /api/health` (which queries the database). Record the latency and any `pool_exhausted` in the server log.

  The temporary log is not committed. The numbers go in the task report, for the PR body.
- [ ] **Step 7: Docs.** Correct the "Where Prisma comes from" production bullet so it says one pool for the process. The reason is the measured three-entry split this change removes. Add the re-derivation (an evaluation probe in `db.ts` on a production build) per the doc's own style.
- [ ] **Step 8: Commit**: `fix: one Prisma client and pool for the whole process, production included`.

### Task 6: the census, and a written verdict on every holder

Must run after Tasks 1–5. Before them, the census fails on holders those tasks are about to move.

**Files:**
- Create: `src/lib/process-state-census.test.ts`
- Modify: `src/lib/census-walk-independence.test.ts` (add the new file to `KNOWN_CENSUS_FILES`)
- Modify: every file the census flags, by adding its `// per-instance: <reason>` line. The spec's per-instance list is the expected set; the census is the authority. Expect at least `email.ts`, `unsubscribe-token.ts`, `push-dispatch.ts`, `mollie-deps.ts`, `csp-report/route.ts`, `degradation.ts`, `teacher-photo.ts`, the two generators, `waitlist-reconciliation.ts`, `push-health.ts`, `db-locks.ts`, `admin-access.ts`, `log-serializers.ts`, `log.ts`, `pg-error.ts`, `attendance-sync.ts`, `offline-status.ts` and `attendance-outbox.ts`.

**Interfaces:**
- Consumes: the `__fairYoga*` holders from Tasks 1–5.
- Produces: `findUnmarkedHolders(fileName: string, text: string): Finding[]`, where `Finding = { line: number; binding: string; shape: 'let' | 'mutated-const' | 'top-level-timer' }`. It is exported from the test file's own scope (not `src/`), and both the fixtures and the tree run use it.

- [ ] **Step 1: Read** `src/lib/write-handler-wrap-census.test.ts` and the header of `src/lib/census-walk-independence.test.ts`. Mirror their structure: an own `readdirSync` walk, an `areasUnderSrc` scope-reach assertion, and `reached` built from the consumed-file list. The census-walk guard checks that structure.
- [ ] **Step 2: Write the fixture tests.** Each fixture is inline source text:
  - **Fails:** a top-level `let`; a `const m = new Map()` with `m.set(…)` in a function; a `const o = { a: { n: 0 } }` with `o.a.n++`; `const s = new Set(); s.add(…)`; a top-level `setInterval(…)`.
  - **Passes:** each of those with a `// per-instance: x` line above it; `const s = (globalThis.__fairYogaX ??= new Map())` mutated; a `ReadonlySet` constant never mutated; a file opening `'use client'`.
  - **Pinned blind spots (passes, as documented):** `const c = createThing()` called later; an alias `const a = m; a.set(…)` where `m` is the marked holder; `// per-instance:` with an empty reason fails.
- [ ] **Step 3: Run** `pnpm exec vitest run --project unit src/lib/process-state-census.test.ts`. Expected: FAIL (`findUnmarkedHolders` not defined).
- [ ] **Step 4: Implement `findUnmarkedHolders`** per spec Decision 5 (*What the guard flags, exactly*), and the tree test `'every server-side holder under src/ is process-wide or carries a per-instance reason'`, which lists each finding as `file:line binding (shape)`.
- [ ] **Step 5: Run the tree test.** Expected: it FAILS, listing the unmarked per-instance holders. Compare that list with the spec's table, and write in the task report any holder the census found that the spec did not, or the reverse, with a verdict.
- [ ] **Step 6: Add the reasons**, one line each. Each says what a split of that holder costs, about that holder only, never naming other modules or counting copies. Re-run: PASS. Run `src/lib/census-walk-independence.test.ts`: PASS.
- [ ] **Step 7: Prove the census bites on the real tree.** Delete the `per-instance:` line from `email.ts`, record the failure, and restore. Revert Task 3's holder to a module-level `new Map`, record the failure, and restore.
- [ ] **Step 8: Review Focus 4.** In a scratch file outside `src/`, declare `var __fairYogaPrisma: string | undefined` in `declare global`, run `pnpm run typecheck`, record the error, and delete the file.
- [ ] **Step 9: Commit** the census, the `KNOWN_CENSUS_FILES` edit and the reasons (exact paths): `test: a census holds every server-side module-level holder to process-wide or a written per-instance reason (#933)`.

### Task 7: docs, and the acceptance runs

**Files:**
- Modify: `docs/technical-architecture.md` (new "Process-wide state" subsection under The Services Layer), `CLAUDE.md` (one Development Principles line)

- [ ] **Step 1: Docs.**
  - The new subsection states: the rule; the idiom with a short example; data, not class instances; the `per-instance:` marker; the census file by name; and a link to the spec.
  - CLAUDE.md gets one bolded principle in the `FireAndForget` line's style, pointing at that subsection.
  - `grep -rn "933" .claude/skills docs/solve-issue-lessons.md`. Replace any workaround text found, rather than annotating it.
- [ ] **Step 2: #933 acceptance, dev.**
  - `pnpm run worktree:up`, then run the three files (`tests/integration/passkey-api.test.ts`, `tests/integration/passkey-credentials-api.test.ts`, `tests/integration/invitations-api.test.ts`). Expected: 121 passed.
  - Append a comment line to `src/lib/api-errors.ts`, wait 3 s, and re-run. Expected: 121 passed. Before this branch, the same steps gave 113 passed / 8 failed.
  - Revert the edit. Record both runs for the PR body.
- [ ] **Step 3: #935 acceptance, production build.**
  - With temporary evaluation and emit probes in `event-bus.ts` (not committed), repeat the spec's measurement: open a stream as a fresh teacher, and create an unbooked `open` online class starting in 60 min with `minStudents: 3` and `autoCancelCheck: HOURS_2`.
  - Expected: the auto-cancel emit lands on the instance the stream listens on, with `listeners ≥ 1`, and the stream receives the notification id.
  - Record the result. The probe test file is not committed.
- [ ] **Step 4: Run** `pnpm run verify` and `pnpm run build`. Expected: green. Record the vitest file counts per project for the PR body.
- [ ] **Step 5: Commit** the docs: `docs: process-wide state, the rule and where it is enforced (#933)`.
