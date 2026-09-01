# A raced create answers with the same code its pre-check does

**Issue:** #161
**Date:** 2026-09-01
**Status:** design

## What the issue asked for, and what is actually there

#161 names five race windows across four routes: a check-then-create that
pre-checks a unique constraint, returns its own coded 409 when the pre-check
hits, and — losing the race — falls through to `withErrorHandler`'s generic
fallback, which answers `"Resource already exists"` with **no error `code` at
all**.

The mechanism is real and the goal is right. The table is not: it was written
against a tree that has since moved.

| # | #161's row | Verdict, measured 2026-09-01 |
|---|---|---|
| 1 | `teacher-rooms/route.ts:55-69`, `TeacherRoom @@unique([teacherId, roomId])`, own code `DUPLICATE` | **Holds.** Now `:56-77`. |
| 2 | `students/route.ts:112-124`, `TeacherStudent @@unique([teacherId, studentId])`, code `ALREADY_LINKED` | **Moved, and the constraint is a different one.** #166/#170 rewrote the route; it writes no `TeacherStudent`. The create reachable from it is `invitation.create` at `services/invitations.ts:210`, on `Invitation @@unique([teacherId, email])`. Window real; code is `ALREADY_INVITED`. |
| 3 | `students/route.ts:126-134`, `tx.student.create` on `Student.email @unique` | **Gone.** #166 retired the unclaimed student. No such create exists — see the census below, which finds exactly two `student.create` sites in `src/` and neither is here. |
| 4 | `teachers/route.ts:31-50`, `Account.email`/`Teacher.pageSlug`, `EMAIL_TAKEN`/`SLUG_TAKEN` | **Holds.** Now `:31-52`. #161 names two unique keys; there are three (below). |
| 5 | `auth/student-signup/route.ts:34-50`, leaks account existence | **Already fixed**, by commit `0fb73461` ("let a raced signup answer 200"). It catches `P2002`, narrows on `isUniqueConflictOn(err, ['email'])`, logs `warn`, and falls through to the uniform 200 — precisely the fix #161 specifies, its "the correct answer is not a 409 at all" clause included. |

**Row 5 is the issue's headline harm and half its title.** The account-existence
oracle described under *"Why it matters beyond the copy #1"* does not exist
today. Nothing in this spec addresses it, because there is nothing to address.

#161 states its table as "a floor... not an exhaustive sweep of every `create`".
That sweep is below, and it finds a sixth window the table missed.

## The census

Every `create` reachable from an API route, and how each one is (or is not)
kept off the generic fallback. Re-derive with:

```bash
grep -rn "\.create({\|createMany" src/app/api --include="*.ts" | grep -v "\.test\."
grep -rn "\.create({" src/services --include="*.ts" | grep -v "\.test\."   # then filter to route-reachable
```

11 sites under `src/app/api/`, plus 1 service create reachable from a route
(`services/invitations.ts:210`, from `POST /api/students`) = **12 candidate
sites**. They fall into five buckets:

| Bucket | Count | Sites |
|---|---|---|
| Cannot collide — no unique key, or the key is a freshly-minted id | 3 | `announcements:132` (`Announcement` declares no unique constraint), `classes:127` and `studio-classes:100` (both create on the entry id just returned) |
| Already refuses via `ON CONFLICT DO NOTHING` | 2 | `classes:114`, `studio-classes:87` — `createManyAndReturn({ skipDuplicates: true })` on the slot exclusion |
| Already catches `P2002` at the route | 2 | `rooms:96` (both identity indexes), `auth/student-signup:44` |
| No pre-check at all — a different question, out of scope | 1 | `auth/passkey/register/verify:36` |
| **Live window** | **4** | `account/student-profile:54`, `teacher-rooms:69`, `teachers:41`, `services/invitations.ts:210` |

3 + 2 + 2 + 1 + 4 = 12. ✓

The fourth live window is not in #161:

**`POST /api/account/student-profile`.** Its pre-check is `session.studentId`
→ 409 `ALREADY_STUDENT`. Two concurrent "join as a student" requests both read
a session with no `studentId`, both find no unclaimed row to claim, and both
reach the `create`; the loser collides and gets the code-less 409. Same
double-tap shape #161 describes for signup, on an authenticated route.

`auth/passkey/register/verify:36` is excluded deliberately: it has no
pre-check, so there is no coded answer to mirror. What re-registering an
already-registered credential *should* do is a design question, not a copy
fix, and dragging it in would put a decision inside a cleanup.

