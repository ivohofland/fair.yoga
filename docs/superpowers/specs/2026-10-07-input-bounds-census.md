# Census for #769: input bounds and send limits

Worktree `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-769`, HEAD `df6b7296` (branch `fix/769-input-bounds`, clean). Read-only. Zod 4.4.3, Prisma 6.19.x, Postgres 16, Next 16.3.4. Taken 2026-10-07.

**The issue's line numbers are stale.** At HEAD: `message` is `schemas.ts:687` (the issue says 680), teacher names are `:270-271` / `:288-289` (the issue says 295-296), invitation names are `:341-342` / `:352-353`, student names are `:283-284` / `:399-400`, `method` is `:673` (the issue says 665), and the class/template/studio schemas are at `:492-629`. `email-templates.ts:238` is correct.

**One of the issue's premises is wrong.** nginx is **not** 10 MB for announcements. `deploy/nginx.conf.example` raises `client_max_body_size 10m` only in `location ~ ^/api/teachers/[^/]+/photo$`. Every other path keeps nginx's **1 MB default**, which `DEPLOYMENT.md:56-59` states. See section F.

---

## Re-derivation tooling

The schema walker introspects every export of `schemas.ts` whose name ends in `Schema`, using Zod 4's `_zod.def`:

```
# from the worktree root (Node 22 is fine; tsx is in node_modules/.bin)
node_modules/.bin/tsx --tsconfig tsconfig.json <scratch>/walk-schemas.ts > rows.tsv   # tally on stderr
```

The script lives at `/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga--claude-worktrees-issue-726/7ee24d14-f1d1-4156-bf5b-c49b06a17ef3/scratchpad/walk-schemas.ts` (copy it anywhere). It unwraps optional, nullable, default and pipe wrappers, recurses through objects, arrays and unions, and classifies each leaf from its checks:

- a `max_length` check → `str-bounded`
- a uuid or datetime format → `str-format`
- a regex with no max → `str-regex-only`
- anything else → `STR-UNBOUNDED`
- a number with a `less_than` check → `num-bounded`, otherwise `NUM-UNBOUNDED`

Raw tally at HEAD (203 leaf rows):

| class | rows |
|---|---|
| STR-UNBOUNDED | 59 |
| STR-UNBOUNDED(email) | 6 |
| str-regex-only | 15 |
| str-bounded | 18 |
| str-format(uuid) | 16 |
| str-format(datetime) | 1 |
| NUM-UNBOUNDED | 32 |
| num-bounded | 12 |
| enum | 18 |
| bool | 22 |
| bounded-array | 2 |
| UNBOUNDED-array | 2 |

Cross-checks:

- `grep -c "z.object" src/lib/schemas.ts` finds every object schema.
- `grep -rln "from 'zod'" src | grep -v test` shows no other **body** schema outside `schemas.ts`. `bank-accounts/[currency]/route.ts:16` has `z.enum(Currency)`, but it validates a path segment. `api-utils.ts`, `profile-authorization.ts`, `attendance-outbox.ts` and `teacher-profile/route.ts` import zod for types only.
- `grep -rln "request\.json()" src/app/api` finds `students/[id]/route.ts`, which parses `archiveStudentBodySchema`, and `teachers/[id]/photo` (formData, size-capped). Every other body goes through `parseBody`.

---

## A. Field census

### A.0 Who parses what (schema → route)

Derived with `grep -rl "\b<Schema>\b" src/app src/services src/lib`.

| Schema | Route(s) | Caller |
|---|---|---|
| teacherProfileSchema | POST `/api/account/teacher-profile` → `prisma.teacher.create` (route:124) | new teacher (ticket or session) |
| updateTeacherSchema | PUT `/api/teachers/[id]` → `updateTeacherProfile` (`services/teacher-profile.ts:57,84`) | teacher |
| studentProfileSchema | POST `/api/account/student-profile` → `student.create` (route:153) | student (ticket) |
| updateStudentSchema | PUT `/api/students/[id]`, self branch only (route:75-93) | student |
| createInvitationSchema | POST `/api/students` (`inviteContact`, `invitations.ts:397/474`), and as `newContact` in POST `/api/registrations` (walk-in, `walk-ins.ts:132,172`) | teacher |
| updateInvitationSchema | PUT `/api/invitations/[id]` (route:218) | teacher |
| bankAccountSchema | PUT `/api/teachers/[id]/bank-accounts/[currency]` → `services/bank-accounts.ts:62-71` | teacher |
| createRoomSchema / updateRoomSchema | POST `/api/rooms`, PUT `/api/rooms/[id]`, `/api/rooms/[id]/publish` | teacher |
| roomSearchQuerySchema | GET `/api/rooms` (query, not stored) | teacher |
| createTeacherRoomSchema / updateTeacherRoomSchema | POST `/api/teacher-rooms`, PUT `/api/teacher-rooms/[id]` | teacher |
| createClassSchema / updateClassSchema | POST `/api/classes`, PUT `/api/classes/[id]` (`class-lifecycle.ts`) | teacher |
| createClassTemplateSchema / updateClassTemplateSchema | POST `/api/class-templates`, PUT `/api/class-templates/[id]` | teacher |
| createStudioClassTemplateSchema / update… | POST `/api/studio-class-templates`, PUT `/[id]` | teacher |
| createStudioClassSchema / updateStudioClassSchema | POST `/api/studio-classes`, PUT `/api/studio-classes/[id]` | teacher |
| markPaidSchema | POST `/api/payments/[id]/paid` → `markPaymentPaid` (`payments.ts:138-156`) | teacher |
| createAnnouncementSchema | POST `/api/announcements` → `sendAnnouncement` | teacher |
| magicLink*, studentSignup, teacherSignup, passkey* | `/api/auth/*` | anonymous |
| pushSubscription / pushUnsubscribe | `/api/push/subscriptions` | any session |

