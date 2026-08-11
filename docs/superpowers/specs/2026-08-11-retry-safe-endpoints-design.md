# Nine endpoints duplicate their side effect, and six more do it only when you look at the clock

Spec for #196. The issue is decision-gated: it asks whether nine endpoints
should be made retry-safe, but the mechanism depends on a product question the
issue could not answer for itself. That question is answered in §1, in writing,
before any design.

This spec covers the whole decision. It is implemented across **two branches**
(§8); branch 1 is the migration half.

---

## 1. The decision this issue was gated on, and the answers

Four product questions, answered by Ivo on 2026-08-11 before any design work.

| Question | Answer | Mechanism it forces |
|---|---|---|
| May a teacher deliberately send two identical announcements? | **No** — suppress an identical `(teacher, class, body)` inside a short window | content comparison + time window. No intent token |
| Is it ever legitimate for one teacher to have two classes at the same date and start time? | **No, never** | a Postgres unique constraint |
| Is a second payment reminder for the same debt legitimate? | **Yes, after a cooldown** | a timestamp column, which already exists |
| A second magic link before the first is used? | **Resend, and the first link stays valid** | reuse the live token |

**The gate resolved to the issue's option 2 (per-endpoint natural keys), not
option 1 (universal idempotency keys).** There is no `IdempotencyKey` table, no
`withErrorHandler` middleware change, and no client plumbing anywhere in this
design.

The reason is worth recording, because the issue assumed the opposite. An
idempotency key is only *required* when the server cannot otherwise tell an
accidental repeat from a deliberate one — which happens exactly when a
deliberate identical repeat is legitimate. Three of the four answers above make
repetition either illegitimate (announcements, classes) or expressible as a
natural key (`reminderSentAt`, the live token). Announcements was the only
candidate that could have forced the expensive mechanism, and the answer was no.

### The announcement window: why a lock rather than an index

Three race-safe shapes were considered. `Announcement.message` is `@db.Text`,
too long for a btree key, so **every index-based design must index a hash** —
and a hash collision in a unique index silently rejects a legitimate
announcement, unreproducibly. With `pg_advisory_xact_lock` the hash is used only
for mutual exclusion and the duplicate test compares the real message text, so a
collision costs a few milliseconds of needless serialisation and nothing else.
A time-bucketed index has a second, independent leak: two sends straddling a
bucket edge both pass.

Two traps, both recorded because both are easy to get wrong:

- It must be `pg_advisory_xact_lock`, **never** `pg_advisory_lock`. The
  transaction-scoped variant releases on commit or rollback; the session-scoped
  one leaks a lock onto a pooled connection.
- Window: **2 minutes**. A network retry lands within seconds and a double-click
  within one.

---

## 2. What the issue claimed, and what measurement found

### 2.1 The census was re-derived server-first

The issue's census enumerated mutating `fetch` call sites and derived
`(method, route)` pairs from them. That method has a structural blind spot: an
endpoint no client currently calls is invisible to it. It is the same blind spot
that produced the issue's own `47 → 49` correction, and #196's text — "or any
future caller" — is itself an argument that the denominator should be the API
surface, not the set of things that reach it.

So this census enumerates **route handlers**, not call sites:

```
Mutating (method, route) pairs under src/app/api/         = 56
  across route.ts files exporting ≥1 mutating method      = 47

  IDEMPOTENT                                              = 27
  CONFLICT (4xx, "already in that state")                 = 20
  DUPLICATE (2xx, side effect happens twice)              =  9
                                              27 + 20 + 9 = 56 ✓
```

**Beware the 47.** It is the number of *files* exporting a mutating method, and
it collides exactly with the pair count the issue published. They are different
quantities that happen to be equal.

`POST /api/rooms` is a split: DUPLICATE on its private branch, CONFLICT on its
public one. One pair, two behaviours. It is counted as DUPLICATE — its worse
branch — and named here so the count can be re-derived either way.

### 2.2 All 56 rows

The prior census published totals (22/18/9) and never enumerated its members.
**A count without its member list cannot be diffed.** You can see that numbers
moved and never which rows moved, which is how a scope error survives its own
correction — #40's spec patched the totals without making the set inspectable.
So the full table is here.

