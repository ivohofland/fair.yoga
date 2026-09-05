# Spec: a causal handshake instead of a wall-clock comparison (#447)

**Issue:** #447 — "A wall-clock comparison stands in for a causal ordering, and
one millisecond reddens CI"
**Branch:** `fix/447-race-ordering-assertion`
**Date:** 2026-09-05

---

## 1. What the issue says, and what is actually true

`src/services/template-room-race.test.ts:91` asserts a causal ordering by
comparing two wall-clock samples taken inside two racing promise callbacks:

```ts
}).then(()   => { resumeCommittedAt = Date.now(); });   // :71
 .finally(() => { archiveSettledAt  = Date.now(); });   // :78
expect(archiveSettledAt).toBeGreaterThanOrEqual(resumeCommittedAt);
```

**The issue's diagnosis is right, its provenance is right, and its suggested fix
is not sufficient.** Each of the three is established below.

### 1.1 Provenance — confirmed exactly as written

```
git log --oneline --follow -- src/services/template-room-race.test.ts
  d4c5ce56 refactor: the simplifier round … (issue 272)
  fc9c7461 test: the archive that used to slip past door 3 is refused, and waits (issue 272)

git log -L 88,92:src/services/template-room-race.test.ts --oneline
  fc9c7461
```

Introduced by `fc9c7461`, touched since only by `d4c5ce56`. No correction
needed.

### 1.2 The census — one instance, not a family

The genus is *two independently-sampled wall clocks compared to infer causal
order*. What distinguishes it syntactically is assignment to an **outer-scope**
variable from inside a callback — `x = Date.now()`, not `const x = Date.now()`,
because the sample has to outlive the callback to be compared against another
one. So the declaration forms are excluded:

```
grep -rn '= Date.now()' src --include='*.test.ts' \
  | grep -vE '(const|let|var)[[:space:]]+[A-Za-z0-9_$]+[[:space:]]*=[[:space:]]*Date\.now\(\)'
```

The bare `grep -rn "= Date.now()"` half of that pipeline returns **50** lines
and is not a census of anything — almost all of them are `const uniqueSuffix =
Date.now()` or `const startedAt = Date.now()`. The filter is what makes the
number mean something.

Run at `0cbb32a1` (before this branch) it returns three lines; run after the
fix it returns one. The arithmetic is `3 − 2 = 1`:

| Hit | Verdict |
|---|---|
| `template-room-race.test.ts:71` | the genus (this issue) |
| `template-room-race.test.ts:78` | the genus (same assertion's other half) |
| `class-generator.test.ts:1910` | **not** the genus — `settledAt − startedAt` on one timeline, asserted `>= 300` against a 400 ms hold: a duration with a 100 ms cushion |

So this is a single-site defect. `#441` is unaffected.

The limit of this command is the same one §4.2.2 states for the tier census: it
finds the genus as *currently spelled*. A future sample taken with
`performance.now()`, or stored on an object field rather than a bare variable,
would not match it.

### 1.3 What actually makes it flake — measured, not reasoned

A 25-iteration instrumented probe recorded, per iteration, the callback order,
`Date.now()` at each callback, `performance.now()` (monotonic) at each, and the
archive's state sampled from *inside* the still-open transaction. Machine load
average was 12–21 on 10 cores, so this was not an idle run.

```
callbackInversions=0   dateTies=1   clockWentBackwards=0   proposedSampleWrong=0
perfDelta (archive settles after resume commits): 0.674 – 4.749 ms, median ≈ 1 ms
dateDelta: 0 once, 1 in 20 of 25, 2–5 otherwise
```

**The finding is the margin, not the direction.** The two callbacks are
separated by roughly *one millisecond*, and the assertion compares
`Date.now()`, which is wall clock and therefore not monotonic. Any backwards
adjustment inside that ~1 ms window flips the comparison. A tie
(`dateDelta = 0`) already occurred once in 25 local iterations, and `>=` is
what currently lets a tie pass.

The issue's own wording — that the archive's `.finally` "can execute in an
earlier millisecond tick … even when the archive genuinely settled later" —
blurs two distinct mechanisms. If the callback truly executed earlier, the
order inverted, and an order-based assertion fails too. The probe found **zero
order inversions in 25 iterations under load**, which points at the clock, not
the scheduler.

### 1.4 Why the suggested fix is not enough

The issue proposes pushing labels into an array and asserting the sequence.
That removes the clock — a real improvement — but it keeps a margin of about
one millisecond of callback-scheduling slack, and it inherits a second, larger
weakness the current assertion also has:

**Neither assertion can tell "the archive waited" from "the archive never
raced at all."** If a future edit lets the resume commit *before* the archive
is issued, the archive still fails the CHECK, the error assertions still pass,
the room is still open, the rule is still active — and both the `>=`
comparison and the order array **pass**. The test would look like it guards a
race while guarding nothing. That is precisely the "guard that cannot fail"
the issue warns about, reintroduced by its own suggested fix.

---

## 2. The mechanism being tested

`prisma/migrations/20260827120000_template_room_archive_invariant/migration.sql`
enforces the invariant with mirrored columns and a CHECK, not a trigger:

```sql
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room"
  CHECK (NOT ("ruleLive" AND "roomArchived"));
```

Both mirrors are maintained by `ON UPDATE CASCADE` on composite foreign keys.
So:

- the **resume** flips `ScheduleRule.isActive`, which changes the generated
  column `live`, so the cascade rewrites `ClassTemplate.ruleLive` — taking that
  row's lock and holding it for the transaction;
- the **archive** flips `TeacherRoom.isArchived`, whose cascade must rewrite
  `ClassTemplate.roomArchived` — *the same row*.

The archive therefore blocks in Postgres until the resume commits, and only
then does the CHECK refuse it. **The property is a row-lock wait**, which is a
causal fact with a wide observable window — not a 1 ms clock comparison.

---

## 3. Design

Replace the inferred ordering with an **observed** one, using the handshake
this repo already uses in `src/services/update-class-lock-order.test.ts`, whose
docblock rejects sleeps for exactly this reason: *"Both handshakes here are
driven by observed state — a promise the completion resolves once it holds its
locks, and `pg_stat_activity` for the reschedule's backend actually waiting on
one."*

Three connections, matching that file:

- `a` — the resume; holds the transaction.
- `archiveDb` — `singleConnectionClient()`, so `pg_backend_pid()` read once
  identifies the backend every later statement runs on. Required because
  `pg_stat_activity` is database-wide and `unit` runs its files in parallel.
- `probe` — reads `pg_stat_activity`; must never block.

Two gates replace the two sleeps:

1. the resume signals **after** its update returns, so the `ClassTemplate` lock
   is provably held before the archive is issued;
2. the poll loop signals the resume it may commit, once the archive's backend is
   **observed** at `wait_event_type = 'Lock'`.

```ts
const resume = a.$transaction(async (tx) => {
  await tx.scheduleRule.update({ where: { id: ruleId }, data: { isActive: true } });
  signalLockHeld();
  await resumeMayCommit;
}, { timeout: 20_000 });

await lockHeld;
const archive = archiveDb.teacherRoom.update({ ... })
  .catch((e: unknown) => { archiveError = e; })
  .finally(() => { archiveSettled = true; });

// Every iteration is a database round trip, not a timer, and the loop cannot
// spin for ever: it exits on whichever of the two happens.
while (!archiveSettled) {
  const [w] = await probe.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_stat_activity
     WHERE pid = ${archivePid} AND wait_event_type = 'Lock'`;
  if ((w?.n ?? 0) > 0) { observedWaiting = true; break; }
}
releaseResume();