### A.1 Prisma columns these fields land in

From `prisma/schema.prisma`:

| Column | Type |
|---|---|
| Teacher.firstName / lastName | `String` (text, no length) |
| Teacher.bio | `String @db.VarChar(250)` |
| Teacher.pageSlug | `String @unique` |
| Student.firstName / lastName | `String` |
| Student.phone / address | `String?` |
| Invitation.firstName / lastName | `String @default("")` |
| TeacherBankAccount.holderName / iban / bic / sortCode / accountNumber / routingNumber | `String` / `String?` |
| Room.venueName / address / city / postcode / floor / roomName | `String` (+ btree `@@index([address, floor, roomName])`) |
| Room.maxCapacity | `Int` |
| Room.equipment | `Json` |
| Room.notes | `String? @db.Text` |
| TeacherRoom.capacityOverride | `Int` |
| TeacherRoom.rentalRate | `Decimal(10,2)` |
| TeacherRoom.equipmentNotes | `Text` |
| ScheduleRule.classType / CalendarEntry.classType | `String` |
| ScheduleRule.durationMinutes / CalendarEntry.durationMinutes | `Int` (CHECK `> 0`) |
| Class.description / ClassTemplate.description | `String? @db.Text` |
| Class / ClassTemplate .roomCost, minRate, targetRate | `Decimal(10,2)` |
| Class / ClassTemplate .minStudents / maxStudents | `Int` (CHECK 0..200 / 1..200) |
| Class.effectiveTeacherRate, totalRevenue; Registration.price; Payment.amount | `Decimal(10,2)` (derived at completion) |
| StudioClassTemplate.location / StudioClass.location | `String` |
| StudioClassTemplate.hourlyRate / StudioClass.hourlyRate | `Decimal(10,2)` |
| StudioClass.studentCount | `Int?` |
| Payment.method | `String?` |
| Announcement.message | `Text` |
| Notification.title | `String` |
| Notification.body | `Text` |
| Account / Teacher / Student `.email` | `String @unique` |
| Invitation | `@@unique([teacherId,email])` + `@@index([email])` |

### A.2 (a) Free-text strings with no `.max()`, by category

59 STR-UNBOUNDED rows break down as follows:

- **5 are bounded by refine or membership**, so they are effectively bounded:
  - `pushSubscriptionSchema.keys.p256dh` and `.keys.auth` (exact decoded byte length)
  - `updateStudentSchema.birthday` (`parseBirthday`)
  - `teacherProfileSchema.defaultTimezone` and `updateTeacherSchema.defaultTimezone` (IANA validity)
- **4 are never persisted** (lookup or query only):
  - `magicLinkVerifySchema.token`
  - `passkeyAuthVerifySchema.challengeId`
  - `roomSearchQuerySchema.postcode` and `.street`

**59 − 5 − 4 = 50 persisted, user-authored rows with no upper bound.** All 50 are writable by a teacher, except the two student-profile rows and the two student self-edit rows.

| Group | Schema.field rows | Count | Column(s) |
|---|---|---|---|
| Names | teacherProfile.{firstName,lastName}, updateTeacher.{firstName,lastName}, studentProfile.{firstName,lastName}, updateStudent.{firstName,lastName}, createInvitation.{firstName,lastName}, updateInvitation.{firstName,lastName}, createRegistration\|2.newContact.{firstName,lastName} (reuse of createInvitation) | 14 | Teacher/Student/Invitation .firstName/.lastName `String` |
| Room | create/updateRoom.{venueName,address,city,postcode,floor,roomName,equipment[*],notes} | 16 | Room.* `String`, `Json`, `Text` |
| TeacherRoom | create/updateTeacherRoom.equipmentNotes | 2 | `Text` |
| Class family | create/updateClass.{classType,description}, create/updateClassTemplate.{classType,description} | 8 | CalendarEntry/ScheduleRule.classType `String`; Class/ClassTemplate.description `Text` |
| Studio family | create/updateStudioClass.{classType,location}, create/updateStudioClassTemplate.{classType,location} | 8 | classType as above; StudioClass(Template).location `String` |
| Payments | markPaid.method | 1 | Payment.method `String?` |
| Announcements | createAnnouncement.message | 1 | Announcement.message `Text`, plus one Notification.body `Text` per recipient |

Check: 14 + 16 + 2 + 8 + 8 + 1 + 1 = **50**.

Arrays with no `.max()`: `createRoomSchema.equipment[]` and `updateRoomSchema.equipment[]` (2 rows), whose items are unbounded too (counted above).

Also unbounded but format-checked:

