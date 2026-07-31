# defaultTimezone on the session

**Date:** 2026-07-31
**Status:** Approved (issue #138; design agreed with Ivo — cross-cutting-only bar
for session fields, the field on the teacher branch of the union, #140 stays a
separate PR)

## Problem

Three teacher pages fetch the session teacher's row for no reason other than
`defaultTimezone`:

```ts
const teacher = await prisma.teacher.findUniqueOrThrow({
  where: { id: session.teacherId },
  select: { defaultTimezone: true },
});
```

Each is a serialised round trip *before* the page's main `Promise.all`, because
the calendar-day boundary it computes feeds the queries inside it. Two of the
three were added by PR #137 (#101 + #115).

Meanwhile `validateSession` (`src/lib/auth/session.ts:60-66`) **already loads the
teacher row on every authenticated request**, selecting `{ id, deletedAt }` to
check GDPR liveness.

**The issue's inventory is accurate** — a sweep confirms exactly three
page-level sites, not more. That is worth noting because every other issue
worked this week undercounted itself (#96 reported four date formats where there
were eight, and a ninth surfaced in whole-branch review). #138 is accurate
because it was written *from* a review that had already measured, rather than
from a grep.

## Design

### 1. One more column on a query that already runs

```ts
teacher: { select: { id: true, deletedAt: true, defaultTimezone: true } }
```

No new query, no new round trip. For student-only accounts `account.teacher` is
`null`, so the extra column costs nothing there either — the cost is one column
on teacher requests, and it replaces a whole round trip on three of them.

### 2. The field goes on the teacher branch of the union, and is required

`SessionUser` is a discriminated union that makes "neither profile" unrepresentable:

```ts
export type SessionUser = { sessionId: string; accountId: string } & (
  | { teacherId: string; defaultTimezone: string; studentId: string | null }
  | { teacherId: null; studentId: string }
);
```

Reading `defaultTimezone` therefore requires having narrowed to a teacher, which
`requireTeacherSession` and `requireTeacher` already do — so `TeacherSession`
inherits it and **no consumer null-checks**.

**Required, not optional.** An optional field would let a construction site
silently omit it and a consumer silently read `undefined` into a timezone
argument. Required means the compiler enumerates every site instead. There are
exactly two that break, both teacher-branch fakes in `src/lib/api-utils.test.ts`;
the student-branch fake and `src/lib/auth/account.ts:52` (which returns the
student branch) are unaffected.

**The name stays `defaultTimezone`,** matching the column. A second name for one
value is how the drift in #96 started.

### 3. The bar for what may live on the session

`SessionUser` is consumed by 23 files and loads on every authenticated request.
#138 adds the first non-identity field, so it sets the precedent. The rule, to be
written into the type's docblock:

> A field earns a place here if it is needed to **compute** something on many
> surfaces. Display-only values stay in page queries.

`defaultTimezone` qualifies: it decides which calendar day a teacher is in — a
correctness input behind the whole #101/#115 family — and it is wanted by three
pages today plus the payments page next (#140).

`firstName` does not qualify, though `validateSession` could carry it just as
cheaply: two session-teacher sites, both display-only. It stays where it is.

### 4. Call sites

| Site | Change |
|---|---|
| `src/app/(teacher)/schedule/past/page.tsx` | query **deleted** — it existed only for this |
| `src/app/(teacher)/settings/reporting/page.tsx` | query **deleted** — same |
| `src/app/(teacher)/page.tsx` | query **stays** (it also selects `bankIban`); only the field comes off |

### 5. What must not change

`src/` carries **30** non-test occurrences of `defaultTimezone: true` on `main`
(before this branch). Three are the session-teacher selects in §4, which this
branch deletes. Of the remaining 27, only **25** are
`include: { teacher: { select: { defaultTimezone: true } } }` joins across
`src/services/` and `src/app/api/`, and they are correct. They hang off a
*class*, *template* or *registration* row and need **that row's** teacher, which
is not necessarily the session user — and the cron routes have no session at
all. The other two are not row-teacher joins and must not be folded into that
count: `src/app/(public)/[slug]/page.tsx` is a standalone teacher-by-slug
lookup with no row to join against, and
`src/services/class-template-lifecycle.ts:410` is a doc comment that contains
the literal string `defaultTimezone: true`, not a query.

This branch's own edits move the total: Task 1 adds one occurrence (the
session select), and Task 2 deletes three (the page-level lookups), so
30 → 31 → 28. **28, not 27 and not 30, is the count once both tasks land.**