expect(observedWaiting).toBe(true);
```

If the archive never blocks, it settles, the loop exits on `archiveSettled`,
`observedWaiting` stays `false`, and the failure message names the property
rather than reporting two integers one apart.

### 3.1 Two consequences worth stating

- **No clock and no sleep remain in the assertion path.** The margin is not
  widened, it is removed.
- **The resume's lock hold drops from 1500 ms to tens of milliseconds**, because
  it now waits for an observation rather than a fixed sleep. That makes the file
  a quieter neighbour in the parallel `unit` tier, not a louder one — see §4.
  Measured on the rewritten file: `tests 76ms`–`104ms`, against the ~2 s the two
  sleeps (500 ms + 1500 ms) previously guaranteed. The file therefore stops
  being a kind‑1 lock holder and needs no tier move of its own.

### 3.2 Proof that the guard bites — measured

A prototype was run against three worlds. All three behaved as designed:

| World | `observedWaiting` | refusal still correct? | verdict |
|---|---|---|---|
| GREEN — resume holds, archive races | `true` | yes | passes |
| RED‑M1 — resume commits *before* the archive is issued | `false` | **yes** (`isCheckViolationOn` true, room open, rule active) | **only the new assertion fails** |
| RED‑M2 — resume touches a non-cascading column, so no lock is held | `false` | no error at all; `roomArchived: true` | archive slips past, as in #272 |

RED‑M1 is the isolating case and the reason for this design: every other
assertion in the file passes, and the current `>=` comparison and the issue's
order array both pass it too.

---

## 4. The second half: the tier census (in scope by decision)

`vitest.config.ts` keeps `LOCK_CONTENTION_TESTS` and ships a re-derivation
command for it at line 49:

```
grep -rln 'not.toMatch(/[^/]*\(40P01\|55P03\)' src --include='*.test.ts'
```

followed by the claim, at line 51: **"Every hit belongs on this list."**

### 4.1 What is wrong with it

Run verbatim it returns exactly three files: `db-locks-lock-order.test.ts`,
`template-lock-order.test.ts`, `gdpr-lock-order.test.ts`. The claim "every hit
belongs on this list" is **true** — all three are on it.

The defect is the converse, and it is in the comment, not the command. The
comment introduces three files as *"all three are the SECOND kind: each asserts
a staged race ends in neither `40P01` nor `55P03`"* — naming
`db-locks-lock-order.test.ts`, `invitations-lock-order.test.ts` and
`gdpr-lock-order.test.ts`. But `invitations-lock-order.test.ts` asserts the
**opposite**:

```
src/services/invitations-lock-order.test.ts:283
  expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
src/services/invitations-lock-order.test.ts:396
  expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
