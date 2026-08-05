# One projection for what a teacher may see about a student

**Issue:** #167 — Honour `StudentPrivacy` in the payment and registration routes
**Spun out of:** #162 / PR #165 (see its spec, section "Filed, not folded")
**Date:** 2026-08-05

## The problem, stated after measuring it

A student is told they control, per teacher, whether that teacher sees their
surname, email, phone, birthday and address. On the five surfaces someone built
a UI for, they do. On the eight API handlers nobody built a UI for, they do not
— those return the raw values, plus the student's income tier as a stored
integer.

The product decision is already made and is not reopened here: the flags are
honoured even when payment is owed, because reminders go through the app and
blocking a non-paying student is the escalation.

## What was measured

`find src/app/api -name route.ts | wc -l` = **56** route files.

**8 of the 56** put a Student-derived field into a body a teacher session can
read, across **10 handlers** (`registrations/[id]` contributes three). 56 − 8 =
**48 route files carry none**. Of the 10 handlers, **2 gate today** (and one of
those two only partially), leaving **8 ungated**.

`grep -rn "StudentPrivacy\|studentPrivacy" src/` returns **12 non-test files**.
Classified:

- **5 filter teacher-facing output by the five `share*` flags** — `api/students/route.ts`,
  `api/students/[id]/route.ts`, `(teacher)/students/[id]/page.tsx`,
  `(teacher)/class/[id]/page.tsx`, `(teacher)/settings/payments/page.tsx`
- **1 filters recipients by `receiveComms`** — `api/announcements/route.ts` (a
  delivery rule, not a field-visibility rule; out of scope)
- **1 is the CRUD for the flags themselves** — `api/students/[id]/privacy/route.ts`
- the remaining 4 are the student's own settings UI (`(student)/account/privacy/page.tsx`,
  `components/student/teacher-privacy-card.tsx`) and lifecycle writers
  (`services/gdpr.ts`, `services/invitations.ts`, `services/waitlist.ts`)

So the field-visibility rule has **5 implementations**, the `isUnclaimed`
bypass has **5** call sites, and the five-line comment explaining that bypass
has **5** identical copies.

### The eight ungated handlers (6 route files)

| Handler | Student fields on the wire | Audience |
|---|---|---|
| `GET /api/payments` | `firstName`, `lastName`, `email` + full `Registration` (`tierAtBooking`, `tierRatio`, `price`) + full `Payment` | teacher-only |
| `GET /api/classes/[id]/payments` | `firstName`, `lastName` + full `Registration` + full `Payment` | teacher-only |
| `GET /api/payments/[id]` | `firstName`, `lastName`, `email` + full `Registration` | teacher-only |
| `GET /api/classes/[id]/registrations` | `firstName`, `lastName` + full `Registration` | teacher-only |
| `GET /api/registrations/[id]` | `firstName`, `lastName` + full `Registration` | **shared** |
| `PUT /api/registrations/[id]` | full `Registration` | teacher-only |
| `DELETE /api/registrations/[id]` | full `Registration` | **shared** |
| `POST /api/registrations` | full `Registration` | **shared**; teacher walk-in path is live |

Plus `GET /api/students/[id]:60`, which returns `incomeTier` unconditionally to
any linked teacher — the one field the profile route's otherwise-complete gate
does not cover.

### Nothing reads any of these bodies

Enumerated by grepping every `fetch(` in `src` (non-test) with its method:

- **The five GET handlers above have zero consumers.** No client code fetches
  `/api/payments`, `/api/classes/[id]/payments`, `/api/payments/[id]`,
  `/api/classes/[id]/registrations`, or `GET /api/registrations/[id]`.
- **The three write handlers' consumers read only `res.ok`** —
  `attendance-list.tsx:32` (PUT), `cancel-booking-button.tsx:30` (DELETE),
  `booking-flow.tsx:78` and `add-walk-in.tsx:63` (POST). Each reads the body
  only on the error path, via `readErrorMessage`.
