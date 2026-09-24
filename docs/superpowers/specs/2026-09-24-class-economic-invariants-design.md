# Class economic invariants: one rule, checked on the merged row, backed by `CHECK`

Issue: #221. Date: 2026-09-24.

## 1. What was measured

The issue was filed 2026-08-13 as a defence-in-depth decision and rescoped on
2026-09-24 after re-verification. Each claim below was re-derived on this branch
(base `510021ae`).

### 1.1 The live bug the original issue ruled out

The original text said "no user-visible failure is known from any of the seven". It
reached that by reading the **create** schemas only. The update schemas are weaker:

| Invariant | `createClassSchema` / `createClassTemplateSchema` | `updateClassSchema` / `updateClassTemplateSchema` |
|---|---|---|
| `minStudents <= maxStudents` | always | only when **both** fields are in the body |
| `minRate <= targetRate` | always | only when **both** fields are in the body |
| `minRate >= -roomCost` | always | **absent** |

Neither `updateClass` (`class-lifecycle.ts`) nor `updateRule` (`rule-lifecycle.ts`,
which `updateClassTemplate` runs on) compares the edit with the stored row.

A throwaway service-level probe (deleted, not committed) against the worktree test
database, on unlocked rows seeded at `roomCost 35, minRate 15, targetRate 25,
minStudents 4, maxStudents 12`:

| Call | Result | Stored after |
|---|---|---|
| `updateClass(…, { maxStudents: 2 })` | `ok: true` | min 4, max 2 |
| `updateClass(…, { minRate: -500 })` | `ok: true` | minRate −500, roomCost 35 |
| `updateClassTemplate(…, { maxStudents: 2 })` | `ok: true` | min 4, max 2 |
| `updateClassTemplate(…, { minRate: -500 })` | `ok: true` | minRate −500 |

**Reachable from the UI, not only the API.** The forms send the full body, so the
two pairwise refines fire, but the third has no update-side refine at all:

- `template-form.tsx` checks `minRate < -roomCost` only when `mode === 'create'`. Its
  comment gives the reason as the server's gap ("updateClassTemplateSchema has no
  minRate/roomCost refine"), and `template-form.test.tsx`'s
  `'permits min rate subsidizing more than room cost on edit'` pins that. The
  leniency mirrors the bug and was never a product decision.
- `class-edit-form.tsx` mirrors only the two pairwise refines.

So a teacher editing an unlocked class or template through the normal form can save
a `minRate` below `-roomCost`, which makes the class's total cost, and so every student
price, negative at low attendance. That is the outcome the create-side refine's own
message names: "prices would go negative".

A stored `min > max` is also a user-visible failure. The class can never reach its
minimum, so auto-cancel cancels it at its check time.

### 1.2 The seven invariants today

| # | Invariant | In the database? |
|---|---|---|
| 1 | `durationMinutes > 0` | **Yes.** Since #327 the column lives on `CalendarEntry` and `ScheduleRule`, both with `CHECK ("durationMinutes" > 0)` |
| 2 | `roomCost >= 0` | no |
| 3 | `minStudents` in `[1, 200]` | no |
| 4 | `maxStudents` in `[1, 200]` | no |
| 5 | `minStudents <= maxStudents` | no |
| 6 | `minRate <= targetRate` | no |
| 7 | `minRate >= -roomCost` | no |

Re-derive with `grep -rn "CHECK" prisma/migrations/*/migration.sql`.

### 1.3 Existing rows

The six conditions for invariants 2–7 were counted on both tables with
`count(*) filter (where …)` in four databases:

| Database | `Class` rows | `ClassTemplate` rows | Violations |
|---|---|---|---|
| `ethical_yoga` (main dev) | 63 | 1 | 0 |
| `ethical_yoga_test` (main test) | 101 | 4 | 0 |
| worktree dev | 4 | 1 | 0 |
| worktree test | 38 | 0 | 0 |

The app is not in production, so there is no deployed data to backfill.

### 1.4 A conflict the issue did not know about

Test fixtures write `minStudents: 0` on purpose. It is how a class starting within
minutes stays open under the live scheduler's auto-cancel sweep, and
`AutoCancelCheck` has no "never" value. Measured:

```
grep -rn "minStudents: 0" src tests e2e prisma                                   → 14 lines
grep -rn "minStudents: 0" src tests e2e prisma | grep -vE "^\S+:[0-9]+:\s*(//|\*)" →  9 lines
```

That is 14 − 5 comment lines = **9 fixture sites across 4 files** (`waitlist.test.ts`,
`invitations-api.test.ts`, `waitlist-api.test.ts`, `registrations-api.test.ts`). A
`CHECK ("minStudents" >= 1)` would break every one of them.

### 1.5 Claims from the issue that held

- `calculateEffectiveTeacherRate` never divides by zero. The two clamps return early
  whenever `minStudents == maxStudents`, and they also return early for every count when
  `minStudents > maxStudents`. The bug is wrong prices and wrong cancellations, not a crash.
