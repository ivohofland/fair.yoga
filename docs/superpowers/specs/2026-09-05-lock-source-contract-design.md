# `ClassLockSource`: making `lockClassRowsOrdered`'s contract checkable

**Issue:** #245 (split out of #239's review) · **Date:** 2026-09-05

`lockClassRowsOrdered` (`src/lib/db-locks.ts`) is the single production
`SELECT … FOR UPDATE OF c` on `Class` in `src/`, taken by four callers. Its
contract — which parameter to supply when, what supplying it does to the lock
set, and which mistakes fail loudly — lives entirely in a docblock above the
function. This spec moves the parts of that contract a compiler or a parser can
hold into places that hold them, and deletes the prose those places replace.

## What was measured

Every claim in issue #245 was re-checked against the tree at `b524aa8b`. Three
hold, one is stale, one understates the problem, and one of the issue's own
summary sentences is wrong. Recording the corrections here is the point of this
section — the issue was filed against an older tree and #327, #284 and #239's
own review round moved underneath it.

### The docblock is 116 lines, not 70

`src/lib/db-locks.ts:289-404`; `404 − 289 + 1 = 116`. The issue's title says 70.
It grew when `entries?: boolean` was added, which is also why item 1 below
understates its own case.

### Item 1 — name and export the parameter object: **holds, understates**

The type is `{ join?: Prisma.Sql; where: Prisma.Sql; entries?: boolean }`. The
issue names two members; there are three. `entries`'s rule ("ask it of the whole
TRANSACTION, not of this statement") sits ~85 lines into the docblock, further
from a hover than either of the two the issue cites.

### Item 2 — an INNER JOIN is a filter: **holds, census wrong**

The semantic claim is correct and undocumented: `{ join: waitlistJoin, where:
c."teacherId" = … }` narrows the lock set to classes having at least one
waitlist entry.

The duplication census is not. Measured over `src/`, excluding `*.test.ts`:

| literal | production sites |
|---|---|
| `JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"` | **3** — `gdpr.ts:1121`, `class-template-lifecycle.ts:745`, `waitlist.ts:1088` |
| `JOIN "WaitlistEntry" w ON w."classId" = c.id` | **2** — `gdpr.ts:434`, `waitlist.ts:1087` |

Re-derive with:

    grep -rn 'JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"\|JOIN "WaitlistEntry" w ON w."classId" = c.id' src/ | grep -v '\.test\.ts'

The issue names only the second and calls it "the duplication". The first is
larger. In `waitlist.ts` the two are concatenated inside one `Prisma.sql`
template, so neither appears there as a standalone byte-identical fragment.

### Item 3 — two guarantees are positional: **holds, understates**

Probed against Postgres 16 in `fairyoga-db-1`, against `ethical_yoga`:

| caller's `where` fragment | with `ORDER BY c.id` (today) | without it |
|---|---|---|
| stray `FOR UPDATE` | `syntax error at or near "ORDER"` | **parses, runs** |
| stray `ORDER BY c."createdAt"` | `syntax error at or near "ORDER"` | **parses, runs** |
| references `w.` with no `join` | `missing FROM-clause entry for table "w"` | same |

So the issue is right that the first two are positional accidents of clause
order. The third is **structural** — name resolution, not clause sequence — and
the docblock's claim about it is safe as written.

**A case the issue does not name, and which is live today.** A locking clause
inside a subquery in the `where` parses and runs *with* `ORDER BY c.id` present:

```sql
SELECT c.id FROM "Class" c
  WHERE c.id IN (SELECT "classId" FROM "WaitlistEntry" FOR UPDATE)
  ORDER BY c.id FOR UPDATE OF c;
```

Measured effect, read from `pg_locks` inside the transaction:

| statement | `Class` | `WaitlistEntry` |
|---|---|---|
| subquery **with** `FOR UPDATE` | `RowShareLock` | **`RowShareLock`** |
| subquery **without** it (control) | `RowShareLock` | `AccessShareLock` |

`RowShareLock` on `WaitlistEntry` is the table-level lock a locking clause
takes; the control shows the reading dropping to `AccessShareLock` when the
clause is removed, so the observation could have come out differently. This is
exactly the widening `FOR UPDATE OF c` exists to prevent, and no clause ordering
prevents it.

**`LEFT JOIN` widening** (issue item 2's third bullet) parses cleanly, as the
issue says. Not addressed by this spec — see *Not in scope*.

### Item 4 — `CANCELLABLE_STATUSES` and `Object.freeze`: **premise stale, concern survives**

The comment the issue quotes — *"the enum has five members, the two outside
`CANCELLABLE_STATUSES` are `completed` and `cancelled`"* — **no longer exists**.
`ClassStatus` has had four members since #327 (`draft`, `open`, `in_progress`,
`completed`); cancellation became `CalendarEntry.cancelledAt` and is not a
status. `prisma/schema.prisma:50-55`. The current docblock
(`gdpr.ts:909-922`) makes no membership claim at all, so there is no wrong
comment to correct.

