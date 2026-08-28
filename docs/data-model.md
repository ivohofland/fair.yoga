# Data Model — Ethical Yoga App

17 entities across 6 domains. This is the source of truth for the application's data layer.

---

## People

### Account (auth identity)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| email | string, unique | The authenticated identity — sessions and passkeys key off this, not off Teacher/Student. Lowercased on write by `emailField` and pinned by `Account_email_lowercase_check` (#170) — Postgres compares this column case-sensitively, so without it a case variant is a second identity. |
| **Timestamps** | | |
| created_at | datetime | |

One Account per human. Teacher and Student are profiles optionally linked to it via their own unique `account_id` — a dual-role person (a teacher who also attends classes) has one Account with both profiles attached. See Design Notes below for the claim path that links an Account to a pre-existing unclaimed Student.

### Teacher (core)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| first_name | string | |
| last_name | string | |
| email | string, unique | Denormalized copy of the account email. Lowercase by `Teacher_email_lowercase_check` (#170). |
| photo_url | string, nullable | |
| bio | string(250) | |
| page_slug | string, unique | Public booking page URL |
| custom_domain | string, nullable | |
| **Defaults** | | |
| default_currency | string, default 'EUR' | |
| default_timezone | string | e.g. 'Europe/Amsterdam' |
| default_reminder | enum: morning_of, evening_before, 1h_before | Pre-fills class reminder setting |
| **Payment settings** | | |
| payment_level | enum: 1, 2 | Level 1 = manual, Level 2 = payment processor |
| bank_iban | string, nullable | Level 1 only |
| bank_account_name | string, nullable | Level 1 only |
| processor_type | enum: mollie, stripe | Level 2 only |
| processor_account_id | string, nullable | Level 2 only |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

### Student (core)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| first_name | string | Required |
| last_name | string | Required |
| email | string, unique | Required. Contact email; copies the account email once claimed. Lowercase by `Student_email_lowercase_check` (#170). |
| income_tier | int (1-5) | Global tier, can change anytime |
| **Optional fields** | | |
| phone | string, nullable | |
| birthday | date, nullable | |
| address | string, nullable | e.g. for teacher sending holiday cards |
| **Preferences** | | |
| reminder_pref | enum: eve, morning, 1h, off | Student controls their own reminders |
| email_notifications | boolean, default true | Fallback email on/off |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

### StudentPrivacy (per-teacher privacy layer)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *student_id* (FK) | → Student | |
| *teacher_id* (FK) | → Teacher | |
| share_full_name | boolean, default false | Surname; when false a teacher sees a last initial |
| share_email | boolean, default false | |
| share_phone | boolean, default false | |
| share_birthday | boolean, default false | |
| share_address | boolean, default false | |
| receive_comms | boolean, default true | Opt-out from teacher announcements |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Not created on booking. Two sites write it: the student's own
`PUT /api/students/[id]/privacy` — where the student opts in to each field —
and `DELETE /api/teacher-links/[teacherId]` (`unlinkTeacher`), which force-sets
every flag, including `receive_comms`, to `false` when a student severs a
teacher link. The second write is not an opt-in; it is the system silencing
every share on the student's behalf because deleting the link alone does not
stop the teacher reaching them. Until one of those two sites has run there is
no row, and every read treats absence as maximum privacy
(`privacy?.shareX ?? false`). One projection reads these flags for every
teacher-facing surface: `src/lib/student-visibility.ts`.

### Invitation (teacher → student contact, #166)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| email | string | Lowercased on write — the one place a teacher types another person's address, so a case slip must not hide the invitation from them |
| first_name | string, default '' | As the teacher typed it; independent of the invitee's own Student row, if one exists |
| last_name | string, default '' | |
| status | enum: pending, accepted, declined | |
| is_archived | boolean, default false | Teacher's own filing action; never hides the row from the invitee |
| responded_at | datetime, nullable | Set when status leaves pending, cleared when an accepted row is returned to pending (see re-inviting, below) |
| **Timestamps** | | |
| created_at | datetime | |
| **Constraints** | | |
| unique | (teacher_id, email) | One contact per address per teacher |
| check | `email = lower(email)` | The lowercasing is relied on by every reader that matches an account or student address against this column |
| check | `(responded_at IS NULL) = (status = 'pending')` | A pending invitation has no response time; an answered one has one |

A teacher may not link themselves to a student unilaterally. `POST /api/students` creates an `Invitation`, never a `Student` row — the `TeacherStudent` link (above) forms only once the invitee accepts it, or books one of the teacher's classes. A declined row is not deleted: it is the tombstone that stops the same address being re-invited, so `PUT`/`DELETE` on a declined invitation both refuse. This is a separate table from `TeacherStudent` on purpose — `POST /api/students` must behave identically whether or not the address is already on the platform, which it cannot if it writes to a table with a unique `email` column.

`accepted` is not a second tombstone. Whether the teacher may invite that address again turns on whether a `TeacherStudent` link actually exists, never on the status alone — erasing a student deletes their links and leaves this row `accepted`, and reading the status there would tell the teacher "already one of your students" forever about someone off their roster, with `unique (teacher_id, email)` blocking any second row. `inviteContact` therefore returns such a row to `pending` (clearing `responded_at`) rather than creating one, and a `TeacherBlock` on the address still withholds delivery exactly as it does for a first invitation.

### TeacherBlock (a student's standing refusal of one teacher, #166)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| email | string | Lowercased on write, same reasoning as `Invitation.email` |
| **Timestamps** | | |
| created_at | datetime | |
| **Constraints** | | |
| unique | (teacher_id, email) | |
| check | `email = lower(email)` | Same reasoning as `Invitation.email` — the block is looked up by an address someone else typed |

Written only when a student unlinks a teacher they were already connected to (`unlinkTeacher`) — a plain decline does not write one; the declined `Invitation` row already blocks a re-invite on its own. Held in its own table rather than as a flag on `Invitation` so a blocked address behaves identically to a fresh one everywhere an `Invitation` is read, edited, archived or re-created — the only place the distinction is allowed to surface is whether an invite email is actually sent.

**Open, and deliberately unresolved: what erasing a student should do to this row.** `deleteStudentAccount` (`src/services/gdpr.ts`) today leaves it exactly as it stands, holding the erased person's plaintext address. That is a placeholder for a decision, not a decision — both answers are defensible and the choice is a legal one, which `CLAUDE.md` parks for proper consultation:

- **Retain (current behaviour).** The block keeps working, and it is not inert after erasure: the person's real mailbox still exists in the world, so if the teacher re-types that address `inviteContact` computes `delivered: false` and no invitation email is sent. Retention is the only thing standing between an erased person and mail from the one teacher they explicitly refused. The cost is a retained plaintext address for someone who asked to be forgotten — on a row they can no longer reach to clear, since erasure rewrites their account email and deletes their sessions.
- **Scrub or hash the address.** Honours the erasure literally. The cost is that lookups are `teacher_id` + exact `email` (`unique (teacher_id, email)`), so a scrubbed row stops matching and the block silently stops blocking; keeping it functional would need a hashed-address column and every reader taught to hash before querying — a schema change and a change at roughly four call sites.

Invitations are handled differently, and that asymmetry is intentional: `deleteStudentAccount` anonymises `Invitation.email` / `first_name` / `last_name` in place (to `deleted-<student_id>@deleted.invalid`, which satisfies the lowercase CHECK) while leaving `status` and `responded_at` alone, so a teacher's `declined` tombstone survives an erasure it would otherwise clear. `deleteTeacherAccount` deletes that teacher's `Invitation` rows outright — they hold other people's addresses and, with the teacher erased, guard a door nobody can open.

---

## Spaces

### Room (shared library)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| venue_name | string | e.g. "De Yogaschool", "Community Center West" |
| address | string | |
| city | string | |
| postcode | string | |
| floor | string | |
| room_name | string | |
| max_capacity | int | Venue's stated capacity |
| equipment | json[] | e.g. ["mats", "blocks", "straps"] |
| notes | text, nullable | |
| is_public | boolean | Visible to other teachers or private |
| *created_by* (FK) | → Teacher | |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Base properties are read-only after creation. Changes via admin only. Duplicate detection at creation time (address + room_name).

### TeacherRoom (per-teacher override)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *room_id* (FK) | → Room | |
| capacity_override | int | Teacher's own cap (may be lower than venue max) |
| rental_rate | decimal | Private to each teacher, never shared |
| equipment_notes | text, nullable | |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Each teacher sets their own capacity and rental rate for a room. Rental rate is private — never shown to other teachers using the same room.

---

## Classes

### ScheduleRule (shared calendar identity, #298)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| kind | enum: regular, studio | Pins which template family this rule belongs to. `ClassTemplate`/`StudioClassTemplate` attach by the composite `(schedule_rule_id, kind)`, so a `CHECK` on each child pins its own literal and the pair can only ever mean "regular child ↔ regular rule" |
| class_type | string | e.g. "Vinyasa", "Yin", "Hatha" |
| day_of_week | int (0-6) | 0 = Monday |
| start_time | time | |
| duration_minutes | int | |
| is_active | boolean | Teacher can pause/stop a recurring class |
| is_archived | boolean | |
| archived_at | datetime, nullable | When this rule was last archived |
| withdrawn_count | int, nullable | How many future unbooked instances that archive withdrew |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

One teacher, one slot, across both template families (#296, #298): an
`EXCLUDE USING gist` constraint over `(teacher_id, day_of_week, slot)` —
`slot` a generated range covering `[start_time, start_time +
duration_minutes)` — partial on `is_archived = false`, refuses two live rules
of either kind whose windows overlap for one teacher on one weekday. Range,
not exact-start: two templates a minute apart are no longer both legal, where
they were before #298. `ClassTemplate` and `StudioClassTemplate` below hold
only their own economics now — they reach their teacher, and everything
calendar-shaped, through this row.

### ClassTemplate (recurring class economics)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *schedule_rule_id* (FK) | → ScheduleRule, unique | The calendar identity — teacher, day/time, active/archived state — moved to the rule (#298); this row reaches Teacher through it, not directly |
| *teacher_room_id* (FK) | → TeacherRoom | |
| description | text, nullable | |
| **Economics** | | Copied to each instance at generation time — a later template edit does not re-copy (#194) |
| room_cost | decimal | From TeacherRoom.rental_rate |
| min_rate | decimal | Minimum teacher earns per student |
| target_rate | decimal | Ideal teacher earns per student |
| min_students | int | Below this, class auto-cancels |
| max_students | int | Registration cap |
| **Policies** | | |
| cancel_deadline | enum: 48h, 24h, 12h, 6h | Student cancellation window |
| auto_cancel_check | enum: 4h, 2h, 1h | When to check min_students threshold |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Class instances are generated on a rolling 4-week basis. Runs indefinitely
until the rule is paused or archived — see ScheduleRule above for day/time,
active/archived state, and the cross-family slot rule.

### CalendarEntry (shared calendar identity, #327)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| kind | enum: regular, studio | Pins which entry family this row belongs to. `Class`/`StudioClass` attach by the composite `(calendar_entry_id, kind)`, so a `CHECK` on each child pins its own literal and the pair can only ever mean "regular child ↔ regular entry" |
| class_type | string | |
| date | date | |
| start_time | time | |
| duration_minutes | int | |
| cancelled_at | datetime, nullable | Liveness, for both families — one column where `Class.status = 'cancelled'` and `StudioClass.cancelled_at` used to be two spellings |
| class_completed_at | datetime, nullable | The owning class completed. Written only by the `class_sync_entry_completed` triggers, and write-once: `entry_completion_marker_guard` refuses every departure from a value it has set, because the schedule freeze reads this column and clearing it in one statement unfroze `date` in the next |
| *schedule_rule_id* (FK) | → ScheduleRule, nullable | Null for one-off entries. Unique with `date` |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

One teacher, one slot, across both entry families (#296, #327): an
`EXCLUDE USING gist` constraint over `(teacher_id, span)` — `span` a generated
`tsrange` covering `[date + start_time, date + start_time + duration_minutes)`
— partial on `cancelled_at IS NULL`, refusing two live entries of either kind
whose windows overlap for one teacher. Range, not exact-start: two entries a
minute apart are no longer both legal, and an entry running past midnight
conflicts with one on the following date.

A cancelled entry releases its SLOT but keeps its DATE: `(schedule_rule_id,
date)` is unique regardless of `cancelled_at`, so the hourly sweep does not
refill a date the teacher deliberately cancelled.

`Class` and `StudioClass` below hold only their own economics now — they reach
their teacher, and everything calendar-shaped, through this row.

**An entry with no child holds a slot nobody can see, and nothing in the schema
forbids one.** Every entry is meant to have exactly one child. There is no
totality constraint and that is deliberate (stage B design §8): what makes the
pair total is a property of the WRITERS — every creator writes parent and child
in one transaction, nested — not of the schema, and PostgreSQL has no way to
say "this row must be referenced" without a deferred constraint trigger per
child table. So the invariant is real, unenforced, and its violation is silent:
an orphan is visible on no page, reachable by no route and removed by no sweep,
while its live `span` goes on occupying
`CalendarEntry_teacher_slot_excl` for its teacher. The symptom is a
teacher — or a fixture — being refused a time that looks free.

Cheap to detect, expensive to diagnose from the symptom. Expect **zero rows**:

```sql
SELECT e.id, e.kind, e."teacherId", e.date, e."startTime", e."cancelledAt"
  FROM "CalendarEntry" e
 WHERE NOT EXISTS (SELECT 1 FROM "Class" c        WHERE c."calendarEntryId" = e.id)
   AND NOT EXISTS (SELECT 1 FROM "StudioClass" s  WHERE s."calendarEntryId" = e.id);
```

Both local databases held some when #327's whole-branch review ran — 8 of 37 in
`ethical_yoga`, 46 of 155 in `ethical_yoga_test`. All were test residue from a
teardown that deleted the CHILD and left the parent standing, the shape
`ca3418aa` fixed across ~25 suites; none appeared after it. If this query ever
returns rows again, look for a `class.deleteMany`/`studioClass.deleteMany`
where a `calendarEntry.deleteMany` belongs — deleting the entry cascades to the
child, and the reverse does not.

### Class (single class instance)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *calendar_entry_id* (FK) | → CalendarEntry, unique | The calendar identity — teacher, date/time, cancellation — moved to the entry (#327); this row reaches Teacher through it, not directly, and a generated class reaches its ClassTemplate through the entry's ScheduleRule |
| kind | enum: regular, studio | Always `regular` here, pinned by a `CHECK`; half of the composite FK above |
| *teacher_room_id* (FK) | → TeacherRoom | |
| description | text, nullable | |
| **Economics** | | Locked after first registration |
| room_cost | decimal | |
| min_rate | decimal | |
| target_rate | decimal | |
| min_students | int | |
| max_students | int | |
| **Policies** | | |
| cancel_deadline | enum: 48h, 24h, 12h, 6h | |
| auto_cancel_check | enum: 4h, 2h, 1h | |
| **State** | | |
| status | enum | draft → open → in_progress → completed. `full` is derived, not stored; cancellation is the entry's `cancelled_at`, not a member |
| settings_locked | boolean | Flips to true on first registration |
| spot_broadcast_at | datetime, nullable | When the first-come-first-claimed broadcast last went out for the seat that is currently free (#220) |
| **Calculated** | | Populated after class ends |
| effective_teacher_rate | decimal, nullable | What the teacher actually earned per student |
| total_students | int, nullable | Final attendance count |
| total_revenue | decimal, nullable | Sum of all student payments |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

### StudioClass (simple tracking)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *calendar_entry_id* (FK) | → CalendarEntry, unique | Same arrangement as `Class` above (#327): the calendar identity, cancellation included, lives on the entry |
| kind | enum: regular, studio | Always `studio` here, pinned by a `CHECK`; half of the composite FK above |
| location | string | Free text (not linked to Room) |
| student_count | int, nullable | |
| hourly_rate | decimal | Teacher's rate at this studio |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

No pricing engine. No individual registration. No link to Room or Student. No `status`. This is income tracking for classes the teacher gives at someone else's studio; the calendar half is the entry above.

---

## Bookings

### Registration (student ↔ class)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *class_id* (FK) | → Class | |
| *student_id* (FK) | → Student | |
| status | enum | registered → attended / no_show / late_cancel / cancelled |
| is_walk_in | boolean, default false | Added by teacher during class |
| tier_at_booking | int (1-5) | Snapshot of student's tier at booking time. Used for pricing. Also serves as income history. |
| **Calculated** | | Populated after class ends |
| price | decimal, nullable | Actual amount this student pays |
| tier_ratio | decimal, nullable | Multiplier applied to this tier |
| **Timestamps** | | |
| registered_at | datetime | |
| cancelled_at | datetime, nullable | |
| updated_at | datetime | |

### WaitlistEntry (overflow)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *class_id* (FK) | → Class | |
| *student_id* (FK) | → Student | |
| position | int | Queue order |
| status | enum | waiting → promoted → claimed → expired → removed |
| promoted_at | datetime, nullable | |
| *registration_id* (FK) | → Registration, nullable | Created when student is promoted |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Hybrid waitlist promotion: before the cancel deadline cutoff, students are auto-promoted in queue order. In the final hour before class, it switches to first-come-first-claimed for any remaining spots.

**Retention (#238):** an entry that never became a registration is deleted once
its class is terminal (`completed`/`cancelled`) and more than 365 days past its
`date`. "Never became a registration" is TWO clauses the sweep treats as
co-equal: `registration_id IS NULL` **and** a status outside
`FULFILLED_WAITLIST_STATUSES` (`promoted`, `claimed`). No writer can make the
two disagree, but deleting is irreversible, so their intersection is taken —
if they ever disagree, the row survives.

An entry that did become a registration is kept because the FK to
`Registration` makes it bookkeeping. That argument stands on the FK alone: a
`Payment` is created only by `completeClass`, so a fulfilled entry on a
**cancelled** class has a `Registration` and no `Payment`.
Swept daily by `reapClosedWaitlistEntries` (`services/waitlist-retention.ts`).

---

## Payments

### Payment (per registration)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *registration_id* (FK) | → Registration | |
| amount | decimal | |
| status | enum | pending → paid / overdue |
| method | string, nullable | e.g. "cash", "bank_transfer", "mollie", "stripe" |
| processor_ref | string, nullable | External transaction ID (Level 2) |
| reminder_sent_at | datetime, nullable | |
| **Timestamps** | | |
| created_at | datetime | |
| paid_at | datetime, nullable | |
| updated_at | datetime | |

Level 1: teacher marks payment as received manually (cash, bank transfer). Level 2: automated via Mollie/Stripe payment links. Failed payment retry policy is an open question for Level 2.

---

## Communication

### Notification (inbox item)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| recipient_type | enum: teacher, student | Polymorphic — both share inbox infrastructure |
| *recipient_id* (FK) | → Teacher or Student | |
| type | string | See types below |
| title | string | |
| body | text | |
| *related_class_id* (FK) | → Class, nullable | |
| is_read | boolean, default false | |
| email_sent | boolean, default false | True when fallback email was triggered |
| created_at | datetime | |
| updated_at | datetime | |

Notification types: booking_confirmed, class_cancelled, payment_received, waitlist_promoted, spot_available, reminder, missed_you, announcement.

Three-layer delivery: in-app notification (real-time) → in-app inbox (persistent) → email (fallback for unread).

### Announcement (teacher → students)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *class_id* (FK) | → Class, nullable | Null = broadcast to all teacher's students |
| message | text | |
| recipient_count | int | Snapshot of how many received it |
| sent_at | datetime | |

When sent, creates one Notification per recipient student. Class-scoped (specific class registrants) or teacher-wide (all students).

---

## Relationships

- Account → has one Teacher (optional)
- Account → has one Student (optional)
- Teacher → has many TeacherRooms
- Teacher → has many ScheduleRules
- ScheduleRule → has one ClassTemplate (kind: regular) or one StudioClassTemplate (kind: studio)
- Teacher → has many CalendarEntries
- CalendarEntry → has one Class (kind: regular) or one StudioClass (kind: studio)
- ScheduleRule → has many CalendarEntries (generated instances), unique per date
- Teacher → has many Announcements
- Room → has many TeacherRooms
- TeacherRoom → has many Classes
- Class → has many Registrations
- Class → has many WaitlistEntries
- Student → has many Registrations
- Student → has many StudentPrivacy records (one per teacher)
- Teacher → has many Invitations
- Teacher → has many TeacherBlocks
- Registration → has one Payment
- WaitlistEntry → has one Registration (when promoted)
- Announcement → creates many Notifications

---

## Design Notes

- **A `Teacher` hard-delete cascades through `ScheduleRule`, not directly to `ClassTemplate`/`StudioClassTemplate`** (#298) — one hop further out than `TeacherRoom`, whose `ClassTemplate_teacherRoomId_roomArchived_fkey` is `ON DELETE RESTRICT`. Measured in a rolled-back transaction against the real constraints: a single `DELETE FROM "Teacher"` still succeeds cleanly and every dependent row goes, because PostgreSQL defers a `NOT DEFERRABLE` foreign-key check to the end of the enclosing statement, and by then the sibling `ON DELETE CASCADE` from `Teacher` through `ScheduleRule` has already removed the `ClassTemplate`/`StudioClassTemplate` row the RESTRICT check would otherwise block on. That deferral is a property of one statement, not of the transaction: nothing in `src/` issues a hard `teacher.delete` today (erasure soft-deletes, per `deleteTeacherAccount`), but wherever tests tear a teacher down by hand across separate `deleteMany` calls, `scheduleRule.deleteMany` must run before `teacherRoom.deleteMany` — reversed, the `teacherRoom.deleteMany` hits the still-live `ClassTemplate`/`StudioClassTemplate` row and fails on `ClassTemplate_teacherRoomId_roomArchived_fkey`, measured the same way.
- **No production path deletes a `ClassTemplate` or `StudioClassTemplate` row** — archiving withdraws a template's future window and records what it withdrew (`archivedAt`/`withdrawnCount` on the rule), and a delete would destroy that record; `deleteTeacherAccount` archives rather than deletes for the same reason. The consequence lives one model out: `ScheduleRule` carries no foreign key back to either child, so a child deleted out from under an open transaction would leave an orphaned rule row that the archive's and the two pause/resume compare-and-swaps would still match. That is why each of those takes the child row `FOR UPDATE` first and checks the returned row count rather than discarding it (`rule-lifecycle.ts`, `class-template-lifecycle.ts`, `studio-class-template-lifecycle.ts`), and why `claimTemplateForGeneration` (`class-generator.ts`) may follow its lock with `findUniqueOrThrow`. Re-derive rather than trusting this sentence — `grep -rnE '(classTemplate|studioClassTemplate)\.(delete|deleteMany)\(' src --include='*.ts' | grep -v '\.test\.'` — no hits today; a first hit is the signal to revisit every site named here.
- **tier_at_booking** on Registration captures the student's income tier at the moment they booked. The student's global tier on the Student table can change anytime, but pricing uses the tier at booking time. This also serves as income history — no separate tracking table needed.
- **settings_locked** on Class flips to true when the first Registration is created. After that, economic fields (room_cost, min_rate, target_rate, min_students, max_students) are immutable.
- **Terminal status is the second, wider freeze** (#247). Once a Class is `completed` or `cancelled`, `updateClass` refuses every field edit — the class, not a column list — and `PUT /api/classes/[id]` answers 409. It never lifts. The entry's schedule is additionally frozen in the database by `entry_frozen_schedule_guard`, because the waitlist retention sweep above deletes on a terminality-plus-date predicate and reads that column before it does; since #327 it covers `date`, `start_time` and `duration_minutes`, all three of which moved to `CalendarEntry` together. `entry_terminal_liveness_guard` freezes `cancelled_at` beside it, for regular entries only — a studio cancellation is reversible — and `entry_completion_marker_guard` makes `class_completed_at` write-once, which is what stops the freeze being walked around in two statements: every one of these is `BEFORE UPDATE OF <columns>` and `UPDATE OF` fires on a column's presence in the SET list, so a guard reading `OLD` is only as immovable as the columns its `OLD` depends on. All three are narrower than the service on purpose, so the two layers are not the same rule twice, and all three decide from the entry's own columns (`cancelled_at`, `class_completed_at`) rather than reaching back for `Class.status` — see `docs/lock-order.md` for why that direction matters.
- **WaitlistEntry** is a separate entity from Registration to cleanly model the hybrid promotion rules. When promoted, a new Registration is created and linked via registration_id.
- **StudioClass** is intentionally disconnected from Room and Student entities. It's a simple log entry for the teacher's calendar and income reporting.
- **Notification** uses a polymorphic recipient (teacher or student) so both user types share the same inbox infrastructure.
- **rental_rate** on TeacherRoom is private to each teacher — never exposed to other teachers using the same room.
- **Authentication** hangs off the Account entity: one Account per human owns the authenticated email, sessions, and passkeys. Teacher and Student are profiles optionally linked to it via their unique `account_id` — a dual-role person (a teacher who attends classes) has one account with both profiles. Student.account_id is nullable, but nothing creates a new unclaimed Student any more (#166): a CRM contact is an Invitation until accepted, and accepting requires an already-signed-in account. The nullable column and the claim-on-first-authenticate path only still serve pre-existing unclaimed rows created before that change. Profile email fields are denormalized copies set at link time.
- **Email is lowercase everywhere** (#170). All six email columns — Account,
  Teacher, Student, MagicLinkToken, Invitation, TeacherBlock — carry a
  `CHECK (email = lower(email))` constraint. `emailField` in `src/lib/schemas.ts`
  normalises everything arriving over HTTP; anything else (seed, GDPR
  anonymisation, psql) is rejected rather than rewritten. Before this, the plain
  btree unique keys under `en_US.utf8` made `Foo@x.com` and `foo@x.com` two
  distinct identities: sign-in silently missed, and signup could create a second
  Account for one human.
- **Invitation and TeacherBlock** (#166) exist because a teacher may not link a student unilaterally. `POST /api/students` creates only an Invitation; the TeacherStudent link forms when the invitee accepts it or books a class. Declining leaves the Invitation row itself as a tombstone against re-inviting; unlinking after being linked additionally writes a TeacherBlock, so the two "no" states aren't uniform — a bare decline blocks re-invites without a TeacherBlock row, only an unlink writes one.

## Open Questions

- How to handle failed payments in Level 2? Retry policy? (parked for later)