- Negative `minRate` is supported product behaviour (the teacher subsidises the room
  cost). No constraint may say `minRate >= 0`.
- A plain `CHECK` violation is not mapped to a clean refusal. `classifyApiError`
  (`api-errors.ts`) matches `23514` only together with the `which is terminal` wording,
  so a new constraint's violation surfaces as a 500.

## 2. Decisions

1. **The database floor for `minStudents` is 0, not 1** (user decision, option A). A
   zero minimum breaks no arithmetic, so the database rules out only impossible rows.
   "At least one" is a product rule that Zod keeps enforcing on every request body. The
   nine fixtures stay as they are. `maxStudents >= 1`, the link #220's argument used,
   is enforced.
2. **A merged-row violation answers 400** with the same `path: message` text
   `parseBody` produces for a create (user decision, option A). It is the same rule
   broken in the same way, and 409 is reserved for state and lifecycle refusals with
   registered codes.
3. **The service checks the row; the database is the backstop** (approach Y). The
   alternative, catching `23514` and mapping constraint names to messages, would make
   the user-facing refusal depend on parsing Prisma error strings. `api-errors.ts`
   records why that is fragile: two message shapes, and a `23514` match on its own
   catches unrelated constraints. Under Y, a `CHECK` firing means a writer skipped the
   service, and a 500 is the honest answer.
4. **One PR for both parts.** The constraint is what catches a future writer that skips
   the service, and the migration is small.
5. **#220's spec is left as written.** Its "one assumption worth naming" paragraph
   (`2026-08-13-waitlist-reconciliation-design.md` §3) records what was true when that
   branch shipped. Specs are records, and the PR body carries what changed.

## 3. Design

### 3.1 The rule, stated once

A new module, `src/lib/class-economics.ts`, exports:

```ts
export type ClassEconomics = {
  roomCost: number; minRate: number; targetRate: number;
  minStudents: number; maxStudents: number;
};
export type EconomicsRule = 'students_order' | 'rate_order' | 'room_subsidy';
export type EconomicsViolation = { rule: EconomicsRule; path: keyof ClassEconomics; message: string };
export function economicsViolations(e: ClassEconomics): readonly EconomicsViolation[];
```

It checks the three cross-field invariants in the order the create refines use today
(5, 6, 7) and returns **every** one broken, in that order, or an empty array. It returns
all of them, not the first, because Zod runs every refine and `parseBody` joins the
issues with `, `. First-only would change what a create's 400 says when two rules
break at once. The paths and messages are exactly today's:

| Invariant | `rule` | `path` | `message` |
|---|---|---|---|
| 5 | `students_order` | `minStudents` | `minStudents cannot exceed maxStudents` |
| 6 | `rate_order` | `minRate` | `minRate cannot exceed targetRate` |
| 7 | `room_subsidy` | `minRate` | `minRate cannot subsidize more than the room cost — prices would go negative` |

`rule` exists because two rules share `path: 'minRate'`. It lets a form map a violation to
its own copy through a `Record<EconomicsRule, string>`, which the compiler keeps complete.

The module imports nothing, so a client component can use it.

- **Create schemas:** `createClassSchema` and `createClassTemplateSchema` replace their
  three `.refine`s with one `.superRefine` that calls `economicsViolations` and adds one
  issue per violation at its `path`. Existing message assertions keep holding.
- **Update schemas:** `updateClassSchema` and `updateClassTemplateSchema` drop their two
  partial pairwise refines. A partial body cannot be checked without the stored row, so
  the check moves to where the stored row is (§3.2). Single-field bounds (`positive()`,
  `max(MAX_CLASS_SIZE)`, `nonnegative()`) stay on the update schemas.

### 3.2 The update paths

Both paths already take a row lock before writing. The check runs **after** that lock,
so it cannot be raced, and only when the request sends at least one economic field.

- **`updateClass`:** after `lockClassRow`, and only if `sentEconomic !== null`, read the
  row's five economic columns through `tx`, overlay the sent fields, and run
  `economicsViolations`. On a violation, throw
  `UpdateClassRefusal({ ok: false, reason: 'invalid_economics', violations })`, which
  rolls back the transaction.

  **Ordering, and why it is tight.** The check must run **before** the class write:
  with §3.4's constraints in place, an invalid `UPDATE` raises `23514` at the write
  itself, which is a 500, not a 400. It also must not pre-empt the refusals that make
  economics moot. A settings-locked class answers `locked` and a terminal or cancelled
  class answers `terminal`, never 400. `updateClass` already refuses both before the
  transaction, using the row it read first. The class CAS (`settingsLocked: false`, not
  terminal, entry not cancelled) is the backstop for a row that changed in between.
  So the read after the lock also fetches the columns that CAS filters on, and when
  that fresh row would fail the CAS, the check is skipped and the CAS refuses exactly
  as it does today. Tests pin both orders: a locked class sent an invalid economic edit
  answers `locked`, and an invalid edit on an unlocked class answers 400, not 500.
