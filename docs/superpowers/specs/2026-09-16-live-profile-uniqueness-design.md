# One live profile per account (#623)

**Issue:** #623 — an account with no live student side is navigated to
`/account/privacy` and silently bounced to `/schedule`.

**Decision:** `Teacher.accountId` and `Student.accountId` trade their hard
`@unique` for hand-authored partial unique indexes scoped
`WHERE "deletedAt" IS NULL`. An account may hold one LIVE profile of each
kind plus any number of erased ones. The bounce disappears because the
control that caused it starts succeeding.

---

## 1. What the issue claimed, and what measurement found

Three of the issue's claims moved. Recording them here because two of the
three are the reason the fix is shaped the way it is.

### 1.1 Case 1 is real, and narrower than stated — CONFIRMED with a correction

`deleteStudentAccount` (`src/services/gdpr.ts:705-719`) anonymises the
`Student` row without clearing `accountId` or `claimedAt` — the `data` of
that `updateMany` names neither column. The account therefore keeps owning
an erased student row, `Student.accountId @unique` refuses a second one, and
`POST /api/account/student-profile`'s create collides and answers
`ALREADY_STUDENT` from its catch (`route.ts:138-142`). `SetUpStudentSide`
reads that code as success and pushes `/account/privacy`, where the
`(student)` layout finds no `session.studentId` and bounces. Confirmed
end to end.

The correction: the issue frames the population as any account with "no live
`Student` row". Only one shape is reachable — **a live teacher beside an
erased student**. `validateSession` (`src/lib/auth/session.ts:86-89`)
*deletes the session* when no live profile remains, so an account holding
only an erased student side cannot be signed in at all; and its
`Account.email` was tombstoned by the same erasure (`gdpr.ts:649-657`, the
`if (!teacherOnAccount)` branch), so a magic link to the real address mints
a fresh account rather than returning to it. The issue comment's population
is the whole population.

### 1.2 `JoinAsStudent` does not navigate to `/account/privacy` — FALSE

The issue states `JoinAsStudent` behaves "identically, since #166". It does
not. Every version of `src/components/booking/join-as-student.tsx` in its
history calls `router.refresh()`; no version has ever called `router.push`.
Re-derive:

```
git log -p --follow -- src/components/booking/join-as-student.tsx | grep -n 'router\.'
```

`SetUpStudentSide:39` is the only client navigation into `/account/privacy`
anywhere in `src/`. The other four references are safe by construction: the
student account page's nav link and the `inbox/invitations` redirect both
require a live student side, `studentNotificationHref` renders only on the
student inbox, and `email-templates.ts:84` is case 2 below.

What `JoinAsStudent` does carry is the pre-#620 defect PR #620 fixed only in
its sibling: it reads **any** 409 as success. Its consequences are assessed
in §7.

### 1.3 Case 2 is real, and its population is not merely empty but unfillable

`notifyInvitee`'s student lookup (`src/services/invitations.ts:628-635`) is
an unfiltered `findUnique` on `email`, so an unclaimed row takes the student
branch. The notification is unreadable in-app (no `accountId`, so no session
reads it) but `processEmailFallback` (`src/services/email-fallback.ts:205-213`)
resolves `Student.email` — the person's real address on such a row — and
`teacher_invitation` is not in `ESSENTIAL_NOTIFICATION_TYPES`, so the send
happens. The button points at `/account/privacy`. All confirmed.

The issue asks for the population to be measured and, at zero, closed. **It
is zero, and no code path in this repository can raise it.** There are two
`Student` creators in the whole repo and both set `claimedAt` unconditionally:

| Site | `claimedAt` |
|---|---|
| `src/app/api/account/student-profile/route.ts:131` | `new Date()` |
| `prisma/seed.ts:324` | `daysAgo(30)` |

Nothing anywhere clears it (`grep -rn claimedAt src/ prisma/` gives readers,
those two writers, and `auth/account.ts:62`, which only ever *sets* it while
claiming). There is no production database for this project, and the
development database returns 0 for the issue's own query against 10 `Student`
rows, of which 0 are unclaimed and 0 soft-deleted.

