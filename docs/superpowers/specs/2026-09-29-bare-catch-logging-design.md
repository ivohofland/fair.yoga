# Log the discarded transport error; lint against new bare catches — design

Issue #692. Per-site census: `2026-09-29-bare-catch-census.md` (same directory).

The user asked for this issue to run end-to-end without interaction, so every
gate below was decided by the implementing session; each decision states the
option not taken and why.

## What the issue said, and what was measured

| Issue claim | Measured |
|---|---|
| "about 60" `catch {` sites outside tests | **78**, by AST (`CatchClause[param=null]` via ESLint, re-derivation command in the census). The issue's own grep reports 80 today; the AST count is the one to trust, since a text grep also matches comments. |
| Three groups | Held, plus a fourth: **2 sites (O)** in `studio-template-form.tsx` / `template-form.tsx` that are payload-shape probes, whose `try` also wraps `anyBlocked`, the message builders, `setSuccess` and `router.push`. |
| "About 40 fetch-failure catches" (group 1) | **48** transport catches (T) — 46 in `src/components` + `src/app`, 2 in `src/lib/room-search.ts` (a client-imported helper). |
| Group 2, correct as bare | **24** (B) as the census classified them: 10 in the lint scope (`src/components`, `src/app`), 14 in `src/lib`. This design reclassifies one in-scope B, census #14 (`booking-name-step.tsx`, an unreadable body on a 200), as T — its twin #67 in `room-search.ts` is T, and the repo already logs this case elsewhere (`room-create-step.tsx`, `class/new/page.tsx`). |
| Group 3, "already log but don't bind" | **4** (L): three `log.error({ timeZone }, …)` fallbacks in `src/lib/timezone.ts`, one in `src/lib/finish-window.ts`. |
| "the `try` often wraps more than `fetch`" | True for almost every T site — `res.json()`, `readError`, setters. Only 7 are fetch-only (#9, 12, 13, 34, 39, 66, 67). The sites wrapping *navigation or DOM work* number 30: 29 with `router.push`/`router.refresh`/`closePanel`, one (#6, `data-and-deletion.tsx` export) with a DOM download. |

Arithmetic (census): 48 T + 24 B + 4 L + 2 O = 78. In lint scope: 46 T + 10 B + 2 O = 58.
After this design's reclassification: 49 T + 9 in-scope B, and the 2 O sites lose their catch entirely (decision 3).

Not in the census, found at spec review, and in scope for the same reason:

- **Six transport catches that already bind and log, in another format** —
  `notifications-form.tsx`, `tier-form.tsx`, `name-form.tsx`,
  `class-edit-form.tsx`, `studio-class-edit-form.tsx` (`'… save failed', err`)
  and `student-directory.tsx` (`'[student-directory] fetch failed', { err }`).
  Re-derive: `grep -rnE "console\.error\(" src --include='*.tsx' --exclude='*.test.*' | grep -v "request failed', {"` and read each hit.
- **Three promise-method handlers that drop the error** —
  `add-walk-in.tsx`'s students and invitations loads (`.catch(() => …)`; their
  `.then` also throws `new Error('students 500')` into it) and
  `profile-setup-form.tsx`'s resend `.catch(() => false)`. A
  `CatchClause[param=null]` selector cannot see these.

Also measured, and load-bearing for the design:

- **`@typescript-eslint/no-unused-vars` already rejects an unused `catch (err)`**
  (probed: `'err' is defined but never used`) — `caughtErrors` defaults to
  `'all'` and this repo sets no `caughtErrorsIgnorePattern`. The bare catch is
  today the *only* way to write a catch that ignores its error. Ban it, and every
  catch in scope must either *touch* its error or carry a disable with a reason.
  "Touch" is all lint can force: `catch (_err)` is also rejected, but
  `void err;` or `setError(String(err))` pass. That the touch is a
  `logRequestFailure` call is convention, held by review.
- **Flat-config replacement.** `eslint.config.mjs` already has a
  `no-restricted-syntax` block over `src/**` (the `teacherStudent` write guard
  and `classLockCastSelector`). A later block setting that rule for overlapping
  files replaces the earlier options — a `src/components` block carrying only
  the new selector would silently switch off both existing guards there.
- **Nothing fails a test on a stray `console.error`** (no `onConsoleLog`, no
  fail-on-console package; `tests/setup/components.ts` sets up jest-dom and a
  router mock only). Logging only breaks tests asserting exact console output.
- **21 hand-written `console.error('[tag] request failed', { … })` lines**
  already exist (`grep -rnE "console\.error\('\[[a-z-]+\] request failed', \{" src --include='*.ts' --include='*.tsx' --exclude='*.test.*' | wc -l`).

## Decisions