- The only routes anyone fetches for student data are `GET /api/students`
  (`student-directory.tsx:56`, `add-walk-in.tsx:39`) and
  `PUT /api/students/[id]/privacy` — and the list is one of the five that
  already gates.

The pattern is the finding: **the surfaces that got privacy gating are exactly
the ones someone built a UI for.** This is why the fix is almost entirely
invisible to the product, and why acceptance is integration tests rather than
e2e.

## Corrections to the issue's premise

**Held, as written:** the two `services/payments.ts` select shapes (at `:198-216`
and `:235-246`, fields at `:201-207` and `:238-244`); that the registration
routes return full `Registration` rows plus raw names; that `StudentPrivacy` has
no `shareIncomeTier` column; that "3 of 4 referencing route files actually
filter" (true, for route files); and the fixture-trap warning — which is not
hypothetical, see below.

**Wrong, and each changes the work:**

1. **`api/payments/[id]/route.ts` is not a consumer of `services/payments.ts`.**
   The issue lists it as one of three. It imports only `@/lib/db` and
   `@/lib/api-utils`, and runs its own inline query at `:21-30` with the same
   `firstName, lastName, email` select. Fixing the service fixes **two** of the
   three payment routes; the third is an independent third copy.

2. **The gating rule is duplicated 5 times, not 2.** The issue says it is
   "already duplicated between the list route and the profile route" — true of
   route files, but three teacher *server pages* gate as well. A census scoped to
   `src/app/api/**/route.ts` structurally cannot see them. This is the single
   biggest change to the shape of the work: the issue's proposed helper would
   have become a *sixth* implementation.