Case 2 is therefore **closed with the measurement recorded**, not fixed. This
follows a precedent already stated in this codebase: `email-fallback.ts:196-198`
deliberately declines a `deletedAt` filter on the same grounds — *"with (1)
holding, nothing could drive it, and an untestable guard is what this branch
has already shipped too many of."*

### 1.4 What measurement added that the issue does not name

`resolveOrClaimAccount` (`src/lib/auth/account.ts:40-47`) returns early when
an `Account` exists for the address and never reaches its claim branch. So
for case 2's population the stranded row is permanent — signing in does not
repair it — while `POST /api/account/student-profile`'s own `unclaimed`
branch (`route.ts:76-90`) would have claimed it. Recorded because it is the
fact that would matter if that population ever became non-empty; it does not
change this spec's outcome.

---

## 2. The decision, and the three rejected alternatives

**Chosen — partial unique index on liveness.** One account, one *live*
profile of each kind.

Its argument is not generosity. It is that the callers already assume it:
`SetUpStudentSide` maps `ALREADY_STUDENT` to "go to `/account/privacy`", and
that mapping is correct for every account shape *except* the one erasure
manufactures. Under this change, `ALREADY_STUDENT` can only mean a genuinely
live student side — which is exactly when that navigation is right. The
alternative fixes make the caller compensate for a state the schema should
not have admitted.

**Rejected — revive the erased row** (clear `deletedAt`, repopulate from the
teacher profile). The row still carries registrations and payments attributed
to "Deleted Student" (`gdpr.ts` keeps financial history by design). Reviving
re-attaches erased history to the person: `/bookings` would show their
pre-erasure bookings. That undoes a GDPR erasure.

**Rejected — erasure clears `accountId` and `claimedAt`.** `privacyIsBypassed`
(`src/lib/student-visibility.ts:271-273`) returns true for `claimedAt === null`,
so the erased row would begin reading as an unclaimed CRM contact and surface
in teacher directories. No PII escapes — every field is anonymised — but it
puts a tombstone into a security-sensitive module's permissive branch. The
`CHECK (("claimedAt" IS NULL) = ("accountId" IS NULL))` also forces the two
columns to move together, so this cannot be done by halves.

**Rejected — honest refusal only** (a distinct 409 code, an explanatory
message, a server-side gate on `/inbox/invitations`). It closes all four
acceptance criteria and is the smallest change available. It was rejected
because it leaves the person permanently unable to hold a student side with
no exit, and because it adds a second thing to remember rather than removing
the shape that made the first thing wrong. Pre-launch — no production
database, nothing to backfill — is the cheapest moment this project will
ever have for the structural fix.

### 2.1 Both halves, not just the student one

`Teacher.accountId` carries the identical hard `@unique` and the identical
defect: `session.teacherId` is null for a soft-deleted teacher, the pre-check
falls through, and the `accountId` collision answers `ALREADY_TEACHER`
(`src/app/api/account/teacher-profile/route.ts:81-84`). The only difference
is volume — `profile-setup-form.tsx` shows the error and stays put, so it is
honest-but-permanently-stuck rather than a silent bounce.

Both halves ship in one migration. Deferring the teacher half means a second
migration dropping and recreating another index later, against roughly four
lines of work now; and leaving one half a hard `@unique` would express one
invariant two ways with nothing recording which is intended.

---

## 3. Mechanism

### 3.1 Migration

`prisma/migrations/<timestamp>_live_profile_unique_per_account/migration.sql`,
hand-authored, following `prisma/migrations/20260811202634_teacher_slot_unique_indexes/`
— the precedent that established this shape and recorded its own measurement.

```sql
DROP INDEX "Teacher_accountId_key";
DROP INDEX "Student_accountId_key";

CREATE UNIQUE INDEX "Teacher_account_live_unique"
  ON "Teacher" ("accountId")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Student_account_live_unique"
  ON "Student" ("accountId")
  WHERE "deletedAt" IS NULL;
```