- **6 email rows**: magicLinkSend, studentSignup, teacherSignup, createInvitation (and its `newContact` reuse), updateInvitation. Measured: `z.string().email()` accepts a 5000-char local part.
- **2 pageSlug rows** (`pageSlugField`: min 1, regex `^[a-z0-9-]+$`, no max). They land in `Teacher.pageSlug @unique`, and the slug is a public URL segment.

Other observations:

- `createInvitationSchema.lastName` and `updateInvitationSchema.lastName` have **no `.trim()`**. Every other name field trims.
- **Long strings can 500, not just bloat.** Measured in a rolled-back temp table: a btree index refuses an incompressible text value of 3200 chars ("Values larger than 1/3 of a buffer page cannot be indexed", SQLSTATE 54000), while 2560 chars is accepted. Three schema fields feed btree indexes:
  - Room.address, floor and roomName (composite `@@index`)
  - Teacher.pageSlug (`@unique`)
  - every email column (`@unique` / `@@unique`)

  `classifyApiError` has no branch for 54000, so the answer is a **500**. This is reasoned from the probe, not exercised through the route.

### A.3 (b) Numbers with no upper bound

32 NUM-UNBOUNDED rows, minus `updateStudentSchema.incomeTier` (refine 1-5), leaves **31**:

| Field | Rows | Schemas | Column |
|---|---|---|---|
| durationMinutes | 8 | create/updateClass, create/updateClassTemplate, create/updateStudioClassTemplate, create/updateStudioClass | `Int` (CalendarEntry, ScheduleRule) |
| roomCost | 4 | create/updateClass, create/updateClassTemplate | `Decimal(10,2)` |
| minRate | 4 | same | `Decimal(10,2)`, **no lower bound either** |
| targetRate | 4 | same | `Decimal(10,2)`, no lower bound beyond `>= minRate` |
| hourlyRate | 4 | create/updateStudioClass(Template) | `Decimal(10,2)` |
| rentalRate | 2 | create/updateTeacherRoom | `Decimal(10,2)` |
| maxCapacity | 2 | create/updateRoom | `Int` |
| capacityOverride | 2 | create/updateTeacherRoom | `Int` |
| studentCount | 1 | updateStudioClass | `Int?` |

Check: 8 + 4 + 4 + 4 + 4 + 2 + 2 + 2 + 1 = **31**.

What bounds these today:

- In Zod 4, `.int()` means safe integer, so integer fields accept up to 2^53−1. Measured: `z.number().int().positive()` accepts 2^31 and refuses 2^53.
- Non-integer numbers reject only ±Infinity and NaN.
- `minRate` is held below only by `economicsViolations` (`minRate >= -roomCost`). Create runs it in `superRefine`; update runs it in the service on the merged row.

### A.4 (c) Overflow → 500, verified

All measured on the local `fairyoga-db-1` (pg16). The DB probes were SELECTs only, except the temp-table index probe, which was rolled back.

- **Decimal(10,2):**
  - `SELECT 99999999.99::numeric(10,2)` succeeds.
  - `99999999.995` fails with "numeric field overflow … must round to an absolute value less than 10^8" (22003).
  - `100000000` fails the same way.
  - So any |value| that rounds to ≥ 10^8 fails. Through Prisma (raw probe) this surfaces as `PrismaClientKnownRequestError` with `meta.code = "22003"`; the typed client maps 22003 to P2020.
  - `src/lib/api-errors.ts` has no P2020 or 22003 branch (`grep -c "P2020\|22003\|out of range" src/lib/api-errors.ts` → 0), so it falls to the default **500** (`api-errors.ts:671`).
  - **18 rows** are affected: roomCost ×4, minRate ×4, targetRate ×4, hourlyRate ×4, rentalRate ×2. minRate overflows on the negative side too, unless `economicsViolations` refuses it first.
  - Values with more than 2 decimals are **silently rounded** by numeric(10,2). That is not an error, but it is worth knowing for the plan.
- **Int (int4):**
  - Probed with a read-only Prisma call, `prisma.calendarEntry.findFirst({ where: { durationMinutes: 2**31 } })`. It throws `PrismaClientUnknownRequestError` (no code): `ConversionError("Unable to fit integer value '2147483648' into an INT4 (32-bit signed integer).")`. 2^31−1 is accepted.
  - That error is unclassified, so the answer is **500**.
  - **13 rows** are affected: durationMinutes ×8, maxCapacity ×2, capacityOverride ×2, studentCount ×1.
- **Template slot generated column:**
  - `ScheduleRule.slot` is `int4range(startMin, startMin + "durationMinutes")` (`20260825061213_schedule_rule/migration.sql:36-44`).
  - The addition overflows int4 for `durationMinutes > 2147483647 − startMin` (startMin ≤ 1439). Measured: `SELECT (1439 + 2147483000)::int4` raises "integer out of range" (22003).
  - Template durations therefore 500 slightly *below* the int4 max too.
- **CalendarEntry.span:**
  - `date + startTime + durationMinutes * interval '1 minute'`. With 2147483647 that reaches year 6109, which is valid, so there is no error.
  - This is the issue's "block the calendar" case: one live entry with a huge span overlaps every later entry under `CalendarEntry_teacher_slot_excl`.
  - The issue's premise holds. A 2^31−1 duration is accepted and occupies the teacher's calendar for millennia. 2^31 is a 500 rather than a 400.