Axis 1 is a sequential retry ("the first request already committed"). Axis 2 is
a concurrent double-submit (§3).

| Method | Route | Axis 1 | Axis 2 |
|---|---|---|---|
| DELETE | /api/account | CONFLICT | RACE-UNSAFE ⚠ |
| POST | /api/account/student-profile | CONFLICT | RACE-SAFE |
| POST | /api/announcements | DUPLICATE | N/A |
| POST | /api/auth/magic-link/send | DUPLICATE | N/A |
| POST | /api/auth/magic-link/verify | CONFLICT | RACE-SAFE |
| POST | /api/auth/passkey/authenticate/options | IDEMPOTENT | N/A |
| POST | /api/auth/passkey/authenticate/verify | CONFLICT | RACE-SAFE |
| POST | /api/auth/passkey/register/options | IDEMPOTENT | N/A |
| POST | /api/auth/passkey/register/verify | CONFLICT | RACE-SAFE |
| DELETE | /api/auth/session | IDEMPOTENT | RACE-SAFE |
| POST | /api/auth/student-signup | DUPLICATE | N/A |
| POST | /api/class-templates | DUPLICATE | N/A |
| PATCH | /api/class-templates/[id] | IDEMPOTENT | RACE-SAFE |
| PUT | /api/class-templates/[id] | IDEMPOTENT | RACE-SAFE |
| POST | /api/classes | DUPLICATE | N/A |
| PUT | /api/classes/[id] | IDEMPOTENT | RACE-SAFE |
| POST | /api/classes/[id]/complete | CONFLICT | RACE-SAFE |
| POST | /api/classes/[id]/transition | CONFLICT | RACE-SAFE |
| POST | /api/cron/auth-cleanup | IDEMPOTENT | RACE-SAFE |
| POST | /api/cron/email-fallback | IDEMPOTENT | RACE-UNSAFE ⚠ |
| POST | /api/cron/generate-classes | IDEMPOTENT | RACE-SAFE |
| POST | /api/cron/payment-reminders | IDEMPOTENT | RACE-SAFE |
| POST | /api/cron/transition-classes | IDEMPOTENT | RACE-SAFE |
| DELETE | /api/invitations/[id] | CONFLICT | RACE-UNSAFE ⚠⚠ |
| PATCH | /api/invitations/[id] | IDEMPOTENT | RACE-UNSAFE (benign) |
| PUT | /api/invitations/[id] | IDEMPOTENT | RACE-UNSAFE ⚠ |
| POST | /api/invitations/[id]/respond | CONFLICT | RACE-SAFE |
| POST | /api/notifications/[id]/read | IDEMPOTENT | RACE-UNSAFE (benign) |
| POST | /api/payments/[id]/paid | CONFLICT | RACE-SAFE |
| POST | /api/payments/[id]/remind | DUPLICATE | N/A |
| POST | /api/payments/[id]/unpaid | CONFLICT | RACE-SAFE |
| POST | /api/registrations | CONFLICT | RACE-SAFE |
| DELETE | /api/registrations/[id] | CONFLICT | RACE-UNSAFE ⚠ |
| PUT | /api/registrations/[id] | IDEMPOTENT | RACE-UNSAFE † |
| POST | /api/rooms | CONFLICT (public) / DUPLICATE (private) | RACE-UNSAFE (public) ⚠ |
| DELETE | /api/rooms/[id] | CONFLICT | RACE-UNSAFE † |
| PUT | /api/rooms/[id] | IDEMPOTENT | RACE-UNSAFE † |
| POST | /api/students | CONFLICT | RACE-SAFE |
| PATCH | /api/students/[id] | IDEMPOTENT | RACE-UNSAFE (benign) |
| PUT | /api/students/[id] | IDEMPOTENT | RACE-SAFE |
| PUT | /api/students/[id]/privacy | IDEMPOTENT | RACE-SAFE |
| POST | /api/studio-class-templates | DUPLICATE | N/A |
| PATCH | /api/studio-class-templates/[id] | IDEMPOTENT | RACE-SAFE |
| PUT | /api/studio-class-templates/[id] | IDEMPOTENT | RACE-UNSAFE † |
| POST | /api/studio-classes | DUPLICATE | N/A |
| PUT | /api/studio-classes/[id] | IDEMPOTENT | RACE-UNSAFE † |
| DELETE | /api/teacher-links/[teacherId] | CONFLICT | RACE-SAFE |
| POST | /api/teacher-rooms | CONFLICT | RACE-SAFE |
| DELETE | /api/teacher-rooms/[id] | CONFLICT | RACE-UNSAFE † |
| PATCH | /api/teacher-rooms/[id] | IDEMPOTENT | RACE-UNSAFE † |
| PUT | /api/teacher-rooms/[id] | IDEMPOTENT | RACE-UNSAFE † |
| POST | /api/teachers | CONFLICT | RACE-SAFE |
| PUT | /api/teachers/[id] | IDEMPOTENT | RACE-SAFE |
| POST | /api/waitlist | IDEMPOTENT | RACE-SAFE |
| DELETE | /api/waitlist/[id] | IDEMPOTENT | RACE-SAFE |
| POST | /api/waitlist/claim | CONFLICT | RACE-SAFE |

