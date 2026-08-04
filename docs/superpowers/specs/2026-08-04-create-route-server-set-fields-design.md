# Server-set and cross-tenant fields taken from request bodies on three routes

**Issues:** #146, #148, plus a third instance found by census (no issue — fixed here).
**Date:** 2026-08-04

> Every line reference and present-tense claim below describes the tree at this branch's
> base commit, `ea03d3a`, not at merge — this is a dated design record, not a live
> reference. The branch itself invalidated several of them by construction.

## What this is

Three API routes accept an id from the request body that identifies a row owned by
someone else, and none of them checks the ownership:

| route | field | remedy |
|---|---|---|
| `POST /api/classes` | `templateId` | drop from schema — server-set, no UI sends it |
| `POST /api/studio-classes` | `templateId` | drop from schema — same |
| `PUT` + `GET /api/students/[id]/privacy` | `teacherId` | validate — the client legitimately supplies it |

The two remedies are different because the two situations are. `templateId` is set by the
generator when a template materialises a class; a client has no legitimate reason to send
it, so the fix is to stop declaring it. `teacherId` on the privacy route is genuinely
chosen by the student — the fix is to check that the student and that teacher are linked.

## Premise verification

Every issue worked in this repo so far has had a premise that was wrong or incomplete.
This one is no exception. What was measured, against what the issues claimed:

### Held

- `src/app/api/classes/route.ts:78` writes `templateId: body.templateId ?? null`, and
  nothing between `parseBody` (`:52`) and `prisma.class.create` (`:62`) reads or validates
  it. The `teacherRoomId` check at `:57-60` is the correct-shape contrast #146 draws.
- `src/app/api/studio-classes/route.ts:24-31` destructures `{ date, ...rest }` and spreads
  `rest` into `prisma.studioClass.create`. `createStudioClassSchema` declares eight keys;
  `date` is destructured out and the other seven ride the spread.
- `templateId` appears in no creation UI. Every UI reference to `templateId` that reaches
  a request (`settings/recurring/[id]`, `settings/studio-classes/[id]`, the four template
  buttons, the two template forms) targets a *template* route, never these two POSTs. The
  two create wizards do contain the identifier at this branch's base — but only inside
  their pin exclusions and the comments explaining them, never in a body.
- No client sends `templateId` or `studentCount` at create: not the two wizards, not the
  one integration test that POSTs to `/api/studio-classes`
  (`tests/integration/studio-api.test.ts:414-421`). `prisma/seed.ts:706-717` does write both
  when seeding a past `StudioClass`, but directly via Prisma, not through the route — the
  schema narrowing doesn't govern that path, so it doesn't change this decision.
- The exploitability gate is real. Both need another teacher's `ClassTemplate` /
  `StudioClassTemplate` UUID (v4, not enumerable), and no disclosure path for one was
  found. The two public pages pass no `templateId` to client components (they pass arrays
  and objects, but no template id among them), and every
  `/api/class-templates*` handler is ownership-checked. **This was not proven exhaustively
  across all server components** — see "Not measured".

### Did not hold

**1. "This is not a data leak" (#146) is false.**

#146 states: *"The created class belongs to A (`teacherId: session.teacherId` is
server-set), so this is not a data leak. It is a cross-tenant denial of service."* The
denial of service is real, but it is not the only consequence, and disclosure is among
the others.

`syncTemplateInstances` (`src/services/template-sync.ts:44-47`) selects instances by
`{ templateId, date: { gt: now } }` with **no `teacherId` scope**, then `updateMany`s
(`:64-80`) twelve columns onto every match — including the squatter's row:

```
teacherRoomId, classType, description, startTime, durationMinutes,
roomCost, minRate, targetRate, minStudents, maxStudents,
cancelDeadline, autoCancelCheck
```