- **Derived overflow (new; not in the issue):**
  - `completeClass` writes `totalRevenue = pricing.totalCost = roomCost + effectiveTeacherRate` and `effectiveTeacherRate` into `Decimal(10,2)` (`class-lifecycle.ts:869-871`), plus `Registration.price` and `Payment.amount` ≤ that total.
  - With roomCost and targetRate each just under 10^8 (both pass a per-field cap of 99,999,999.99), totalCost reaches about 2×10^8, which **overflows at completion**.
  - Completion runs in the hourly sweep or on POST complete, so a per-field cap at the column maximum is **not sufficient**. The plan needs `roomCost_max + targetRate_max ≤ 99,999,999.99`, or practical caps far below it, e.g. 100,000.
- The issue's 1e12 example reproduces the 500 as described.

### A.5 (d) Fields already bounded

All 18 str-bounded rows:

| Field | Bound | Columns |
|---|---|---|
| relativePath (redirect) ×3 | `.max(200)` + `isSafeRelativePath` | — |
| passkey response.id ×2 | regex + `.max(1364)` | — |
| bio ×2 | `.max(250)` | VarChar(250) |
| bankAccount.holderName | `.max(200)` | — |
| bankField iban, bic, sortCode, accountNumber, routingNumber (×5) | `.max(64)` | — |
| updateStudent.phone | `PHONE_MAX` = 40 | — |
| updateStudent.address | `ADDRESS_MAX` = 300 (`src/lib/contact-details.ts:7-8`) | — |
| archiveStudentBody.waivePaymentIds[*] | `.min(1).max(64)` | — |
| push endpoint ×2 | `.url().max(2048)`; subscribe also requires https | — |

Count: 3 + 2 + 2 + 1 + 5 + 1 + 1 + 1 + 2 = 18.

All 12 num-bounded rows:

| Field | Bound | DB CHECK |
|---|---|---|
| minStudents / maxStudents ×8 | `.int().positive().max(MAX_CLASS_SIZE = 200)` | mirrored: `Class_*_range_check` and `ClassTemplate_*_range_check`, BETWEEN 0/1 AND 200 |
| dayOfWeek ×4 | `.int().min(0).max(6)` | — |

Arrays: `studentIds` max 500 (`MAX_CUSTOM_AUDIENCE`) and `waivePaymentIds` max 500.

Regex-only (15 rows), all bounded by their pattern except pageSlug:

| Field | Rows | Schemas |
|---|---|---|
| isoDate `date` | 4 | create/updateClass, create/updateStudioClass |
| timeHHmm `startTime` | 8 | create/updateClass, create/updateClassTemplate, create/updateStudioClassTemplate, create/updateStudioClass |
| magic-link code `^\d{6}$` | 1 | magicLinkClaimSchema |
| pageSlug, no max | 2 | teacherProfileSchema, updateTeacherSchema |

Check: 4 + 8 + 1 + 2 = 15.

---

## B. User strings in outgoing email

Templates live in `src/lib/email-templates.ts`. Senders:

- `src/lib/email.ts`: `sendInvitationEmail`, `sendHtmlEmail`
- `src/services/email-fallback.ts:339`: `renderNotificationEmail` → Resend
- `src/services/class-reminders.ts:102`

**Escaping:**

- `escapeHtml` (`email-templates.ts:23-30`) escapes `& < > " '`.
- `renderNotificationEmail` escapes title, intro and body in HTML (`:202-204`).
- `renderInvitationEmail` escapes `teacherName` in the body (`:241`).
- **Subjects are raw strings:**
  - `renderNotificationEmail` returns `subject: notification.title` (`:207`).
  - `renderInvitationEmail` returns `` `${teacherName} would like to connect on fair.yoga` `` (`:238`).
  - They go to Resend's JSON API (`email.ts:79-84`, `email-fallback.ts:344`), so there is no SMTP header assembly in this repo.
  - The app does not strip CR/LF from names. Header safety rests on Resend; not verified here.
- **Push** (`push-policy.ts`) carries the same title and body, truncated to fit the payload. Money groups get a fixed line.

