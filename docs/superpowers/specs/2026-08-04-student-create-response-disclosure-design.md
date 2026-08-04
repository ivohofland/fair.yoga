# POST /api/students discloses a stranger's full student row

**Issue:** #162 · **Date:** 2026-08-04 · **Branch base:** `c12e388`

## What was measured

Everything below was reproduced against the running dev server, not read off the
source. Two throwaway scripts drove real HTTP requests through real sessions.

Line references throughout this spec are as of `c12e388`, the commit this branch
started from — they describe the code as measured, not as it stands after the fix.

### The disclosure

A teacher with no relationship to a student, knowing only that student's email,
POSTs `{firstName, lastName, email}` and receives **16 fields**:

```
id, accountId, firstName, lastName, email, incomeTier, phone, birthday,
address, reminderPref, emailNotifications, claimedAt, tierSelectedAt,
deletedAt, createdAt, updatedAt
```

Observed values for a claimed student with no `StudentPrivacy` row:
`phone: "+31 6 12345678"`, `birthday: "1988-03-14"`,
`address: "Kerkstraat 1, 1017 GA Amsterdam"`, `incomeTier: 5`.

The same teacher's very next `GET /api/students/[id]` returns **7 fields**, with
`lastName` cut to `"S"` and no email, phone, birthday or address. Same teacher,
same student, one second apart.

**The issue named 9 of them and missed 6.** Its list was `firstName`, `lastName`,
`email`, `incomeTier`, `phone`, `birthday`, `address`, `claimedAt`, `accountId`;
absent were `reminderPref`, `emailNotifications`, `tierSelectedAt`, `deletedAt`,
`createdAt`, `updatedAt`. `9 + 6 = 15`, plus `id` itself — which the issue did not
list and which is the only field that should be there — gives 16.

`accountId` is worth calling out separately even though the issue did name it: it
is the internal id of the `Account` row, i.e. of the auth principal, and no other
API response hands that to a third party.

### The census the issue left unmeasured

The issue closed with "Not measured: whether the same raw-row shape leaks through
any other write path's response." It has now been measured, across response
bodies rather than writes.

`find src/app/api -name route.ts` → **52 files**. Within them,
`respondOk|NextResponse.json` matches 139 lines, of which 49 are import
statements, leaving **90 response call sites**. Classifying each by what it
returns and who owns that row relative to the caller:

`src/app/api/students/route.ts:123` is the **only** site that hands a caller a
raw row owned by someone they have no ownership chain to. Every other bare-row
response is either the caller's own row, or a row the caller owns through an
enforced chain (own class → its registrations → their payments).

So the issue's central claim — *"this is the only student read path in the
codebase that does not filter"* — holds, and is in fact stronger than stated: it
is the only such path in the API at all.

One adjacent case: `students/[id]/route.ts:131` (teacher `PUT`) also returns a
bare `Student` row belonging to another person. It is **folded into this branch**
— see Design §3 — though its severity is much lower and the spec says so rather
than inflating it to match.

One correction to the contrast the issue draws, though. `StudentPrivacy` is
consulted in **4 of 52** route files (`students/route.ts`,
`students/[id]/route.ts`, `announcements/route.ts`,
`students/[id]/privacy/route.ts`) — but the fourth of those is the settings CRUD
for those flags, not a route that filters output by them, so 3 is the number
that actually filters. The payment and registration routes return un-redacted
`lastName` to the owning teacher regardless of `shareFullName`
(`services/payments.ts:202-206` and `:239-242`), and the first of those two
also returns `email` regardless of `shareEmail`. So "the codebase filters
everywhere except here" is true of the *student* routes, not of the app. That
is now its own decided issue (see "Filed, not folded").

## Corrections to the issue's premise

1. **The field list was incomplete** — 16, not 9. See above.

2. **The issue's two acceptance options are mutually exclusive, and it does not
   notice.** It offers "the same filtered shape as `GET /api/students/[id]`" as
   an option, *and* requires a test proving the teacher does not receive
   `incomeTier`. But `students/[id]/route.ts:55` returns `incomeTier`
   unconditionally to any linked teacher — there is no `shareIncomeTier` flag in
   `StudentPrivacy` at all. Returning the `GET` shape therefore cannot satisfy
   the issue's own acceptance bar. Only `{ id }` does.