So when the victim next edits their template, the victim's `teacherRoomId`, `roomCost`,
`minRate` and `targetRate` are written onto the attacker's class, which the attacker then
reads on their own class detail page — that page includes
`teacherRoom: { include: { room: true } }` (`src/app/(teacher)/class/[id]/page.tsx:37`).
CLAUDE.md's data model says `TeacherRoom` "holds private rental rate per teacher — never
shared between teachers."

This arm requires the victim to edit their template afterwards, and the squatted class
must be future-dated, `draft`/`open`, `settingsLocked: false`, and on the template's
`dayOfWeek` — otherwise `template-sync.ts:56-61` deletes it as "wrong day" instead.

There is no studio analogue: `studio-class-template-lifecycle.ts` contains no write-back
onto `StudioClass`, so #148's half is denial of service and self-harm only.

**2. The roadmap's "mass-assignment hardening line is finished" is true but narrower than
it reads.**

The machinery is real and thorough — `NoneOf` pins, a teacher-editable allowlist, a
forbidden list, update types derived from `ClassUncheckedUpdateManyInput`
(`src/services/class-lifecycle.ts:278,340,363,405,414`, and the equivalent battery in
`class-template-lifecycle.ts:154-182`). All of it sits on the **update** path. #79 was
`PUT /api/classes/[id]`; #82 was `PUT /api/class-templates/[id]`.

Measured: `.strict()` is applied to 9 schemas in `src/lib/schemas.ts`, and all 9 are
update schemas — 9 for 9, no exceptions. `schemas.test.ts` carries key-set pins for
`updateClassSchema` and `updateClassTemplateSchema`; no create schema has one. Of 34
exported schemas, 34 − 9 = 25 are non-strict, and every create schema is among them.

So #146 and #148 are not instances a sweep missed. They are the half of the surface the
sweep never looked at. That reframing predicts further instances on other create paths,
which is why a census was run rather than a targeted grep — and it found one.

**3. #146 misquotes CLAUDE.md.**

#146 says the `as never` casts violate CLAUDE.md's *"no type assertions to silence
errors"*. No such rule exists. CLAUDE.md line 8 reads: *"TypeScript with `strict: true` —
no `any`, no implicit types, non-negotiable."* The casts are still worth removing, but on
their own merits, not a cited rule.

**4. `.strict()` is not a mass-assignment control, and "stop spreading" would not have
prevented #146.**

Measured against the installed zod (4.4.3):

```
z.object({a: z.string()}).parse({a:'x', evil:'y'})                       -> {"a":"x"}
z.object({a: z.string()}).strict().safeParse({a:'x', evil:'y'}).success  -> false
```

A non-strict `z.object` **strips** undeclared keys before Prisma sees them. `.strict()`
converts a silent strip into a 400 — a developer-experience property, not a security
control. The dangerous thing is *declaring* a server-owned key at all.

The proof is in this repo: `createClassSchema` is non-strict, is spread nowhere, and its
handler names every field it writes explicitly at `classes/route.ts:63-80` — and is still
#146. Conversely
`createStudioClassTemplateSchema` is non-strict *and* spread wholesale
(`studio-class-templates/route.ts:28`) and is clean, because its six keys are all
teacher-owned scalars with no FK among them.

This is why the spread removal in #148's option 2 is specified below as a readability
change and not as the fix.

### The census

A data-flow census traced every property of every `data:` object back to its origin
across all 41 Prisma writes in the 52 route files, plus every service write reachable from
a route with a body-derived argument. Method was data flow, not key names — a grep for key
names cannot see `const { date, ...rest }`, which is how #148 stayed hidden.

Arithmetic: `grep -rnE "\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(" src/app/api --include=route.ts`
returns 42 lines; exactly one is not Prisma (`notifications/stream/route.ts:75`, a
`Map.delete`). 42 − 1 = **41 writes**. `grep -rl` with the same pattern returns 25 files,
but `notifications/stream/route.ts` is one of them and its only match is that `Map.delete`
— so the 41 writes live in **24** route files, and the other **28** of the 52 contain
none. 24 + 28 = 52. (An earlier revision said 25 and 27: the non-Prisma hit had been
subtracted from the write count but not from the file count.)