| User string | Where | Template / site | Set by | Escaped | Reaches a never-signed-up address? |
|---|---|---|---|---|---|
| Teacher firstName + lastName | **Subject and body** of the invitation email | `renderInvitationEmail` via `notifyInvitee` (`invitations.ts:822`); name built at `:934` | teacher, any self-registered one | body yes; subject raw (plain text) | **Yes.** Only sent when the address has no Student row and no teacher account (`invitations.ts:810-822`). Triggered by POST `/api/students` and POST `/api/invitations/[id]/resend`, sharing a 50/h per-teacher bucket (`checkStudentWriteLimit`). PUT `/api/invitations/[id]` sends nothing. |
| Teacher firstName + lastName | Body of `teacher_invitation` notification ("X added you as a contact…") | `invitations.ts:708` (student), `:780` (teacher) → email fallback | teacher | yes | No. Existing Student or teacher account only. But an *unclaimed* walk-in Student row counts as "existing" and has no account. |
| Invitee firstName / lastName (Invitation row) | **Not in any email** | — | teacher | — | — |
| Teacher name + classType | walk_in_added **title `You're in ${classType}`** (subject) and body `${teacherName} added you to ${classType}…` | `walk-ins.ts:216-218` | teacher | body yes; subject raw | **Yes.** A walk-in with `newContact` creates an **unclaimed Student** at an arbitrary address (`walk-ins.ts:132`; `emailNotifications @default(true)`). `walk_in_added` is ESSENTIAL (`notification-policy.ts:24-39`) and emailed on the next sweep. Rate limit: 50/h shared `students` bucket (`registrations/route.ts:145-150`). |
| classType | Bodies only (titles are fixed) | cancel (`classes/[id]/cancel/route.ts:152`), auto-cancel (`class-transitions.ts:632,640`), completion (`class-lifecycle.ts:910`, teacher), payment_request / reminders (`lib/payment-request-copy.ts:16`), waitlist (`waitlist.ts:183,742,861,1085`), template withdraw (`class-template-lifecycle.ts:874`), booking (`registrations/route.ts:423,434`), gdpr (`gdpr.ts:1495`), class reminder (`class-reminders.ts:162-173`) | teacher | yes | Yes, to unclaimed walk-in students: class_cancelled and payment_request are ESSENTIAL. |
| Teacher firstName | Class-reminder body "Your X … with {firstName}." | `class-reminders.ts:173` | teacher | yes | Only students who chose email reminders. |
| Student firstName | Teacher's booking notification `${firstName} booked ${classType}.` | `registrations/route.ts:434` | student (or teacher, for walk-ins) | yes | No; goes to the teacher. |
| Announcement message | Body; title fixed `'New announcement'` | `announcements/route.ts:86-93` → email fallback | teacher | yes | **Yes**, to unclaimed walk-in students in the audience (they are registered and emailNotifications defaults true). `announcement` is *not* essential, so it honours `emailNotifications`, which nobody unclaimed has turned off. Sent once unread for 30 min. |
| Studio names / StudioClass.location | **No such email path.** There is no "studio name" field. `location` appears in no notification (`grep -rnE '\$\{[^}]*location' src/services src/app/api` → none). StudioClass has no students. | — | — | — | — |
| Bank holderName | **Not in any email.** In-app student pay page (`/bookings/[classId]/pay`) and EPC QR via `paymentMethodsFor` (`lib/payment-methods.ts:77`). `email-templates.ts` uses only the boolean `teacherHasPaymentMethods`. | — | teacher | — | — |
| Room venueName / address | Not in any notification text (grep as above). Public rooms are shown to other teachers in room search. | — | teacher | — | — |

Re-derive with:

```
grep -rnE "\\$\{[^}]*(classType|firstName|lastName|teacherName|location|holderName|message|venueName|method)[^}]*\}" src/services src/app/api src/lib --include='*.ts' | grep -v '\.test\.'
grep -rnE "(title|body):\s*\`[^\`]*\\$\{" src --include='*.ts' | grep -v '\.test\.'
```

---

## C. Existing validation on names, and name write sites

**Validation today.** Every name field is `z.string().trim().min(1)`, except Invitation `lastName`, which is `z.string()` with no trim (optional/default ''). There is no max, no regex, no URL check and no control-character check. Repo-wide:

```
grep -rnE "\\\\u0000|\\\\x00|\\\\p\{C|control char|isUrl|looksLikeUrl" src
```

finds nothing on input. The only URL regex is `push/config.ts:58` (VAPID subject). Rendering escapes HTML (B). Names are unsanitised on write, by design (`email-templates.ts:229-232`).

**Teacher names written by:**

- POST `/api/account/teacher-profile` → `prisma.teacher.create` (`route.ts:124`), from teacherProfileSchema
- PUT `/api/teachers/[id]` → `services/teacher-profile.ts:57` and `:84` (`teacher.updateMany`), from updateTeacherSchema
- `gdpr.ts:1612-1616`, erasure → 'Deleted Teacher'
- `prisma/seed.ts:178,194,224`

**Student names written by:**

- POST `/api/account/student-profile`:
  - ticket path → body (studentProfileSchema) → `student.create` (`route.ts:153`)
  - session path → **copies the caller's Teacher firstName/lastName** (`route.ts:116-121`)
- PUT `/api/students/[id]`, self only (`route.ts:75-93`), from updateStudentSchema
- `services/walk-ins.ts:128-136`: `student.createManyAndReturn` from the teacher-supplied `newContact` (createInvitationSchema). A teacher-chosen name lands on a Student at an arbitrary address.
- `gdpr.ts:870` erasure. Unclaimed-row claim (`lib/auth/account.ts:63`) writes no names.

**Invitation names written by:**

- `services/invitations.ts:396-397` create and `:474` revive, from POST `/api/students` via createInvitationSchema
- PUT `/api/invitations/[id]` (`route.ts:218`), from updateInvitationSchema
- `walk-ins.ts:172` createMany
- gdpr `:756,:764,:788` erasure

Other consumers of names: passkey `userDisplayName` (`passkey/register/options/route.ts:61`), gdpr export, `lib/format.ts`.

---

## D. Announcements and rate limits

**`src/app/api/announcements/route.ts`:**

- `requireTeacher`, then `parseBody(createAnnouncementSchema)`, then audience, then the `receiveComms=false` opt-out filter, then `sendAnnouncement`.
- **No `checkRateLimit`** (`grep -n checkRateLimit src/app/api/announcements/route.ts` → none).