The dropped names are exact; they are created at
`prisma/migrations/20260720210151_account_hybrid/migration.sql:72-73`.

`Student.accountId` is nullable, and Postgres treats NULLs as distinct in a
unique index, so many rows with `accountId IS NULL AND deletedAt IS NULL`
continue to coexist exactly as today. `Teacher.accountId` is non-nullable and
unaffected by that consideration.

### 3.2 Schema

`@unique` comes off both `accountId` columns. Prisma requires a one-to-one
relation's foreign key to be unique, so both reverse relations become lists —
this is enforced by `prisma validate`, not merely intended:

```
Account.teacher  Teacher?   ->  Account.teachers  Teacher[]
Account.student  Student?   ->  Account.students  Student[]
```

Each model gains a `///` docblock naming its invisible index, per the
convention `Room` sets at `prisma/schema.prisma:292-298`: a partial index
cannot appear in this file unless a comment keeps it visible.

### 3.3 Drift

`prisma migrate diff --from-schema-datasource --to-schema-datamodel --exit-code`
does not see a partial unique index. Measured and recorded by the precedent
migration's own header; re-derivable with the command `unique-conflict.ts`
ships:

```
SELECT indexname FROM pg_indexes WHERE schemaname='public'
  AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE%';
```

That census returns 2 today (`Room_public_identity_unique`,
`Room_private_identity_unique`) and 4 after this change. The `DROP INDEX`es
*are* visible to Prisma and arrive with the schema edit that removes
`@unique`, so the datamodel and the database agree afterwards.

### 3.4 `isUniqueConflictOn` is unaffected, and this is load-bearing

Two branches consume `accountId` uniqueness as an error —
`student-profile/route.ts:138` and `teacher-profile/route.ts:81` — and both
answer a coded 409. If the partial index reported its conflict differently,
both would fall through to their routes' unrecognised-P2002 throw and become
500s.

`src/lib/unique-conflict.ts:7-14` already states, with a measurement, that a
hand-authored partial unique index reports `meta.target` as the column-name
array identically to a declared `@unique`. That docblock's evidence names one
index; this change makes it four, so the build re-runs the census and extends
the citation rather than inheriting the claim. The existing #161 double-tap
race test (`tests/integration/account-api.test.ts:859`) is the empirical
proof: it must still answer `ALREADY_STUDENT`, not 500.

---

## 4. The liveness obligation, which is the real work

A relation-wide sweep found **five** production sites reading
`Account -> Teacher` or `Account -> Student` by name. Tests, `prisma/seed.ts`
and `scripts/` read the relation nowhere; no raw SQL, `where:` traversal,
`orderBy` traversal, `include:`, destructuring, or hand-written
`Prisma.Account*` type references exist anywhere in the repo.

| Site | Today | Obligation |
|---|---|---|
| `src/lib/auth/session.ts:79-85` | selects `deletedAt`, filters in JS | filter in the query |
| `src/lib/auth/account.ts:36-45` | selects `deletedAt`, filters in JS | filter in the query |
| `src/app/api/auth/passkey/register/options/route.ts:22-29` | **no liveness filter** | filter in the query — see §6 |
| `src/app/api/auth/passkey/authenticate/verify/route.ts:52-54` | selects `deletedAt`, filters in JS | filter in the query |
| `src/services/invitations.ts:669-674` | **no liveness filter** | filter in the query |

**Every site filters `deletedAt: null` in the query, not in JavaScript
afterwards.** `src/services/gdpr.ts:645-648` already writes it this way and
is the shape to copy.

