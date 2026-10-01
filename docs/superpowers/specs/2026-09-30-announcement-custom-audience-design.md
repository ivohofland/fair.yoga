# Announcements: a custom-selection audience (#48)

## 1. The premise, as measured

The issue holds, with two corrections to its scope.

- `createAnnouncementSchema` (`src/lib/schemas.ts`) is `{ classId?, message }`; the
  route (`src/app/api/announcements/route.ts`) has two audience branches (class
  registrants; every student with a non-cancelled registration with this teacher,
  minus the teacher's archived ones), then subtracts `StudentPrivacy.receiveComms =
  false`. `teacher-screens.md` §8.3 promises a third, "custom selection". No CI gate
  covers announcement audiences, so nothing is duplicated.
- **Correction 1 — the picker cannot reuse `GET /api/students`.** That list is
  `TeacherStudent`-based and includes linked contacts who never booked; the
  all-students audience is *registration*-based and excludes them (the composer's
  own "Who receives this?" copy says so). A picker fed by `/api/students` would offer
  people the send then silently drops.
- **Correction 2 — dedupe must learn the audience.** `sendAnnouncement` suppresses an
  identical `(teacherId, classId, message)` within `ANNOUNCEMENT_DEDUPE_WINDOW_MS`.
  Two custom sends of one message to different people would suppress each other and
  the second group would never be told.

## 2. Decisions (agreed with the user)

1. **Eligible set = the all-students audience.** Custom is a *narrowing*: no new
   reach, no new consent question. Linked-but-never-booked contacts stay unreachable,
   as today.
2. **Dedupe is per recipient, for every audience, by real values.** Every
   announcement stores the students it actually notified in
   `Announcement.audienceStudentIds String[]` (sorted, unique). A send of the same
   `(teacherId, message)` within `ANNOUNCEMENT_DEDUPE_WINDOW_MS` (unchanged, 2 min)
   notifies only students absent from the union of those recent rows. Resending to
   `{A, B, C, D}` after `{A, B}` notifies C and D; a double-click notifies nobody new.
   The compare reads real ids; the SHA-256 stays confined to `lockAnnouncementSlot`,
   where it only serialises (its docblock rules out a hash deciding whether people get
   a message). `classId` leaves both the predicate and the lock key: a person who got
   "Bring a mat" through a class send has been told, whichever audience names them next.
   The lock key and predicate change in one edit, for the coupling that docblock explains.
3. **Picker = an audience step in the composer** on `/students`; class detail stays
   class-scoped.

## 3. Design

**Schema.** `createAnnouncementSchema` gains `studentIds: z.array(uuid).min(1).max(500)
.optional()`. The schema does not transform it: the route dedupes the ids and the
service sorts the ones it stores. `classId` and `studentIds` together are a
400 (a refine, not a precedence rule — a body naming two audiences is ambiguous).
The 500 cap bounds one request's fan-out on the 2 GB VPS.

**Audience resolution.** The all-students query moves from the route into
`services/announcements.ts` as `listAnnouncementAudience(db, teacherId)` (student ids,
before opt-out) so the route's two branches and the picker endpoint read one query.

**Custom branch (gate 4).** `studentIds ∩ listAnnouncementAudience`. An id outside the
audience — another teacher's student, an archived one, a stale picker row, a made-up
uuid — is dropped with no distinction between them (no oracle on who exists or who is
linked elsewhere), then `receiveComms` opt-outs are dropped exactly as in the other
branches. Empty after both → the existing `400 No students to notify`. The response
carries `recipientCount`, which is what tells the teacher a stale row fell away.

**Picker endpoint.** `GET /api/announcements/audience` (`requireTeacher`) returns the
audience as `{ id, displayName }`, names through `projectStudentForTeacher` so a
withheld surname stays withheld. Muted students are **listed** — omitting them would
let the teacher read opt-outs off the gaps; the send drops them as it does today.
Search is client-side over already-projected `displayName` (the #176 hazard was a
*server* filter on redacted columns).

**Service.** Inside the locked transaction `sendAnnouncement` reads the recent rows for
`(teacherId, message)`, subtracts their ids from `recipients`, and then:
- nothing left → `deduped: true`, nothing written; the route answers 200 with
  `{ recipientCount (= alreadyNotified), duplicateSuppressed: true, alreadyNotified }`;
- some left → fans out to the remainder and creates a row whose `recipientCount` and
  `audienceStudentIds` are the remainder only, and the result carries
  `alreadyNotified` (how many of the requested set had it), so the composer can say
  "Sent to 2 students (2 already had it)".
Lock order is unchanged (`advisory → Class`; a custom send takes no `Class` lock).
The route's empty-recipient 400 still precedes the service, so "nothing left" after
dedupe is a 200, never a 400.

**Storage.** An all-students send now stores every recipient id. Bounded by one
teacher's audience (tens to low thousands of uuids per row); the ids also give a sent
history for free. The array is needed only inside the window, so clearing it after is
possible later; not done here.

**GDPR.** The array holds other people's ids. Student erasure removes the id from every
`Announcement.audienceStudentIds` inside its transaction (`array_remove`); the teacher
export (`gdpr.ts`) leaves the array out. Whether that extra write touches a new lock
node is an item for the plan to census against `docs/lock-order.md` (every mode, not
just cycles) before it is written.

**UI.** Composer gets "Everyone / Choose students" when mounted without `classId`;
"Choose" loads the audience, renders a searchable checkbox list (select all / clear),
disables Send at zero selected, and swaps the "Who receives this?" copy. Copy states
the drop rules. No new motion, no badges (design brief).

**Not in production yet**, so the column needs no backfill (`{}` default).

## 4. Tests (written first)

Unit: schema (exclusivity, cap, sort/unique); service (`{A,B}` then `{A,B,C,D}` notifies
only C and D and reports `alreadyNotified: 2`; `{A,B}` twice notifies once; same message
through a class send then an all-students send skips the class's registrants; a
send after the window goes to everyone; concurrent identical sends serialise to one). Integration: foreign-teacher id → no `Notification` row for that
student; archived, muted and unknown ids dropped; nothing left → 400; class + ids →
400; audience endpoint omits never-booked contacts and respects the name projection.
Component: picker select / search / disabled-at-zero. Each guard is mutated and its
failure text recorded in the PR (`intersection`, `refine`, `subtraction`, `lock key`).

## 5. Docs touched

`docs/data-model.md` (Announcement table + audience rule), `docs/teacher-screens.md`
§8.3 (no change needed to the promise; note the eligibility), `docs/lock-order.md`
only if the GDPR census finds a new node. Counts, if any, live there with their
re-derivation command, never in a docblock.

## 6. Out of scope

Saved/named groups; a longer dedupe window (kept at 2 min by decision); selecting from class detail; messaging never-booked contacts
(**#48** stays about the third audience only); a sent-history screen, though the
column makes one possible.

## 7. Rulings during build

- **Erased students are not in any audience.** `Student.deletedAt` is filtered at both audience reads (`listAnnouncementAudience` and the class-scoped registration read in `POST /api/announcements`), because erasure leaves a started or completed class's registration uncancelled and the profile would otherwise be notified and listed in the picker.
- **The Announcement scrub is a new lock node**, ordered Student -> Class -> Announcement; the census and the accepted write-back race are in `docs/lock-order.md`, "`Announcement` rows: the audience scrub (#48)".
- **A fully-deduped send answers 200** with `{ recipientCount (= alreadyNotified), duplicateSuppressed: true, alreadyNotified }`: how many of this request's students already had the message, not the size of any earlier send.
- **Dedupe ignores `classId` across scopes, by decision.** A student booked in two classes who gets the identical message for both within two minutes is told once, with the first send's class link. Flagged for the user's reaffirmation in the PR.