**Dedupe** (`services/announcements.ts`):

- `ANNOUNCEMENT_DEDUPE_WINDOW_MS = 2 * 60 * 1000` (`:46`).
- `pg_advisory_xact_lock` on hash(teacherId|message) (`:135-143`).
- Inside the lock: `announcement.findMany({teacherId, message, sentAt >= now−2min})`. Recipients already in those rows' `audienceStudentIds` are skipped; the rest each get one Notification (`createBulkNotifications`) and one Announcement row.
- Exact text match only. Any edit (one character) is a new key.

**Audience sizes:**

| Audience | Who | Bound |
|---|---|---|
| class (`classId`) | Every non-cancelled registration of that class, student not erased | `maxStudents ≤ 200`, but walk-ins may exceed it. No hard cap. |
| all (neither field) | `listAnnouncementAudience`: distinct students with a non-cancelled registration in any of the teacher's classes, minus archived and erased (`:168-181`) | **Unbounded** |
| custom (`studentIds`) | ≤ 500 ids (`MAX_CUSTOM_AUDIENCE`, `schemas.ts:681`), intersected with the all-audience | ≤ 500 |

Per send, the write is `|message| × recipients` across Notification.body, plus Announcement.message once. Each Notification then gets an SSE emit, the push sweep, and the email fallback after 30 min unread.

**Rate-limit module** (`src/lib/rate-limit.ts`):

- In-memory sliding window, per process, partitioned by prefix.
- `RateLimitPrefix` union (`:37-49`) is tethered to `PREFIX_CAPACITIES` by `satisfies Record<RateLimitPrefix, number>` (`:51-64`).
- 12 prefixes: `magic-link:ip`, `magic-link:email`, `magic-link:claim`, `passkey-auth-options`, `student-signup:ip`, `student-signup:email`, `students`, `teacher-signup`, `teacher-signup:email`, `slug-available`, `teacher-photo`, `push-subscriptions`. Re-derive with `sed -n 37,64p src/lib/rate-limit.ts`.
- Keys are built by `rateLimitKey(prefix, id)`, so a new prefix is a compile-checked union member plus a capacity entry.
- `checkRateLimit(key, limit, windowMs)` returns `{allowed, retryAfterSeconds}`. `respondRateLimited(limit, action)` answers 429 with "… Try again in N minutes."
- `checkStudentWriteLimit(teacherId)` = `students` prefix, **50 per hour** (`:228-230`). Callers:
  - POST `/api/students` (`route.ts:86`)
  - POST `/api/invitations/[id]/resend` (`:66`)
  - POST `/api/registrations` newContact walk-in (`:146`)
- Per-account or per-teacher precedents:
  - `teacher-photo` (`teachers/[id]/photo/route.ts:23`, keyed by teacher id)
  - `push-subscriptions` (keyed by accountId)
- IP-keyed limits go through `checkIpRateLimit`.

---

## E. UI `maxLength` today

`grep -rnE "maxLength" src/components src/app --include='*.tsx' | grep -v test` finds exactly:

| File | Field | maxLength |
|---|---|---|
| `components/settings/profile-form.tsx:202` | bio | `250` (literal) |
| `components/signup/profile-setup-form.tsx:418` | bio | `BIO_MAX` |
| `components/student/contact-details-form.tsx:159` | phone | `PHONE_MAX` (40) |
| `components/student/contact-details-form.tsx:187` | address | `ADDRESS_MAX` (300) |
| `components/auth/handoff-code-entry.tsx:81` | sign-in code | 6 |

Fields that have **none**:

- names: `profile-form`, `profile-setup-form`, `student/name-form`, `booking/booking-name-step`, `students/create-student-form`, `students/contact-form`, `class/add-walk-in`
- classType, description: `class/new/new-class-form`, `settings/template-form`, `class/class-edit-form`
- classType, location: `studio-class/new/new-studio-class-form`, `settings/studio-template-form`, `studio-class/studio-class-edit-form`
- announcement message: `class/send-announcement` (textarea)
- room fields and notes: `settings/room-create-step`, `settings/edit-room-form`
- equipmentNotes: `settings/edit-teacher-room-form`
- bank fields: `settings/bank-account-form`, even though the schema bounds them at 64/200

`Input` and `Textarea` (`components/ui/input.tsx:51`, `textarea.tsx:45`) spread `...props`, so `maxLength` passes through.

Numbers: no `max=` attribute on any duration or money input. The only `min`/`max` props are dates and progress-bar displays (`grep -rnE "\b(min|max)=\{" …`). Client-side duration checks are only `<= 0` and integer (`new-class-form.tsx:272-273`, `template-form.tsx:145-146`, `new-studio-class-form.tsx:113`).

`markPaid` UI always sends `{ method: 'manual' }` (`lib/use-payment-actions.ts:36`). Values seen in tests and seed: `'cash'` ×12, `'bank_transfer'` (seed and tests), `'manual'`. Payment.method is **never read** in src outside the equality check in `payments.ts:156` (`grep -rn "\.method\b" src | grep -v request.method`).

---

## F. Body-size limits

