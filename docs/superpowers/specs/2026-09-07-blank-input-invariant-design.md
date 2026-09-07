# A blank value is a blank value, whatever it is made of — #405

Issue #405 bundles five follow-ups from the five-agent review of #403 (student
name editing). Four of the five premises needed correcting before anything could
be designed on them; the corrections are recorded here, because they are the most
useful thing this spec contains.

The headline: §1 is filed as a two-field typo and is actually a twenty-two-field
hole in one file, reachable by anyone who types spaces into a form.

---

## 1. What was measured

### §1 — the whitespace hole, by two independent methods

**Syntactic census.** Every `.min(1)` in `src/lib/schemas.ts`:

```
grep -c "min(1)" src/lib/schemas.ts                     # 35
grep "min(1)" src/lib/schemas.ts | grep -c "trim()"     # 12
```

**35 = 12 already `.trim()`ed + 23 not.** The 12 are the `classType` (8) and
`location` (4) fields #311 fixed. The command was mutation-checked against three
other ways a non-empty check could have been spelled — `nonempty()`, `.length`,
and a spaced `min( 1 )` — none of which occur, and against multi-line spellings,
of which `pageSlugField` is the only one and is caught.

**Behavioural probe.** A throwaway test walked `Object.entries(schemas)` and
asked each field two questions: does it refuse `''`, and does it accept `'   '`.
A field answering yes to both has the hole. That found **22 fields across 12
schemas**:

| Shape | Fields | Schemas |
|---|---|---|
| names | 10 | `teacherProfileSchema`, `studentProfileSchema`, `updateTeacherSchema`, `createInvitationSchema`, `updateInvitationSchema`, `updateStudentSchema` |
| room address | 8 | `createRoomSchema`, `updateRoomSchema` — `venueName`/`address`/`city`/`postcode` each |
| opaque tokens | 2 | `magicLinkVerifySchema.token`, `passkeyAuthVerifySchema.challengeId` |
| other user text | 2 | `markPaidSchema.method`, `createAnnouncementSchema.message` |

**The two methods reconcile exactly: 23 − 22 = 1**, and that one is
`pageSlugField`, which carries no `.trim()` but is fenced by
`^[a-z0-9-]+$` and so refuses whitespace already. Nothing else in the file
guards blankness by another route.

Two corrections to the numbers I myself put in front of the maintainer before
running the probe. I predicted 20 and excluded `token` and `challengeId` as
"machine-generated, so not a real defect". The probe does not know about that
classification and flagged them, which is the better answer: including them
means the invariant below needs **no exemption list at all**. An invariant with
zero exemptions cannot be weakened by someone adding a thirteenth entry to its
allowlist.

The issue's own arithmetic is also off: it says `classType`/`location` use the
right idiom "in four other places". It is 12, across 8 schemas.

**Who hits this.** `updateStudentSchema` — the pair the issue names — is the
mildest of the 22. The same hole lets a teacher store a whitespace-only first
name on their **public** page (`teacherProfileSchema`), send a CRM
**invitation email** addressed to nobody (`createInvitationSchema`), and
broadcast a whitespace-only **announcement** to every student in a class
(`createAnnouncementSchema`). No unusual state is needed for any of these —
only spaces in a text box.

### §2 — confirmed, no correction

The whole test suite makes exactly two `PUT /api/students/…` requests
(`tests/integration/tier-selected-at.test.ts:176,189`), both as the owning
student, both for `reminderPref`/`incomeTier`. `tests/integration/students-api.test.ts`
has no `PUT` describe block at all. No cross-student attempt exists anywhere.
The gate at `src/app/api/students/[id]/route.ts:71` is correct today; this is
coverage, not a live hole, exactly as filed.

### §3 — one file stale, not three

Only `src/components/student/tier-form.tsx:28-30` is actually stale: it names
`notifications-form.tsx` as its only sibling. #403 *did* update
`notifications-form.tsx:25-27`, and `name-form.tsx:26-27` was written correct.
So the live drift is one file. The drift-*prone* roster is three, which is the
part worth acting on.