3. **Narrowing the response does not stop a stranger learning the tier.** The
   link this branch creates grants `GET` access immediately; the reproduction
   confirmed the stranger's follow-up `GET` returned `incomeTier: 5`. The tier is
   protected only by dropping it from `GET`, or by gating the link itself.

4. **The issue's exploitability section understates it: there is no rate limit
   on this route.** Only `magic-link/send`, `student-signup` and `teachers` are
   throttled. Every probe of a non-existent email also *creates a real Student
   row*, so the probe is an unmetered write, not just a read.

5. **Ruled out — soft-deleted students are not reachable.** `deleteStudentAccount`
   (`services/gdpr.ts:271-284`) rewrites the email to
   `deleted-<studentId>@deleted.invalid` and nulls phone, birthday and address.
   An erased student cannot be found by their real address, and carries nothing
   if they were.

6. **Held, as written:** the CRM form reads only `data.id`
   (`create-student-form.tsx:81-82`) and redirects to a page that renders through
   the filtered `GET`. Its component test already mocks
   `{ data: { id: 'student-1' } }` (`create-student-form.test.tsx:23`) — the UI
   contract is *already* `{ id }`. Narrowing the response is a zero-UI-change fix.

## Where this sits in the security model

Gate 4 (ownership), per the project's gate model — but neither of the two
standard shapes. The id is not client-supplied, as it was in #146/#148. The
client supplies `email`, a **selector** that resolves to a row owned by someone
else. Same family, different mechanism: there is no id to check ownership of, so
the remedy is not "add an ownership check" but "never load the fields in the
first place".

This is also why `SERVER_OWNED_FIELDS` in `src/lib/schemas.test.ts` does not
catch it, though not for the reason it might look like. The nearest curation
note (`:298-304`) scopes out client-supplied cross-tenant **foreign keys** —
`classId`, `roomId`, `teacherRoomId` — not natural-key selectors. `email` is a
natural-key selector, not a foreign key, so that note does not literally cover
this case; it falls outside the register by omission, not by an explicit
carve-out.

## Design

### 1. Narrow at the query, not at the response

```ts
const existing = await prisma.student.findUnique({
  where: { email },
  select: { id: true },
});
```

and likewise `select: { id: true }` on the `tx.student.create` inside the
transaction. Both branches then return `respondOk({ id }, …)`.

**Why the query and not the response.** A response-side projection is a guard an
unrelated edit can widen, and nothing fails when it does. A `select` makes
`existing` typed `{ id: string }`, so an edit that tries to *read* any other
field off it — `existing.email`, say — is a **compile error** under `strict`.
That is narrower than it sounds: an edit that widens the `select` and then
returns the wider `existing` compiles cleanly, because `respondOk` is generic
over whatever it is handed, so nothing pins the response shape to the query
shape at the type level. What actually catches a widened `select` is the
exhaustive `Object.keys(...)` assertions in the integration tests (see
Testing), not the compiler. Query-level narrowing is still the better fix over
projecting at the response — it just is not the unconditional compile-time
guarantee this made it sound like.

Nothing in the branch reads any other field of `existing` — only `existing.id`,
at the `teacherStudent.create` and the response.

### 2. Rate limit, keyed per teacher — shared across both write routes

```ts
// src/lib/rate-limit.ts
export function checkStudentWriteLimit(teacherId: string): RateLimitResult {
  return checkRateLimit(`students:${teacherId}`, 50, 60 * 60 * 1000);
}
```

```ts
const limit = checkStudentWriteLimit(session.teacherId);
if (!limit.allowed) {
  return respondError(`Too many student requests. Try again in ${minutes} minute(s).`, 429);
}
```

Placed after `requireTeacher`/`requireSession` and before `parseBody`, matching
`teachers/route.ts:12-18`. Called from two sites: `POST /api/students`, and the
teacher branch of `PUT /api/students/[id]` (Design §3) — same key
(`students:${teacherId}`), so the two routes spend from one bucket. See the
correction below for why.