- **nginx** (`deploy/nginx.conf.example`): `client_max_body_size 10m` only in `location ~ ^/api/teachers/[^/]+/photo$` (`:30-40`). `location /` sets none, so it gets nginx's **1 MB default**, which `DEPLOYMENT.md:56-59` documents. The production config is not in the repo; the example is the source of truth.
- **Next.js:**
  - `next.config.ts` has no `bodySizeLimit` or `serverActions` setting (grep).
  - App Router route handlers impose no body limit on `request.json()`.
  - `src/proxy.ts` matcher (`:27-37`) covers no `/api/*` path, so the proxy's 10 MB clone limit does not apply either.
- **`parseBody`** (`src/lib/api-utils.ts:159-176`): `await request.json()` with no size check.
- **The only app-level size limit** is the photo route: `Content-Length` checked against `MAX_PHOTO_REQUEST_BYTES` before reading (`teachers/[id]/photo/route.ts:26-33`), then `file.size > MAX_PHOTO_BYTES` (8 MB).

So in production an announcement is capped at about 1 MB by nginx, not 10 MB. In dev, or behind any proxy without that default, it is unbounded.

---

## G. Existing data versus the proposed caps

Scanner: `/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga--claude-worktrees-issue-726/7ee24d14-f1d1-4156-bf5b-c49b06a17ef3/scratchpad/lens.cjs` (run with `node`). It scans string literals keyed `firstName|lastName|classType|description|location|message|method|holderName|venueName` across `prisma/`, `tests/` and `src/`, plus `durationMinutes: <n>` literals and `.repeat(n≥60)` sites.

**Result: nothing over the proposed caps.**

| Key | Longest literal | Where | Proposed cap |
|---|---|---|---|
| firstName | 36 | `tests/integration/students-api.test.ts` | 60 |
| lastName | 30 | `src/services/waitlist.test.ts` | 60 |
| classType | 38 | `tests/integration/classes-api.test.ts` | 80 |
| location | 37 | `prisma/seed.ts` | 200 |
| description | 215 | `src/lib/degradation-codes.ts`, unrelated key; class descriptions in seed are ≤ 44 chars | 2000 |
| message | 184 | `api-errors.test.ts`, an error message, not an announcement | 2000 |
| method | 13 (`'bank_transfer'`) | — | 64 |
| holderName | 17 | — | 200 |
| venueName | 30 | — | 200 |

- `durationMinutes` literals > 1440: **none**. Seed uses 60, 75 and 90.
- No `.repeat()` fixture builds a long name, classType, description, location or message. Long `.repeat` sites are auth, push, address-301 (already capped) and digest tests.
- No money fixture ≥ 10^7: `grep -rnE "(roomCost|minRate|targetRate|hourlyRate|rentalRate):\s*-?[0-9_]{8,}" tests src prisma` → none.

**Edit-resend risk is real in shape.** Edit forms resend unchanged text fields in full:

- `class-edit-form.tsx:160`: `{ ...form, description: … }`
- `template-form.tsx:345-349`: `{ ...form, classType, description }`
- `profile-form.tsx:145-152`: firstName, lastName, bio, pageSlug, every time
- `studio-class-edit-form.tsx` and `studio-template-form.tsx` (full payload)

So a stored value over a new cap would make the row uneditable through its own form until the user shortens it. No seed or fixture row is over any proposed cap, and the user's memory note says the product is not in production yet, so no backfill is needed.

---

## Extra findings worth carrying into the plan

1. **Derived Decimal overflow at completion** (A.4). Caps on roomCost and targetRate must be jointly ≤ 99,999,999.99, or overflow moves from the PUT to the sweep.
2. **Unclaimed walk-in Students are a second arbitrary-address email channel** the issue does not name:
   - a classType-bearing **subject** (`You're in ${classType}`)
   - teacher name in the body
   - later announcements, cancellations and payment requests
   - it shares the 50/h `students` bucket
3. **ScheduleRule.slot is minutes-since-midnight on one weekday.** A template with duration > 1440 − start extends past 1440 on the same weekday and does not conflict with the next day's rules. A 1440 cap makes that a bounded cross-midnight case; a stricter "end ≤ 24:00" rule is a separate decision.
4. **Unbounded emails and pageSlug.** pageSlug is a public URL and a btree-unique column, and very long values 500 via index-row-size (54000). Emails are unbounded in length; RFC 5321 caps them at 254.
5. **`markPaid.method` is write-only data.** The UI sends only `'manual'`, nothing reads it, and tests use `cash`/`bank_transfer`/`manual`. An enum would need those tests updated.

---

## Appendix: the census tooling, verbatim

The scratch paths above are where these first ran. Copy either block to a file. Replace the absolute worktree path with the checkout you are in, then run it as the Re-derivation section says.

### walk-schemas.ts