The underlying defect survives, and the issue states it correctly:
`const CANCELLABLE_STATUSES: readonly ClassStatus[]` erases the literal types,
so adding a fifth `ClassStatus` updates neither this list nor
`SCHEDULED_STATUSES` (`class-template-lifecycle.ts:468`), leaves those classes
uncancelled on an Article 17 path, and keeps every test green. The partition is
now 3 + 1, not the issue's 3 + 2.

**The issue's proposed fix does not compile clean here.** Its
`const _partitionIsTotal: never = …` would trip `@typescript-eslint/no-unused-vars`:
`eslint.config.mjs:13` configures `argsIgnorePattern: '^_'` only — arguments,
not variables — so a `_`-prefixed unused top-level binding is still an error.

### Item 5 — `statusInList`: **holds**

`gdpr.ts:943` and `class-template-lifecycle.ts:497` hold character-identical
``Prisma.raw(X.map((s) => `'${s}'`).join(', '))`` expressions. Each rendered
constant has exactly **one** reader (`gdpr.ts:1124`,
`class-template-lifecycle.ts:749`), and both readers are the `where` of a
`lockClassRowsOrdered` call — which is what makes `db-locks.ts` the right home
for the shared helper rather than a new module.

### The issue's comment — two prose rosters: **holds, both verified**

- `gdpr.ts:479-489` — the four-member roster of `lockClassRowsOrdered` call
  sites. Near-verbatim duplicate of `docs/lock-order.md:76-84`: same four, same
  "Five until #194", same `grep -rn 'lockClassRowsOrdered(' src/` re-derivation.
- `gdpr.ts:1042-1053` — the five-member roster of `ClassTemplate`-before-`Class`
  ordering sites. Duplicate of `docs/lock-order.md:1920-1937`: same five, same
  history.

Both are accurate today. Both are the shape CLAUDE.md's *Comment Discipline*
forbids and `db-locks.ts:381-389` explicitly declines to keep ("a caller list
kept in this file goes stale, and nothing that counts can catch it").

### A correction to the issue's own summary

> *"None of the four guarantees currently has a test."*

False as written, and it conflates two different lists in the docblock:

- The **"FOUR things deliberately here"** list — `ORDER BY c.id`,
  `FOR UPDATE OF c`, `setLockTimeout`, the dedupe — **all four have tests**:
  `db-locks-lock-order.test.ts:252` and `db-locks.test.ts:421`, `:482`, `:544`,
  `:458` respectively. Three were added by #239's own review round; that test's
  comment says so ("until #239's review it was the only one nothing could fail
  on").
- The **"fails loudly" sentence** — a caller referencing `w.` without a `join`,
  or writing its own `ORDER BY` or `FOR UPDATE`, gets a SQL error — has
  **zero** tests. Verified: no `toThrow`, `rejects`, `missing FROM` or
  `syntax error` assertion exists in either lock test file.

It is the second list this spec adds tests for.

## Design

### A. `ClassLockSource` — the named, exported type (items 1 + 2)

Exported from `db-locks.ts`. Each member carries the rule governing it on the
member itself, where a contributor's hover reaches it:

```ts
export interface ClassLockSource {
  /**
   * Extra tables the `where` may name … AND A FILTER. An INNER JOIN NARROWS
   * the lock set … `{ join: CLASS_TO_WAITLIST_JOIN, where: c."teacherId" = … }`
   * locks only classes that have at least one waitlist entry …
   */
  join?: Prisma.Sql;
  /**
   * The predicate … parenthesised by the helper before splicing, so `OR`/`AND`
   * precedence inside it is yours and cannot leak …
   */
  where: Prisma.Sql;
  /**
   * … ask it of the whole TRANSACTION, not of this statement …
   */
  entries?: boolean;
}
```

The function docblock loses the paragraphs these replace. It keeps what is
genuinely about the *statement* — the four things it owns, the per-acquisition
timeout note, the returned-ids argument, the `VERDICT (#327)` re-derivation
pointer.

### B. Shared join constants (item 2)

In `db-locks.ts`, beside the type whose `join` they are values for:

```ts
export const CLASS_TO_ENTRY_JOIN = Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`;
export const CLASS_TO_WAITLIST_JOIN = Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`;
```

`waitlist.ts` composes both: ``Prisma.sql`${CLASS_TO_WAITLIST_JOIN} ${CLASS_TO_ENTRY_JOIN}` ``.
Verified — nested `Prisma.Sql` values are merged as text, and the composed
fragment's `.strings` holds the flattened result as a single entry.

This removes the typo'd-join-condition failure the issue names (a join a caller
cannot mistype is a join that cannot silently return zero rows and take zero
locks) at the five production sites. It does not remove it for a caller that
writes its own; `join` stays `Prisma.Sql`, for the reason the issue itself
gives about typed selectors.

### C. The guard (item 3)

Two layers, because neither covers the other:

**Structural — parenthesise the caller's predicate.**

```ts
WHERE (${source.where})
```

Verified: a stray `FOR UPDATE` now errors at `FOR`, and a stray `ORDER BY` at
`ORDER` — at the offending token, independent of what follows. The guarantee
stops depending on `ORDER BY c.id` sitting where it does. Verified not to change
any existing caller's plan or bound values; wrapping preserves parameter
positions. It also closes item 2's `OR`/`AND` precedence hazard, for free.

**Runtime — one assertion, for the case parens cannot reach.**

```ts
const ILLEGAL_IN_FRAGMENT = /\b(order\s+by|for\s+(update|share|no\s+key|key\s+share)|limit|offset)\b|;/i;
```

tested against the `.strings` of **both** `join` and `where`. Verified about
`.strings`:

- it is the STATIC template text only — a fragment whose *bound value* is the
  string `'for update'` has `strings: ['c."teacherId" = ', '']`, so data cannot
  trip it;
- nesting cannot evade it — a composed fragment's inner static text appears
  flattened in the outer `.strings`;
- `Prisma.raw` output **is** included, which is correct: that is the one place
  text is interpolated. The two constants it applies to render
  `'draft', 'open', 'in_progress'` and `'draft', 'open'`, neither containing a
  needle.

The regex is a second layer with one job — the subquery locking clause measured
above. Parens carry the rest.

**Tests.** One per guarantee in the "fails loudly" sentence, plus one for the
subquery case, each mutation-tested: break the guard, record the exact error
text, restore, re-verify.

### D. The status partition (item 4, revised)

Tether by construction rather than by a dangling `never` binding, which this
project's lint config rejects:

```ts
const CLASS_STATUS_CANCELLABILITY = {
  draft: true, open: true, in_progress: true, completed: false,
} as const satisfies Record<ClassStatus, boolean>;

const CANCELLABLE_STATUSES = Object.freeze(
  (Object.keys(CLASS_STATUS_CANCELLABILITY) as ClassStatus[])
    .filter((s) => CLASS_STATUS_CANCELLABILITY[s]),
);
```

`satisfies Record<ClassStatus, boolean>` makes a fifth `ClassStatus` a compile
error until it is classified, and deriving the array from the record means the
two cannot drift — there is no second list to forget. No unused binding, so no
lint conflict.

The one `as` is narrow, and its safety follows from the line above it: the
literal `satisfies Record<ClassStatus, boolean>`, so its keys *are* exactly
`ClassStatus`; the assertion only restores what `Object.keys` erases. That
argument goes in the docblock beside it. `Object.freeze` stays — it is what
makes the `Prisma.raw` rendering defensible at runtime, and the existing
docblock says so.

The same treatment for `SCHEDULED_STATUSES` (`class-template-lifecycle.ts:468`),
whose own docblock records a status dropped from one of two hand-written lists
leaving "every test covering this function green, silently re-opening the
deadlock the pre-lock exists to close". Same risk, same fix.

### E. `statusInList` (item 5)

In `db-locks.ts`, `readonly ClassStatus[] → Prisma.Sql`, replacing both
hand-written `Prisma.raw(…)` expressions. It carries the `Prisma.raw`-not-
`Prisma.join` argument (the `::text` cast costs the index) and the frozen-
constant precondition once, instead of twice in near-identical docblocks.

`ClassStatus` enters `db-locks.ts` as an `import type`, which erases — so the
module's documented import surface (`crypto` + `@prisma/client`, never
`@/lib/log`) is unchanged.