**Why per teacher rather than per IP.** The caller is authenticated, so IP keying
is strictly weaker — evadable by rotating IPs, and it punishes teachers sharing a
network. It also avoids the fallback its siblings carry for the `ip === 'unknown'`
case, which drops the IP limit entirely when no proxy header is present.
`magic-link/send` and `student-signup` survive that because each also keeps an
unconditional per-email limit; `teachers/route.ts` has no second limit and is
genuinely unthrottled in that case. A teacher key needs no fallback at all.

**Correction — this section originally left the sibling route unbounded.** As
first written, this design put the limiter only on `POST /api/students`, at
30/hour, and treated that as a bound on the disclosure. It was not one. A PR
review found, and it was confirmed by running it, that the teacher branch of
`PUT /api/students/[id]` is an **unmetered** twin of the same oracle:
`createStudentSchema` requires `email`, so every call into that branch writes
one straight into the `@unique` `email` column with no pre-check, and Prisma's
`P2002` on the collision surfaces through `classifyApiError`
(`src/lib/api-errors.ts:74-82`) as a plain `409` — no different in kind from
the `POST`'s 200-vs-201. A single throwaway unclaimed contact, `PUT` repeatedly
with a new candidate email each time, probes indefinitely: `409` means taken,
`200` means free, and each `200` moves that same contact's email to the next
candidate. No new `Student` row is ever created, so the probe trips neither the
`POST` limiter nor the junk-row signal described below — it is invisible to
both. Measured: 40 consecutive probes returned 20×409 / 20×200 and zero 429s.

**Resolution.** Both routes write a client-supplied `email` to the same
`@unique` column, so metering one and not the other leaves the pair unbounded.
They now share a single hourly budget, keyed on the teacher, via
`checkStudentWriteLimit` in `src/lib/rate-limit.ts`. Raised from 30/hour to
**50/hour** in the same change, since the shared budget now has to cover a
teacher's corrections through the `PUT` path in the same sitting a roster is
entered through `POST`, not only the adds.

**Why 50/hour.** A teacher entering a workshop roster, then fixing a few typos
in it, in one sitting must not hit it. At 50/hour a sweep over 10,000 candidate
addresses costs `10000 / 50 = 200 hours = 8.3 days`. Run through `POST` that
also leaves ~10,000 junk `Student` rows behind — a real price and a loud
signal; run through the `PUT` twin instead it leaves no rows at all, so time is
the only cost that variant pays. Neither is a wall. The wall is the invitation
flow (see "Filed, not folded"); this limit is what holds until it lands.

**This is an order of magnitude, not a guarantee.** The limiter
(`src/lib/rate-limit.ts`) is in-process: a deploy or restart hands every bucket
a fresh budget, so "8.3 days" assumes a server that runs that long without one.
Its backing map is also shared across every rate-limited key in the app, capped
at 10,000 entries (`MAX_KEYS`), and evicts the oldest-inserted bucket once
full — so a teacher's bucket can be reset by unrelated load elsewhere in the
app, not only by the window elapsing.

### 3. The sibling in the same family: teacher `PUT`

`students/[id]/route.ts:126-131` returns the raw updated row. Same treatment:
`select: { id: true }` on the update, return `{ id }`. The pre-check load at
`:107` narrows too — to `select: { id: true, claimedAt: true }`, since `claimedAt`
is the only field it reads.

**Its severity, stated honestly rather than inflated to match.** This branch fires
only for an **unclaimed** student the teacher is already linked to, and the
reference `GET` at `:49` states that unclaimed carries no privacy restrictions —
so `firstName`, `lastName`, `email` and `incomeTier` are legitimately the
teacher's to see here; `incomeTier` is already part of the `GET` contract
unconditionally (`:55`), so this branch adds nothing new on that field. What
actually escapes the `GET` contract is `reminderPref`, `emailNotifications`,
`tierSelectedAt`, `deletedAt`, and `accountId`.