```ts
// Census of every exported Zod schema in src/lib/schemas.ts: one row per leaf field.
// Run from the worktree root: node_modules/.bin/tsx --tsconfig tsconfig.json <this file>
import * as S from '/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-769/src/lib/schemas';

type Row = { schema: string; field: string; kind: string; bounds: string; cls: string };
const rows: Row[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function unwrap(s: Any): { s: Any; mods: string[] } {
  const mods: string[] = [];
  for (;;) {
    const t = s?._zod?.def?.type;
    if (t === 'optional' || t === 'nullable' || t === 'default' || t === 'prefault' || t === 'readonly') {
      mods.push(t);
      s = s._zod.def.innerType;
    } else if (t === 'pipe') {
      mods.push('pipe');
      s = s._zod.def.in;
    } else return { s, mods };
  }
}

function checksOf(s: Any): string[] {
  const out: string[] = [];
  for (const c of s?._zod?.def?.checks ?? []) {
    const d = c._zod.def;
    out.push(d.check + (d.maximum !== undefined ? `<=${d.maximum}` : '') + (d.minimum !== undefined ? `>=${d.minimum}` : '') + (d.value !== undefined ? `${d.inclusive === false ? '>' : ''}${d.value}` : '') + (d.format ? `:${d.format}` : '') + (d.pattern ? `:${d.pattern}` : ''));
  }
  return out;
}

function leaf(schema: string, path: string, raw: Any) {
  const { s, mods } = unwrap(raw);
  const t = s._zod.def.type;
  if (t === 'object') {
    for (const [k, v] of Object.entries(s._zod.def.shape)) leaf(schema, path ? `${path}.${k}` : k, v);
    return;
  }
  if (t === 'array') {
    const ch = checksOf(s);
    rows.push({ schema, field: `${path}[]`, kind: 'array', bounds: ch.join(' ') || '-', cls: ch.some((c) => c.startsWith('max_length')) ? 'bounded-array' : 'UNBOUNDED-array' });
    leaf(schema, `${path}[*]`, s._zod.def.element);
    return;
  }
  if (t === 'union') {
    s._zod.def.options.forEach((o: Any, i: number) => leaf(schema, `${path}|${i}`, o));
    return;
  }
  const ch = checksOf(s);
  const fmt = s._zod.def.format ?? s._zod.bag?.format;
  let cls = '';
  if (t === 'string') {
    const hasMax = ch.some((c) => c.startsWith('max_length'));
    const hasRegex = ch.some((c) => c.includes('regex')) || !!s._zod.bag?.patterns?.size;
    const isFmt = fmt && fmt !== 'regex';
    cls = hasMax ? 'str-bounded' : isFmt && fmt !== 'email' ? `str-format(${fmt})` : hasRegex ? 'str-regex-only' : 'STR-UNBOUNDED';
    if (fmt === 'email' && !hasMax) cls = 'STR-UNBOUNDED(email)';
  } else if (t === 'number') {
    const hasMax = ch.some((c) => c.startsWith('less_than'));
    cls = hasMax ? 'num-bounded' : 'NUM-UNBOUNDED';
  } else if (t === 'enum' || t === 'literal') cls = 'enum';
  else if (t === 'boolean') cls = 'bool';
  else cls = t;
  const extra = [fmt ? `format=${fmt}` : '', s._zod.bag?.maximum !== undefined ? `bag.max=${s._zod.bag.maximum}` : ''].filter(Boolean);
  rows.push({ schema, field: path, kind: `${t}${mods.length ? ` (${mods.join(',')})` : ''}`, bounds: [...ch, ...extra].join(' ') || '-', cls });
}

for (const [name, v] of Object.entries(S)) {
  if (!name.endsWith('Schema')) continue;
  leaf(name, '', v);
}
for (const r of rows) console.log([r.schema, r.field, r.kind, r.bounds, r.cls].join('\t'));
const tally: Record<string, number> = {};
for (const r of rows) tally[r.cls] = (tally[r.cls] ?? 0) + 1;
console.error(JSON.stringify(tally, null, 1), 'total rows', rows.length);
```

### lens.cjs

```js
// Scan string-literal values for named keys; report max length per key and any over caps.
const fs = require('fs');
const path = require('path');
const root = '/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-769';
const caps = { firstName: 60, lastName: 60, classType: 80, description: 2000, location: 200, message: 2000, method: 64, holderName: 200, venueName: 200 };
const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
  }
}
['prisma', 'tests', 'src'].forEach((d) => walk(path.join(root, d)));
const max = {};
const over = [];
const re = /\b(firstName|lastName|classType|description|location|message|method|holderName|venueName)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
const durRe = /\bdurationMinutes\s*:\s*(\d+)/g;
const repRe = /\.repeat\(\s*(\d+)\s*\)/g;
const durs = [];
const reps = [];
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const rel = path.relative(root, f);
  let m;
  while ((m = re.exec(s))) {
    const len = m[3].length;
    if (!max[m[1]] || len > max[m[1]].len) max[m[1]] = { len, where: rel };
    if (len > caps[m[1]]) over.push(`${rel}: ${m[1]} len ${len}`);
  }
  while ((m = durRe.exec(s))) if (+m[1] > 1440) durs.push(`${rel}: durationMinutes ${m[1]}`);
  while ((m = repRe.exec(s))) if (+m[1] >= 60) {
    const line = s.slice(0, m.index).split('\n').length;
    reps.push(`${rel}:${line}: ${s.slice(s.lastIndexOf('\n', m.index) + 1, s.indexOf('\n', m.index)).trim().slice(0, 140)}`);
  }
}
console.log('MAX per key (string literals, prisma+tests+src):', JSON.stringify(max, null, 1));
console.log('OVER CAPS:', over.length ? over.join('\n') : 'none');
console.log('durationMinutes > 1440 literals:', durs.length ? durs.join('\n') : 'none');
console.log('.repeat(>=60) sites:\n' + reps.join('\n'));
```