### 1. The helper: `logRequestFailure(tag, context, err)` in `src/lib/client-errors.ts`

Emits exactly `console.error(\`[${tag}] request failed\`, { ...context, err })` —
byte-identical to the 21 hand-written lines, so their existing test assertions
(e.g. `delete-room-button.test.tsx`) prove the conversion changed nothing.

`client-errors.ts` is where `readError` lives: client-safe, imports only
`api-error-codes`. Not a new module, because that is where a reader looking
for "how does a client component report a failed request" already goes.

Not taken: a structured reporter (a future client error sink). The helper is
the seam one would plug into; building the sink is not this issue.

**The 21 hand-written lines and the six other-format transport logs convert
to the helper**, so every client transport-failure log has one format. The six
other-format ones have tests asserting the old string; those assertions move
to the helper's line. Their `'… save failed (HTTP)', status` siblings are
refusals, not transport failures, and stay. Out: `[verify]`'s positional-`err`
line (a classified rejection, #452, not this shape). `[onboarding-skip]`'s
`{ step, status }` line is a refusal wearing the "request failed" words; its
message becomes `'[onboarding-skip] refused'` (the `mark-notification-read.ts`
convention), so that `request failed` names transport failures only; its
sibling `{ step, err }` line converts.

**Context must never carry PII** — email, names, the magic-link `code`,
privacy choices, the IBAN. The census's "Ctx vars" column names the safe
identifiers per site and flags 11 sites with PII in scope. The type narrows
what it can: `context` is
`Readonly<Record<string, string | number | boolean | null | undefined>> & { err?: never }`
— primitives only, and no caller-supplied `err` to shadow the real one. A type
cannot tell an ID from an email, so the rule also lives beside the helper in
`docs/technical-architecture.md`. `err` itself can carry response fragments (a
V8 `SyntaxError` from `res.json()` quotes the body's start) — harmless in the
user's own console, a consideration for whoever plugs a sink into this seam.

**Tags.** One tag per catch, from the file name, as the existing lines do
(`[delete-room-button]`). A file with more than one T catch suffixes the action
(`booking-name-step-resend`), so every tag names one catch. Existing tags keep
their current spelling. The census "tag" column's free-form suffixes
(`[class-new] rooms load failed`) are superseded by this rule — the helper's
message suffix is fixed.

### 2. The lint tether, scoped to `src/components` and `src/app`

`no-restricted-syntax` with selector `CatchClause[param=null]`, in a new config
block over `src/components/**` and `src/app/**` (tests excluded) that **repeats
the two existing `src/**` selectors** — hoisted to named constants so the two
blocks cannot drift, exactly as `classLockCastSelector` already is.

A second selector in the same block catches the promise-method form:
`CallExpression[callee.property.name='catch'] > :function:matches([params.length=0], [params.0.name=/^_/])` —
a `.catch(() => …)` handler that takes no parameter, or one named `_…`
(unused-arg names starting `_` pass `no-unused-vars` here via `argsIgnorePattern`). Its hits are measured
before landing; the one known server hit
(`src/app/api/registrations/[id]/route.ts`, `.catch(() => -1)`, whose comment
already calls the dropped error a known gap) takes a disable with that reason.

Not taken:
- **The shared `src/**` block.** It would reach `src/lib`'s 14 B sites —
  tooling and server probes (git, lock files, parse probes) plus
  `iana-timezone.ts`, a client-reachable `Intl` probe — all correct as bare:
  14 disables for a rule aimed at client transport failures. The price is that
  the client helpers in `src/lib` (`room-search.ts`, `use-payment-actions.ts`,
  `mark-notification-read.ts`) sit outside the tether; this PR converts them
  once.
- **A local plugin alias** (register the core rule a second time under
  `local/no-restricted-syntax` via `builtinRules` from
  `eslint/use-at-your-own-risk`), which would give the ban its own rule id
  and need no repetition. Rejected: an import from an explicitly unstable
  internal path is a worse trade than two hoisted constants.

Server code in `src/app/api` falls under the rule too; a bound catch there
logs through pino (`log.error({ err }, …)`), never the console helper — the
rule's message says so.

The in-scope B sites get
`// eslint-disable-next-line no-restricted-syntax -- <reason>` as the last
line of the `try` block, directly above `} catch {`. (A trailing
`eslint-disable-line` on the catch line reads better but does not survive:
Prettier moves it into the catch block, off the line it must disable —
measured at plan review.) Where an explanatory comment
already sits in the catch, the reason absorbs it — one comment, not two. The
directive also silences the other two selectors on that one line; a `catch`
line holds neither a `teacherStudent` write nor a cast.

The existing config comment explaining why the protections share one block
opens with a prose count ("Two unrelated …") and says they share one block;
both stop being true. It is rewritten to name the hoisted constants and state
the replacement rule once, with no count.

### 3. The two O sites: replace the `try` with a guard

`studio-template-form.tsx` and `template-form.tsx` probe a parsed 201 body.
The `null`-payload path lands in the catch **by design** and is asserted
(`console.warn(msg, null)`, `console.error` never called). Logging there as a
request failure would be wrong. What *is* wrong today is that
`anyBlocked`, the message builders, `setSuccess` and `router.push` are inside
the probe — a bug in any of them is silently routed to the "unexpected shape"
warn.

On `JSON.parse` output the only expression in that `try` that can throw is
`.data` on `null` (JSON values have no getters; `.data` on a number, string or
array is `undefined`; `hasIntegerCounts` is total; `anyBlocked` runs only
after it). So the `try` goes: read `data` behind an
`typeof rawJson === 'object' && rawJson !== null` guard, and a shape mismatch
reaches the same `!handled` → `console.warn(msg, rawJson)` path. A bug in the
builders or navigation now throws visibly. No catch remains to disable.

### 4. Narrowing the T sites: only where non-navigation work is inside

The issue asked to confirm some sites and narrow where needed. Decision:
**narrow `data-and-deletion.tsx`'s export** (DOM download inside the try — a
DOM throw currently reads "Network error"); **leave `router.push`/`refresh`
inside** the 29 sites that have it.

Why: the harm the issue names is a bug that "leaves no trace". Once the catch
logs `err`, a throw from `router.refresh()` is logged with its stack — the
trace exists. What remains is the on-screen label, and a throwing
`router.refresh()` is not a realistic failure. Restructuring 29 handlers
(moving navigation past `finally`-managed busy flags) is churn with its own
regression risk for no observable gain. `notification-list.tsx`'s deliberate
`throw new Error('HTTP …')` into the same catch stays: logging it is useful,
and the logged `err` says `HTTP 500` where it was one.

A stated exception, found at spec review: census #10 `handoff-code-entry.tsx`
reads the body of a 200 from a single-use code claim inside the same `try`, so
an unreadable 200 would show "Network error" and invite a retry that cannot
succeed. Left as is: `/api/auth/magic-link/claim` answers both of its 200s
through `respondOk`, a JSON body, so
that path needs a response this server does not produce, and the copy is out
of scope. The catch now logs, which is what would identify it if a proxy ever
produced one.

### 5. The L group binds `err` into the pino object

`log.error({ timeZone, err }, …)` at all four sites. Pino serializes `err`
specially, so the stack lands in the server log. `finish-window.test.ts`
asserts the exact object and moves to `objectContaining`. Not linted —
`src/lib` is outside the rule's scope — so this is a one-time fix, stated as
such.

### 6. Tests

- `logRequestFailure` gets a unit test pinning the exact `console.error` call.
- The 24 T sites whose tests already reach the catch (census "Tests" column,
  "no spy") gain a `console.error` spy asserting the tagged call — written
  first, seen failing, then the catch converts. That is the repo's
  existing convention (`room-settings-step.test.tsx`).
- T sites with no network-error test get none new. Lint forces each catch to
  touch its error, not to log it — a `void err` would pass — so for those
  sites the helper call is held by this PR's review, not by a test. Accepted:
  the conversion is one mechanical line per site, reviewed as a diff, and ~22
  new rejection tests would each re-prove the helper's one line.
- `vitest.config.ts`'s comment saying an unstubbed fetch is "swallowed into
  'Network error'" becomes stale — it is logged now — and is rewritten to say
  what is true.

### 7. Guard proofs (each break → record exact error → restore)

1. A bare `catch {}` added to a `src/components` file → the new selector fires.
2. A `teacherStudent.create` call in a `src/app` file → still flagged after the
   new block (proves decision 2's repetition, not just its intent).
3. A `x as ClassLock` cast in a `src/components` file → still flagged.
4. Removing one B site's disable → lint error at that line.
5. A `catch (err) {}` that ignores `err` in scope → `no-unused-vars` fires.
6. `logRequestFailure`'s message format altered → its unit test and the
   pre-existing assertions (e.g. `delete-room-button.test.tsx`) fail.
7. A `.catch(() => …)` in `src/components` → the second selector fires.
8. Scope edges, each must NOT fire: a bare catch in a `src/components`
   `*.test.tsx`, a bare catch in `src/lib`; and in `src/services/roster-link.ts`
   a `teacherStudent.create` stays allowed while `as ClassLock` stays flagged.
   (`pnpm exec eslint --stdin --stdin-filename <repo path> < probe` needs no
   file on disk.)

## Out of scope

Changing user-facing copy; the `readError` convergence (#307/#197); a
client-side error sink; linting `src/lib`.