`accountId` being always `null` on this path takes two things together, not
one. `Student_claim_link_check`
(`prisma/migrations/20260721061528_student_claim_link_check/migration.sql`)
enforces `("claimedAt" IS NULL) = ("accountId" IS NULL)` and `:109` has already
403'd every claimed student — that proves it for the row as read. The
load-bearing other half is that nothing in the request can subvert it from the
write side: this branch parses the body with `createStudentSchema`, not
`updateStudentSchema`, and that schema admits only `firstName`, `lastName` and
`email` — there is no field a caller could submit that would land in
`accountId`. Worth noting separately: the pre-check load at `:107` and the
`update` at `:126` are two separate statements, not one transaction. Nothing
writes to this row between them today, so the gap is inert, but it is a gap —
a future edit that adds a second write in between should not assume the
claimed-check still holds by the time the update runs.

So this is a **shape inconsistency, not a disclosure**. It is folded in because it
is the same defect shape in the same file: leaving it signals to the next reader
that returning the raw row is fine here, which is how the pattern spread.

**Consumer check:** `edit-student-form.tsx:83` ignores the response body entirely
and calls `router.refresh()`. Nothing reads it.

**Deliberately not changed — the self-edit branch at `:102`.** It returns the
caller's own row to the caller, which is not a disclosure at any boundary.
`tier-form.tsx:48` and `notifications-form.tsx:99` check only `res.ok` and never
read the body, so narrowing it *would* be safe — it is left alone because it is
not a defect, not because it was overlooked.

### 4. Status codes stay as they are

200 for an already-existing student, 201 for a created one. Unifying them was
considered and rejected: it does not close the Student-row-existence oracle —
the disclosure is that a **Student row** exists for the address, not that an
**Account** does, and unifying the status would not touch the channel that
actually carries that bit. See "What this does not do" below for the
measurement that rejected it.

## What this does not do

**The oracle is metered, not closed — and it is not the "account-existence"
oracle the name suggests.** After the fix, a teacher still learns whether a
**Student row** exists for an email — not whether an `Account` does, and the
two are not the same thing. This route's own 201 branch creates a `Student`
row with no `Account` behind it at all, and any other teacher's unclaimed CRM
contact (`accountId: null`) answers the existing-branch's 200 exactly the same
way a self-registered address does. So the 200/201 split, and the follow-up
`GET` that recovers it, bundle two distinct leaks into one bit: whether the
address has ever self-registered, **and**, separately, whether it is already
sitting in some *other* teacher's contacts — CRM membership the address's
owner is never told about. That second leak has no name elsewhere in this
document; call it the **CRM-membership leak**. Unifying the status would not
close either half, which was measured rather than assumed:

```
POST {firstName:"Zzz", lastName:"Qqq", email:<target>}   → 200
POST {firstName:"Zzz", lastName:"Qqq", email:<free>}     → 201
then GET /api/students as the same teacher:
  firstName="Realname"  lastName="R"    claimedAt=2026-08-04T12:33:29
  firstName="Zzz"       lastName="Qqq"  claimedAt=null
```

The already-exists branch ignores the submitted names, so the pre-existing
student surfaces under their real name — that returned **name** is the channel
that recovers the row-exists bit on its own, independent of the status code.
`claimedAt` is a *different* bit riding along in the same response: whether
that row's owner has actually claimed an account, not whether the row exists
at all. This measurement shows both changing together only because the chosen
`target` happened to be a claimed student; a `target` that was instead an
unclaimed CRM contact would answer 200 with `claimedAt=null` too — identical to
the freshly-created row on that field — and the name would still be what gives
it away. A unified status would have removed one guard that could not fail,
not the leak itself — exactly the shape this project keeps finding at review.

(Commit `cfdd118`'s subject — "POST /api/students was an unmetered
account-existence oracle" — carries this same imprecision. It already sits on
this branch's history and cannot be corrected without rewriting it; this
document is the correction.)

The real control is whether a teacher may create the link at all knowing only an
email. That question **has** been answered — acceptance will be required — but the
answer is a feature, not a guard, so it ships separately. Until it does, the rate
limit is what stands between this route and a bulk sweep.