The two sites with no filter today are why this is stated as an obligation
rather than a refactor. `invitations.ts:673` (`if (account?.teacher)`) is
*correct* today, and the reason interlocks two facts: reaching that branch
means no `Student` row holds the address, and `deleteTeacherAccount` leaves
`Account.email` intact only when a live student remains — whose denormalised
email would have matched the student branch first. This change breaks that
interlock. With erased teachers permitted alongside a live one,
`account.teachers[0]` may be a tombstone, and `inviteeTeacherId` would name
an erased teacher. An unfiltered translation of these two sites is a
regression this change introduces; the filter is what prevents it.

### 4.1 `liveProfile`, because a compile-time guarantee is being spent

`Account.student` typed `Student?` makes at-most-one a fact the compiler
knows. A list does not, and the partial index enforces it only at runtime.
A small helper keeps the loss loud rather than silent:

```ts
/** The one live profile of a kind on an account, or null. Throws on more
 *  than one, which the partial unique index makes unreachable. */
function liveProfile<T>(rows: T[]): T | null {
  if (rows.length > 1) throw new Error('account holds more than one live profile');
  return rows[0] ?? null;
}
```

Lives in `src/lib/live-profile.ts` — the five sites span `src/lib/auth/`,
`src/app/api/` and `src/services/`, so it belongs to none of them. Without it, an index that was dropped or never
applied degrades to silently selecting an arbitrary row — and on two of the
five sites that row can be a tombstone. The project already throws on
invariant violations of this shape (`student-profile/route.ts:187`).

### 4.2 A standing invariant check

`scripts/verify-account-backfill.sql` opens by promising every count in it is
zero. It gains the fact this index buys, for both tables:

```sql
SELECT 'accounts with two live students', count(*) FROM (
  SELECT "accountId" FROM "Student"
   WHERE "accountId" IS NOT NULL AND "deletedAt" IS NULL
   GROUP BY "accountId" HAVING count(*) > 1) t;
```

---

## 5. What this change does NOT touch

- **`src/services/gdpr.ts`.** The erasure keeps `accountId` on the row it
  tombstones, which the partial index now permits alongside a new live one.
  Erasure semantics are unchanged in both directions.
- **`CHECK (("claimedAt" IS NULL) = ("accountId" IS NULL))`.** An erased row
  holds both, a new live row holds both, a legacy unclaimed row holds
  neither. Unaffected in every case.
- **`src/app/(student)/account/privacy/page.tsx`.** It reads
  `session.studentId` and `account.email`; neither changes. Its
  `export const dynamic = 'force-dynamic'` also means the post-fix navigation
  re-renders rather than serving a cached bounce.
- **The `Teacher.account` / `Student.account` back-edges.** Many-to-one, and
  used only as `account: { create: { email } }` nested writes.
- **`TeacherBlock`.** Keyed `(teacherId, email)`, so a refusal recorded
  before an erasure still blocks the new profile. Correct, and deliberate.
- **`Student.email @unique`.** A new live row takes the account's real
  address; the erased row's was tombstoned, so they cannot collide. The
  route's `unclaimed` lookup cannot find the erased row for the same reason.

---

## 6. Folded in: the passkey display name

`src/app/api/auth/passkey/register/options/route.ts:29` reads
`account.teacher ?? account.student` with no liveness filter on either side.
An account whose *teacher* side was erased while its student side stayed live
takes the `??`'s left branch — the tombstone — and registers the credential
as `Deleted Teacher` (`gdpr.ts:1423-1424` writes exactly those two strings).
That name lands permanently in the viewer's operating-system credential
manager.

Reachable today with no blocking condition: hold both profiles, erase the
teacher side, register a passkey. It is folded in rather than filed because
§4 requires editing that exact expression regardless. The comment at
`:16-17` ("name it after whichever profile exists (teacher first)") stops
being precise and is corrected with it.

---

## 7. Declined, with the path named

**`JoinAsStudent`'s any-409-as-success.** Under this change its reachable
409s are `ALREADY_STUDENT` from a double-tap — whose `router.refresh()` then
renders the correct booking flow — and `NO_PROFILE_SOURCE`, which
`student-profile/route.ts:54-64` documents as unreachable by construction. An
unrecognised P2002 throws a plain `Error` and surfaces as 500, not as the
code-less 409 that `readErrorMessage` would misread. No reachable path leads
to a wrong outcome, so this is declined rather than folded: it is loose, not
defective.

