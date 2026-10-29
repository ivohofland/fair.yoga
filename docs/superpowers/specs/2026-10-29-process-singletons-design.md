# Process-wide server state (#933, #935)

## Intent

One Node process serves this app: route handlers, server-rendered pages, and
the scheduler started from `instrumentation.ts`. Code written as if a
module-level `const store = new Map()` were "the" store for that process is
wrong in two settings:

- **`next dev`, after an edit** (#933). Each route entry re-evaluates the
  modules it imports, so two routes can hold different copies of one store.
- **A production build** (#935). The API route handlers share one copy, but
  the page (SSR) layer and the instrumentation/scheduler entry each get their
  own.

The fix is one rule: **state that must be the same for every caller in the
process lives on `globalThis`**, using the idiom this repo already uses in four
places. A test-time guard makes the rule something a contributor is told about,
not something they have to know.

## What was measured (and where the issue was wrong)

All measured on 2026-10-29 in worktree `fix-933-hmr-global-state`. The method:
a temporary `Math.random()` id logged at module evaluation and at each store
read or write. Those probes are not committed.

1. **The symptom reproduces exactly.** On a fresh dev server, the three files
   from #933 (`passkey-api`, `passkey-credentials-api`, `invitations-api`)
   passed 121/121. After one appended comment line in `src/lib/api-errors.ts`,
   they gave 113 passed / 8 failed, the same eight cases #933 lists.
2. **The instance split is shown, not inferred.** After the edit,
   `register/options` stored its challenge on instance `atsg9h` and
   `register/verify` read instance `yr0k3a`, which held 0 entries. The shared
   `students` rate-limit bucket was served by two instances (`ci4fp6` 51 hits,
   `i2cpbq` 1 hit). Before the edit, store and read were on one instance.
3. **`globalThis` fixes it.** With both stores held on `globalThis`, the same
   edit left the three files at 121/121. Modules still evaluated several
   times (six distinct ids for `passkey.ts`), but every copy reached the same
   store.
4. **#933's "production is unaffected" holds only for what #933 tested.**
   Under `next build` + `next start`:
   - All challenge stores and reads, and all rate-limit hits, landed on one
     instance, so the passkey and rate-limit failure is dev-only.
   - `passkey.ts` was still evaluated a second time, in an `ssr` chunk, by
     the page layer through the `@/lib/auth` barrel. That copy is inert:
     nothing in the page layer writes or reads challenges.
   - `event-bus.ts` was evaluated twice: `re3q87` at boot, which only
     instrumentation runs, and `sywql1` in the route layer, where
     `GET /api/notifications/stream` subscribes. A probe let the scheduler
     auto-cancel a class while the teacher held a stream open. The emit
     logged `bus emit on re3q87 listeners 0`. **Every scheduler-created
     notification misses the live stream in production.** That is #935.
5. **The issue's grep finds a subset.** Its regex finds module-level
   `const x = new Map|Set|WeakMap`. It misses object literals holding maps
   (`passkey.ts` `challengeStores`, `evictionLogState`), class-instance
   singletons (`notificationBus`), top-level `let`, factory-returned stateful
   closures (`degradation.ts` `coalescer`, `teacher-photo.ts` `decodeSlot`),
   and timers started on import (`passkey.ts`'s backstop `setInterval`). The
   full sweep, with its re-runnable method, is in the table below.

6. **Production builds three Prisma clients.** `src/lib/db.ts` stores the
   client on `globalThis` only when `NODE_ENV !== 'production'`. On a
   production build with an evaluation probe in `db.ts`, the module evaluated
   three times (`erfzb1`, `35o8ik`, `89v794`), each with `reusing false`:
   instrumentation, the route layer, and the page layer. Each is its own pool
   of up to `DEFAULT_POOL_MAX`, which is 9 in production
   (`docs/technical-architecture.md`, "Where Prisma comes from"), so up to
   3 × 9 = 27 connections. After two integration files and three page loads,
   `pg_stat_activity` showed 14 connections to the worktree's database. One
   pool cannot exceed 9, so this confirms the separate pools independently of
   the probe. Local `max_connections` is 100. See Decision 4.

## The rule

A **server-side module-level mutable holder** is a top-level binding in a
non-`'use client'` file under `src/` whose value changes after module
evaluation: a `let`, a `const` bound to a `Map`/`Set`/`WeakMap`/`WeakSet`/
`EventEmitter`/array/object literal that is mutated later, a `const` bound to a
call that returns a stateful closure, or a timer started at top level.

Every such holder is one of:

- **Process-wide**: written as
  ```ts
  declare global {
    // <why this is process-wide, one line>
    var __fairYoga<Name>: <Type> | undefined;
  }
  const store = (globalThis.__fairYoga<Name> ??= <init>);
  ```
  This is the idiom already in `scheduler.ts`, `shutdown.ts` and the SSE
  route. `declare global` gives the key its type, so there is no cast and no
  central registry importing from every module.
- **Per-instance, with a reason**: left in place, with a leading comment
  `// per-instance: <why a split costs nothing that matters>`.

## Decisions

1. **No new helper module** (*my call; it changes what I described in chat*).
   I proposed a `processSingleton(key, init)` helper. Reading the four
   existing holders changed my mind. `globalThis.__fairYogaX ??= init` with
   `declare global` is already one line, already strictly typed, and already
   this codebase's idiom. A helper would add indirection, need its own typed
   key registry to stay cast-free, and leave four call sites on the old
   shape. The guard (Decision 5) is what makes the rule uniform, and it
   checks this idiom directly.
2. **Process-wide holders store data, not behaviour.** A value that
   outlives an edit keeps its old prototype. A `NotificationBus` subclass
   instance on `globalThis` would keep its pre-edit methods until restart. So:
   - The emitter is a plain `EventEmitter` stored at
     `globalThis.__fairYogaNotificationBus`. `notificationBus` is a plain
     object literal whose methods delegate to that emitter, so
     `vi.spyOn(notificationBus, …)` still works. The listener cap
     (`setMaxListeners(100)`) is applied inside the `??=` initialiser, once.
   - A process-wide holder is a `Map`, `Set`, array, plain object or bare
     `EventEmitter`, never an instance of a class defined in this repo. The
     guard enforces this for `new` initialisers it can see.
3. **The `passkey.ts` backstop timer starts once per process**, behind its
   own `globalThis` flag or by living inside the process-wide state object.
   Each evaluation currently starts a new `setInterval` that is never cleared
   and keeps its copy's maps alive. The tick calls the module's current
   function, not one captured at first start, so a dev edit to the flush
   logic takes effect: the timer looks the function up through the global
   state on each tick.
4. **The Prisma client is one process-wide pool** (owner's decision,
   2026-10-29). Production has one pool per bundle entry (measured, item 6).
   `db.ts` drops its `NODE_ENV !== 'production'` condition and holds the
   client on `globalThis` unconditionally, so routes, pages and the scheduler
   share one pool of `DEFAULT_POOL_MAX` (9 in production). The sizing formula
   `cores × 2 + 1` exists to cap concurrent queries at what the database's
   CPUs serve, and three pools let up to 27 compete for the same 4 cores.

   Rejected:
   - Keeping the three pools as they are, with a `per-instance:` reason.
   - Two deliberate pools, one for requests and one for the scheduler. That
     gives isolation by design, but it is a follow-up to file only if the
     contention check below shows sweeps delaying requests.

   The risk is pool waits when a sweep burst meets requests.
   `connectionTimeoutMs` bounds those waits and `pool_exhausted` reports them.
   The build measures this with a contention check: hold a sweep-sized burst
   on the shared pool, and record request latency and any `pool_exhausted`
   in the PR body. It also corrects the pool paragraph in
   `docs/technical-architecture.md` ("Where Prisma comes from"), which
   describes one pool of 9 as if that were already true.
5. **The guard is a census test over the syntax tree**, like
   `src/lib/db-locks-verdict-census.test.ts`: TypeScript's parser, not a
   regex, so comments and strings are not hits and a `let` is a `let`
   wherever it sits. It walks every `.ts`/`.tsx` file under `src/`, excluding
   `*.test.*`, `src/generated/`, and files whose first statement is
   `'use client'`. It fails, naming `file:line` and the binding, on any
   top-level holder per *The rule* that is neither:
   - initialised through `globalThis.__fairYoga*` (directly or via `??=`), nor
   - preceded by a `// per-instance:` comment carrying a non-empty reason.

   It also fails on a top-level `setInterval`/`setTimeout` call not inside a
   `globalThis`-guarded block.

   What the guard flags, exactly (*my call, settled after the builder check*):
   - **Every top-level `let`**, unconditionally. A top-level `let` exists to
     be rebound. The `??=` idiom cannot rebind, so a process-wide `let`
     becomes a field of a global state object:
     `(globalThis.__fairYogaNotifyHealth ??= { recentFailures: [] })`, then
     `state.recentFailures = …`. This covers `notify-health.ts`
     `recentFailures` and `rate-limit.ts` `lastUnresolvedIpLogTime`.
   - **A top-level `const` initialised with `new X(…)`, an object literal or
     an array literal, that is mutated anywhere in the file.** "Mutated"
     means one of:
     - an assignment (`=`, any compound operator) or `++`/`--` whose
       target's root identifier is the binding, through any property or
       element chain (`challengeStores[purpose].clear()`,
       `evictionLogState[purpose].suppressed++`);
     - a call of one of the census's `MUTATORS` (the array, `Map`/`Set` and
       `EventEmitter` methods that change their receiver) on a receiver
       whose root identifier is the binding;
     - `Object.assign(binding…)` or `delete binding.x`.
   - **A `static` class property initialised with `new X(…)`, an object
     literal or an array literal**, mutated or not: it is a module-level
     holder reached through its class.
   - **Not flagged:** the shapes the guard's docblock
     (`src/lib/process-state-census.test.ts`) lists as what it does not see,
     each pinned by a fixture. That docblock is the list. The
     call-initialised shape would flag 259 non-test sites by a rough grep,
     route exports and zod schemas included, for a handful of real holders.
     The known ones (`coalescer`, `decodeSlot`, the streak trackers, `pino`)
     get their `per-instance:` reason anyway, for the reader rather than the
     guard.

   The guard proves itself on fixtures: a planted holder of each flagged
   shape fails, the same holder with a reason passes, and a planted holder
   of each shape the docblock lists as unseen passes, except the shadowing
   fixture, which flags (the loud direction). Each fixture pins its shape as
   documented rather than accidental.
6. **Immutable constants are not holders.** A `const` that the rule in
   Decision 5 does not flag is skipped, whatever its type. `pg-error.ts`
   `MESSAGE_READERS` is filled by `fromMessage` calls that run during its own
   module's evaluation. A syntax scan cannot know that, so it flags the
   holder, and the holder carries `// per-instance: filled once at module
   evaluation with this copy's own readers, and read only against them, so a
   split copy holds a complete set of its own`.
7. **Client-only modules are out of scope by file directive only.**
   `attendance-sync.ts`, `offline-status.ts` and `attendance-outbox.ts` have
   no `'use client'` directive, and are imported only by `'use client'`
   files and by each other. Their holders carry the reason
   `// per-instance: browser state`, a claim about what the holder holds,
   and the guard holds the claim: every file that imports a module carrying
   that reason must open with `'use client'` or carry it itself (direct
   value imports; a transitive import through a client file is not seen).
   `import 'client-only'` would do the same at build time, but the package
   is only vendored inside `next/dist/compiled`, and adding it as a direct
   dependency goes through `docs/supply-chain.md`.

## The holders and their verdicts

The sweep method, re-runnable: the walk in Decision 5, done by hand on
2026-10-29 with the commands recorded in the PR body. This table is the
state at the time of writing. The guard owns the live answer, and the table
is not kept in sync with the code.

**Process-wide (moved onto `globalThis`):**

| Holder | Why it must be shared |
|---|---|
| `src/lib/auth/passkey.ts` `challengeStores`, `evictionLogState`, backstop timer | `*/options` writes the challenge and `*/verify` reads it, and they are different routes (#933). The eviction throttle and the timer act on the store, so they move with it (Decision 3). |
| `src/lib/rate-limit.ts` `prefixStates`, `lastUnresolvedIpLogTime` | The `students` prefix is one budget across `/api/students`, `/api/registrations` and `/api/invitations/[id]/resend`. Split, each route grants its own 50/hour (#933). The IP-warning throttle moves with the module's state. |
| `src/lib/event-bus.ts` `notificationBus` | The scheduler and the page layer emit, and only the SSE route listens (#935, measured in production). |
| `src/lib/notify-health.ts` `recentFailures` | A process-wide burst detector for invitation-email failures. Split, it needs the threshold in each copy before it suppresses the per-row signal (#166/#392). Both callers are routes, so this is dev-only today. |
| `src/services/processor-token.ts` `inflight` | Deduplicates a Mollie token refresh per connection. The page layer (pay page, settings) and routes both refresh, and are separate copies in production. A duplicate refresh racing a rotation risks a false disconnect if Mollie invalidates the old refresh token, which the Mollie spec records as undocumented. It also restores the premise of that spec's Decision 15. |
| `src/services/processor-methods-cache.ts` `offerCache` | `forgetOfferedMethods` runs in routes, and the pay page reads the page layer's copy. A profile switch leaves the pay page showing the old profile's methods for up to 60 s in production. |
| `src/lib/db.ts` `prisma` | One pool for the whole process, production included (Decision 4). Today production builds one client per bundle entry, three measured. |

**Per-instance, with a reason (left in place):** the warn-once and log-throttle
flags (`email.ts`, `unsubscribe-token.ts`, `push-dispatch.ts`, `mollie-deps.ts`,
`csp-report/route.ts`), `mollie-deps.ts`'s memoised client (built from
constant env), `degradation.ts`'s `coalescer` (a split writes more rows with
partial counts and loses nothing), `teacher-photo.ts`'s `decodeSlot` (one route
layer in production, and the dev cost is a doubled cap), the scheduler-only
streak trackers (`productionStreaks` in the two generators and waitlist
reconciliation, and `push-health.ts`'s tick state, captured once by the
`globalThis`-guarded `startScheduler`), the identity `WeakMap`/`WeakSet`s
(`db-locks.ts`, `admin-access.ts`, `log-serializers.ts`, which never cross
copies and fail closed if they did), the three browser-state modules
(Decision 7), and `pino` in `log.ts`. Each gets its one-line reason where it
sits. The guard finds any I missed.

**Already process-wide, unchanged:** `scheduler.ts`, `shutdown.ts`,
`notifications/stream/route.ts` (`__fairYogaSseCounts`). `zod-locale.ts` is
zod's own global config.

## Tests

- **Per process-wide holder:** a unit test that writes through the module,
  calls `vi.resetModules()`, re-imports it, and reads the same value back.
  The test is broken once by reverting that holder to a module-level `const`,
  the failure text recorded, then restored.
- **#933 acceptance:** the three integration files pass after an edit to a
  `src/lib` file on a running dev server, recorded in the PR body with the
  reproduction from *What was measured*, red before and green after.
- **#935 acceptance:** an integration test opens a stream and triggers a
  scheduler-path notification. If an in-test path through the scheduler's
  own copy is not available, the PR records the production-build probe
  before and after instead, and says why the test cannot run in the suite.
- **The guard:** fixture-proven per shape (Decision 5), then run over `src/`,
  where it must pass only after every holder above has its verdict written.
- **Existing tests that relied on module re-evaluation for a clean slate**
  will now see shared state within a file. Each one found gets the module's
  existing reset (`_resetChallengeStores`, `resetRateLimits`) or a new
  test-only reset, not a weaker assertion.

## Non-goals

- Multi-process consistency. Two app instances would still split rate limits
  and challenges, as they would today. CLAUDE.md fixes one process on one VPS.
- Making stale dev code reload. A timer or the scheduler still runs pre-edit
  code until restart. This spec only makes state consistent.
- Moving per-instance holders onto `globalThis` for uniformity (owner's
  decision, 2026-10-29: keep them in place with a reason).

## Docs

`docs/technical-architecture.md` gains a short "Process-wide state" section
under the services layer: the rule, the idiom, the `per-instance:` marker, and
a link to this spec. CLAUDE.md gains one line under Development Principles
pointing there, in the style of the `FireAndForget` line. The #933 workaround
paragraph in `.claude/skills/solve-issue/SKILL.md`'s hazards list, if one was
added, is replaced, not annotated.