**A probe's link is permanent, and the student cannot remove just it.** A
successful probe leaves a `TeacherStudent` row, and there are three paths that
delete one: the teacher's own `DELETE /api/students/[id]`
(`students/[id]/route.ts:161`, teacher-gated), the student's own account
erasure (`services/gdpr.ts:223`, `deleteStudentAccount`), and teacher-account
erasure (`services/gdpr.ts:363`, `deleteTeacherAccount` — a teacher who deletes
their own account takes every link with them, including to students they never
had a real relationship with). Of the three, only the student's own erasure is
theirs to invoke, and it is total, not surgical: the student sees the stranger
listed on their privacy settings and can remove them only by deleting their
entire account, not just that one link. This is the sharpest remaining
consequence of "metered, not closed", and the invitation-flow issue must
decide unlink semantics, not only link semantics.

**`incomeTier` remains readable by any linked teacher.** Not fixed here, and the
reason is worth writing down rather than rediscovering. Prices are
`totalCost / Σratios × ratio_i` (`services/pricing.ts:140-146`) and `TIER_RATIOS`
are public constants in this repo and in `docs/visual/pricing-simulator.html`.
All five are distinct, so normalising one class's prices by the smallest yields
`{1, 1.23, 1.54, 1.85, 2.08}` and recovers **every attending student's exact
tier** from data the teacher already has. The API disclosure adds nothing for
anyone who has taken a class; it adds the current tier only for a linked student
who never has. It is a self-declared 1-of-5 band, the least sensitive field in
play. It belongs to the privacy-helper issue, which will decide it once for all
teacher-facing student projections instead of a fourth inline copy.

**Not audited:** whether `exportStudentData`/`exportTeacherData` keep a dual-role
account's two halves separated, and whether any `event-bus` publisher attaches
fields that would flow out through the SSE stream. Both are outside
`src/app/api/**/route.ts` and outside this issue.

## Testing

All in `tests/integration/students-api.test.ts`.

**The acceptance test must fail against today's code.** Verified before writing
the fix: today the response carries 16 keys.

1. **Disclosure.** A **claimed** student with `phone`, `birthday`, `address` and
   `incomeTier: 5` set and no `StudentPrivacy` row; a second teacher with no link
   POSTs that email. Assert `Object.keys(json.data)` deep-equals `['id']`.

   A new fixture is required, but not for the reason it first looks like. `POST
   /api/students` never reads `claimedAt` at all — there is no unclaimed-only
   gate here for a test to fall vacuously against, so any existing fixture
   would exercise the bug just as well. What actually rules out the file's
   *top-level* fixtures (the 25-student loop and `unlinked`, all created
   without `claimedAt`) is that none of them has `phone`, `birthday` or
   `address` set — the fields this disclosure actually needs to demonstrate.
   The new fixture exists to show what leaked, not to dodge a gate that isn't
   there.

   The assertion is **exhaustive on keys**, not field-by-field absence. A test
   asserting `phone === undefined` and three siblings cannot fail when someone
   later adds a new sensitive column to `Student`; a key-set assertion can.

2. **Created branch.** The 201 response body is `{ id }` too. Updates the existing
   assertion at `:147` (`json.data.firstName`); the `expect(res.status).toBe(201)`
   at `:145` stays valid.