- **`updateClassTemplate`:** `CLASS_FAMILY.updateChild` runs inside `updateRule`'s
  transaction after its `FOR UPDATE` on the template row. There it reads the stored
  economics through `tx`, overlays `childData`, runs `economicsViolations`, and throws a
  refusal that rolls back the rule edit too. The check sits before
  `tx.classTemplate.update` for the same reason as above: the constraint fires on the
  write. Templates have no settings lock, so there is no refusal it could pre-empt.
  `updateClassTemplate` turns the refusal into a returned
  `{ ok: false, reason: 'invalid_economics', violations }` arm. The arm is added to
  `UpdateClassTemplateResult` only, not to the generic `UpdateRuleResult`, which the
  studio family shares. The throw reaches `updateClassTemplate` untouched: `updateRule`'s
  catch matches transient, not-found, slot and room-FK errors and rethrows everything
  else (`rule-lifecycle.ts`, the final `throw err`).
- **Routes:** `PUT /api/classes/[id]` and `PUT /api/class-templates/[id]` map the new
  reason to a 400 whose message is
  `violations.map((v) => \`${v.path}: ${v.message}\`).join(', ')`, the same shape
  `parseBody` builds from Zod issues. Both routes end in a `never` exhaustiveness
  check, so a missing branch fails to compile.

`StudioClass` and `StudioClassTemplate` have no such economics and are unaffected.

### 3.3 The forms

- `template-form.tsx`: the `-roomCost` check stops being create-only, and its comment
  now states the rule rather than the gap. The `#590` test that pins edit-mode
  leniency flips to assert that edit mode refuses before any request.
- `class-edit-form.tsx`: gains the third check, in the same unlocked-only branch as the
  other two.
- Both forms call `economicsViolations` instead of restating the predicates, and show
  the first violation's copy from their own
  `Record<EconomicsRule, string> satisfies`-tethered map. The copy stays the forms'
  sentence-case wording ("Min students cannot exceed max students"; the existing
  subsidy sentence), which the forms' tests already pin. The server's camelCase messages
  are for API clients, the form's are for teachers.

### 3.4 The migration

A hand-written migration modelled on
`prisma/migrations/20260802150845_income_tier_range_check/migration.sql`, adding to each
of `"Class"` and `"ClassTemplate"`:

| Constraint suffix | Expression |
|---|---|
| `_room_cost_check` | `"roomCost" >= 0` |
| `_min_students_range_check` | `"minStudents" BETWEEN 0 AND 200` |
| `_max_students_range_check` | `"maxStudents" BETWEEN 1 AND 200` |
| `_students_order_check` | `"minStudents" <= "maxStudents"` |
| `_rate_order_check` | `"minRate" <= "targetRate"` |
| `_room_subsidy_check` | `"minRate" >= -"roomCost"` |

The migration's comments describe only its own SQL. The reason the floor is 0 while Zod
says 1, and the `200` duplicated from `MAX_CLASS_SIZE`, go in `docs/data-model.md`. A
comment on `MAX_CLASS_SIZE` points there. No constraint name may contain the phrase
`which is terminal`: `isTerminalStatusViolation` matches on it.

## 4. Testing

Test-first. Each of these fails before the change it covers:

- **Service (`updateClass`, `updateClassTemplate`):** on an unlocked row, each of these
  partial edits is refused with `invalid_economics` and the stored row is unchanged:
  `{maxStudents: 2}` over min 4; `{minRate: -500}` over roomCost 35;
  `{minRate: 30}` over targetRate 25; `{roomCost: 0}` over a stored negative minRate.
  Each also has a passing control: a partial edit that stays valid is applied. A
  settings-locked class sent an invalid economic edit answers `locked`, not
  `invalid_economics`.
- **Routes:** each new reason reaches the client as 400 with the `path: message` text.
- **Pure function:** each invariant's boundary (equal is allowed, one past is refused),
  plus the order in which violations are reported.
- **Forms:** edit mode refuses a subsidy beyond room cost before any request, for both
  forms.
- **Constraints bite:** for each of the six constraints on each table, write a
  violating row through Prisma directly (bypassing Zod and the service) and assert
  Postgres refuses it with that constraint's name. Also one control per table showing
  `minStudents: 0` is accepted.
- **Mutation proof** (§3 of the skill), recorded in the PR body:
  - Delete the service check in each update path; the service tests go red.
  - Change one comparison inside `economicsViolations`; the unit and create-schema tests
    go red.
  - Drop one `ADD CONSTRAINT`; its bite test goes red.

## 5. Out of scope

- **#183** (waiting queue uniqueness) is unaffected.
- A "never" value for `AutoCancelCheck`, which would let fixtures stop using
  `minStudents: 0`. Not needed once the database floor is 0.
- Mapping a `CHECK` violation to a 4xx. Under decision 3 it means a bug, and a 500 is
  correct.