---

## 8. Claims this change falsifies

Swept rather than recalled. Dated records under `docs/superpowers/specs/` and
`docs/superpowers/plans/` are deliberately **not** rewritten — a plan is a
record of what was decided then.

| Location | What is falsified |
|---|---|
| `prisma/schema.prisma:132` | "profiles optionally hanging off it" reads as 0-or-1 |
| `prisma/schema.prisma:135-137` | "live linked profiles" now carries weight it did not |
| `src/services/rule-lifecycle.ts:1087-1089` | "`Teacher.email`, `pageSlug` and `accountId` are all `@unique`" |
| `src/app/api/account/teacher-profile/route.ts:44-46` | "every branch ... names a unique constraint" |
| `src/app/api/account/teacher-profile/route.ts:92` | log string "neither the slug, the email nor the account key" |
| `src/app/api/account/student-profile/route.ts:120-122` | same as the teacher route's |
| `src/lib/unique-conflict.ts:7-14` | census of hand-authored partial indexes goes 2 → 4 |
| `src/services/invitations.ts:665-668` | "why this one needs no teacher liveness filter" |
| `tests/integration/account-api.test.ts:819-823` | names `Student_accountId_key` directly |
| `docs/data-model.md:18` | "via their own **unique** `account_id`" |
| `docs/data-model.md:659` | "via their **unique** `account_id`" |
| `docs/data-model.md:151` | "an erased teacher's account keeps a truthy `account.teacher`" — names the renamed field AND rests on the behaviour being restructured; moves together with `invitations.ts:665-668`, which cites it |

`rule-lifecycle.ts:1087-1089` is corrected by **removing** `accountId` from
the roster, not by asserting something about it. Its conclusion — that an
update touching one of those columns takes `FOR UPDATE` — stands on `email`
and `pageSlug`, both still plainly `@unique` in the model next door. Whether
Postgres counts a partial unique index among a relation's key columns is
deliberately not relied upon and not claimed; nothing in this repository
updates `Teacher.accountId` at all.

---

## 9. Tests

1. **The index, both directions.** One live plus N erased rows per account is
   accepted; a second LIVE row is refused. Both tables. This is the guard, so
   it is proven by breaking it: drop the index, watch the refusal stop
   happening, record the exact error text, restore, re-verify.
2. **Acceptance criterion 1 and 3, student side.** An account with a live
   teacher and an erased student POSTs `/api/account/student-profile` and
   receives **201 with a new `studentId`** — not `ALREADY_STUDENT`. The
   session then carries it and `/account/privacy` renders instead of
   redirecting.
3. **The teacher mirror.** A live student beside an erased teacher can create
   a teacher profile.
4. **`ALREADY_STUDENT` still means what it says.** The existing #161
   double-tap race test must stay green — a genuinely live student side still
   answers the coded 409 rather than a 500. This is §3.4's empirical proof.
5. **The passkey display name** is the live profile's, not `Deleted Teacher`.
6. **No erased row is ever selected** at either of the two sites that lack a
   filter today — in particular `notifyInvitee` resolves a live
   `inviteeTeacherId` when the account also holds an erased teacher.

---

## 10. Risks

- **A silent wrong-row pick** if a site is translated without its filter.
  §4.1's helper turns the two-row case loud, but it cannot catch a single
  tombstone where a live row was expected — only the query filter does.
  Every one of the five sites is named in §4 so none is translated by
  pattern-matching.
- **`isUniqueConflictOn` regressing to 500s.** Mitigated by test 4, which
  fails loudly rather than subtly.
- **Build environment.** A regenerated Prisma client is required, and the
  development server on `:3000` belongs to the user. This work runs in a git
  worktree with its own database and application, per the `verify` skill.
