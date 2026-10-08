# A degradation that nobody is told about is a silent failure (#157)

2026-10-08 (#770): `/api/health` is no longer fully public — the degradation count and per-job detail need the cron secret; see `2026-10-08-defense-in-depth-design.md` §2.5.

## Problem

Several modules substitute a safe value instead of throwing, on the reasoning
that one wrong value shown once beats a 500 on a public page, and each says the
log line is what makes the substitution observable. Nothing reads that log:
`log.ts` is bare pino on stdout, `docker-compose.prod.yml` ships nothing, and
`DEPLOYMENT.md` §7 states "no automated alerting on log level exists yet
(issue #157)". The sentence "the log line is the only thing that would tell you"
is true and operationally hollow.

The issue asks for something much smaller than an observability stack: a
warning from the named fallbacks reaches a human without anyone thinking to
look, the mechanism is named in `docs/technical-architecture.md`, and the
docblocks become true.

## Premise check (measured at `ea7b38e4`)

### What held

- **No error-tracking SDK.** `grep -n sentry package.json pnpm-lock.yaml`
  returns nothing. The issue's `grep -rli sentry` no longer shows that: it now
  matches `src/services/class-lifecycle.ts` because `MatchesEntryFields`
  contains "sentry" case-insensitively. The command is a trap; the claim holds.
- **`log.ts` is the only logging primitive**: bare pino, no `redact`, no
  serializers, no wrapper.
- **`docker-compose.prod.yml` sets no logging driver** and ships nothing.
- **The architecture doc defers monitoring.** The line is at
  `technical-architecture.md` "Monitoring / observability" (line 1133, not 467).

### What was wrong or incomplete

**A — Two of the three named sites are not what the issue says.**

| Issue's claim | Measured |
|---|---|
| `timezone.ts:97,141` falls back to UTC with a `warn` | The UTC fallbacks log at **`error`**, at four sites: `timezone.ts` (three) and `finish-window.ts` (one), found by `grep -rniE "falling back to UTC" src` |
| `studio-class-generator.ts` has the same pattern | Its `log.warn` (`studio-class-generator.ts:232`) is **lock contention** (#122): routine, self-healing, with its own streak and health tracking. It substitutes no value |
| `toIncomeTier` substitutes the median and warns | Holds, but the warn is in `readIncomeTier`, which `toIncomeTier` calls. One warn covers both |

**B — "Eight new call sites" has moved.** What the issue counted as degrade
sites is a different set today. The honest measure is the whole surface:
`grep -rn "log\.warn(" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
gives 82 call lines, and the same with `log\.error(` gives 69, across
`grep -rlE "log\.(warn|error)\(" …` = 58 files. Whether any given one is a
degradation is a question about what it does to the user, not about its level.
That classification is a task of this issue (below), not an assumption.

**C — `/api/health` is public by design.** Its docblock promises "liveness,
DB reachability, and per-job scheduler state … nothing else". Any health block
this issue adds must respect that, which rules out per-code counts or sample
context on it.

**D — A neighbouring worktree edits the same route** (`issue-711`, health
staleness). Not a design input, but the implementer should rebase carefully.

## Decisions (agreed with Ivo)

1. **Curated events, not "all warns".** A site that substitutes or withholds a
   value because data that should have been impossible turned up calls
   `logDegraded(code, context)`. Lock timeouts, throttles, refusals and
   documented races stay ordinary warns.
2. **Events are recorded in the database and emailed in a daily digest.** One
   row per code. Chosen over in-memory counters (reset by every deploy) and
   immediate email (needs the table anyway for dedupe).
3. **The digest repeats only on re-fire.** A code is emailed when it is new or
   has fired again since the last email. Nobody acknowledges anything.
4. **No `OPERATOR_EMAIL` never blocks boot.** It is surfaced, not fatal (below).
5. **Health reports without flipping.** A degraded-but-serving app is not an
   outage and must not make the uptime monitor cry wolf.
6. **The rest of the warn sites are audited here**, seeded from the known
   degradations.
7. **Redaction of the `err` serializer is a separate issue** (#739). This
   channel carries no `err` and no free text, so it does not depend on it.

## Design

### 1. The registry — `src/lib/degradation-codes.ts` (pure data, client-safe)

`DEGRADATION_CODES` maps each code to `{ description, contextKeys }`, where
`contextKeys` is an `as const` tuple of the keys that code may carry.
`DegradationCode` is `keyof typeof DEGRADATION_CODES`, and the context type for a
code is derived from its tuple, so a call site that passes an unlisted key is a
compile error.

The seed, subject to the audit adding more:

| Code | Raised by | Context keys |
|---|---|---|
| `INCOME_TIER_OUT_OF_RANGE` | `readIncomeTier` (`tiers.server.ts`) | `tier`, `studentId`, `registrationId` |
| `TIMEZONE_INVALID_FALLBACK_UTC` | the four invalid-timezone fallbacks | `timeZone`, `site` |

`site` is a fixed enum naming which fallback fired. Every key is an id, an enum
or an IANA zone string: nothing a person typed, no names, no emails, no `err`.

### 2. The helper — `src/lib/degradation.ts` (server-only)

`logDegraded(code, context?)` returns **`FireAndForget`** (CLAUDE.md; rule and
construction in `technical-architecture.md`, "Work that must not be awaited").
It does two things:

- Emits the same `log.warn` / `log.error` line the site emits today, so every
  existing test that asserts that line keeps passing.
- Records the event, filtered through the code's allowlist at **runtime** as
  well as in the types (the types do not stop a cast).

It never throws and never delays its caller. If the write rejects it logs at
`error` and returns.

**Coalescing.** A degraded value on a public page would otherwise write on every
view, and concurrent renders would contend on one row. Per code, the first
occurrence in a window writes immediately; further ones accumulate a pending
count and the latest sample, and an `unref`'d timer flushes them at the window's
end. The trailing flush is not optional: without it, an event landing just
after a flush but before the digest would never update `lastSeenAt`, and the
digest's "fired again" test would miss it. `occurrences` is approximate by
construction (pending counts are lost if the process exits mid-window).

### 3. The table

`DegradationEvent`: `code` (primary key), `occurrences`, `firstSeenAt`,
`lastSeenAt`, `lastNotifiedAt`, `sample` (`Json`, the latest allowlisted
context). A hand-authored `CHECK (occurrences > 0)`. No foreign keys, so it is
not a node in `docs/lock-order.md`; the only writes are single-row upserts.
Row count is bounded by the registry, so there is no retention sweep. Created
with `prisma migrate dev`, per CLAUDE.md.

### 4. The digest — `src/services/degradation-digest.ts`

A new sweep inside `isolatedSweeps('daily-cleanup', …)`, so a failed digest
cannot starve the session purge and still surfaces in job health.

- Selects rows where `lastNotifiedAt IS NULL OR lastNotifiedAt < lastSeenAt`.
- **Claims before sending**, the pattern `technical-architecture.md` (Cron Jobs
  → Overlapping triggers) records for payment reminders and email fallback: a
  conditional `updateMany` keyed on the `lastSeenAt` it read, setting
  `lastNotifiedAt` to **that value, not to now**. An event that lands between
  the read and the stamp advances `lastSeenAt` past it and is emailed next time.
  A claim count other than 1 skips the row. A failed send releases the claim.
- One email per run, listing the claimed codes: code, the registry description,
  first/last seen, approximate count, the allowlisted sample, and a pointer to
  the docs. Sent through the existing `sendHtmlEmail`; values are escaped.
- **Dry-run.** In dev and CI (`emailDryRun()`) `sendHtmlEmail` logs and answers
  `ok`, so the digest claims and moves on. In production without
  `EMAIL_DRY_RUN=1` and without a Resend key it answers `{ ok: false }`; the
  digest **releases its claims and throws**, so the event stays due and the job
  reports unhealthy — otherwise the net would look intact while sending nothing.
- **No `OPERATOR_EMAIL`** with something to send: the sweep throws, which flips
  `daily-cleanup` unhealthy on the existing public job verdict, so no new public
  surface is needed. `startScheduler` also logs at `error` once at boot in
  production when it is unset, as it already does for `CRON_SCHEDULER=off`. With
  nothing to send it stays quiet.

### 5. Health — `/api/health`

One added aggregate, `degradations: { open }`, where `open` is the number of
registry rows with `lastSeenAt` in the last 24 hours. No codes, no samples, no
configured-flag. `status` is unchanged by it. The route's docblock is updated to
say what it now reveals. The count shares the existing `try`: if it fails, the
database is down and the route already answers 503.

*This corrects what was presented during brainstorming, which put per-code
counts and an operator-configured flag on the public endpoint.*

### 6. Documentation and docblocks (acceptance criterion 3)

- `technical-architecture.md`: replace the "Monitoring / observability" line,
  add the mechanism to Cron Jobs, add the table to `data-model.md`.
- `DEPLOYMENT.md` §7: replace "no automated alerting on log level exists yet
  (issue #157)", document `OPERATOR_EMAIL` and the new health field. `.env.example`
  and the compose example in `technical-architecture.md` gain the variable.
- Each converted site's docblock stops saying a log line is what would tell you
  and names its registry code instead. No counts or rosters in prose.
- `docs/degradation-sites.md` holds the audit (below): the classification, the
  rule, and the command that re-derives the surface.
- **Sweep for what was invalidated**, not what was edited: `grep -rn '#157'` and
  `grep -rniE "only thing that would tell you|no automated alerting"` across
  source, docs, specs and plans, each hit given a verdict.

### 7. The audit

Every non-test `log.warn(` and `log.error(` call is classified by one rule: **a
site is a degradation iff it substitutes, or withholds, a value a user will see,
because data that should have been impossible turned up.** The classification
lands in `docs/degradation-sites.md` with the grep that re-derives the surface,
so a new site cannot silently join it. Sites that qualify are added to the
registry and converted; the rest are recorded as routine with a one-line reason.
A test fails if a `logDegraded` call names an unregistered code or a registered
code has no call site.

Likely candidates the issue did not name, to be decided by the audit and not
assumed: the unreadable-class-date branches in `timezone.ts`. The
`(public)/[slug]` signed-out fallback is a documented race with a hard delete
and is expected to classify as routine.

## Tests (written first)

- **Registry/helper (unit):** off-allowlist keys are dropped at runtime
  (mutation: loosen the filter); a rejected write never throws and logs once;
  coalescing writes once per window, flushes the trailing count, and carries the
  batched total; a code without an allowlist is a type error (`satisfies
  Record<DegradationCode, …>`).
- **Digest (integration):** a new event is emailed once; not again until it
  re-fires; an event landing between read and stamp is emailed next run (not
  lost); a failed send releases the claim; two overlapping runs send exactly
  one email, with both runs held at a barrier after their read so neither can
  claim first, and no sleep-based harness; unset `OPERATOR_EMAIL` with an event
  throws; a refusal from the provider (production without a key answers
  `{ ok: false }`) releases the claim and throws.
- **Health:** `degradations.open` counts rows seen in 24 h, ignores older ones,
  and leaves `status` at `ok`. No code or sample appears in the body.
- **Seeded sites:** a bad tier and an invalid zone each record exactly one event
  with only allowlisted context, and the existing log-line assertions still pass.
- **Audit:** the registry/call-site tether above.

Each guard is proven to bite: break it, record the exact failure text, restore.

## Order

1. Migration, registry, helper (tests first).
2. Digest sweep, `OPERATOR_EMAIL`, boot-time error.
3. Health aggregate.
4. Convert the seeded sites.
5. The audit and any further conversions.
6. Documentation and docblocks, last, against the final code.

Task order is load-bearing: 4 and 5 need the helper from 1; 6 must follow all of
them so no docblock is written against code that then moves.

## Not done here

- **#739** (allowlist the `err` serializer) — a prerequisite for shipping logs
  off-box, not for this. #739 is unaffected.
- A log backend, log shipping, or an acknowledgement workflow.
- Any change to the studio generator's lock-contention warn, or to the
  `session.studentId` race warn: both are routine.
- Cadence beyond daily. A fallback that fires is told within a day, which is the
  issue's own bar.
