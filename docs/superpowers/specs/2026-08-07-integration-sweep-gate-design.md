# The integration suite is not re-runnable, which is why nobody runs all of it

**Issue:** #185 — 20 of 26 integration files are unobserved on any given branch,
and a `beforeAll` throw reports as 'skipped'
**Spun out of:** #170 / PR #184
**Date:** 2026-08-07

## The problem, stated after measuring it

The issue reads as a missing gate. It is not. CI already runs every integration
file, `npm run lint` and `npm run typecheck` against the pull request's merge
result, and both jobs are required checks. The gate the issue asks for exists.

What does not exist is a way to get that verdict **before** pushing — and the
reason it does not exist is smaller and more concrete than "no one built it."
Eight unauthenticated requests in `tests/integration/` share one per-IP rate-limit
budget, and one pass spends it. So the suite cannot be run twice in an hour. So
the project wrote a rule forbidding the whole-project run. So plans hand-listed
integration files. So 20 of 26 went unobserved on #170.

The chain runs bottom-up, and the fix belongs at the bottom of it. Restore
idempotency and every consequence above it dissolves without new machinery.

## What was measured

### The suite is 26 files, and CI runs all of them

`npm test` is bare `vitest run` with no `--project` filter, so it collects all
three projects.

| project | glob | files |
|---|---|---|
| `unit` | `src/**/*.test.ts` | 46 |
| `components` | `src/components/**/*.test.tsx`, `src/app/**/*.test.tsx` | 32 |
| `integration` | `tests/integration/**/*.test.ts` | 26 |
| | **total** | **104** |

CI run `31213531903` (branch `fix/170-email-normalisation`, green) reported:

```
Test Files  104 passed (104)
```

46 + 32 + 26 = 104. The counts match exactly, so every integration file ran.

**This falsifies the issue's "CI is not currently a backstop for this."** The
issue flagged that claim as one to confirm rather than assert; confirmed, and it
is the other way round.

### CI already runs the whole tree against the merge result

Both jobs logged the same checkout:

```
HEAD is now at 883f253 Merge d21115810c9c58cb4135226ca9892bb73870fe7b
                       into 4d96ee4e69e1797fc10877f4e20768274a0aa456
```

`checks` runs `npx prisma validate`, `npm run typecheck`, `npm run lint`.
`test` runs migrations, build, `npm test`, then Playwright. Per the comment at
the head of `.github/workflows/ci.yml`, `checks` and `test` are both required
status checks on `main`.

It demonstrably works on the exact defect the issue's comment describes. Run
`31213207079`, same branch, one commit earlier:

| job | conclusion | failing step |
|---|---|---|
| `checks` | failure | `Lint` |
| `test` | success | — |

That is the orphaned `notifyInvitee` import, caught whole-tree, merge blocked.
**So the comment's requested acceptance — one gate running the sweep and lint
and typecheck against the merge result — is already satisfied.** It is two jobs
rather than one, but both gate the merge, so it is one gate in the only sense
that matters.

### A `beforeAll` throw is not silent

The issue's second acceptance criterion rests on a `beforeAll` failure being
reportable only as "N skipped". Measured directly, with a fixture planted in
`tests/integration/` that throws in `beforeAll` over three `it`s:

```
 FAIL  |integration| …/zz-scratch-beforeall.test.ts > scratch
Error: SCRATCH: simulated fixture failure

 Test Files  1 failed (1)
      Tests  3 skipped (3)
```

Exit code: **1**.

The word "skipped" appears only in the per-*test* tally. The per-*file* line says
`1 failed`, a `FAIL` block names the file and the throw, and the process exits
non-zero. **No automated gate can miss this.** What went wrong on #170 was a
human reading `3 skipped` and filing it as a deliberate `it.skip` — a
presentation problem for a reader, not a detection problem for a gate.

This spec therefore adds no reporter configuration. There is nothing to fix.

### The suite is not idempotent, and the issue is right about that

Two full sweeps, each file run by explicit path, back to back:

| pass | result | failures |
|---|---|---|
| 1 | 26 passed, 0 failed | — |
| 2 | 24 passed, **2 failed** | `auth-email-case.test.ts`, `signup-api.test.ts` |

Every failure in pass 2 is a rate-limit refusal:

```
AssertionError: expected 429 to be 200
AssertionError: expected 429 to be 201
```

Exactly the two files the issue names. The claim holds.

**A correction I owe the record:** reading `clientIp()` — which returns
`'unknown'` when no `x-forwarded-for` or `x-real-ip` is present, and whose
callers skip the per-IP check entirely in that case — I first concluded the
per-IP limiters could not fire against a direct `fetch` to `localhost`. The run
disproved it. Next populates the forwarded address, so the limiters do fire.
The inference was from one reading; the measurement is ground truth.

### Why it is not idempotent: exactly zero headroom

Three routes rate-limit per IP. Counting every call site in `tests/integration/`:

| endpoint | per-IP limit | window | call sites | headroom |
|---|---|---|---|---|
| `POST /api/auth/student-signup` | 5 | 1 h | **5** | **0** |
| `POST /api/teachers` | 3 | 1 h | 2 | 1 |
| `POST /api/auth/magic-link/send` | 10 | 15 min | 1 | 9 |

One sweep spends the `student-signup` budget 5 of 5. The sixth call — which is
`auth-email-case.test.ts` at the start of the next sweep — is refused. The
arithmetic predicts the observed failure exactly.

**This is worse than a re-run problem, and the issue does not name it.** With
zero headroom, adding a *single* new `student-signup` test anywhere under
`tests/integration/` makes the **first** sweep fail — locally and in CI — with a
429 raised in whichever file happens to run last, not in the file that caused it.

### The rate-limit rule names the wrong file

`.claude/skills/solve-issue/SKILL.md:223`:

> **Never run `npx vitest run --project integration` without a file path.** One
> file in that project is IP rate-limited and the whole-project run trips it.

Both halves are wrong.

`students-api.test.ts` does hold three `429` assertions, but every one of them
keys on `students:${teacherId}` via `checkStudentWriteLimit`, and each creates a
fresh `Teacher` first — the fixture's bio is literally `'Fresh limiter bucket'`.
A per-teacher bucket for a teacher that did not exist a moment ago can neither
be poisoned by another file nor poison one. Sequencing that file "last or alone"
buys nothing. The files that actually share a budget are the two the sweep
found, and they share it through the per-*IP* limiters, which
`students-api.test.ts` never touches.

And the whole-project run is not forbidden in practice: CI performs it on every
pull request, via `npm test`.

The rule is nonetheless the proximate cause of the issue's headline finding. It
told plan authors to hand-list integration files, and a hand-written list of 6
leaves 20 unobserved.

### The per-IP limiters have no test coverage

No test in the repository asserts a per-IP 429. Deleting the `checkRateLimit`
call from `POST /api/auth/student-signup` breaks nothing. The budget is consumed
entirely by tests that are not testing it and do not want it.

### `docs/test-database.md` states an invariant the suite does not hold

Line 108, in the verification steps for the test-database split:

> Verify: `npm test` twice locally (second run proves idempotency)

That is the right standard and it is already project policy. It is currently
false. Line 52 of the same file also still describes the `integration` project as
"(17 files)"; it is 26.

## The design

Four changes. The first is the only one that is load-bearing; the rest follow
from it.

### A. Give every rate-limited request its own IP bucket

Add to `tests/helpers.ts`:

```ts
/**
 * A unique `x-forwarded-for` so a request lands in its own per-IP rate-limit
 * bucket. …
 */
export function freshIp(): Record<string, string>
```

It returns an `x-forwarded-for` header carrying a random `10.x.y.z` address —
private range, so it reads as obviously synthetic to anyone who finds one in a
log. `clientIp()` takes the first comma-separated entry, so a single address is
enough; the value only has to be unique, but looking like an address keeps the
mechanism legible.