**Legend.** ⚠ = a read-then-write with a duplicable or destructive side effect
behind it; these are §3. **†** = the same unguarded read-then-write shape with
nothing duplicable behind it — an absolute-value write or a delete, where both
racers converge on the same result. Their only cost is that
`DELETE /api/rooms/[id]` and `DELETE /api/teacher-rooms/[id]` surface Prisma's
`P2025` as a 500 rather than a 404, because `classifyApiError` has no branch for
it. That is a real wart and it belongs to #197's family, not this one.

### 2.3 What moved, and the delta that cannot be reconciled

| | Issue | Measured | Δ |
|---|---:|---:|---:|
| Pairs | 49 | 56 | +7 |
| IDEMPOTENT | 22 | 27 | +5 |
| CONFLICT | 18 | 20 | +2 |
| **DUPLICATE** | **9** | **9** | **0** |

**All nine of the issue's DUPLICATE endpoints were confirmed**, and the domain
half verified 10 of 10 inherited claims true — including the subtle one:
`templateId` is `String?` (`schema.prisma:370`, `:462`) and no migration in
`prisma/migrations/` emits `NULLS NOT DISTINCT`, so the "Postgres treats NULLs as
distinct" reasoning holds on evidence rather than assertion.

Six of the seven new pairs are explained: `POST /api/cron/{auth-cleanup,
email-fallback, generate-classes, payment-reminders, transition-classes}` and
`POST /api/teachers` have **no client caller at all**, so a census that starts
from `fetch` call sites cannot reach them by construction.

**The seventh cannot be identified, and that is the finding.** Reconciling it
needs the prior census's member list, which was never published — only its
totals. Recorded rather than guessed.

### 2.4 One inherited claim is false, and it understates the defect

The issue says `POST /api/auth/student-signup` sends "a second welcome email".
**There is no welcome email in this codebase.** `route.ts:53` calls
`sendMagicLinkEmail`, and both the token mint (`:51`) and the send sit *outside*
the `if (!existingAccount && !existingStudent)` guard that ends at `:50`. What
duplicates is a **second live sign-in credential**, not a courtesy message.

That also means one fix closes two of the nine: `magic-link/send` and
`student-signup` mint through the same `generateMagicLinkToken` helper.

---

## 3. Six defects the sequential axis structurally could not see

The issue's census asked "what happens when the second request arrives *after
the first committed*". A double-submit usually fires both requests before either
commits. Prisma's default isolation is Read Committed, so a `findFirst`-then-
`create` pre-check does **not** become safe by being wrapped in `$transaction` —
only a unique constraint or a compare-and-swap makes it safe.

Classifying every pair on that second axis found six endpoints filed CONFLICT or
IDEMPOTENT whose guard cannot hold under a genuine double-click:

| Endpoint | What a concurrent double-submit does |
|---|---|
| `DELETE /api/invitations/[id]` | **Destroys the decline tombstone.** The status pre-check reads `pending`; a decline commits in the gap; `delete({ where: { id } })` has no status scope. Re-invite then succeeds |
| `PUT /api/invitations/[id]` | Same hole — editing the email off a declined row frees the address (`route.ts:94`) |
| `DELETE /api/registrations/[id]` | In the final-hour broadcast, every waiting student gets **two** `spot_available` notifications and two emails (`waitlist.ts:659-674`, no capacity check, no guard) |
| `POST /api/cron/email-fallback` | Two overlapping sweeps **both send real emails** — `markEmailSent` (`notifications.ts:216-219`) has no `emailSent: false` in its `where` and no count check |
| `DELETE /api/account` | GDPR erasure runs twice; `handleSpotFreed` double-sends the `spot_available` set |
| `POST /api/rooms` (public) | Two identical rooms in the shared cross-teacher namespace — `findFirst` `:61-68` then `create` `:74`, with no unique on `Room` |

The invitation pair is the sharpest, because `invitations/[id]/route.ts:130-134`
**states the invariant it fails to enforce**:

> The tombstone must outlive the teacher's wish to be rid of it. If this row
> could be deleted, delete-then-re-invite would restore exactly the harassment
> loop that declining exists to end.

Anyone who reads that guard confirms it. Only asking "what if the row changed
underneath me?" finds it.

`POST /api/cron/email-fallback` has a sibling that shows the correct shape:
`payment-reminders.ts:74-82` does a conditional `updateMany` and returns early on
`count === 0`. The fallback sweep is the same operation without the CAS.

**15 defects across 14 endpoints** (rooms carries two).

---

## 4. Design

### 4.1 Branch 1 — five endpoints, one hand-authored migration

Prisma cannot express partial indexes, so these are raw SQL, following
`prisma/migrations/20260721061528_student_claim_link_check/`. They are **partial
on purpose**: a cancelled class must not block re-creating that slot, and an
archived template must not block a new one.

```sql
CREATE UNIQUE INDEX "Class_teacher_slot_unique"
  ON "Class" ("teacherId", "date", "startTime")
  WHERE status <> 'cancelled';

CREATE UNIQUE INDEX "StudioClass_teacher_slot_unique"
  ON "StudioClass" ("teacherId", "date", "startTime")
  WHERE "cancelledAt" IS NULL;

CREATE UNIQUE INDEX "ClassTemplate_teacher_slot_unique"
  ON "ClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

CREATE UNIQUE INDEX "StudioClassTemplate_teacher_slot_unique"
  ON "StudioClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" ("address", "floor", "roomName")
  WHERE "isPublic" = true;

CREATE UNIQUE INDEX "Room_private_identity_unique"
  ON "Room" ("createdById", "address", "floor", "roomName")
  WHERE "isPublic" = false;
```

The room key `(address, floor, roomName)` is not chosen here — it is the key the
existing dedupe already uses (`rooms/route.ts:61-68`). The private index is
scoped by `createdById` because two teachers each keeping a private room at one
address is legitimate; that is what `TeacherRoom`'s per-teacher rate model
assumes.

**Each index gets a `///` comment on its model in `schema.prisma`.** Prisma
cannot see these indexes (§7), so `schema.prisma` will not show them and no
future `migrate dev` will drop them — safe, but silent. The comment is the only
thing that tells the next reader they exist.

Route changes: each of the five `create` calls surfaces `P2002` as a **409 with
a message naming the clash**, not the generic "Resource already exists".
`withErrorHandler` already maps P2002 to 409 (`api-errors.ts:248-256`); these
routes catch it first to say which slot is taken.

### 4.2 Branch 2 — nine endpoints, no schema change

Recorded here so the decision lives in one place; not implemented on branch 1.

**These nine are not #196's nine.** Both sets happen to have nine members and
they overlap in only four (`announcements`, `remind`, `magic-link/send`,
`student-signup`). #196's nine are the DUPLICATE rows of §2.2; these nine are
"needs no migration". Same trap as the `47` in §2.1 — two different quantities
that happen to be equal.