It found one further instance of this exact defect (fixed here), and several adjacent
findings that are not (see "Not fixed here").

## The third instance

`src/app/api/students/[id]/privacy/route.ts`. Both handlers prove the caller owns the
**student** side and never touch the **teacher** side:

- `PUT` (`:63-65`, `:69-89`): `session.studentId !== id` → 403, then `teacherId` is
  destructured out of the body and used directly as the upsert key.
- `GET` (`:21-28`): the same student check, then `teacherId` is read from the query string
  and used directly.

`updatePrivacySchema` (`src/lib/schemas.ts:151-159`) declares
`teacherId: z.string().uuid()`. There is no `teacherStudent.findUnique`, no
`teacher.findUnique`, and no comparison of any kind on the *teacher* side. (The file does
compare on the student side — `session.studentId !== id`, twice, quoted a few lines above.
That is exactly the asymmetry.)

An authenticated student can create or overwrite a `StudentPrivacy` row for any teacher —
including one they have no relationship with — setting `shareFullName`, `shareEmail`,
`sharePhone`, `shareBirthday`, `shareAddress` to `true`. That pre-authorises disclosure to
a stranger, and it becomes live the moment a `TeacherStudent` link exists. Per #162, a
teacher can create that link unilaterally knowing only an email address.

It cannot reach another *student's* row — `studentId` comes from the path and is
session-checked. It needs a valid `Teacher` UUID; an unknown one is a foreign-key error,
not a write.

The `GET` discloses nothing about the teacher — it returns the student's own row, or a
virtual maximum-privacy default (the five share flags false, `receiveComms` true). It is
fixed anyway, because fixing one handler and leaving its
twin is the failure this backlog keeps repeating.

## The design

### `templateId` — drop it from both create schemas

`src/lib/schemas.ts`: remove the `templateId` line from `createClassSchema` (`:237`) and
from `createStudioClassSchema` (`:373`).

`src/app/api/classes/route.ts`: delete `templateId: body.templateId ?? null` (`:78`).
`Class.templateId` is `String?`, so an omitted key leaves it null — the same value the
line wrote for every legitimate call.

`src/app/api/studio-classes/route.ts`: replace the `{ date, ...rest }` spread with an
explicit field list, matching how `POST /api/classes` and `POST /api/class-templates`
already write. This is a readability change, not the fix — see premise correction 4 — but
it makes the next added key a visible decision instead of an invisible one.

A client that still sends `templateId` has it silently stripped by Zod and receives a
normal 201 with `templateId: null`. `.strict()` is deliberately **not** added: it is not a
mass-assignment control (measured above), no create schema in the repo is strict, and
adding it to two of them would break a 9-for-9 convention while implying strictness was
the fix.

### `studentCount` — drop it too

`createStudioClassSchema` also declares `studentCount`. It is not a security problem: a
teacher can already set it on their own row via `PUT /api/studio-classes/[id]`
(`student-count-editor.tsx:26`), so accepting it at create grants no new privilege. It is
dead surface — the create form does not send it — and removing it lets the studio wizard's
pin carry **zero** exclusions.

### `teacherId` — validate it on both privacy handlers

Both `PUT` and `GET` gain a `TeacherStudent` lookup after the student-side check and
before touching `StudentPrivacy`. No link → 403.

The check is for **existence**, not `isArchived: false`. Archiving is the teacher's filing
action; a student should not lose control over their own privacy settings because a
teacher archived the relationship. `account/privacy/page.tsx:28-32` renders cards only for
non-archived links, so no UI path sends an archived `teacherId` either way — the looser
check is chosen for the semantic, not for compatibility.

### Tighten the pins that already exist

Both create wizards carry a `_formCoversCreate` pin asserting that every create-schema key
is a form field, with `templateId` listed as an explicit exclusion and a comment naming
these issues:

- `src/app/(teacher)/class/new/page.tsx:75-77` — excludes `'description' | 'templateId'`
- `src/app/(teacher)/studio-class/new/page.tsx:44-46` — excludes `'studentCount' | 'templateId'`

Removing the fields from the schemas lets the exclusions go. The studio pin becomes
exclusion-free. The class pin keeps `'description'`, which belongs to **#147** (render an
input, or drop the field) and is out of scope here; its comment is rewritten to describe
only that one remaining exclusion.

This is the part that stops recurrence. Once the exclusions are gone, adding a key to
either create schema without a matching form field fails the build, naming the key.

### The structural guard: a forbidden list for every schema

The wizard pins above are per-form and opt-in. They exist only because #136 pinned those
two wizards; a new create route with a new form would carry no pin unless a contributor
remembered to write one. Fixing three instances and hardening two forms does not make the
*class* of defect fail the build, and that asymmetry is the same one premise correction 2
identifies: the update path has a forbidden list
(`PlainUpdateForbiddenClassField`, `src/services/class-lifecycle.ts:390`) and the create
path has nothing.

So this branch adds the missing half, in `src/lib/schemas.test.ts`:

- `SERVER_OWNED_FIELDS` — names that are set by the server and must never be declared by a
  schema without a stated reason: `templateId`, `status`, `settingsLocked`, `paidAt`,
  `tierAtBooking`, `tierSelectedAt`, `claimedAt`, `cancelledAt`, `accountId`, `isArchived`,
  `archivedAt`, `withdrawnCount`, `totalRevenue`, `isPublic`, `photoUrl`, `createdById`,
  `teacherId`, `studentId` — plus `id`, `effectiveTeacherRate` and `totalStudents`, added
  in review so the register is not a strict subset of the `PlainUpdateForbiddenClassField`
  it claims parity with.
- An expected-exceptions map, one entry per schema that legitimately declares one, each
  with a one-line reason.
- A test asserting that for **every** exported schema, the intersection of its keys with
  `SERVER_OWNED_FIELDS` **equals** its expected set — exact equality, not a subset check,
  so the list cannot rot in either direction. Adding a forbidden key to any schema fails
  naming it; removing a legitimate one fails too, forcing the map to stay true.

Measured today, all 34 exported schemas are enumerable via `.shape` (it survives
`.refine()` in zod 4.4.3, verified), and exactly ten declare a candidate name. After this
branch the two create schemas drop out, leaving eight documented exceptions:

| schema | field | why it stays |
|---|---|---|
| `createRegistrationSchema` | `studentId` | a teacher registers a roster student; checked in `src/app/api/registrations/route.ts:87-92` |
| `createRoomSchema` | `isPublic` | a create-time choice, legitimately the client's |
| `transitionClassSchema` | `status` | the state machine's own input; `'completed'` deliberately absent |
| `updatePrivacySchema` | `teacherId` | the student chooses the teacher; the link is checked as of this branch |
| `updateRegistrationSchema` | `status` | attendance on the teacher's own class |
| `updateRoomSchema` | `isPublic` | **known gap** — no form sends it, one-way door; blocked on #73 |
| `updateStudioClassSchema` | `cancelledAt` | **known gap** — a client can backdate; self-affecting |
| `updateTeacherSchema` | `photoUrl` | **known gap** — no form sends it, rendered nowhere; blocked on #46 |

The last three are the findings this branch decided not to fix. Putting them in the
exceptions map is deliberate: it moves them from a spec nobody re-reads to a line beside
the guard, where the next person to touch that schema sees them.

Each name in `SERVER_OWNED_FIELDS` is additionally pinned against the Prisma model key
union, mirroring `_forbiddenColumnsExist` (`class-lifecycle.ts:405`), so a typo cannot sit
in the list protecting nothing.

### `as never`