`tier-form.tsx` additionally points at another file for its reasoning ("See that
file for why there is no forward pin"). That pointer is sound today and is a
second drift surface; it goes with the roster.

### §4 — the cited authority does not govern this file

`docs/information-architecture.md` is titled "Information Architecture —
**Teacher App**", and CLAUDE.md's IA section describes the teacher's four-tab
IA. There is no student-app IA document, so "CLAUDE.md's IA section is explicit
that detail views get their own page" does not reach
`src/app/(student)/account/page.tsx`.

The index was also never a pure row list: `AddPasskey` has been inlined on it
since the index was created (`0154c483`, whose commit message says "Cross-link
and Sign-in stay on the index"). And #403 amended the comment to "personal
details + one row per area", so it is not silently claiming purity either.

What survives is narrow and real, and it is a Comment Discipline violation
rather than an IA one: the comment asserts **"teacher-settings pattern"**, and
`src/app/(teacher)/settings/page.tsx` contains no inline form. That is a claim
about another file, which is the thing CLAUDE.md forbids outright.

The maintainer's call: keep `NameForm` inline, correct the comment.

### §5 — the "established convention" is the minority idiom

48 non-test `.tsx` files carry at least one bare `} catch {` (62 occurrences);
13 non-test `.tsx` files log with `console.error`. The two files the issue names
are 2 of 48. Fixing them does not make the codebase consistent and this spec
will not claim it does.

The issue also misses `notifications-form.tsx`, which has the identical shape,
sits beside the other two, and was touched by #403. Three, not two.

None of the three forms has a test that exercises its `catch` at all, so the
logging would ship unproven. Each gets one.

---

## 2. The design

### §1 — trim the 22, and tether the rule so a 23rd cannot appear

**The fix at each site is inline `.trim()`**, placed before `.min(1)`, matching
the 12 sites #311 already wrote. Deliberately not a shared `requiredText`
constant: a constant would churn those 12 correct sites for no behavioural gain,
hide each field's type at its use site, and — the point — would not actually
prevent the next person from writing `z.string().min(1)` by hand. Only the test
below prevents that.

Order is load-bearing. Zod's `.trim()` is a transform that runs before the
checks, so `z.string().trim().min(1)` refuses `'   '` while
`z.string().min(1).trim()` still accepts it and merely stores `''`.

**The tether** is one new derived test in `src/lib/schemas.test.ts`:

> Every field of every exported schema that refuses the empty string must also
> refuse a string made only of whitespace.

Discovered by iterating `Object.entries(schemas)`, never by a roster. Its
properties are what make it worth writing:

- **It reads behaviour, not syntax.** It never looks for `.min(1)`. So
  `pageSlugField`, guarded by a regex instead, passes without needing a
  `.trim()` it does not want — and a future field guarded some third way passes
  too.
- **Fields exempt themselves.** A field that legitimately accepts a blank value
  (`bio`, `notes`, `description`, a nullable `phone`) accepts `''` and is
  skipped. There is no allowlist to maintain and none to weaken.
- **A schema added tomorrow is covered the moment it is exported.** This is the
  whole reason to prefer it to a fourth hand-written roster.

It must also prove it looked at something. A discovery loop that silently
visits zero fields — a moved module, a renamed export — reports an empty
offender list and passes green. So the test asserts a floor on the number of
fields it checked, commented as a floor and not a census, so growth never
touches it.

**It supersedes exactly two existing tests.** The #311 block
(`schemas.test.ts:702`) has six `it` declarations: two census tests ("covers
exactly the eight schemas carrying `classType`"), two whitespace-rejection
`it.each` blocks, and two trim-behaviour `it.each` blocks. The universal
invariant subsumes **the two rejection blocks only** — those get deleted, with a
pointer left in their place.
The census tests assert something different (which schemas carry the field at
all) and the trim tests assert something the invariant does not (that padding is
stripped before storage, `'  Vinyasa  '` → `'Vinyasa'`). Both stay. 6 − 2 = 4
tests remain in that block.

Deleting them is not tidiness. Left standing, `it.each(classTypeSchemas)('rejects
empty and whitespace-only')` is a template inviting a fifth and sixth roster —
for names, for room fields — which is the drift this whole change exists to end.

**Proving it bites** (a pin that compiles but cannot fail certifies nothing).
Before the trims land, the new test must be observed RED naming all 22 fields.
After they land and it is green, one `.trim()` is removed from a site the test
did not have to be told about — `createRoomSchema.city`, not one of the two the
issue names — the exact failure text is recorded, and it is restored and
re-verified. A guard proven only against the field it was written for is a guard
proven against nothing.

### §2 — the ownership test

A new `describe('PUT /api/students/[id]')` in
`tests/integration/students-api.test.ts` with its own fixture: two claimed
students, each with an account and a session, so the block is order-independent
in the way that file's other blocks are.

Three cases:

1. Student A `PUT`s student B's id with `{ firstName: … }` → **403**, and B's
   stored name is unchanged. The assertion on B's row matters: a 403 whose write
   happened anyway is the failure this test exists to catch.
2. Student A `PUT`s their own id with `{ firstName: … }` → **200**, name
   changed. Without this the 403 case would also pass against a route that
   rejects everything.
3. Student A `PUT`s their own id with `{ firstName: '   ' }` → **400**. This is
   §1's acceptance criterion proven end-to-end on the route, not just at the
   schema.

Case 3 depends on the trims landing, so §1 is built first.

### §3 — drop the roster from all three docblocks

Each of the three forms keeps its own reason and states it without naming a
sibling. The durable fact needs no roster: `updateStudentSchema` is `.strict()`,
so a key the schema dropped would 400 at runtime, and the reverse pin catches
that at compile time instead. `tier-form.tsx`'s cross-file pointer goes with the
roster — each docblock becomes self-contained.

### §4 — correct the page comment

`src/app/(student)/account/page.tsx:20` describes only itself: personal details
inline, then one row per settings area. No claim about the teacher page. The
layout does not change.

### §5 — log in three forms, and prove each log fires

`tier-form.tsx`, `name-form.tsx` and `notifications-form.tsx` bind the error and
`console.error` it, following `class-edit-form.tsx:139-145` and
`studio-class-edit-form.tsx:195-201`. Each comment says what actually reaches
that block in *that* file, which is not the same in all three: `name-form.tsx`
delegates body parsing to `readErrorMessage`, which handles its own unreadable
body and returns the fallback rather than throwing, so only `fetch` itself
failing lands there; `tier-form.tsx` and `notifications-form.tsx` never read the
body at all.

Each form gets a component test that stubs `fetch` to reject, asserts the user
sees "Network error. Try again.", and asserts `console.error` was called. The
third assertion is the one that makes this a change rather than a gesture.

---

## 3. Task order

1. **§1** — tether (RED on 22) → 22 trims → GREEN → supersede the two #311
   rejection blocks → mutation-test the tether.
2. **§2** — the three PUT integration cases. **After task 1**: case 3 asserts the
   400 that task 1 creates.
3. **§3 + §4** — four comment corrections, no behaviour change. Independent.
4. **§5** — three forms logged, three failure tests. Independent.

---

## 4. Not this issue

- **The 25 fields that legitimately accept a blank value** — `bio`, `notes`,
  `description`, `phone`, `address`, `bankIban`, both invitation `lastName`s, and
  the rest. They accept `''` by design, so the invariant exempts them, and
  normalizing `'   '` → `''` across them is a separate data-hygiene question
  with a different justification. Untouched, and the tether will not start
  covering them by accident.
- **Array element schemas.** `createRoomSchema.equipment` is
  `z.array(z.string())`, so `['   ']` stores a blank equipment tag. The
  invariant walks top-level fields only and does not see it. Named here so the
  tether is not read as covering more than it does.
- **The other 45 files with a bare `catch {}`.** Named in §5 above, not swept.
  A ~60-site mechanical diff does not belong in a five-part follow-up issue.
- **Moving `NameForm` to an `/account/profile` sub-page.** Declined by the
  maintainer; the comment is corrected instead.
- **#403 is unaffected** — it is merged, and its own review comments are not
  filed here.

---

## 5. Acceptance

- `PUT /api/students/[id]` with `firstName: "   "` returns 400. (§1, as filed)
- The other 21 fields refuse whitespace too, and a 23rd cannot be introduced
  without the tether going red.
- A student attempting `PUT` on another student's id gets 403 and changes
  nothing.
- No docblock in the three student forms names a sibling form.
- No comment in `src/app/(student)/account/page.tsx` makes a claim about
  `src/app/(teacher)/settings/page.tsx`.
- Each of the three forms logs its network failure, proven by a test that fails
  if the log is removed.