| Endpoint | Mechanism |
|---|---|
| `POST /api/announcements` | `pg_advisory_xact_lock` on `hash(teacherId, classId, message)`, then compare-recent-then-insert, 2-minute window |
| `POST /api/payments/[id]/remind` | CAS on the **existing** `Payment.reminderSentAt` (`schema.prisma:536`), copying `payment-reminders.ts:74-82`. The column is already written at `payments.ts:193` and never read |
| `POST /api/auth/magic-link/send` | Reuse the live unconsumed token rather than minting a second |
| `POST /api/auth/student-signup` | Same helper; additionally move the mint+send inside the existing guard |
| `DELETE /api/invitations/[id]` | `deleteMany({ where: { id, status: { not: 'declined' } } })` + count check |
| `PUT /api/invitations/[id]` | Same status scope on the update's `where` |
| `DELETE /api/registrations/[id]` | Guard the final-hour broadcast against re-sending |
| `DELETE /api/account` | Scope the erasure write by `deletedAt: null` |
| `POST /api/cron/email-fallback` | `emailSent: false` in `markEmailSent`'s `where` + count check |

---

## 5. Interactions the constraints create

Three, all found by reading rather than by testing, and each needs an explicit
answer because each changes behaviour that exists today.

### 5.1 The generator must pre-check, because its `P2002`-skip does not work

`class-generator.ts:123-126` catches `P2002` and `continue`s, commented *"a
concurrent run created this instance first"*, and the function's docblock claims
it generates *"idempotently (`@@unique([templateId, date])` + P2002-skip)"*.

**That claim is false on four of its five call sites, and it was measured, not
reasoned about.** `generateInstancesForTemplate` takes
`PrismaClient | Prisma.TransactionClient`, and it is passed a **transaction
client** by `class-templates/route.ts:63`, `class-template-lifecycle.ts:456`,
`class-generator.ts:265`, and `template-sync.ts:119`. In Postgres a statement
error inside a transaction aborts the whole transaction. Probed directly against
this schema on a throwaway database:

```
inside $transaction : duplicate → P2002 caught
                      next insert → 25P02 "current transaction is aborted,
                                    commands ignored until end of transaction block"
autocommit          : duplicate → P2002 caught
                      next insert → SUCCEEDED
```

So the `continue` skips nothing on the transactional path — it poisons the
transaction, and the *next* date's `create` fails with an unrelated error.

Today this is latent rather than live: the `findFirst` at `:99` covers the
ordinary case, so P2002 fires only under a genuine concurrent race, where the
outcome is a rolled-back template creation surfacing as a 500. **This migration
would make it routine**, because a manually created class at the same slot is an
ordinary state, and one blocked date would roll back the entire window and the
template with it.

**Design: pre-check the slot, never rely on the catch.**

1. Compute the candidate dates exactly as now.
2. **One** query per run for the occupied slots — both "this template already has
   an instance on this date" (today's per-date `findFirst`, folded in) and "this
   teacher already has a non-cancelled class at this date and start time".
3. Create only the free dates.
4. Return `{ created, skipped }`, where `skipped` names each date and which of
   the two reasons applied.

**Decision (Ivo, 2026-08-11): skip only the date that is blocked, and say so.**
Every other date in the window is still generated — a single clash must never
cost the teacher the rest of their four weeks. The teacher-facing message reads
"3 classes scheduled, 1 slot already had a class" rather than a bare smaller
delta. This is #119's rule — report what the window holds — applied to a new way
of holding it.

The pre-check is a read-then-write and so is not race-safe on its own; the
unique index is its backstop. Under a true race the transaction still aborts, as
it does today. What changes is that the route maps that P2002 to a **409 naming
the clash** instead of a generic 500.

The false docblock at `class-generator.ts:76-78` is corrected in the same
change. A comment asserting an idempotency the code does not have is worse than
no comment, because it is what stops the next reader checking.

### 5.2 Every new unique key is a new wait edge

`docs/lock-order.md:315` states it: *"two concurrent `INSERT`s of one unique key
make the second wait on the first's uncommitted tuple, and that wait deadlocks
like any other."* That document also records two sites that lock `Class` rows in
heap order (`syncTemplateInstances`, `archiveOrUnarchiveTemplate`), described as
"live, unfixed", with a reproduced `40P01`.

Reading the create sites bounds the risk:

| Site | Transactional context |
|---|---|
| `api/classes/route.ts:62` | bare `prisma.class.create` — autocommit, single statement |
| `api/studio-classes/route.ts:30` | bare — autocommit |
| `api/rooms/route.ts:74` | bare — autocommit |
| `api/class-templates/route.ts:44` | inside `tx`, followed by instance generation |
| `api/studio-class-templates/route.ts:41` | inside `tx`, same shape |
| `class-generator.ts:103` | inside the generator's per-template `FOR UPDATE` claim (`:208-213`) |

The three bare creates are single autocommit statements, which cannot hold a
lock across statements and so cannot close a cycle. The template routes block on
the *template's* uncommitted tuple before reaching any `Class` insert, which is
one clean wait, not a cycle. **This is an argument, not a measurement, and this
project's convention is to measure** — so the plan carries a deadlock probe
built the way `docs/lock-order.md` built its own, and `docs/lock-order.md` is
updated if it finds an edge. Nothing here is claimed to be safe on reasoning
alone.

### 5.3 A manual class and a recurring template can no longer share a slot

A consequence of §1's second answer, not of any implementation choice, and it
reaches further than deduplication. It is correct by the stated rule and is
called out here so it is not discovered as a surprise.

---

## 6. Rejected designs, with what rejected each

**Universal idempotency keys** (`withErrorHandler` middleware + schema + client
plumbing). The issue's option 1 and the design it expected. Rejected by §1: an
intent token is only *required* where a deliberate identical repeat is
legitimate, and no surface in this codebase turned out to be one. Building the
mechanism for zero forced call sites is cost with no coverage gain.

**A content hash in a unique index for announcements.** Rejected because
`message` is `@db.Text` and any index must key on a hash, so a collision
*silently rejects a real announcement*. The advisory lock uses the hash only for
mutual exclusion and compares real text.

**A time-bucketed unique index for announcements.** Rejected on a second,
independent leak: two sends straddling a bucket edge both pass, so the guard is
provably fallible in the case it exists to catch.

**A pre-check without a lock for announcements.** Satisfies the issue's literal
acceptance criterion (which describes a *sequential* retry) and fails the
concurrent double-click. Rejected because §3 fixes that same shape at five other
endpoints; leaving it here would be incoherent.

**Non-partial unique indexes.** Rejected: they would make a cancelled class
permanently block its slot and an archived template block a replacement — a new
bug in exchange for the old one.

**Client-side only** (the issue's option 3, extending #40's settled-state
pattern). Rejected by #196's own framing: PR #198 already removed the reachable
client path to four of the nine and the endpoints stayed duplicable. A retried
request from a flaky connection does not go through the component.

---

## 7. Feasibility, measured

Prisma cannot express partial indexes, and CI runs
`prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code`
(`.github/workflows/ci.yml:124`), which fails when the live database and
`schema.prisma` disagree. So: does a hand-authored partial unique index read as
drift?

Measured on a throwaway `drift_probe` database with the full migration history
applied — **with a control, because "no drift" proves nothing unless the
instrument can report drift**:

```
baseline (no extra index)                    exit=0   No difference detected.
+ partial UNIQUE … WHERE status <> 'cancelled'  exit=0   No difference detected.
+ plain UNIQUE (teacherId, date, startTime)     exit=2   [-] Removed unique index
```

Partial indexes are invisible to the check; the equivalent non-partial index is
seen immediately. The design is safe and the check is working.

Dev data violates none of the four candidate keys (0 duplicate groups on each).
**That is weak evidence** — 16 `Class` rows, 7 `StudioClass`, 1 `ClassTemplate` —
and it is production that decides. See §11.

The second measurement this design rests on is the transaction-abort probe in
§5.1, run the same way and for the same reason: it contradicted a docblock, and
a docblock is exactly the kind of claim that gets inherited rather than checked.

---

## 8. Scope

Split by whether a migration is needed (Ivo, 2026-08-11):

**Branch 1 — this branch.** One migration, six indexes, five endpoints:
`POST /api/classes`, `/api/studio-classes`, `/api/class-templates`,
`/api/studio-class-templates`, `/api/rooms`. Plus §5.1's generator slot
pre-check, its skipped-slot reporting and its docblock correction, and §5.2's
deadlock probe.