`classes/route.ts:76-77` writes `body.cancelDeadline as never ?? undefined`. Prisma
generates `CancelDeadline` as `'HOURS_48' | 'HOURS_24' | 'HOURS_12' | 'HOURS_6'`
(`node_modules/.prisma/client/index.d.ts:151-158`) — identical to the Zod enum output.
The cast is expected to be unnecessary. Both casts, and the redundant `?? undefined`, are
removed; if the removal does not typecheck, the assertion is kept with a comment recording
why, rather than the change being forced through.

## Guards, and proving each bites

Per project practice, every guard is broken, its exact error recorded, then restored and
re-verified. A guard that cannot fail certifies nothing.

| guard | what breaks it |
|---|---|
| `schemas.test.ts` key-set pin on `createClassSchema` | re-add `templateId` to the schema |
| `schemas.test.ts` key-set pin on `createStudioClassSchema` | re-add `templateId` or `studentCount` |
| studio wizard `_formCoversCreate` (now exclusion-free) | re-add either key to the schema |
| class wizard `_formCoversCreate` | re-add `templateId` to the schema |
| integration: foreign `templateId` does not attach (classes) | restore the `templateId:` line |
| integration: foreign `templateId` does not attach (studio) | restore the spread |
| integration: privacy PUT 403s an unlinked teacher | remove the link check |
| integration: privacy GET 403s an unlinked teacher | remove the link check |
| `SERVER_OWNED_FIELDS` exceptions map | add `templateId` to *any* schema; and separately, delete a legitimate exception to prove exact equality fails in both directions |
| `SERVER_OWNED_FIELDS` name pin | misspell a name in the list and confirm the build names it |

The two key-set pins mirror the existing ones for `updateClassSchema` and
`updateClassTemplateSchema` (`schemas.test.ts:134`, `:159`). They are worth having
alongside the wizard pins because the class wizard's pin still carries the `description`
exclusion, so it is not airtight; a key-set test reads the schema object directly and is.

`POST /api/classes` currently has **zero** integration coverage —
`tests/integration/classes-api.test.ts` contains exactly three `describe` blocks
(`/complete`, `/transition`, `PUT /[id]`), none for the create route. That absence is why
this survived. The new tests establish that coverage.

## Rejected alternatives

**Validate `templateId` ownership instead of dropping it (#146 option 2; #148 offers no
validate option — its option 2 is "stop spreading into `create`").**
Rejected: the field is server-set and appears in no UI, so there is nothing to validate
*for*. Dropping it is strictly narrower, and it is what lets the wizard pins become
self-enforcing — a validation check would leave the key declared and the exclusions in
place.

**Teacher-scope the generator's `findFirst`.** This looks like the root fix and is worse
than the disease. `class-generator.ts:98` reads
`findFirst({ where: { templateId: template.id, date } })`; adding `teacherId` makes the
generator stop skipping the squatted date and attempt an insert instead — which violates
the global `@@unique([templateId, date])` (`prisma/schema.prisma:353`, `:430`).
Generation runs inside an interactive transaction (`SET LOCAL lock_timeout` at `:140`,
`FOR UPDATE` at `:216`), and a constraint violation aborts a Postgres transaction: the
existing `catch … continue` at `:122-127` cannot un-abort it, so every later statement in
that template's window fails with `25P02`. A silent gap would become a hard cron failure.
Fixing the create routes removes the only non-race way to reach that state.

**Add `.strict()` to the create schemas.** Rejected on the measurement in premise
correction 4, and on convention. Recorded here because it is the obvious suggestion and a
reviewer will raise it.

**Scope the `templateId`-keyed service queries by teacher** (`template-sync.ts:44`,
`class-template-lifecycle.ts:396-400`, `studio-class-template-lifecycle.ts:92-96`).
Defence in depth, and genuinely tempting given the blast radius. Out of scope: with no
squatted row reachable, a `templateId` uniquely determines its owner, so the extra scope
is unreachable code today. Filing it would add an issue that closes no path.