```

It asserts the staged race **does** deadlock. The description is wrong, and the
`not.toMatch`-only command is blind to it as a direct consequence — which is
why a file the comment calls second-kind is absent from the command's output
and nobody noticed.

### 4.2 The corrected predicate

The property that makes a file tier-unsafe on the assertion side is not
"asserts no deadlock". It is:

> **the file asserts on *which* lock-contention outcome a staged race
> produces — in either direction.**

Both directions are wrecked by a parallel neighbour's lock noise; they merely
fail differently. Noise adds waits, so it pushes a *negative* assertion
(`not.toMatch(/40P01/)`) toward failing, and a *positive* one
(`toMatch(/40P01/)`) toward passing for the wrong reason.

Widened command:

```
grep -rlE '(not\.)?toMatch\(/[^/]*(40P01|55P03|deadlock|lock timeout)' src --include='*.test.ts'
```

Ten hits. The arithmetic: `10 = 4 already on LOCK_CONTENTION_TESTS + 2 already
serial via SWEEP_TESTS + 4 needing a verdict`.

The four needing a verdict were adjudicated by reading each one. Three belong;
one does not:

| File | What it asserts about contention | Also holds locks? | Verdict |
|---|---|---|---|
| `src/lib/db-locks.test.ts` | `NOWAIT` **presence** probes on rows it owns (`:588`, `:636`), with `'free'` counter-assertions (`:587`, `:638`) | no — every holder is handshake-gated and sub-second | **legitimately off** — a presence probe answers in one round trip and has no timing threshold |
| `src/services/class-template-lifecycle.test.ts` | census hits assert a timeout **does** occur (`:2446`, `:3110`), but `:1097`, `:2287–2296` and `:3037` assert contention does **not** | yes — 0.3 s to ~2 s, in four separate tests | **belongs** |
| `src/services/gdpr.test.ts` | `:632` asserts a timeout does occur; `:479`, `:551` (×5 via `it.each`), `:771`/`:788` and `:870` assert an **absence** of 55P03/40P01 | yes — ~9 s across six staggered `Class … FOR UPDATE` transactions (`:686–800`), plus a 4 s and six 900 ms holds | **belongs** — the strongest case |
| `src/services/waitlist.test.ts` | four assert a timeout **does** occur (`:596`, `:966`, `:1308`, `:2177`); `:1802` asserts one does **not** | yes — four 3 500 ms held row locks (`:579`, `:949`, `:1291`, `:2156`) | **belongs** — a noise *source* and a noise *victim* in one file |

**A premise of mine was wrong here, and the sweep corrected it.** I read
`waitlist.test.ts`'s `if (!outcome.ok) expect(outcome.err).toMatch(/55P03/)` as
a vacuous conditional tolerance. It is not: it is a TypeScript narrowing guard
sitting immediately after an unconditional `expect(outcome.ok).toBe(false)` at
`:595`, so the file does assert the timeout occurs.

### 4.2.1 A second false claim, in two places

`vitest.config.ts:69` justifies splitting `gdpr-lock-order.test.ts` out rather
than moving `gdpr.test.ts` wholesale with: *"that file runs in ~26s and exactly
one of its tests reads lock timing"*. The same sentence is duplicated at
`src/services/gdpr-lock-order.test.ts:76`.

**It undercounts by roughly four.** `gdpr.test.ts` stages lock races at `:453`,
`:519` (an `it.each` over five statuses), `:591`, `:686` and `:804` — and three
of those assert the *absence* of 55P03/40P01, including a hand-built AB‑BA
deadlock probe at `:804` that is `template-lock-order.test.ts`'s exact shape
written as `toBe('returned')` rather than `not.toMatch(/40P01/)`. Both copies
of the sentence are corrected by this branch; the `+2.5s extracted` cost figure
beside it was measured against the undercount and is restated from the new
measurement.

### 4.2.2 Why the census missed all of it

The single root cause, and it is the one worth writing down: **the shipped
command reads syntax, and the thing it needs to find is semantic.** An
assertion that a staged race came out a particular way is written in this repo
as any of

```
not.toMatch(/40P01|deadlock detected/)      // what the command matches
toMatch(/40P01|deadlock/i)                  // invitations-lock-order.test.ts
toBe('returned')                            // gdpr.test.ts:479, :870
toEqual({ ok: true, … })                    // class-template-lifecycle.test.ts
expect(elapsedMs).toBeGreaterThan(5_000)    // gdpr.test.ts:788
```

Only the first is findable by a grep for `not.toMatch`. A widened regex catches
the second and improves matters; it cannot catch the last three, and no regex
will. That is the honest limit of the technique, and the comment must say so
rather than promise a census it cannot deliver.

### 4.2.3 The cost of the obvious fix, measured

Moving the three files onto `LOCK_CONTENTION_TESTS` wholesale was measured
before being rejected:

```
npx vitest run --project unit --no-file-parallelism \
  src/services/gdpr.test.ts src/services/waitlist.test.ts \
  src/services/class-template-lifecycle.test.ts
    → 3 files, 151 tests, 50.57s

npx vitest run --project unit-sweeps        (the serial tier as it stands)
    → 17 files, 167 tests, 50.19s
