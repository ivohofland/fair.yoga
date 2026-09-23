# A transient database failure says which one it was (#232)

**Issue:** [#232](https://github.com/ivohofland/fair.yoga/issues/232) — "A drained
connection pool is logged as a lost lock race, at warn".

**Direction agreed (brainstorm, 2026-09-23):**

1. `pool_exhausted` and `deadlock` log at `error`; every other transient kind stays
   at `warn`.
2. Two axes, kept separate. `transient` keeps meaning *a retry can win* and goes on
   driving every 503, every `busy` arm and every sweep escalation exactly as it
   does today. The new **kind** decides only the log level and the log field.

## 1. Premise, as measured against `origin/main` at `982e54e1`

| Claim in the issue | Verdict | Evidence |
|---|---|---|
| `TRANSIENT_PRISMA_CODES` holds `P2024`, `P2028`, `P2034`, and all three reach `busy` at `warn` | **Holds** | `src/lib/api-errors.ts:214`; `classifyApiError`'s transient branch (`:524`) answers `level: 'warn'` |
| "There is no path in this codebase by which pool exhaustion produces an `error`-level line" | **Holds** | Every consumer picks `warn` when `isTransientDbError` is true; see the census below |
| "The five template lifecycle functions each log a lock-race message" | **Holds, and understates the surface** | The five are now `rule-lifecycle.ts` (archive, pause/resume, edit — each serving both families since #284/#298) plus the two creates. They are 5 of 15 call sites |
| A drained pool is not distinguishable in the logs "without reading `err.message`" | **Partly false** | Measured: pino's default `err` serializer copies a `PrismaClientKnownRequestError`'s enumerable fields, so a top-level `P2024` line already carries `err.code: "P2024"` and `err.meta: { connection_limit, timeout }`. It stops holding where the Prisma error sits under a wrapper — `SpotFreedError` carries it as `cause`, and `err.code` is then the wrapper's |
| (implicit) a deadlock is distinguishable from a lock timeout | **False, and this is the real gap** | Measured: both `40P01` and `55P03` arrive on model writes as `PrismaClientUnknownRequestError`, whose serialized keys are `clientVersion, message, name, stack, type` — no `code`. The SQLSTATE exists only inside the driver string |
| "A `40P01` … points at #229" | **Stale** | #229 closed 2026-08-30 via #368, standardising on `ClassTemplate` before `Class`. A deadlock at a template site is now a regression signal, not evidence for an open decision |

The pino measurement: a script constructing one `PrismaClientKnownRequestError`
(`code: 'P2024'`) and one `PrismaClientUnknownRequestError` (message carrying
`code: "55P03"`), logged through `pino({ base: undefined })` and piped through
`jq '{errKeys: (.err|keys), code: .err.code}'`, printed
`["clientVersion","code","message","meta","name","stack","type"]` / `"P2024"`
for the first and `["clientVersion","message","name","stack","type"]` / `null`
for the second.

### The call-site census

```
git grep -nE "isTransientDbError\(" -- 'src/**/*.ts' ':!**/*.test.ts' \
  | grep -vE "^\S+:[0-9]+:\s*(\*|//)" | grep -v "function isTransientDbError"
```

15 sites in 11 files: `account/route.ts` 3, `registrations/[id]/route.ts` 1,
`registrations/route.ts` 1, `waitlist/route.ts` 1, `api-errors.ts` 1
(`classifyApiError`), `class-template-lifecycle.ts` 1, `gdpr.ts` 1,
`rule-lifecycle.ts` 3, `studio-class-template-lifecycle.ts` 1,
`waitlist-reconciliation.ts` 1, `waitlist-retention.ts` 1 —
3+1+1+1+1+1+1+3+1+1+1 = 15.

Of the 15, `account/route.ts:70` (`erasureFailure`) chooses copy, not a level, and
logs nothing; the other 14 either log directly or, for `classifyApiError`, return
the level `withErrorHandler` logs at.

## 2. The classifier

In `src/lib/api-errors.ts`, beside the code sets it replaces:

```ts
export type TransientKind =
  | 'lock_timeout'
  | 'deadlock'
  | 'serialization'
  | 'pool_exhausted'
  | 'tx_budget';

export interface TransientDbFailure {
  kind: TransientKind;
  level: 'warn' | 'error';
}

export function transientDbFailure(error: unknown): TransientDbFailure | null;
export function isTransientDbError(error: unknown): boolean; // transientDbFailure(error) !== null
```

| Kind | Matched on | Level | Why this level |
|---|---|---|---|
| `lock_timeout` | `55P03` | warn | The system doing what `SET LOCAL lock_timeout` configures it to do |
| `deadlock` | `40P01`, `P2034` | **error** | Since #229 every known cycle is closed but one — the `updateClass` × `updateClass` slot-key deadlock `docs/lock-order.md` records. A deadlock anywhere else is a new cycle or a regressed one, and must be seen |
| `serialization` | `40001` | warn | Cannot fire: nothing runs a serializable or repeatable-read transaction |
| `pool_exhausted` | `P2024` | **error** | An operational fault — a leak or a drained pool. No retry wins it until the pool recovers, and the next request meets the same pool |
| `tx_budget` | `P2028` | warn | Contention or a slow transaction; the 10 s and 20 s budgets are deliberate |

Tethers, per CLAUDE.md *Comment Discipline*:

- The level table is `satisfies Record<TransientKind, 'warn' | 'error'>`, so a
  new kind cannot compile without a level.
- The code → kind maps are typed against `TransientKind` so an unknown kind
  cannot appear in them.

**`P2034` lands in `deadlock`, not `serialization`.** Prisma documents it as
"write conflict or deadlock". A write conflict needs a serializable or
repeatable-read transaction and this repo has none — the `40001` row's own
reason. The docblock states that dependency where a future serializable
transaction must meet it.

**Accepted consequence of the `deadlock` row**, stated in the docblock: the known
`updateClass` slot-key deadlock now logs at `error` when it fires. It needs two
concurrent `updateClass` writes by one teacher; that it pages is the point of
recording it rather than special-casing it.

Unchanged behaviour the classifier must keep:

- Prisma codes are checked before SQLSTATEs; SQLSTATEs are matched only inside
  their Postgres framing (`code: "…"` / `` Code: `…` ``), never as a bare
  substring — the trap the existing docblock documents.
- The `Error.cause` walk, bounded by `MAX_CAUSE_DEPTH`, applies to the kind as it
  does to the boolean. The first transient error found on the chain supplies the
  kind.
- `isLockTimeout` is untouched. It is a separate `55P03`-only predicate used by the
  two generators, and their "lock race" lines are accurate because of it.

## 3. `classifyApiError`

The transient branch takes `level` from the classifier and adds
`detail: { transientKind }`. Its `logMessage` drops "contention" — wrong for a
drained pool — and becomes `'transient database failure surfaced to a client'`.
Status, user-facing message and absence of a `code` are unchanged.

## 4. The consumer sites

Every site that logs:

- takes its level from `transientDbFailure(err)?.level`, falling back to the
  level its non-transient branch already uses;
- adds `transientKind` to the log fields (`null` on the non-transient branch,
  kept so a query can facet on it);
- keeps `transient` in the fields where it is there today;
- drops the mechanism from the message: "…lost a lock race…" and
  "…lost the template lock race…" become "…rolled back on a transient database
  failure…", with the rest of each message unchanged. Messages stay static
  strings so they group.

Site-specific rules:

- **`waitlist-reconciliation.ts`** keeps its `stuck` override: a transient failure
  at `MAX_CONSECUTIVE_CONTENDED_TICKS` logs at `error` regardless of kind. Its
  returned `transient` flag is unchanged, so `decideEscalation` sees nothing new.
- **`waitlist-retention.ts`** and the spot-freed hooks (`registrations/[id]`,
  `gdpr.ts`): level, field and message, by the general rule above.
- **The two `tierSelectedAt` writes** (`registrations/route.ts`,
  `waitlist/route.ts`): level and field only — their message names no mechanism.
- **`account/route.ts`**: the two logging sites take level and field; the
  `ErasureLockSetError` branch stays `error`; `erasureFailure` (`:70`) keeps using
  the boolean.
- **The five template sites** keep returning `{ ok: false, reason: 'busy' }`.

The `busy` docblock in `rule-lifecycle.ts` (`ArchiveTemplateResult`'s arm) is
reread whole, not grepped: it describes what the arm's log line claims.

## 5. Sweeping the phrase

`entry-generation.ts`'s `EditLogNoun` docblock ships a re-derivation grep keyed
on `"edit lost a lock race"`; it must be updated to the new wording in the same
change, and run to confirm it still finds the sibling lines.

The phrase sweep is `git grep -nE "lock race" -- src docs CLAUDE.md`, excluding
`docs/superpowers/` (records, not live docs). Every hit gets a verdict. Expected
legitimate survivors: lines and comments whose matcher is `isLockTimeout`
(the generators and their tests), and prose that really is about a `55P03`.

## 6. Tests

Unit (`src/lib/api-errors.test.ts`):

- each code maps to its kind and level, in each error shape it arrives in —
  `55P03` both as the Unknown model-write shape and the `P2010` raw shape;
- a `P2024` under a `SpotFreedError` `cause` yields `pool_exhausted` / `error`;
- a digit string that merely contains a code (`'40P01'` in a message without the
  framing) yields `null`;
- `isTransientDbError` agrees with `transientDbFailure(...) !== null` for all of
  the above.

Per consumer: the existing tests that inject a transient failure and assert the
log line gain an assertion on `transientKind` and level; each logging site gets
one `warn` kind and one `error` kind asserted. Where a site has no such test
today, one is added. Integration tests are not hand-listed; the suite covers
them.

### Mutations, each of which must turn a test red

| # | Mutation | Expected red |
|---|---|---|
| 1 | `pool_exhausted` → `warn` in the level table | the `P2024` unit test and one site's `error` assertion |
| 2 | `deadlock` → `warn` | the `40P01` unit test |
| 3 | Map `P2024` to `lock_timeout` | the kind assertion |
| 4 | Classify only the top-level error for the kind (no `cause` walk), so a wrapped `P2024` yields `null` | the wrapped-`P2024` test |
| 5 | Drop `transientKind` from one template site's log fields | that site's test |
| 6 | Hard-code `level: 'warn'` in `classifyApiError`'s transient branch | its `P2024` case |
| 7 | Reconciliation: let the kind's level override `stuck` | the existing stuck-at-limit test |

Record each mutation's exact failure text; restore; confirm `git status` clean.

## 7. Not in scope

- **#354 is unaffected** — the generators' skip-and-report behaviour uses
  `isLockTimeout`.
- No 503 body, API error code, `busy` arm, `/api/health` field or escalation rule
  changes. The only observable differences are log levels, log fields and log
  messages.
- No migration, no schema change.

## 8. Acceptance

1. A drained pool is distinguishable from a lost lock race in every consumer's
   log line by a field (`transientKind`), including when wrapped.
2. A `P2024` and a `40P01` log at `error` at every consumer; `55P03`, `P2028` and
   `40001` log at `warn`, except where reconciliation's `stuck` rule raises them.
3. The levels are chosen in one compiler-tethered table whose docblock states the
   alerting contract, beside the codes it classifies.
4. No log line produced from `transientDbFailure` names a lock race.
5. Mutations 1–7 each go red, with the failure text recorded in the PR body.