### F. The rosters (the issue's comment)

`gdpr.ts:479-489` and `gdpr.ts:1042-1053` are **replaced** by one-line pointers
to the `docs/lock-order.md` sections that own those censuses — not annotated,
per CLAUDE.md ("correct a claim by replacing it, not annotating it"). What each
roster used to say goes in the PR body. The surrounding comments' *reasoning* —
why the lock sits where it does, the AB-BA argument, the `updateClass` window —
stays: it is about the code it sits on and has no other owner.

## Not in scope

- **`docs/lock-order.md`'s own censuses.** They are the owners. They stay, and
  F points at them.
- **`LEFT JOIN` silently widening.** Real, and named in the issue. Not fixed
  here: the shared constants remove it at all five production sites, and
  banning `LEFT` in the regex would be a semantic restriction on a parameter
  whose whole point is that callers compose it. Revisit only if a caller ever
  needs an outer join, which none does today.
- **The `entries` second statement**, unchanged.
- **A typed-selector union** instead of `Prisma.Sql`, settled against in #239
  and re-affirmed in the issue.
- No migration; no schema change.

## Verification

- `npm run verify` — typecheck, lint, and every vitest project, with the app
  live on `:3000`.
- Each new guard mutation-tested: break it, record the exact error text,
  restore, re-verify. Recorded per guard in the PR body.
- The subquery case gets two tests, because once the guard is in the helper
  refuses that fragment and never reaches Postgres: one that the guard refuses
  it, and one on a RAW statement — the guard's own justification — re-running
  the `pg_locks` readings above with the no-`FOR UPDATE` control beside them,
  so neither can pass vacuously.

## Sequencing

Task order is load-bearing at one point: **E before D**. `statusInList` must
exist before `CANCELLABLE_STATUSES` and `SCHEDULED_STATUSES` change shape, or
the two hand-written `Prisma.raw` expressions get edited twice.