```

`50.19 + 50.57 = 100.8s`, i.e. **+101%** on the serial tier. The config already
declined exactly this trade for `gdpr.test.ts` alone at +92%.

**Read that as the step, not the job.** `.github/workflows/ci.yml`'s `test-unit`
job runs `--project unit` and then `--project unit-sweeps` as two steps, so both
tiers are already on the same critical path. What a whole-file move actually
costs is therefore not the +101% by itself: it is that all 151 tests in those
three files stop running in parallel with their neighbours and start running one
after another. Extraction moves only the contention tests and leaves the
remainder in the parallel pool, which is why it is the cheaper answer as well as
the more accurate one.

### 4.3 Why "every hit belongs" cannot survive the widening

A widened command necessarily admits conditional tolerances of the form
`if (!outcome.ok) expect(err).toMatch(/55P03/)`, which assert nothing on the
happy path and are tier-safe by construction. So the comment's claim has to
change shape: from a membership proof to a triage instruction — **every hit
needs a verdict, not every hit belongs**. That is weaker, and it is the honest
form; a command that reads syntax cannot decide a semantic question.

---

## 4.4 The decision: extract, do not move

Rather than move three large files into the serial tier at +101%, the
lock-staging tests are **extracted** into `*-lock-order.test.ts` siblings and
only those siblings are serialized. This is the shape this project has already
used twice — `gdpr-lock-order.test.ts` and `class-lifecycle-tier-guard.test.ts`
were both split out of larger files for exactly this reason — so it introduces
no new pattern.

- `src/services/gdpr.test.ts` → append to the **existing**
  `src/services/gdpr-lock-order.test.ts`.
- `src/services/waitlist.test.ts` → new
  `src/services/waitlist-lock-order.test.ts`.
- `src/services/class-template-lifecycle.test.ts` → new
  `src/services/class-template-lifecycle-lock-order.test.ts`.

The two new siblings join `LOCK_CONTENTION_TESTS`; the three source files stay
in the parallel tier, and become genuinely tier-safe rather than merely
unlisted.

---

## 5. What this spec does not do

- It does not change the invariant, the migration, or any production code. Only
  tests and `vitest.config.ts` are touched — no file under `src/app`,
  `src/services/*.ts` (non-test), `src/lib/*.ts` (non-test) or `prisma/`.
- **#441 is unaffected** — same genus of "an assertion resting on something
  nothing guarantees", different mechanism, different project.
- It does not attempt a compiler tether for `LOCK_CONTENTION_TESTS` membership.
  That is a real option (a marker in each file's header plus a test asserting
  the marker set equals the list) and is recorded here as a decision
  deliberately not taken in this PR, because it is a design question of its own
  rather than a leaf.

## 6. Environment note (not a finding against main)

The shared `ethical_yoga_test` database currently has
`20260905120000_class_room_archive_invariant` applied, which is **not** in this
branch (its last migration is `20260903195051_student_signup_purposes`). It
comes from the `issue-339-class-room-archive` worktree and renames
`Class_teacherRoomId_fkey` to `Class_teacherRoomId_roomArchived_fkey`.

That makes three tests fail locally in the `unit` tier —
`room-archive.test.ts` (2) and `room-deletion.test.ts` (1) — **on this branch
with no changes applied**. They are pollution from an unmerged branch, not
defects, and this PR neither causes nor fixes them.

The same branch leaks through a **second** vector. This worktree's own
`node_modules` contains only `.cache` and `.vite`; `@prisma/client` resolves up
to the main checkout's shared copy, which was generated from a schema carrying
a `live` field this branch's `prisma/schema.prisma` does not define. So
`npx tsc --noEmit` reports one error, at
`src/components/schedule/class-list.test.tsx:86`, for the same reason.

Neither was corrected here: regenerating the client would write into the shared
`node_modules` and break the `issue-339-class-room-archive` worktree's own
typecheck. **CI is the authoritative signal for both** — it installs and
generates per run, against a per-run database. Local evidence in this PR is
therefore scoped to the files it touches, each of which is clean.