3. **The "Adjacent" section points at a branch that no longer exists.** It names
   "`students/[id]/route.ts`, the teacher `PUT` branch." Commit `8b2a1f8`
   ("retire the unclaimed student, and the two branches that served it", #166)
   deleted it. The current `PUT` is student-self-edit only, else 403. The wider
   question it raised — what a teacher may see about an *unclaimed* student — is
   also largely moot: nothing creates unclaimed `Student` rows any more.

4. **`POST /api/registrations` is missing from the site list.** The teacher
   walk-in path (`add-walk-in.tsx:63`) receives a full `Registration` including
   `tierAtBooking`, which `registrations/route.ts:163` sets from the student's
   `incomeTier`.

5. **Two registration handlers are shared, not teacher-only.** `GET` and
   `DELETE /api/registrations/[id]` use `requireSession` (`:20`) and authorize as
   student-self *or* class teacher (`:36-39`). A gate there must branch; a
   student's read of their own row must pass through untouched.

6. **The tier argument understates the exposure.** The issue argues a teacher
   could *recover* tiers by normalising prices. No derivation is needed:
   `Registration.tierAtBooking` (`Int`) and `Registration.tierRatio`
   (`Decimal(5,4)`) ship as raw values on 6 of the 10 handlers, because the outer
   `include`s carry no `select`.

7. **Timing.** The handover said #166 landed "yesterday". PR #169 merged
   `2026-08-05T08:32:30Z` — the same morning this issue was scoped.

**My own errors, recorded:** I first reported four copies of the `isUnclaimed`
comment; there are five. I also first framed the tier exposure as
derivable-from-displayed-prices, which is true but weaker than the measured fact
in correction 6.

## Decisions taken

**1. Tier fields are dropped, and no `shareIncomeTier` flag is added.**

The evidence against the flag: on `/class/[id]` for a completed class,
`PricingBreakdown` (`pricing-breakdown.tsx:64-77`) renders "Price per tier —
Tier 4 · €15.20", and `PaymentChecklist` directly below renders "Anna B. —
€15.20". All five `TIER_RATIOS` are distinct, so price → tier is injective. Every
attending student's exact tier is legible by name, on one screen, with no
arithmetic. A `shareIncomeTier: false` would hide the tier from routes nothing
calls while the class page keeps printing it — a guard that provably cannot bite,
which is the failure mode this project keeps shipping.

What dropping the fields *does* buy: no teacher surface renders `incomeTier` at
all, and nothing in the app calls `GET /api/students/[id]`. So removing it costs
nothing and closes the one case anything can close — a student who accepted an
invitation and has never attended a class, whose tier a teacher currently gets
for free.

**2. One projection, applied to all 13 sites** — the **8 ungated handlers**
(spread over 6 route files) *and* the **5 existing implementations of the gating
rule** (2 route files + 3 teacher pages). Fixing only the ungated handlers would
leave six implementations of a rule this issue exists because it drifted.

**3. Hidden fields are emitted as `null`, never omitted.** The two existing
implementations disagree: `students/route.ts:126` emits `email: null`;
`students/[id]/route.ts:66-69` omits the key. A stable shape types better
(`string | null` over optional), asserts better, and — decisively — makes a
missing key impossible to confuse with a route that forgot to select the field,
which is the failure this issue is about.

**4. Teacher-facing responses carry a composed `displayName`, not
`firstName`/`lastName`.** Today the API truncates to a bare initial
(`lastName.charAt(0)` → `"B"`) while `formatStudentName` truncates to a
lowercased dotted initial (`"b."`); `student-directory.tsx:114` runs the second
over the output of the first. It works only because the composition happens to be
idempotent, and nothing tests that. Emitting `displayName` leaves one truncation
rule and — the reason to prefer it — means the un-truncated surname is not in the
projected object at all, so a new call site cannot leak it by forgetting to
truncate.

**5. The `isUnclaimed` bypass survives, collapsed to one copy, and its comment
is reworded to stop claiming a filing that does not exist.** All five copies end
"Filed as a leaf"; no such issue exists among the 46 open or the closed set.
This is the same defect `fe9c009` fixed within #166 itself for two other
comments — and it is resolved the other way here, deliberately. That commit
landed at `2026-08-05T08:27:44Z`, five minutes before PR #169 merged, so the
claim these five comments make was already known to be a shape worth checking.
`fe9c009` filed #174 because
that comment described a **live race**. This one describes dead code: nothing
creates unclaimed `Student` rows, every `TeacherStudent` writer requires
`session.studentId`, and `Student_claim_link_check` ties `accountId` to
`claimedAt`. Confirmed with the owner that there is **no production deployment —
local dev only** — so there is no legacy unclaimed data anywhere for the bypass
to expose. An issue saying "retire `claimedAt`" would be a decision-shaped
placeholder with no decision behind it. The comment is the better home; it
already carries the full explanation of why the bypass cannot be removed alone.

## Design

### `src/lib/student-visibility.ts`

Follows `src/lib/contacts.ts`: a small pure module extracted so it can be tested
directly, with a **type-only** `@prisma/client` import so it stays safe to pull
into a `'use client'` chain and carries no Prisma or pino runtime.

```ts
teacherVisibleName(student): string
projectStudentForTeacher(student): TeacherVisibleStudent   // calls the above
studentVisibilitySelect(teacherId): Prisma.StudentSelect
```

`TeacherVisibleStudent` = `{ id, displayName, email, phone, birthday, address,
claimedAt }`. Every key always present, `null` when withheld. No `firstName`, no
`lastName`, no `incomeTier`.

**Why two projection exports rather than one.** Three of the five consolidated
sites render only a name. Routing them through the full projection would force
them to load `email`, `phone`, `birthday` and `address` purely to discard them —
the consolidation would *increase* over-fetch. `teacherVisibleName` takes the
narrow input those sites already have; `projectStudentForTeacher` calls it, so
there is still exactly one truncation rule.

`studentVisibilitySelect` lives in the same module so the query shape and the
projection are defined together, rather than rediscovered per call site.

### The 13 sites

**Five that already gate** — replace the inline rule with the shared one:
`api/students/route.ts`, `api/students/[id]/route.ts` (and drop `incomeTier`),
`(teacher)/students/[id]/page.tsx`, `(teacher)/class/[id]/page.tsx`,
`(teacher)/settings/payments/page.tsx`. The last three also narrow `include` to
`select`; two of them currently load every `Student` column. The `/api/students`
contract loses `firstName`/`lastName`/`shareFullName` and gains `displayName`,
so its two consumers — `student-directory.tsx:114` and `add-walk-in.tsx:39` —
are updated; both get simpler.

**Three payment routes** — `getOutstandingPayments` already takes `teacherId`;
`getPaymentsForClass(db, classId)` gains one. Both return projected rows with
**honest return types**: today both declare `Promise<Payment[]>` while returning
a structural superset carrying names and email, so the signature actively hides
the leak from anyone reading it. `api/payments/[id]/route.ts` gets its own edit.

**Five registration handlers** — `GET /api/classes/[id]/registrations` takes the
projection. `GET /api/registrations/[id]` branches on caller. `PUT` and `DELETE`
narrow to `{ id, status }`; `POST` narrows to `{ id }`. The `select` on each
`Registration` read drops `tierAtBooking` and `tierRatio`.

### Guards, and proving each one bites

Per guard, the plan carries an explicit break-record-restore step.

- Integration tests on the payment and registration routes with a **claimed**
  student and `shareEmail: false` / `shareFullName: false`, asserting neither the
  email nor the full surname appears. Written to fail against today's code first.
- **`tests/integration/payments-api.test.ts:78-85` is fixed before any assertion
  is written against it.** Its student is created with no `claimedAt` and no
  `accountId` — unclaimed — so a privacy test built on that fixture takes the
  `isUnclaimed ||` bypass and passes against the bug. This is the trap the issue
  warned about, instantiated in the exact suite the work extends. **Task order is
  load-bearing:** the fixture fix precedes the assertions, or the assertions
  certify nothing.
- A field-list pin for `TeacherVisibleStudent` in the `type-pins.ts` /
  `SERVER_OWNED_FIELDS` idiom, so a new `Student` column cannot silently join a
  teacher-facing response.
- A test that no teacher-facing response body contains a raw surname — the
  property `displayName` exists to make checkable.

### Suites that run

`tests/integration/payments-api.test.ts`, `registrations-api.test.ts`,
`students-api.test.ts`, `privacy-api.test.ts` — **by explicit path**; the
integration project is never run whole (one file in it is IP rate-limited).
Plus unit tests for `student-visibility.ts` and component tests for
`student-directory.tsx`.

## Acceptance

1. A teacher with `shareEmail: false` on a **claimed**, linked student receives
   no email from `GET /api/payments`, `GET /api/payments/[id]`,
   `GET /api/classes/[id]/payments`, or `GET /api/students/[id]`.
2. A teacher with `shareFullName: false` on that student receives no full
   surname from **any** teacher-facing handler — the eight ungated ones and the
   two that gate today — only a composed `displayName`.
3. No teacher-facing response carries `incomeTier`, `tierAtBooking` or
   `tierRatio`.
4. A student's own `GET`/`DELETE /api/registrations/[id]` is unchanged.
5. The field-visibility rule has one implementation; `grep` for the bypass
   comment returns one copy, and it claims nothing untrue.
6. Every test in 1–3 fails against `main` before the fix.

## What this does not do

- **It does not hide the tier of a student who has taken a class.** The class
  page prints tier→price and name→price in adjacent sections. Nothing here
  changes that, and no flag could. Stated rather than glossed, because the
  issue's acceptance could be read as promising it.
- It does not add `shareIncomeTier`.
- It does not remove the `isUnclaimed` bypass, or the claim path,
  `Student_claim_link_check`, and `Student.claimedAt` that would have to go with
  it.
- It does not touch `receiveComms` or `api/announcements/route.ts`.
- It does not change what the teacher UI shows, except that
  `student-directory.tsx` and `add-walk-in.tsx` read `displayName` instead of
  composing it.