**Branch 2 — next.** The nine endpoints in §4.2, no schema change.

**#196 remains open after branch 1** and is closed by branch 2. (Written that
way deliberately: GitHub's auto-close parser matches `close #N` and does not
read a negation in front of it.)

Out of scope for both, and named so nobody re-derives them: `P2025` surfacing as
a 500 on two delete routes (#197's family); the eight benign `†` rows; the
`edit-room-form.tsx` two-sequential-PUT item parked in #196's Update, which is a
client-side atomicity question rather than a duplication one.

---

## 9. Guards, and the mutation that proves each bites

Every guard below gets its mutation run, its exact error text recorded, and the
mutation reverted. A guard that compiles but cannot fail certifies nothing.

| Guard | Mutation that must break it |
|---|---|
| `Class_teacher_slot_unique` | Drop the index → "second identical POST creates a second row" test must fail |
| its `WHERE status <> 'cancelled'` | Remove the predicate → "a cancelled class does not block re-creating that slot" must fail |
| `StudioClass_teacher_slot_unique` + predicate | Same pair, against `cancelledAt IS NULL` |
| `ClassTemplate_teacher_slot_unique` + predicate | Same pair, against `isArchived = false` |
| `StudioClassTemplate_…` + predicate | Same pair |
| `Room_public_identity_unique` | Drop → concurrent duplicate public room test must fail |
| `Room_private_identity_unique` | Drop → duplicate private room test must fail |
| Generator slot pre-check (§5.1) | Remove the "teacher already has a class at this slot" clause → the test asserting the **other three dates still generate** must fail with `25P02`, not merely with a wrong count |
| Skipped-slot reporting | Return only `created` → the test asserting the skipped list must fail |

**Fixtures must not be able to poison shared state.** Every test creates its own
teacher and uses dates outside the seed window, so no mutation can leave a row
that a later unrelated run trips over. This is the transferable half of #185's
lesson, where a mutation constant sat inside the range the code itself produced
and resurfaced as an unexplained failure in another suite an hour later.

---

## 10. Acceptance

1. Each of the five endpoints has a test issuing the **same request twice** and
   asserting the side effect happened **once** — a row count, not merely that the
   second response was a 4xx. This is #196's stated criterion.
2. `POST /api/classes`, `/api/studio-classes` and `/api/rooms` additionally have
   a **concurrent** test (both requests in flight), since §3 is the axis this
   round added and a sequential-only test would not observe it.
3. Partial semantics are pinned: a cancelled class and an archived template each
   fail to block a legitimate re-create.
4. The generator reports skipped slots (§5.1), with a test — and a separate test
   that a template whose window contains **one** blocked date still generates
   **every other date**, and still creates the template. One clash must not cost
   the teacher the rest of their four weeks.
5. The deadlock probe (§5.2) is run, its result recorded in the PR body, and
   `docs/lock-order.md` updated if an edge is found.
6. Production is checked for constraint violations **before** the migration is
   applied anywhere (§11).
7. `npm run verify` green — typecheck, lint, and all three vitest projects.

---

## 11. Risks, and what is not known

**Production data may violate the constraints, and this is a hard blocker.**
`CREATE UNIQUE INDEX` fails outright against violating rows. Dev is clean but
holds 16 classes. The four counting queries must be run against production, and
if any returns a non-zero group count, this design needs a remediation step that
does not exist yet. **Do not apply the migration before that check.**

**The deadlock analysis in §5.2 is reasoning, not measurement.** It is the
weakest claim in this spec, which is why the probe is an acceptance item rather
than a nice-to-have.

**One census delta (§2.3) is unexplained** and cannot be explained without an
artifact that was never written. It affects a count, not a defect: the DUPLICATE
set is enumerated and each member independently verified.

**A concurrent generation race still aborts its transaction**, because Prisma's
interactive transactions expose no savepoint and §5.1's measurement shows a
caught error cannot be recovered from inside one. The pre-check removes the
routine case, not the race. This is unchanged from today's behaviour rather than
introduced here, and it is stated so the next reader does not mistake the
pre-check for a race guard.