**Reversed in review, for `template-sync.ts` only.** A branch whose thesis is that opt-in
protections rot is an odd place to decline defence in depth, and the reasoning above
assumes the create-route fix never regresses — the assumption this branch exists to
distrust. `template-sync.ts:44` is now teacher-scoped; it is the query that turned the
squat into a rental-rate disclosure. The other two sites stand as written.

## Not fixed here

Named so nobody reads this as a clean sweep.

- **#162** — `POST /api/students` returns an unfiltered student row to any teacher who
  knows the email. Filed today from the same census; more severe than anything here and
  reachable with no UUID. Needs a product decision on unilateral linking.
- **#147** — `description` is accepted by `createClassSchema` and rendered by no input.
  Keeps its exclusion in the class wizard pin.
- **`cancelledAt`** on `PUT /api/studio-classes/[id]:50-59` — a client can backdate,
  forward-date or null a cancellation timestamp. Ownership *is* checked, so the blast
  radius is a teacher's own bookkeeping. Self-affecting; not filed.
- **`isPublic`** on `PUT /api/rooms/[id]` — declared, spread into the update, sent by no
  form, and a one-way door (a public room can no longer be edited or deleted, and every
  other teacher can attach to it). Self-inflicted and needs #73's `isPublic` product
  decision. `edit-room-form.tsx` simply never mentions `isPublic` — nothing in that file
  records a block, so read this as an inference, not as something the code states.
- **`photoUrl`** on `PUT /api/teachers/[id]` — declared, written, sent by no form,
  rendered nowhere. Latent until someone adds the `<img>`; blocked on #46.

  These three are not merely left alone: each becomes a named entry in the
  `SERVER_OWNED_FIELDS` exceptions map with its reason, so the next person to touch that
  schema reads the gap instead of rediscovering it. That is the intended use of the map —
  it is a register of decisions, not only a blocklist.
- **`lastName` blanking** — the teacher branch of `PUT /api/students/[id]` validates with
  `createStudentSchema`, whose `lastName` is `.optional().default('')`. Zod materialises
  defaults, so a PUT omitting `lastName` writes `''` over the stored surname. Data loss,
  not security, and API-only (`edit-student-form.tsx` always sends it).
- **The P2002 catch inside the generator's transaction** (`class-generator.ts:122-127`)
  cannot work as written when `db` is a `TransactionClient`. Pre-existing, and this change
  makes it *less* reachable by removing the squat path; the remaining path is a race the
  `FOR UPDATE` row lock serialises. Recorded as a code comment, not an issue.

## Not measured

- Whether a `ClassTemplate` UUID is reachable by a non-owner through some server
  component's RSC payload or the GDPR export (`exportTeacherData`). The two public pages
  and every `/api/class-templates*` handler were checked; the rest was not. This is the
  gate the whole exploit chain rests on, so it is the most valuable thing left unproven —
  but the fix does not depend on the answer.
- Whether a `StudentPrivacy` row written for an unlinked teacher survives and applies once
  that teacher links. `GET /api/students/[id]:39-46` reads it by `(studentId, teacherId)`
  with no freshness check, which suggests yes. Not confirmed by test; the fix makes it
  moot going forward but says nothing about rows already written.

## Testing

Integration tests are run **by explicit file path** — one file in that project is IP
rate-limited and a whole-project run trips it.

- `tests/integration/classes-api.test.ts` — new `POST /api/classes` describe: happy path,
  and a POST carrying another teacher's `templateId` that must produce a class with
  `templateId: null` while the victim's template is untouched.
- `tests/integration/studio-api.test.ts` — the same pair for `POST /api/studio-classes`,
  plus `studentCount` no longer being settable at create.
- `tests/integration/privacy-api.test.ts` — PUT and GET each 403 for a teacher the student
  has no link to; the existing linked-teacher tests must still pass.
- `src/lib/schemas.test.ts` — key-set assertions for both create schemas.
- Component tests for the two wizards already exist and must stay green; their pins are
  compile-time, so `npx tsc --noEmit` is the check that the tightened pins hold.
