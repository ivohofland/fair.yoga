# Data Model — Ethical Yoga App

11 entities across 6 domains. This is the source of truth for the application's data layer.

---

## People

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
- **Authentication** hangs off the Account entity: one Account per human owns the authenticated email, sessions, and passkeys. Teacher and Student are profiles optionally linked to it via their unique `account_id` — a dual-role person (a teacher who attends classes) has one account with both profiles. Student.account_id is nullable: CRM-created students stay unclaimed until the human first authenticates (the claim moment links the account and stamps claimed_at). Profile email fields are denormalized copies set at link time.

## Open Questions

- How to handle failed payments in Level 2? Retry policy? (parked for later)