That arithmetic is stated so it can be re-run rather than trusted:
`grep -rn "defaultTimezone: true" src/ | grep -v "\.test\."`. But the grep only
gives a count — classifying each hit as a session select, a row-teacher join,
a standalone lookup, or a doc comment is what actually verifies the claim,
and is the step this document skipped the first time.

The distinction is the whole point: **session-teacher lookups are duplication;
row-teacher joins are not.** Anyone tempted to consolidate them should stop.

Two other things the issue flagged, both resolved by measurement:

- **`pageSlug`** was named as a candidate. It is not one — the site cited
  (`class/[id]/page.tsx`) is a row-teacher join.
- **`settings/profile/page.tsx`** fetches the whole teacher row with no select.
  That is its edit form's source data, legitimately, and it stays.

### 6. No staleness to design around

`validateSession` has no cache wrapper and hits the database on every call, so a
teacher who changes their timezone sees it on the next request. This removes the
usual objection to putting mutable data on a session, and is worth stating
because a future reader will assume the problem exists.

## Testing

- **`src/lib/auth/session.test.ts`** runs a real Prisma client under the `unit`
  project and already has teacher-only, student-only and dual-account fixtures.
  Assertions go there:

  - a teacher-only session carries the teacher's `defaultTimezone`;
  - a dual account carries it too (the union puts it on the teacher branch, and
    a dual account takes that branch);
  - a student-only session does **not** carry the key at all. Assert its
    absence explicitly — `expect(result).not.toHaveProperty('defaultTimezone')`
    — rather than checking it is `undefined`, which passes whether the key is
    missing or present-and-empty. The union's guarantee is about the key.

  Use a timezone other than the schema default (`Europe/Amsterdam`) in at least
  one fixture, so an implementation that hard-codes the default rather than
  reading the column fails.
- **`src/lib/api-utils.test.ts`**'s two teacher-branch fakes gain the field. They
  will fail to compile until they do, which is the mechanism working.
- **The three pages have no unit seam** — `vitest.config.ts` scopes its projects
  to `src/**/*.test.ts` and `src/components/**/*.test.tsx`, so nothing matches
  `src/app/**`. That gap is **#143** and is not in scope here. Their correctness
  rests on the compiler: deleting a query and reading `session.defaultTimezone`
  either type-checks or does not.
- **The reviewable invariant for the whole PR is that no rendered output
  changes.** Any diff in a rendered string is a defect, not an improvement.

## Out of scope

- **#140** — `p.paidAt` on the payments page renders a UTC calendar date instead
  of the teacher's. This PR makes it a one-line fix and deliberately does not
  make it. #138 is a refactor with provably zero behaviour change, reviewable on
  that single claim; #140 changes what a teacher sees and deserves its own test
  and review. The payments page's existing comment already points here.
- **`firstName` on the session** — fails the §3 bar.
- **#143**, the missing page-level test seam.

## Risks

- **`SessionUser` is depended on by every authenticated surface.** This is the
  risk PR #137's spec named when it deferred the work, and it has not gone away
  — it is only bounded. Making the field required converts it from a runtime
  risk into a compile-time one, and the two break sites are both tests.
- **The row-teacher joins are the trap.** Twenty-five call sites use a
  superficially identical `select: { defaultTimezone: true }` and must not be
  touched. A reviewer skimming for "duplication" will find them. §5 exists to be
  quoted at that moment.
- **Deleting a query is invisible in a diff review.** Two of the three sites lose
  their `findUniqueOrThrow` entirely. If a page still needs that row for another
  field and the deletion is over-eager, nothing renders differently until the
  missing field is read — so the "zero rendered output changes" check must be
  performed against the running app, not inferred from the diff.
