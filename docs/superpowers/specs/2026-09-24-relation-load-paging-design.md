# Relation loads over platform-wide sets — design (#674)

## Problem

Prisma 6.19.3 loads a relation (`include` / nested `select`) with a second
statement, one parent key per row. For a **composite** relation that key is a
row value, and the statement reads

```sql
WHERE ("id","kind","live") IN (($1, CAST($2::text AS "ClassFamily"), $3), ...)
```

Postgres parses a long row-value `IN` list into a nested expression tree and
fails with `54001 stack depth limit exceeded` at the image's default
`max_stack_depth` (2048 kB). A cron sweep whose parent set grows with the whole
platform therefore stops working at a fixed platform size, and fails the same
way on every later tick.

## What was measured (premise check, 2026-09-24)

The issue's premise holds. Its scope was too narrow.

- **Plain SQL, default stack (2 MB):** 3,000 `(int, text, bool)` tuples
  return, 8,000 fail with `54001`. A **single-column** `IN` of 32,000 values
  returns.
- **Plain SQL, `SET max_stack_depth = '100kB'`:** 300 tuples return, 400 fail.
  A single-column `IN` of 30,000 values still returns. Single-column lists are
  structurally safe: Postgres turns them into a flat `= ANY(array)`.
- **Through Prisma:** a `connection_limit=1` client keeps a session-level
  `SET max_stack_depth` across later Prisma queries. The logged relation-load
  SQL is exactly the tuple shape above. The next hop (`teacher`, one column) is
  `"id" IN ($1,$2)`, which is safe.
- **Relation *filters* are safe.** `where: { calendarEntry: { cancelledAt: null } }`
  compiles to a `LEFT JOIN`, not an `IN` list. Only *loads* are exposed.
- **The `_count` cost.** `autoCancelClasses`'s filtered `_count` compiles to an
  uncorrelated
  `LEFT JOIN (SELECT "classId", COUNT(*) FROM "Registration" WHERE status IN (...) GROUP BY "classId")`.
  Narrowing the outer query does not narrow that aggregate. The 1.6 s per tick
  measured on #224's M-scale data comes from it.

### Census: where a composite relation is loaded

Composite relations (`grep -n "fields: \[[^]]*,[^]]*\]" prisma/schema.prisma`):
`ClassTemplate.scheduleRule`, `ClassTemplate.teacherRoom`,
`Class.calendarEntry`, `Class.teacherRoom`, `StudioClassTemplate.scheduleRule`,
`StudioClass.calendarEntry`, and their back-relations.

Load sites were found with
`grep -rnE "\b(calendarEntry|classes|studioClasses|teacherRoom|classTemplates|studioClassTemplates|scheduleRule)\s*:\s*(\{|true)" src`
(excluding tests), and each hit was read to separate loads from filters.

**Cross-tenant: the parent set grows with the whole platform.** Each one is a
background sweep.

| Site | Hop | Parent set |
|---|---|---|
| `autoCancelClasses` (`class-transitions.ts`) | Class → CalendarEntry | every future open live class (~4 weeks × every template) |
| `generateClassInstances` (`class-generator.ts`) | ClassTemplate → ScheduleRule | every active template |
| `generateStudioClassInstances` (`studio-class-generator.ts`) | StudioClassTemplate → ScheduleRule | every active studio template |
| `autoTransitionToInProgress` (`class-transitions.ts`) | Class → CalendarEntry | open classes dated up to tomorrow |
| `autoCompleteClasses` (`class-transitions.ts`) | Class → CalendarEntry | `in_progress` classes |
| `reconcileWaitlists` (`waitlist-reconciliation.ts`) | Class → CalendarEntry | open classes with a waiting entry |
| `getUnreadForEmailFallback` (`notifications.ts`) | Notification → Class → CalendarEntry | classes linked from unread, unsent notifications of any age (kept for a year) |
| `sendPaymentReminders` (`payment-reminders.ts`) | Payment → Registration → Class → CalendarEntry | classes with an overdue payment, which accumulate until someone acts |