## The design

Per route, catch `P2002` around the `create` and answer with the same code the
pre-check answers with. The pre-check stays — it is the common path and saves a
round trip; the catch is only the race's tail. This is #161's own prescription
and the codebase's established idiom (`rooms`, `auth/student-signup`,
`PUT /api/invitations/[id]`).

**Match on the column set via `isUniqueConflictOn`, never on `err.code ===
'P2002'` alone.** `unique-conflict.ts` is the measured matcher: it compares
`meta.target` as a set, and its docblock records that Prisma reports the
column-name array even for indexes it cannot see. A bare `P2002` check would
swallow a future constraint on the same create under reasoning that was only
ever established for today's keys — the failure mode `auth/student-signup`'s
catch already documents at length and defends against.

**An unrecognised `P2002` must not be rethrown as a `P2002`.** `classifyApiError`
answers any `P2002` with the code-less 409 this issue exists to remove, so a
rethrow would deliver the same defect through the other door. Follow
`auth/student-signup:88-92`: log at `error` with the raw target, then throw an
ordinary `Error` so it classifies 500.

### Window 1 — `POST /api/teacher-rooms`

`TeacherRoom` has two unique keys: `@@unique([teacherId, roomId])` and
`@@unique([id, isArchived])`. The second is on a freshly-minted uuid and cannot
collide.

- `isUniqueConflictOn(err, ['teacherId', 'roomId'])` → 409 `DUPLICATE`,
  message `'Teacher-room link already exists'` — byte-identical to the
  pre-check at `:66`.

### Window 2 — `inviteContact`, reachable from `POST /api/students`

`Invitation @@unique([teacherId, email])`.

- `isUniqueConflictOn(err, ['teacherId', 'email'])` → `{ ok: false, reason:
  'ALREADY_INVITED' }`, which the route already maps to
  `respondError(REFUSAL_MESSAGES.ALREADY_INVITED, 409, 'ALREADY_INVITED')`.

`ALREADY_INVITED` is exact here, not approximate, and the reason is a census:
**`:210` is the only `Invitation` INSERT in the module.** Every other write to
that table (`:274`, `:600`, `:640`, `:802`) is an `updateMany` against a row
that already exists. So the row that won this race was inserted by another
`inviteContact` moments earlier, and `Invitation.status` is `@default(pending)`
— the exact state `ALREADY_INVITED` names. Had any other writer been able to
INSERT, the winner could have been a `declined` tombstone and this answer would
have been wrong.

This also matches the standing precedent: `PUT /api/invitations/[id]:170`
already answers `ALREADY_INVITED` for a `P2002` on this same constraint, and
says in its own comment that it is "the same code `POST /api/students` answers
with, since it is the same constraint."

The catch belongs in the service, not the route — the route never sees the
`create`, and `InviteRefusal` is the service's own vocabulary.

### Window 3 — `POST /api/teachers`

Three unique keys are reachable, where #161 names two. `teacher.create` writes
`Teacher` with a nested `account: { create: { email } }`:

- `Account.email @unique` → `meta.target` `['email']`
- `Teacher.email @unique` → `meta.target` `['email']`
- `Teacher.pageSlug @unique` → `meta.target` `['pageSlug']`

(`Teacher.accountId @unique` cannot collide — the nested create mints a fresh
account.)

The first two are indistinguishable by column set, and that is fine: they mean
the same thing to the caller. The schema's own header comment records why they
cannot disagree — *"Profile email columns are denormalized copies set at link
time; live linked profiles match the account's email by construction, and there
is deliberately no email-change flow"*.

- `isUniqueConflictOn(err, ['email'])` → 409 `EMAIL_TAKEN`, `'Email already in use'`
- `isUniqueConflictOn(err, ['pageSlug'])` → 409 `SLUG_TAKEN`, `'Page slug already in use'`

This is the one window where the missing code has a concrete cost beyond copy,
and #161 states it correctly: the settings form renders an inline error against
the offending field, so a code-less 409 leaves the teacher told that *something*
is taken with no way to learn which but to change one field and retry blind.

### Window 4 — `POST /api/account/student-profile`

**Catch both `['accountId']` and `['email']`, and map both to
`ALREADY_STUDENT`.**

Catching only one would be a guard that passes its test and fails in
production. A double-tap writes the same `accountId` *and* the same `email`, so
**both** unique keys collide and Postgres reports whichever index it reaches
first — not something this code can predict. Which one actually arrives is to
be **measured**, not assumed (see Verification below); the fix covers both
either way.

