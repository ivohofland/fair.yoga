# Data Model — Ethical Yoga App

16 entities across 6 domains. This is the source of truth for the application's data layer.

---

## People

### Account (auth identity)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| email | string, unique | The authenticated identity — sessions and passkeys key off this, not off Teacher/Student |
| **Timestamps** | | |
| created_at | datetime | |

One Account per human. Teacher and Student are profiles optionally linked to it via their own unique `account_id` — a dual-role person (a teacher who also attends classes) has one Account with both profiles attached. See Design Notes below for the claim path that links an Account to a pre-existing unclaimed Student.

### Teacher (core)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| first_name | string | |
| last_name | string | |
| email | string, unique | Denormalized copy of the account email |
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
| email | string, unique | Required. Contact email; copies the account email once claimed |
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
| share_email | boolean, default false | |
| share_phone | boolean, default false | |
| share_birthday | boolean, default false | |
| share_address | boolean, default false | |
| receive_comms | boolean, default true | Opt-out from teacher announcements |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Created on first booking with a teacher. Default = maximum privacy. Student explicitly opts in to share each field per teacher.

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

### ClassTemplate (recurring class definition)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *teacher_room_id* (FK) | → TeacherRoom | |
| class_type | string | e.g. "Vinyasa", "Yin", "Hatha" |
| description | text, nullable | |
| day_of_week | int (0-6) | 0 = Monday |
| start_time | time | |
| duration_minutes | int | |
| **Economics** | | Copied to generated instances |
| room_cost | decimal | From TeacherRoom.rental_rate |
| min_rate | decimal | Minimum teacher earns per student |
| target_rate | decimal | Ideal teacher earns per student |
| min_students | int | Below this, class auto-cancels |
| max_students | int | Registration cap |
| **Policies** | | |
| cancel_deadline | enum: 48h, 24h, 12h, 6h | Student cancellation window |
| auto_cancel_check | enum: 4h, 2h, 1h | When to check min_students threshold |
| is_active | boolean | Teacher can pause/stop a recurring class |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

Class instances are generated on a rolling 4-week basis. Runs indefinitely until teacher deactivates.

### Class (single class instance)

| Field | Type | Notes |
|---|---|---|
| **id** (PK) | uuid | |
| *teacher_id* (FK) | → Teacher | |
| *teacher_room_id* (FK) | → TeacherRoom | |
| *template_id* (FK) | → ClassTemplate, nullable | Null for one-off classes |
| class_type | string | |
| description | text, nullable | |
| date | date | |
| start_time | time | |
| duration_minutes | int | |
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
| status | enum | draft → open → full → in_progress → completed → cancelled |
| settings_locked | boolean | Flips to true on first registration |
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
| *teacher_id* (FK) | → Teacher | |
| date | date | |
| start_time | time | |
| duration_minutes | int | |
| location | string | Free text (not linked to Room) |
| student_count | int, nullable | |
| hourly_rate | decimal | Teacher's rate at this studio |
| **Timestamps** | | |
| created_at | datetime | |
| updated_at | datetime | |

No pricing engine. No individual registration. No link to Room or Student. This is purely a calendar + income tracking entry for classes the teacher gives at someone else's studio.

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
- Teacher → has many Classes
- Teacher → has many ClassTemplates
- Teacher → has many StudioClasses
- Teacher → has many Announcements
- Room → has many TeacherRooms
- TeacherRoom → has many Classes
- ClassTemplate → has many Classes (generated instances)
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

- **tier_at_booking** on Registration captures the student's income tier at the moment they booked. The student's global tier on the Student table can change anytime, but pricing uses the tier at booking time. This also serves as income history — no separate tracking table needed.
- **settings_locked** on Class flips to true when the first Registration is created. After that, economic fields (room_cost, min_rate, target_rate, min_students, max_students) are immutable.
- **WaitlistEntry** is a separate entity from Registration to cleanly model the hybrid promotion rules. When promoted, a new Registration is created and linked via registration_id.
- **StudioClass** is intentionally disconnected from Room and Student entities. It's a simple log entry for the teacher's calendar and income reporting.
- **Notification** uses a polymorphic recipient (teacher or student) so both user types share the same inbox infrastructure.
- **rental_rate** on TeacherRoom is private to each teacher — never exposed to other teachers using the same room.
- **Authentication** hangs off the Account entity: one Account per human owns the authenticated email, sessions, and passkeys. Teacher and Student are profiles optionally linked to it via their unique `account_id` — a dual-role person (a teacher who attends classes) has one account with both profiles. Student.account_id is nullable, but nothing creates a new unclaimed Student any more (#166): a CRM contact is an Invitation until accepted, and accepting requires an already-signed-in account. The nullable column and the claim-on-first-authenticate path only still serve pre-existing unclaimed rows created before that change. Profile email fields are denormalized copies set at link time.
- **Invitation and TeacherBlock** (#166) exist because a teacher may not link a student unilaterally. `POST /api/students` creates only an Invitation; the TeacherStudent link forms when the invitee accepts it or books a class. Declining leaves the Invitation row itself as a tombstone against re-inviting; unlinking after being linked additionally writes a TeacherBlock, so the two "no" states aren't uniform — a bare decline blocks re-invites without a TeacherBlock row, only an unlink writes one.

## Open Questions

- How to handle failed payments in Level 2? Retry policy? (parked for later)