The issue named only the first and `reconcileWaitlists`. The generators hit
the ceiling next after `autoCancelClasses`: at about 6 templates per teacher,
7,500 templates is about 1,250 teachers.

**Per-tenant: bounded by one teacher's or one student's history.** Left
alone. The largest are a teacher's whole calendar history: the GDPR export,
`/schedule/past`, reporting, and the unfiltered `GET /api/classes` and
`GET /api/studio-classes`. At 6 classes a week a teacher reaches 7,500 entries
after about 24 years. A student's bookings or GDPR export is smaller again.
Neither is a defect that anyone will hit.

**Bounded by a single row, a `take` or a date window:** everything else.

## Decision

**One rule: a sweep never loads a relation over a platform-wide parent set in
one statement.** Each cross-tenant site above reads its snapshot in keyset
pages through one helper. `autoCancelClasses` additionally gets a date window
and a separate registration count, which fixes the cost.

Rejected:

- **Two-step reads by single-column id** (flat rows, then
  `calendarEntry.findMany({ where: { id: { in } } })`, joined in JS). This has
  no ceiling at all, but it means bespoke join code at eight sites and loses
  Prisma's nested result types.
- **`relationJoins` preview with `relationLoadStrategy: 'join'`.** Enabling the
  preview makes `join` the default for every query in the app. That is too
  much change for a preview feature.
- **Raising `max_stack_depth`.** It is bounded by the OS stack limit, so it
  only moves the ceiling a few times over. And it is deployment configuration
  that a fresh environment silently lacks.

## Design

### 1. `readInPages` (`src/lib/read-in-pages.ts`)

```ts
export const SWEEP_PAGE_SIZE = 500;

export async function readInPages<T>(
  fetchPage: (after: T | undefined, take: number) => Promise<T[]>,
): Promise<T[]>
```

- The helper calls `fetchPage(undefined, SWEEP_PAGE_SIZE)`, then
  `fetchPage(lastRowOfPreviousPage, SWEEP_PAGE_SIZE)`, until a page comes back
  shorter than `SWEEP_PAGE_SIZE`. It returns the concatenation.
- **The caller owns the keyset.** It builds its own `where` from `after` and a
  matching `orderBy`. Most sites use `id > after.id` with `orderBy: { id: 'asc' }`.
  `getUnreadForEmailFallback` keeps its `createdAt` order with
  `(createdAt, id) > (after.createdAt, after.id)` and
  `orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]`, so its result order is
  unchanged. The caller selects every field its cursor reads.
- The callback's `T` is inferred from the Prisma call, so every site keeps its
  nested result type.
- **Why 500:** the default-stack threshold is about 7,500 parents, so 500
  leaves a 15× margin. Real sweeps rarely exceed one page, so the extra round
  trips are negligible. The number lives in one constant.

**Why paging is safe at every site.** Pages are read at slightly different
moments, so the result is not one consistent snapshot. Every site already
treats its read as a pre-filter:

- the class sweeps re-read and lock the row before deciding;
- the generators re-read the template under `claim*ForGeneration`;
- the email fallback and payment reminders stamp with a conditional update
  that refuses a row already handled.

A row inserted during the read is picked up by this tick or the next one,
which is the same property the unpaged read had against a row inserted just
after it.

### 2. `autoCancelClasses`: window the read and count separately

A class can be auto-cancelled only while `checkTime <= now < start`, where
`checkTime = start − checkHours` and `checkHours <= MAX_CHECK_HOURS`, the
largest `CANCEL_CHECK_HOURS` value. That value is derived from the record,
not written as a literal. So `start ∈ (now, now + MAX_CHECK_HOURS]`.

`start` is the teacher-local `date` + `startTime` resolved in the teacher's
zone. Relative to `date` read as UTC midnight, the start instant lies in
`[date − 14 h, date + 24 h + 12 h)`: `startTime` covers `[0, 24 h)`, and zone
offsets span UTC−12 to UTC+14.

Solving for `date`:

```
date ∈ ( now − 36 h, now + MAX_CHECK_HOURS + 14 h ]
```

This is taken as whole UTC calendar dates, inclusive at both ends. `from` is
the first midnight strictly after `now − 36 h`, and `to` is the midnight at
or before `now + MAX_CHECK_HOURS + 14 h`. Both bounds are tight, so moving
either inward by a day misses a reachable class. That is what lets the edge
tests bite. The bounds are passed as UTC-midnight `Date`s for the `@db.Date`
column, so no timestamp-to-date truncation can narrow them. That makes 2 or 3
calendar dates instead of 4 weeks. The window lives in a small exported pure function
beside `inCancelWindow`, so it can be tested at its edges without a database.

**The count.** The `_count` is removed from the snapshot. After the windowed,
paged read, one `registration.groupBy({ by: ['classId'], where: { classId: { in: ids }, status: { in: ACTIVE_REGISTRATION_STATUSES } } })`
builds a map. That is the shape `reconcileWaitlists` already uses. It stays a
pre-filter with the same status constant, so the paragraph explaining why the
filter is load-bearing still holds. `classId` is one column, so its `IN` list
is safe at any size. The authoritative count under the lock is unchanged.

### 3. Tests

- **`readInPages` unit test:** returns every row across a boundary of exactly
  one page, of one page plus one, and of an empty first page. It passes
  `after` as the previous page's last row.
- **Per-site ceiling tests, one per cross-tenant site.** Each test opens a
  `connection_limit=1` client with a session `SET max_stack_depth` at a value
  measured in the plan's first task: one where a 500-row page returns and the
  seeded set fails. It seeds enough parent rows that one unpaged statement
  exceeds the lowered threshold, then calls the sweep with that client.
  - **RED:** the sweep, or the read it isolates, fails with `54001`. For
    sweeps that catch per-row errors, the assertion is on the read's outcome,
    not just "did not throw".
  - **GREEN:** the same call returns normally.
  - Seeded rows are shaped to be **no-ops** for the sweep (for example
    `minStudents: 0` for auto-cancel), so a green run changes nothing the rest
    of the file relies on.
- **Auto-cancel window edges, pure function:** a class in `Pacific/Kiritimati`
  (UTC+14) and one in `Etc/GMT+12` (UTC−12), each starting exactly
  `MAX_CHECK_HOURS` after `now` and just after `now`, fall inside the date
  window. Mutating either bound by one day turns a case red.
- **Auto-cancel count:** the existing auto-cancel tests keep passing
  unedited. That is the behavioural pin that the `groupBy` answers the same
  question the `_count` did. A class whose registrations are all cancelled is
  still swept.
- **Mutation proofs (plan step per guard):** revert each site to its unpaged
  read and see its ceiling test fail with `54001`. Widen the page size past
  the lowered threshold and see a ceiling test fail. Narrow the window by a day
  at either end and see an edge case fail. Drop the status filter from the
  `groupBy` and see the "all registrations cancelled" test fail.

### 4. Measurement

On a throwaway database with every migration applied, loaded with #674's
`load.sql` at `T=500 Y=3 RD=1100` (never the dev or test database, since the
script truncates), time `autoCancelClasses` per tick before and after.
`reconcileWaitlists` and the generators are also timed at `T=500`, to show
paging costs nothing there. The PR reports the numbers with the command that
produced them.

### 5. Documentation

A short section in `docs/technical-architecture.md` (Services Layer), titled
"Relation loads over platform-wide sets", states the rule, the mechanism, and
the census re-derivation commands above. Its site table carries the command,
not a count. Comments at each call site annotate only their own read and link
there. No census or roster goes in a docblock.

## Out of scope

- Per-tenant sites, for the reason above. The docs section records the verdict.
- Prisma's generic chunking, or a lint rule against unpaged composite loads.
  One rule in `docs/`, plus a ceiling test per site, is proportionate to eight
  sites.
- `autoTransitionToInProgress`'s missing lower date bound. Its set stays about
  two days of classes, and it is paged anyway.