**This is not an account-existence oracle, and the reason is structural.** The
route sits behind `requireSession`, reads `email` off the caller's own account
row, and writes a `Student` for the caller's own `accountId`. There are exactly
two `student.create` sites in all of `src/`:

```bash
grep -rn "student\.create" src --include="*.ts" | grep -v "\.test\."
# src/app/api/auth/student-signup/route.ts:44
# src/app/api/account/student-profile/route.ts:54
```

So the row that could have landed in the gap is one of exactly two things.
Another `student-profile` for the same account — the caller's own. Or a
`student-signup` for the same address — impossible, because that route's
`if (!existingAccount && !existingStudent)` guard sees the caller's account and
skips its create entirely. `Account.email @unique` is what closes the case: no
*other* account can hold this address, so no *foreign* `Student` row can be the
one that collided.

The disclosed fact is therefore always "your own account acquired a student
profile a moment ago" — which the caller reads off their own session on the
next request. `auth/student-signup` was different **because it is
unauthenticated**: its 409 told an anonymous stranger an address was free.
Authentication is the whole difference between the two, and it is why that
route's answer is a 200 and this one's is a coded 409.

- `isUniqueConflictOn(err, ['accountId']) || isUniqueConflictOn(err, ['email'])`
  → 409 `ALREADY_STUDENT`, `'Account already has a student profile'` —
  byte-identical to the pre-check at `:22`.

## The stale claim this work falsifies

`src/lib/api-errors.ts:498-503` reads:

> Reaching this branch means a route's own check-then-create lost its race —
> **at least four routes have that window today** — or a route never
> pre-checked at all.

A prose count, in a comment, about routes in other files. CLAUDE.md's *Comment
Discipline* forbids exactly this: a claim reaching past its own file has no
owner, because the person who invalidates it never sees it. This branch is
where the count would be read and where nothing could keep it honest.

**Replace it, do not annotate it** — the before-and-after belongs in the PR
body. The replacement states the invariant instead of counting: reaching this
branch means a `create` raised a `P2002` that its own caller did not recognise,
which is a route that never pre-checked or a catch that has fallen behind its
constraint. No number, so nothing to go stale.

## Verification

**Force a real race; do not stub the create.** #161 offers stubbing as
sufficient. It is not the right instrument here, for three reasons:

1. These are integration tests against the dev server on `:3000`, over HTTP.
   The route's internals are not reachable to stub.
2. This codebase already has a deterministic lever for a true race, worked out
   in `tests/integration/signup-api.test.ts:196-235`: an **uncommitted holder**.
   A second `PrismaClient` inserts the conflicting row inside an open
   transaction; both requests sail past their pre-checks (uncommitted rows are
   invisible under READ COMMITTED), both park on the pending unique-index
   entry, and the holder commits so they lose. It is not flaky — the
   interleaving is forced, not raced for. That the surviving row is the
   *holder's* is the proof the lever bit.
3. **Only a real race can answer the `student-profile` question.** A stub
   asserts whichever constraint the test author wrote into the fixture, which
   is precisely the assumption under test.

Per window: one test that forces the race and asserts **status and `code`**,
and — the observable completion signal #161 names — that
`withErrorHandler`'s `warn` for an escaped `P2002` does not fire.

**Prove every guard bites** (CLAUDE.md rule 3, and this project's standing
rule). Per window, break the catch, record the exact failure text, restore,
re-verify. The mutation that matters is not "delete the catch" — it is
**narrow the column set to the wrong key**, because that is the realistic
regression: a constraint gets added or renamed and the matcher silently stops
matching. For `student-profile` specifically, the mutation is *catch only
`['accountId']`* — if the suite still passes, the test is not exercising the
non-determinism this design exists to cover.

**Warm the touched routes before scoring any mutation.** `next dev` compiles
lazily and a first-request compile can blow a timeout that reads exactly like
an assertion failure.

## Out of scope

- **Changing `withErrorHandler`'s fallback copy or giving it a `code`.** #161
  rules this out and #121 established why: the wrapper is the last resort, and
  the fix belongs at the routes that can produce the collision so the fallback
  stays rare and generic. Only the stale *comment* on that branch changes.
- **Widening pre-checks into transactions or advisory locks.** Catching
  `P2002` is cheaper and is already the idiom.
- **`auth/passkey/register/verify`.** No pre-check to mirror; see the census.
- **#161's row 5.** Already fixed. **#121 is unaffected.**