3. **Rate limit — one shared budget.** Its own teacher, so the bucket key is
   fresh — the limiter is in-process on the server and integration tests cannot
   reset it over HTTP. 50 `POST`s succeed, the 51st returns 429.

   Because the fix now shares one bucket between `POST /api/students` and the
   teacher branch of `PUT /api/students/[id]` (Design §2's correction), a
   second test spends it across both on purpose — one `POST` to create a real
   contact, then 49 `PUT`s against that same contact's id, each moving its
   email to a fresh candidate — and confirms the 51st write of either kind is
   refused. Giving the `PUT` its own separate bucket would pass every other
   test in the file unnoticed; only this one would catch it. A third test
   confirms an invalid body still spends a hit, because the limiter runs
   before `parseBody`: 50 rejected bodies, then a flawless 51st request
   refused anyway.

   Budget check on the shared teacher's bucket: the file's existing POSTs are at
   `:136` (create), `:158` (409) and `:210` (invalid body) = **3**, plus 2 more
   spent by the `PUT` describes later in the file. `:187` uses a second teacher
   and `:219` sends no session, so neither reaches the limiter — the check sits
   after `requireTeacher`/`requireSession`. The new disclosure test also uses
   its own stranger-teacher. A handful of hits out of 50 leaves ample headroom,
   but note that the invalid body at `:210` *does* count a hit, because the
   limiter runs before `parseBody`.

   The existing `expect(json.data.id).toBe(createdStudentId)` at `:201` stays
   valid unchanged — it already asserts only the id.

4. **Teacher `PUT` returns `{ id }`.** Same exhaustive key assertion.

   **Fixture warning.** Do *not* reach for the `GET/PUT /api/students/[id] —
   profile-presence authorization` block at `:240`: its `rosterStudent` is created
   with `claimedAt: new Date()`, so the teacher branch 403s at `:109` before ever
   reaching the response — the test would pass against the bug. This test needs an
   **unclaimed** student linked to the teacher. Create a dedicated one in the test
   body and push its id onto `studentIds` so the existing `afterAll` cleans it up;
   do not reuse `studentIds[0]`, which the `GET` search tests assert on by name.

**Every guard gets broken before it is trusted.** Per guard: remove or invert it,
record the exact failure text, restore, re-run. Specifically — delete the
`select: { id: true }` on the `findUnique` and confirm test 1 fails with the
16-key set; delete the rate-limit block and confirm test 3 gets a 2xx where it
expects 429; delete the `select` on the `PUT`'s update and confirm test 4 fails.

Test 4 needs its falsifiability checked twice over, because it has *two* ways to
pass vacuously: against a claimed fixture the route 403s before responding, and
against an unlinked one it 403s at `:116`. Confirm the un-fixed route returns the
wide key set for this exact fixture before trusting the test.

## Filed, not folded

**1. Linking a student requires that student's acceptance.** Decided by the user
during this brainstorm: a teacher may not attach themselves to a student
unilaterally. Filed as work, not as a decision — but it is a substantial new path,
not a guard, and it is what actually closes both residuals above.

Measured while scoping it: there is **no invitation concept anywhere** in the
codebase, and `POST /api/students` sends **no notification on either branch**. The
unclaimed path is not the consenting counterexample it looks like — the teacher
creates the student row *and* the link immediately, and claiming
(`lib/auth/account.ts:38-50`) merely stamps `claimedAt` when that person later
signs in. They never agree; they arrive to find the teacher already attached. So
consent has to be added to both paths.

Open design questions that issue must answer before anyone starts:

- Does the *unclaimed* path need consent too? Creating a `Student` row for someone
  who never agreed is arguably a larger GDPR question than the link.
- Decline semantics: permanent block, or may the teacher re-invite? Re-invite is a
  harassment vector; permanent is a trap for a student who later changes their mind.
- Does registering for a teacher's class constitute acceptance? If so, the
  invitation path covers only the CRM-add case.
- Migration: every existing `TeacherStudent` row is implicitly accepted.
- Where does the student accept — Inbox, Settings, or a dedicated screen? A 4-tab
  IA question.
- Does the invitation response itself leak existence? Making "invitation sent"
  indistinguishable for a registered and an unregistered address is what finally
  closes the enumeration oracle this spec only meters.

**2. Honour `StudentPrivacy` in the payment and registration routes.** Decided by
the user during this brainstorm: the flags are honoured even when payment is
owed, because reminders go through the app and blocking a non-paying student is
the escalation. That makes it a leaf, but not this branch's leaf — it touches
`services/payments.ts:202-206` and `:239-242` plus four route files, and doing it
properly means
extracting one shared `projectStudentForTeacher` helper rather than a fourth
inline copy of the gating rule. Folding it here would turn a one-file fix into a
privacy-model refactor. It subsumes the `incomeTier` question above.

**Ratio: 1 closed, 2 opened.** Both arrive with their product decision already
made, so neither is a decision-shaped placeholder. The privacy-helper issue is a
true leaf. The invitation flow is not — it is a feature with six open design
questions listed above, and it wants its own brainstorm rather than a plan.