Spread it into the headers of all **8** call sites that reach an IP-limited
endpoint, which fall in two files:

| file | `student-signup` | `POST /api/teachers` | `magic-link/send` | total |
|---|---|---|---|---|
| `signup-api.test.ts` | 4 | 2 | 0 | 6 |
| `auth-email-case.test.ts` | 1 | 0 | 1 | 2 |
| | 5 | 2 | 1 | **8** |

Applied uniformly to all three endpoints, including `magic-link/send` where
there is no pressure today, because a uniform rule is what stops the tripwire
coming back.

After this, the budget is no longer shared, the headroom column stops existing,
and `npm test` twice is green twice.

**Explicit spread at each site, not a wrapped `fetch`.** The sites stay
greppable and a reader sees at the call why the header is there. A global wrapper
would hide the mechanism in exactly the way that let it go unnoticed for a year.

### B. Cover the limiter that A now bypasses

One new test, in `signup-api.test.ts`, pinning a *single* fresh IP and walking
the budget: five `student-signup` requests accepted, the sixth `429`. Because
the address is generated per run, the test owns its own bucket and is idempotent
by construction — the same property A gives everything else.

This is the only test in the repository that would fail if the per-IP limiter
were removed. Its guard is proved by deleting the `checkRateLimit` call from the
route, recording the failure text, and restoring it.

### C. `npm run verify`

```json
"verify": "npm run typecheck && npm run lint && npm test"
```

Sequential and fail-fast: typecheck (~3 s) and lint (~10 s) are cheap and catch
the whole-tree defects that per-diff review structurally cannot, so they run
before the suite rather than after it.

This is the local equivalent of both CI jobs. It is deliberately **not** wired
into CI — CI's split between a fast static job and a database-backed one means a
type error reports in about two minutes instead of after a full build, and
collapsing them into one script would give that up for nothing.

Its guard is proved by breaking an integration fixture, confirming
`npm run verify` exits non-zero and names the file, and restoring.

### D. Correct the record

| artifact | correction |
|---|---|
| `.claude/skills/solve-issue/SKILL.md` | Replace the rate-limit rule. The whole-project run is safe; `npm run verify` before pushing; stop hand-listing integration files in plans. |
| `docs/test-database.md:52` | Drop the "(17 files)" count rather than updating it — `ci.yml` already argues, for the type-pin list, that a count written into prose is accurate for one branch. |
| `README.md:64` | Add the `npm run verify` row. |
| issue #185 | Comment recording the two false premises and the zero-headroom finding. |

## What this does not do

- **No reporter or `beforeAll` machinery.** Measured above: vitest already exits
  1 and prints `FAIL`. There is no detection gap to close.
- **No change to CI.** It already does what the issue and its comment ask for.
- **No change to the limits themselves.** 5/hour and 3/hour are production
  policy; this spec changes only which bucket the *tests* land in.
- **Does not make the e2e suite idempotent.** Playwright was not measured here.
  `tests/e2e/invitations.spec.ts` mentions `student-signup` only in a comment, so
  it consumes none of this budget, but no broader claim about e2e is made.

## Acceptance

- [ ] `npm run verify` exists and runs typecheck, lint, and the full test suite.
- [ ] Two consecutive `npm test` runs are green, restoring the invariant
      `docs/test-database.md:108` already claims. This is the headline check —
      it currently fails, so it cannot pass vacuously.
- [ ] A test asserts the per-IP 429 on `student-signup`, and is proved to fail
      when the limiter is deleted from the route (error text recorded, restored).
- [ ] `npm run verify` is proved to go red on a deliberately broken integration
      fixture (error text recorded, restored).
- [ ] The `solve-issue` rate-limit rule, `docs/test-database.md`, `README.md` and
      issue #185 all reflect what was measured.

## References

#170, PR #184 · `.github/workflows/ci.yml` · `src/lib/rate-limit.ts` ·
`tests/integration/{auth-email-case,signup-api,students-api}.test.ts` ·
`docs/test-database.md`
