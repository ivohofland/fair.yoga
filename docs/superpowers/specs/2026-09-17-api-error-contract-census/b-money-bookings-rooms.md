# Census B — payments / registrations / waitlist / rooms / teacher-rooms / announcements

> **Record, not reference.** A subagent census taken for the #197 spec
> (`../2026-09-17-api-error-contract-design.md`) by reading the tree at
> `4e1ec6e4`. Line numbers are as of that commit. Nothing was run except
> `grep`/`sed`/`wc`.

Paths are repo-relative.

## Conventions

- **Pairs** = every exported mutating method (POST/PUT/PATCH/DELETE) in the 15 route files. The GET handlers in `rooms/route.ts`, `rooms/[id]/route.ts`, `teacher-rooms/route.ts`, `teacher-rooms/[id]/route.ts` and `registrations/[id]/route.ts` are not counted.
- **Route-file shorthand**: `pay/paid` = `src/app/api/payments/[id]/paid/route.ts`, and the same pattern for the others. `reg` = `src/app/api/registrations/route.ts`, `reg/[id]`, `wl` = `src/app/api/waitlist/route.ts`, `wl/[id]`, `wl/claim`, `rooms`, `rooms/[id]`, `publish` = `rooms/[id]/publish/route.ts`, `tr` = `teacher-rooms/route.ts`, `tr/[id]`, `ann` = `announcements/route.ts`.
- **Service shorthand**: `payments.ts`, `waitlist.ts`, `room-deletion.ts`, `room-archive.ts` = `src/services/<name>`. `db-locks.ts` = `src/lib/db-locks.ts`.
- **Test shorthand**: PA/RA/WA/RM/RP/TR/AN are `tests/integration/{payments,registrations,waitlist,rooms,rooms-publish,teacher-rooms,announcements}-api.test.ts`. RLO is `src/app/api/registrations/route-lock-order.test.ts`, a colocated test that runs against real Postgres. PS and WS are the service unit tests `src/services/payments.test.ts` and `waitlist.test.ts`, listed only where no route-level test exists or where they pin the prose. Ranges run from the `it(` line to the assertion line.
- **retry?**
  - **ALREADY**: the response is reachable only when the request's goal already holds.
  - **BOTH**: a plain identical retry after the first request committed, with no other writer in between, reaches the response, and so does a state where the goal does not hold.
  - **GENUINE**: a plain retry cannot reach the response.
  - **GENUINE†**: a GENUINE response that can also be reached with the goal achieved, but only after some other writer changed state in between.
- **Out-of-scope count**: distinct out-of-scope response sites. `requireSession` has 2 (both 401), `requireTeacher`/`requireStudent` have 3 (two 401s and one 403), `parseBody` has 2 (`Invalid JSON` and the schema message). Route-local auth or input-shape sites are added and named. No route in this group has a 429; `src/proxy.ts` matches no `/api` path.
- **Client display**: every error display listed is red text (`text-danger`) unless stated otherwise.

---

## 1. POST /api/payments/[id]/paid

**A. Clients**
- `src/lib/use-payment-actions.ts:33` (`markPaid`) reads the error with `readErrorMessage` (:48). The message shows as red `role=alert` text in `payment-checklist.tsx:51-53`, `outstanding-payment-row.tsx:172-174` and `students/student-payment-list.tsx:31`. Those are the hook's three consumers: `payment-checklist.tsx:25`, `outstanding-payment-row.tsx:46`, `student-payment-list.tsx:21`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Payment not found` | — | pay/paid:33 | pay/paid:33 | GENUINE | USER | PA:433-436 status only |
| 403 | `Access denied` (not the teacher's payment) | — | pay/paid:35 | pay/paid:35 | GENUINE | DEV? (generic HTTP phrasing; names nothing in product terms) | PA:438-444 status only |
| 409 | `` `Payment not found: ${paymentId}` `` | — | payments.ts:99 | pay/paid:42 | GENUINE (race: row deleted between the route's read at :24 and the service) | DEV (interpolates a UUID) | none |
| 409 | `` `Cannot mark payment as paid: current status is "${payment.status}". Must be "pending" or "overdue".` `` | — | payments.ts:102 | pay/paid:42 | BOTH (plain retry → status `paid`; genuine → `not_charged`) | DEV | PA:463-469 status only (this is the retry path); PS:181-189 `toContain('paid')`; PS:545-552 exact prose (`not_charged` variant) |

**C.** A retry gets the 409 `current status is "paid"` row, because `updateMany` is scoped to `status in (pending, overdue)` (payments.ts:88-104). No side effect.
**Out of scope:** 5 (requireTeacher 3, parseBody 2).

## 2. POST /api/payments/[id]/unpaid

**A. Clients**
- `src/lib/use-payment-actions.ts:95` (`undo`) reads the error with `readErrorMessage` (:103). It shows as red text on the same three surfaces as §1.
- `src/components/class/mark-unpaid-button.tsx:35` reads the error with `readErrorMessage` (:48) and shows a red `span` (:126). This button is rendered by `not-charged-payment-row.tsx:50` and `received-payment-row.tsx:69`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Payment not found` | — | pay/unpaid:31 | pay/unpaid:31 | GENUINE | USER | PA:487-490 status only |
| 403 | `Access denied` | — | pay/unpaid:33 | pay/unpaid:33 | GENUINE | DEV? (generic) | PA:492-498 status only |
| 409 | `` `Payment not found: ${paymentId}` `` | — | payments.ts:162 | pay/unpaid:37 | GENUINE (race) | DEV | none |
| 409 | `` `Cannot undo: current status is "${payment.status}". Must be "paid" or "not charged".` `` | — | payments.ts:165 | pay/unpaid:37 | ALREADY (only `pending` or `overdue` reach this, and both are the "owed again" state the undo exists to reach) | DEV | PA:510-519 status only; PS:573-579 exact prose |

**C.** A retry gets the 409 `Cannot undo … "pending"` row (payments.ts:155-167). `mark-unpaid-button.tsx:40-43` says so in its own comment.
**Out of scope:** 3.

## 3. POST /api/payments/[id]/not-charged

**A. Clients**
- `src/lib/use-payment-actions.ts:61` (`markNotCharged`) reads the error with `readErrorMessage` (:72). Only `outstanding-payment-row.tsx:46/:90` uses this action, and it shows the error as red `role=alert` text (:172-174).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Payment not found` | — | pay/not-charged:35 | pay/not-charged:35 | GENUINE | USER | PA:537-540 status only |
| 403 | `Access denied` | — | pay/not-charged:37 | pay/not-charged:37 | GENUINE | DEV? (generic) | PA:542-548 status only |
| 409 | `` `Payment not found: ${paymentId}` `` | — | payments.ts:197 | pay/not-charged:41 | GENUINE (race) | DEV | none |
| 409 | `` `Cannot mark as not charged: current status is "${payment.status}". Must be "pending" or "overdue".` `` | — | payments.ts:200 | pay/not-charged:41 | BOTH (plain retry → `not_charged`, rendered with the underscore; genuine → `paid`, the refund refusal) | DEV | PA:581-587 status only (the retry path); PS:529-536 exact prose (`paid` variant); PS:538-542 `ok:false` only |

**C.** A retry gets the 409 `current status is "not_charged"` row (payments.ts:190-202).
**Out of scope:** 3.

## 4. POST /api/payments/[id]/remind

**A. Clients**
- `src/components/class/send-reminder-button.tsx:63` reads the error with `readErrorMessage` (:72) and passes it to `onError`. That renders as red `role=alert` text in `payment-checklist.tsx:51-53` (wired at :97) and `outstanding-payment-row.tsx:172-174` (wired at :85).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Payment not found` | — | pay/remind:31 | pay/remind:31 | GENUINE | USER | PA:240-246 status only |
| 403 | `Access denied` | — | pay/remind:33 | pay/remind:33 | GENUINE | DEV? (generic) | PA:248-259 status only |
| 409 | `` `Payment not found: ${paymentId}` `` | — | payments.ts:267 | pay/remind:37 | GENUINE (race) | DEV | none |
| 409 | `` `Cannot send a reminder: current status is "${payment.status}". Must be "pending" or "overdue".` `` | — | payments.ts:277 | pay/remind:37 | GENUINE† (reminder sent, then payment settled, then retry) | DEV | PA:280-299 status only; PS:458-470 `toContain('"paid"')` |
| 409 | `A reminder for this payment was just sent. Try again in a couple of minutes.` | — | payments.ts:282 | pay/remind:37 | ALREADY (a retry within `MANUAL_REMIND_COOLDOWN_MS`, payments.ts:226, 2 min; also reached when the sweep, which stamps `reminderSentAt` at `payment-reminders.ts:87`, or another tab reminded first — the student was reminded either way) | USER | PA:337-405 status only (`[200,409]`, concurrent); PS:423-438 `ok:false` only |

**C.** Within 2 minutes a retry gets the cooldown 409 row, from the CAS at payments.ts:257-265 and :280-283. After 2 minutes it gets 200 and a second student notification; the code states that is by design (payments.ts:212-225).
**Out of scope:** 3.

## 5. POST /api/registrations

**A. Clients**
- `src/components/booking/booking-flow.tsx:88` (student booking) reads the error with `readErrorMessage` (:96) and shows red `role=alert` text (:254).
- `src/components/class/add-walk-in.tsx:85` (teacher roster add or walk-in) reads the error with `readErrorMessage` (:95) and shows red `role=alert` text (:167).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Student not found` | — | reg:92 | reg:92 | GENUINE | USER | none |
| 403 | `Student is not in your roster` (no TeacherStudent row) | — | reg:99 | reg:99 | GENUINE | DEV? ("roster" is internal vocabulary; no UI copy uses it) | RA:295-300 exact prose; RA:324-328 status only |
| 404 | `Class not found` | — | reg:317 (thrown :140) | reg:317 | GENUINE | USER | none |
| 409 | `This student's account no longer exists` (teacher path; `StudentErasedError` from db-locks.ts:335 via reg:109) | — | reg:321 | reg:320-323 | GENUINE | USER | RLO:409, :495, :570 status + prose (`toEqual`) |
| 409 | `This account has been deleted` (student path, same throw) | — | reg:321 | reg:320-323 | GENUINE | USER | RLO:375, :434, :464 status + prose |
| 403 | `Not your class` | — | reg:326 (thrown :145) | reg:326 | GENUINE | USER | RA:315-321 exact prose |
| 409 | `` `Cannot register for a class with status "${classStatus}"` `` (thrown with `'cancelled'` at :156 or `cls.status` at :159) | — | reg:45 | reg:329 | GENUINE† (a walk-in add, then the class completes, then a retry) | DEV (interpolates the enum; `"cancelled"` is a pseudo-status since #327) | RA:562-607 exact prose (`"cancelled"`); RA:410-411 status only (`in_progress`, student) |
| 409 | `Class is full` | — | reg:332 (thrown :178) | reg:332 | **BOTH** (a plain retry after the student's own booking took the last seat: `isFull` at :175-179 is checked **before** the existing-registration check at :183-189; genuine → someone else filled the class) | USER | RA:610-651 `toContain`; RA:343-358 status only (concurrent loser); RA:377-386 status only |
| 409 | `Student is already registered for this class` (thrown :188, or P2002 on `(classId, studentId)`) | — | reg:345 | reg:345 | ALREADY (a plain retry while seats remain; a concurrent duplicate via P2002; a teacher adding a self-booked student) | USER (third person even on the student's own booking) | RA:369-375 status only |

**C.** A retry gets the **already registered** row if seats remain, and the **Class is full** row if the first booking took the last seat. A walk-in retry skips the capacity check (reg:171-177) and gets **already registered**. The transaction rolls back, so there is no duplicate side effect. A code comment at `src/app/api/registrations/route.test.ts:391-392` claims "the retry would be refused as already registered", which is true only when seats remain.
**Out of scope:** 6 (requireSession 2, parseBody 2, reg:69 `Teacher access required` 403, reg:73 `Student access required` 403).

## 6. PUT /api/registrations/[id]

**A. Clients**
- `src/components/class/attendance-list.tsx:68` reads the error with `readErrorMessage` (:83), shows red `role=alert` text (:110-113) and calls `router.refresh()` (:88).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Registration not found` | — | reg/[id]:102 | reg/[id]:102 | GENUINE | DEV? (model noun; student-facing copy says "booking") | none |
| 403 | `Not your class` | — | reg/[id]:104 | reg/[id]:104 | GENUINE | USER | RA:932-939 status only |
| 404 | `Registration not found` (fresh read after a 0-count write) | — | reg/[id]:177 | reg/[id]:177 | GENUINE (race) | DEV? (as above) | none |
| 409 | `Cannot record attendance on a cancelled class` | — | reg/[id]:179 | reg/[id]:179 | GENUINE | USER | RA:1339-1358 status only |
| 409 | `This student cancelled late. You can mark them attended once the class has started.` | — | reg/[id]:183 | reg/[id]:182-185 | GENUINE | USER | RA:1238-1257 `toContain('once the class has started')`; RA:1265-1278 status only (`no_show` target, which gets the same "attended" wording) |
| 409 | `Cannot record attendance on a cancelled registration` | — | reg/[id]:187 | reg/[id]:187 | GENUINE | DEV? (model noun) | RA:1322-1337 status only |

**C.** A retry gets 200, idempotent: the scoped `updateMany` (reg/[id]:150-162) matches again and the route returns `{id, status}` (:190).
**Out of scope:** 5 (requireSession 2, reg/[id]:87 `Only teachers can update attendance` 403, parseBody 2).

## 7. DELETE /api/registrations/[id]

**A. Clients**
- `src/components/student/cancel-booking-button.tsx:30` reads the error with `readErrorMessage` (:34) and shows red `role=alert` text (:65). On success it calls `router.refresh()`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Registration not found` | — | reg/[id]:223 | reg/[id]:223 | GENUINE | DEV? (model noun) | none |
| 403 | `Access denied` (neither the booking's student nor the class's teacher) | — | reg/[id]:229 | reg/[id]:229 | GENUINE | DEV? (generic) | RA:944-950 status only |
| 409 | `` `Cannot cancel a registration on a ${state} class` `` (state is `completed` or `cancelled`, :237) | — | reg/[id]:238 | reg/[id]:238 | GENUINE† (the class check at :235 comes before the registration-status check at :240, so a booking that was already cancelled, on a class that since completed or was cancelled, gets this) | DEV? (model noun; the state comes from a two-word map) | none |
| 409 | `Registration is already cancelled` (pre-check) | — | reg/[id]:241 | reg/[id]:241 | BOTH (plain retry; genuine → a teacher's free cancel of a `late_cancel` row, where the student stays charged) | DEV? (model noun) | RA:1693-1705 status only |
| 409 | `Registration is already cancelled` (late-cancel CAS) | — | reg/[id]:276 | reg/[id]:276 | ALREADY (concurrent duplicate only, or a concurrent free cancel won) | DEV? | RA:1584-1633 status only; RA:1635-1691 status only |
| 409 | `Registration is already cancelled` (full-cancel CAS) | — | reg/[id]:301 | reg/[id]:301 | BOTH (concurrent duplicate; genuine → the teacher's free cancel lost to the student's concurrent late cancel) | DEV? | RA:1521-1582 status only (`[200,409]`) |

**C.** A retry gets the pre-check row at reg/[id]:240-241. No second promotion or notice is sent.
**Out of scope:** 2.

## 8. POST /api/waitlist

**A. Clients**
- `src/components/booking/booking-flow.tsx:75` reads the error with `readErrorMessage` (:83) and shows red `role=alert` text (:254).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | wl:27 | wl:27 | GENUINE | USER | none |
| 409 | `This account has been deleted` | — | waitlist.ts:232 | wl:64 | GENUINE | USER | none at the route (WS:2150 checks `reason` only) |
| 409 | `Cannot join the waitlist for a cancelled class` | — | waitlist.ts:252 | wl:64 | GENUINE | USER | none at the route |
| 409 | `` `Cannot join the waitlist for a class with status "${cls.status}"` `` | — | waitlist.ts:253 | wl:64 | GENUINE | DEV | none at the route (WS:369 checks `reason` only) |
| 409 | `The class still has open spots — book directly instead` | — | waitlist.ts:261 | wl:64 | GENUINE† (a waiting student retries after a seat freed without a promotion, in the FCFC or frozen window) | USER | none at the route (WS:358-364 checks `reason`) |
| 409 | `You are already registered for this class` | — | waitlist.ts:268 | wl:64 | GENUINE† (join, then promotion, then retry: the student holds a seat, not a queue place) | USER | none at the route (WS:375 checks `reason`) |

**C.** A retry gets 201 with the same entry, which `waitlist.ts:339-341` returns for a `waiting` row. The link and invitation writes re-run as no-ops.
**Out of scope:** 5 (requireStudent 3, parseBody 2).

## 9. DELETE /api/waitlist/[id]

**A. Clients**
- `src/components/student/waitlist-entry-actions.tsx:49` reads the error with `readErrorMessage` (:54) and shows red text with no `role=alert` (:82). On success it calls `router.refresh()`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Waitlist entry not found` | — | wl/[id]:22 | wl/[id]:22 | GENUINE | DEV? (model name `WaitlistEntry`; this route's own 409 says "waitlist spot") | none |
| 403 | `Access denied` (not the caller's entry, and the caller has no teacher profile) | — | wl/[id]:27 | wl/[id]:27 | GENUINE | DEV? (generic) | RA:834-840 status only |
| 403 | `Access denied` (class missing or not the caller's) | — | wl/[id]:33 | wl/[id]:33 | GENUINE | DEV? (generic) | RA:826-832 status only |
| 404 | `Waitlist entry not found` (`NOT_FOUND`, waitlist.ts:458) | — | wl/[id]:50 | wl/[id]:50 | GENUINE (race with erasure) | DEV? | none at the route (WS:1587 checks `reason`) |
| 409 | `That waitlist spot is no longer active — refresh to see the latest.` (`NOT_WAITING`, waitlist.ts:457) | — | wl/[id]:51 | wl/[id]:51 | **BOTH** (plain retry: the first DELETE left the row `removed` (waitlist.ts:442-445), and the retry re-reads it by id at :21; genuine → the row is `promoted`/`claimed`, so the student now holds a seat and never left) | USER | RA:854-871 `toContain('no longer active')` and `not.toContain('not found')` |

**C.** A retry gets the 409 `no longer active` row.
**Out of scope:** 2.

## 10. POST /api/waitlist/claim

**A. Clients**
- `src/components/student/waitlist-entry-actions.tsx:28` reads the error with `readErrorMessage` (:37) and shows red text (:82). On success it calls `router.refresh()`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 409 | `Cannot claim a spot in a cancelled class` | — | waitlist.ts:659 | wl/claim:34 | GENUINE | USER | none |
| 409 | `` `Cannot claim a spot in a class with status "${cls.status}"` `` | — | waitlist.ts:660 | wl/claim:34 | GENUINE† (a claim, then the class starts, then a retry) | DEV | none |
| 409 | `The waitlist is frozen — the cancellation deadline has passed` | — | waitlist.ts:674 | wl/claim:34 | GENUINE† (a claim, then the deadline passes, then a retry) | DEV? ("frozen" is the internal `WaitlistWindow` member name) | none at the route (WS:946-950 checks `reason`) |
| 409 | `Spots can only be claimed in the final hour before the deadline — before that the queue promotes automatically` | — | waitlist.ts:680 | wl/claim:34 | GENUINE | USER | WA:231-249 `toMatch(/final hour\|window/i)` |
| 409 | `The spot has already been claimed` | — | waitlist.ts:687 | wl/claim:34 | **BOTH** (a plain retry after the student's own claim took the last seat: `readSeatCount` at :685 runs before the entry lookup at :690; genuine → another student claimed first) | USER | WA:268-278 `toMatch(/already been claimed/i)`. **This test is the plain-retry path**: the same student and class, right after its own 201 at WA:251-266 |
| 409 | `You are not on the waitlist for this class` | — | waitlist.ts:694 | wl/claim:34 | **BOTH** (a plain retry after the student's own claim while seats remain: the entry is now `promoted`, waitlist.ts:721-724; genuine → the student never joined or left) | USER | none at the route (WS:986 checks `reason`) |

**C.** A retry gets the `already been claimed` row if the student took the last seat, otherwise the `not on the waitlist` row. No second registration is created.
**Out of scope:** 5 (requireSession 2, wl/claim:23 `Only students can claim waitlist spots` 403, parseBody 2).

## 11. POST /api/rooms

**A. Clients**
- `src/components/settings/room-create-step.tsx:116` parses the body itself (`json.error?.message`, :123-124), shows red `role=alert` text (:193) and never branches on `code`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 409 | `A shared room at this address already exists` (`isPublic` true) | DUPLICATE_ROOM | rooms:121 | rooms:119-129 | **BOTH** (plain retry: the teacher's own new row now holds `Room_public_identity_unique`; genuine → someone else's shared room) | USER | RM:713-725 code + exact prose (**a plain identical retry by the same teacher**); RM:727-740 code only (concurrent) |
| 409 | `You already have a room at this address. Add a floor or room name to tell them apart.` | DUPLICATE_ROOM | rooms:126 | rooms:119-129 | **BOTH** (plain retry: the teacher is told to rename a room they just created; genuine → a different private room with a blank floor or name) | USER | RM:689-703 code + exact prose (**a plain identical retry**) |

**C.** A retry gets 409 `DUPLICATE_ROOM` (the first or second row, depending on `isPublic`). No second row is written.
**Out of scope:** 5.

## 12. PUT /api/rooms/[id]

**A. Clients**
- `src/components/settings/edit-room-form.tsx:80` parses the body itself (:99-100) and shows red `role=alert` text (:173). It then chains the `PUT /api/teacher-rooms/[id]` call covered in §16.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Room not found` | — | rooms/[id]:144 | rooms/[id]:144 | GENUINE | USER | none |
| 403 | `Shared rooms cannot be edited` | — | rooms/[id]:147 | rooms/[id]:147 | GENUINE | USER | RM:332-349, RM:355-373 `toContain` |
| 403 | `Only the room creator can update this room` | — | rooms/[id]:151 | rooms/[id]:151 | GENUINE | USER | RM:318-327 `toContain` (the comment at RM:323 cites stale line `:37`) |
| 409 | `You already have a room at this address. Add a floor or room name to tell them apart.` | DUPLICATE_ROOM | rooms/[id]:201 | rooms/[id]:197-204 | GENUINE (a row never collides with itself) | USER | RM:762-800 code + exact prose |
| 404 | `Room not found` (fresh read after a 0-count write) | — | rooms/[id]:218 | rooms/[id]:218 | GENUINE (race) | USER | none |
| 409 | `This room has just been shared and can no longer be edited` | NOW_SHARED | rooms/[id]:220 | rooms/[id]:220 | GENUINE (race with publish; after commit, a retry hits the 403 at :147 instead) | USER | **none** |
| 403 | `Only the room creator can update this room` (after a 0-count write) | — | rooms/[id]:222 | rooms/[id]:222 | GENUINE; **unreachable today**: `createdById` is written only at rooms:108, and `updateRoomSchema` (`src/lib/schemas.ts:335-345`) and publish do not write it | USER | none |
| 404 | `Room not found` (re-read after a successful write) | — | rooms/[id]:226 | rooms/[id]:226 | GENUINE (race with delete) | USER | none |

**C.** A retry gets 200, idempotent: `updateMany` at rooms/[id]:191-194 matches again.
**Out of scope:** 6 (requireTeacher 3, parseBody 2, rooms/[id]:164 `No valid fields to update` 400).

## 13. DELETE /api/rooms/[id]

**A. Clients**
- `src/components/settings/delete-room-button.tsx:22` parses the body itself (:26-27) and shows red `role=alert` text (:65). It stays on the page after an error; on success it hard-navigates (:43).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Room not found` | — | rooms/[id]:32 | rooms/[id]:32 | ALREADY (plain retry: the room is gone) | USER | none |
| 403 | `Shared rooms cannot be deleted` | — | rooms/[id]:35 | rooms/[id]:35 | GENUINE | USER | RM:453-463, RM:465-476 `toContain` |
| 403 | `Only the room creator can delete this room` | — | rooms/[id]:39 | rooms/[id]:39 | GENUINE | USER | RM:478-486, RM:509-523 `toContain` |
| 409 | `This room is still in use and cannot be deleted. Archive it instead.` | ROOM_IN_USE | room-deletion.ts:81-82 (code at :119) | rooms/[id]:55 | GENUINE | USER | RM:488-507 `toContain`, no code; RM:540-557 exact prose + code; RM:600-616 exact prose + code |
| 409 | same message (FK backstop) | ROOM_IN_USE_RACE | room-deletion.ts:81-82 (code at :120) | rooms/[id]:109 | GENUINE (race) | USER | **none** |

**C.** A retry gets 404 `Room not found`, which the button shows as red text after a delete that succeeded but whose response was lost.
**Out of scope:** 3.

## 14. POST /api/rooms/[id]/publish

**A. Clients**
- `src/components/settings/share-room-button.tsx:83` parses the body itself **and reads `code`** (:89-111).
  - `ALREADY_SHARED` is treated as success: `router.refresh()` runs and nothing is shown (:100-103).
  - `NOT_ROOM_CREATOR` and `NOT_FOUND` show red text and refresh (:108-111).
  - Anything else shows red `role=alert` text (:176).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Room not found` | NOT_FOUND | publish:54 | publish:54 | GENUINE | USER | RP:100-103 status only |
| 403 | `Only the room creator can share this room` | NOT_ROOM_CREATOR | publish:57 | publish:57 | GENUINE | USER | RP:106-115 code; RP:118-124 code |
| 409 | `This room is already shared` | ALREADY_SHARED | publish:61 | publish:61 | ALREADY | USER | RP:126-132 code |
| 409 | `A shared room at this address already exists` | DUPLICATE_ROOM | publish:82 | publish:81-85 | GENUINE (a plain retry hits `ALREADY_SHARED` first) | USER | RP:134-157 code + exact prose |
| 404 | `Room not found` (after a 0-count write) | NOT_FOUND | publish:98 | publish:98 | GENUINE (race) | USER | none |
| 403 | `Only the room creator can share this room` (after a 0-count write) | NOT_ROOM_CREATOR | publish:100 | publish:100 | GENUINE; **unreachable today** (same `createdById` argument as §12) | USER | none |
| 409 | `This room is already shared` (after a 0-count write) | ALREADY_SHARED | publish:102 | publish:102 | ALREADY (concurrent duplicate) | USER | none |
| 404 | `Room not found` (re-read after the write) | NOT_FOUND | publish:106 | publish:106 | GENUINE (race) | USER | none |

**C.** A retry gets 409 `ALREADY_SHARED` (publish:60-61), and the client handles it as success.
**Out of scope:** 3.

## 15. POST /api/teacher-rooms

**A. Clients**
- `src/components/settings/room-settings-step.tsx:83` parses the body itself (:90-91), shows red `role=alert` text (:132) and never branches on `code`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Room not found` | — | tr:52 | tr:52 | GENUINE | USER | TR:351-358 status only |
| 403 | `Access denied` (someone else's private room) | — | tr:55 | tr:55 | GENUINE | DEV? (generic) | TR:340-349 status only |
| 409 | `Teacher-room link already exists` | DUPLICATE | tr:69 | tr:69 | ALREADY | DEV (names the `TeacherRoom` model) | TR:293-309 code only (**a plain identical retry**) |
| 409 | `Teacher-room link already exists` (P2002 on `(teacherId, roomId)`) | DUPLICATE | tr:96 | tr:96 | ALREADY (concurrent) | DEV | TR:707-745 code + exact prose |

**C.** A retry gets the first `DUPLICATE` row (tr:68-70). The client shows it as red text: `Teacher-room link already exists`.
**Out of scope:** 5.

## 16. PUT /api/teacher-rooms/[id]

**A. Clients**
- `src/components/settings/edit-room-form.tsx:105` parses the body itself (:116-117) and shows red text (:173).
- `src/components/settings/edit-teacher-room-form.tsx:79` parses the body itself (:86-87) and shows red `role=alert` text (:131).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Teacher-room not found` | — | tr/[id]:53 | tr/[id]:53 | GENUINE | DEV (model name) | none |
| 403 | `Access denied` | — | tr/[id]:56 | tr/[id]:56 | GENUINE | DEV? (generic) | TR:367-384 status only (a loop over the four methods) |

Not a row: the unscoped `teacherRoom.update` at tr/[id]:67 throws P2025 if the link is deleted after the read, and that falls through to `classifyApiError`'s 500.

**C.** A retry gets 200, idempotent (a plain update).
**Out of scope:** 6 (requireTeacher 3, parseBody 2, tr/[id]:64 `No valid fields to update` 400).

## 17. PATCH /api/teacher-rooms/[id]?state=archived|unarchived

**A. Clients**
- `src/components/settings/archive-room-button.tsx:21-24` reads the error with `readErrorMessage` (:39) and shows red `role=alert` text (:60). On success it calls `router.push`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Teacher-room not found` (`not_found`, room-archive.ts:131) | — | tr/[id]:115 | tr/[id]:115 | GENUINE | DEV (model name) | none |
| 403 | `Access denied` (`forbidden`, room-archive.ts:132) | — | tr/[id]:116 | tr/[id]:116 | GENUINE | DEV? (generic) | TR:367-384, TR:395-401 status only |
| 409 | `` `${subject} still ${verb} this room.` `` (`describeRoomBlockers`; subject built at room-archive.ts:115-118 and `plural()` :86-88; e.g. `1 unfinished class still uses this room.`) | ROOM_IN_USE (**inline literal**, not `ROOM_IN_USE_CODE`) | room-archive.ts:121 (reason set at :188 by the pre-count, or at :271 by the constraint catch) | tr/[id]:120 | GENUINE (archiving only) | USER | TR:480-486 code + exact prose |
| 409 | `This room is still in use.` (fallback when the constraint-catch re-count is zero) | ROOM_IN_USE | room-archive.ts:106 | tr/[id]:120 | GENUINE (race) | USER | none |

**C.** A retry gets 200 `{ action: 'unchanged' }`, idempotent (room-archive.ts:142-144).
**Out of scope:** 4 (requireTeacher 3, tr/[id]:87 `A state of archived or unarchived is required` 400).

## 18. DELETE /api/teacher-rooms/[id]

**A. Clients**
- `src/components/settings/unlink-room-button.tsx:23` reads the error with `readErrorMessage` (:27) and shows red `role=alert` text (:51). On success it calls `router.push`.

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Teacher-room not found` | — | tr/[id]:140 | tr/[id]:140 | ALREADY (plain retry: the link is gone) | DEV (model name) | none |
| 403 | `Access denied` | — | tr/[id]:143 | tr/[id]:143 | GENUINE | DEV? (generic) | TR:367-384 status only; TR:547-560 exact prose |
| 409 | `This room is still in use and cannot be deleted. Archive it instead.` | ROOM_IN_USE | room-deletion.ts:81-82 (code at :119) | tr/[id]:155 | GENUINE | USER (but it says "deleted" for an action the UI calls **Unlink**) | TR:529-539 `toContain('Archive it instead')`, no code; TR:619-642 exact prose + code; TR:644-663 exact prose + code |
| 409 | same message (FK backstop) | ROOM_IN_USE_RACE | room-deletion.ts:81-82 (code at :120) | tr/[id]:192 | GENUINE (race) | USER | **none** |

**C.** A retry gets 404 `Teacher-room not found`, shown as red text on the page the teacher is still on.
**Out of scope:** 3.

## 19. POST /api/announcements

**A. Clients**
- `src/components/class/send-announcement.tsx:34` parses the body itself, accepting a string or object `error` (:54-56), and shows red `role=alert` text (:129).
- On success it reads `duplicateSuppressed` and shows a neutral caption for a suppressed send (:75-78).

**B.**
| status | message | code | born at | relayed at | retry? | register | tests |
|---|---|---|---|---|---|---|---|
| 404 | `Class not found` | — | ann:31 | ann:31 | GENUINE | USER | AN:219-225 status only |
| 403 | `Not your class` | — | ann:33 | ann:33 | GENUINE | USER | AN:201-206 status only |
| 400 | `No students to notify` (every registrant is cancelled or muted) | — | ann:71 | ann:71 | GENUINE | USER | AN:208-217 status only |

**C.** Within `ANNOUNCEMENT_DEDUPE_WINDOW_MS` (2 min) a retry gets **200** with `duplicateSuppressed: true` (`announcements.ts:195-212`, ann:105), and the client shows a neutral caption. After the window it gets 201 and a new send.
**Out of scope:** 5.

---

## Summary

- **Total pairs: 19.**
  - Payments: 4 POST.
  - Registrations: POST, PUT, DELETE.
  - Waitlist: POST, DELETE, POST claim.
  - Rooms: POST, PUT, DELETE, POST publish.
  - Teacher-rooms: POST, PUT, PATCH, DELETE.
  - Announcements: POST.
- **Pairs with no client caller: 0.** Every pair has at least one `fetch` in `src/`.
- **Out-of-scope sites across the group:** 79 (5+3+3+3+6+5+2+5+2+5+5+6+3+3+5+6+4+3+5).

### In-scope rows: 95 — USER 56 · DEV 16 · DEV? 23

Per pair: 4, 4, 4, 5, 9, 6, 6, 6, 5, 6, 2, 8, 5, 8, 4, 2, 4, 4, 3.

**DEV (16):**
- POST /api/payments/[id]/paid — 409 — `Payment not found: ${paymentId}`
- POST /api/payments/[id]/paid — 409 — `Cannot mark payment as paid: current status is "${payment.status}". Must be "pending" or "overdue".`
- POST /api/payments/[id]/unpaid — 409 — `Payment not found: ${paymentId}`
- POST /api/payments/[id]/unpaid — 409 — `Cannot undo: current status is "${payment.status}". Must be "paid" or "not charged".`
- POST /api/payments/[id]/not-charged — 409 — `Payment not found: ${paymentId}`
- POST /api/payments/[id]/not-charged — 409 — `Cannot mark as not charged: current status is "${payment.status}". Must be "pending" or "overdue".`
- POST /api/payments/[id]/remind — 409 — `Payment not found: ${paymentId}`
- POST /api/payments/[id]/remind — 409 — `Cannot send a reminder: current status is "${payment.status}". Must be "pending" or "overdue".`
- POST /api/registrations — 409 — `Cannot register for a class with status "${classStatus}"`
- POST /api/waitlist — 409 — `Cannot join the waitlist for a class with status "${cls.status}"`
- POST /api/waitlist/claim — 409 — `Cannot claim a spot in a class with status "${cls.status}"`
- POST /api/teacher-rooms — 409 — `Teacher-room link already exists` (tr:69)
- POST /api/teacher-rooms — 409 — `Teacher-room link already exists` (tr:96)
- PUT /api/teacher-rooms/[id] — 404 — `Teacher-room not found`
- PATCH /api/teacher-rooms/[id] — 404 — `Teacher-room not found`
- DELETE /api/teacher-rooms/[id] — 404 — `Teacher-room not found`

**DEV? (23):**
- 11 × 403 `Access denied` (generic HTTP phrasing):
  - POST /api/payments/[id]/paid
  - POST /api/payments/[id]/unpaid
  - POST /api/payments/[id]/not-charged
  - POST /api/payments/[id]/remind
  - DELETE /api/registrations/[id]
  - DELETE /api/waitlist/[id] (wl/[id]:27)
  - DELETE /api/waitlist/[id] (wl/[id]:33)
  - POST /api/teacher-rooms
  - PUT /api/teacher-rooms/[id]
  - PATCH /api/teacher-rooms/[id]
  - DELETE /api/teacher-rooms/[id]
- POST /api/registrations — 403 — `Student is not in your roster`
- PUT /api/registrations/[id] — 404 — `Registration not found` (reg/[id]:102)
- PUT /api/registrations/[id] — 404 — `Registration not found` (reg/[id]:177)
- PUT /api/registrations/[id] — 409 — `Cannot record attendance on a cancelled registration`
- DELETE /api/registrations/[id] — 404 — `Registration not found`
- DELETE /api/registrations/[id] — 409 — `Cannot cancel a registration on a ${state} class`
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:241)
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:276)
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:301)
- DELETE /api/waitlist/[id] — 404 — `Waitlist entry not found` (wl/[id]:22)
- DELETE /api/waitlist/[id] — 404 — `Waitlist entry not found` (wl/[id]:50)
- POST /api/waitlist/claim — 409 — `The waitlist is frozen — the cancellation deadline has passed`

### Code vs no code: 20 rows with a code · 75 without

The rows with a code are all in rooms, publish and teacher-rooms: 2 + 2 + 2 + 8 + 2 + 2 + 2. **No service-born message in the group carries a code.**

Codes seen: `DUPLICATE_ROOM`, `NOW_SHARED`, `ROOM_IN_USE`, `ROOM_IN_USE_RACE`, `NOT_FOUND`, `NOT_ROOM_CREATOR`, `ALREADY_SHARED`, `DUPLICATE`.

### ALREADY (10)
- POST /api/payments/[id]/unpaid — 409 — `Cannot undo: current status is …`
- POST /api/payments/[id]/remind — 409 — `A reminder for this payment was just sent. Try again in a couple of minutes.`
- POST /api/registrations — 409 — `Student is already registered for this class`
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:276, concurrent)
- DELETE /api/rooms/[id] — 404 — `Room not found` (rooms/[id]:32)
- POST /api/rooms/[id]/publish — 409 — `This room is already shared` (publish:61)
- POST /api/rooms/[id]/publish — 409 — `This room is already shared` (publish:102)
- POST /api/teacher-rooms — 409 — `Teacher-room link already exists` (tr:69)
- POST /api/teacher-rooms — 409 — `Teacher-room link already exists` (tr:96)
- DELETE /api/teacher-rooms/[id] — 404 — `Teacher-room not found` (tr/[id]:140)

### BOTH (10)
- POST /api/payments/[id]/paid — 409 — `Cannot mark payment as paid: …` (retry → `paid`; genuine → `not_charged`)
- POST /api/payments/[id]/not-charged — 409 — `Cannot mark as not charged: …` (retry → `not_charged`; genuine → `paid`)
- POST /api/registrations — 409 — `Class is full` (the student's own booking took the last seat; `isFull` is checked before `existing`)
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:241)
- DELETE /api/registrations/[id] — 409 — `Registration is already cancelled` (reg/[id]:301)
- DELETE /api/waitlist/[id] — 409 — `That waitlist spot is no longer active — refresh to see the latest.`
- POST /api/waitlist/claim — 409 — `The spot has already been claimed` (the student's own claim took the last seat)
- POST /api/waitlist/claim — 409 — `You are not on the waitlist for this class` (the student's own claim, with seats remaining)
- POST /api/rooms — 409 — `A shared room at this address already exists` (DUPLICATE_ROOM)
- POST /api/rooms — 409 — `You already have a room at this address. Add a floor or room name to tell them apart.` (DUPLICATE_ROOM)

### GENUINE (75), of which GENUINE† (7)
The seven GENUINE† rows:
- the remind status message
- the registration status message
- `Cannot cancel a registration on a ${state} class`
- `The class still has open spots…`
- `You are already registered for this class` (waitlist)
- the claim status message
- `The waitlist is frozen…`

### Every code string, and where it is written
| code | written at |
|---|---|
| `DUPLICATE_ROOM` | `src/app/api/rooms/route.ts:128`; `src/app/api/rooms/[id]/route.ts:203`; `src/app/api/rooms/[id]/publish/route.ts:84` |
| `NOW_SHARED` | `src/app/api/rooms/[id]/route.ts:220` |
| `ROOM_IN_USE` | `src/services/room-deletion.ts:119` (`ROOM_IN_USE_CODE`, used at `rooms/[id]/route.ts:55` and `teacher-rooms/[id]/route.ts:155`); **inline literal** at `src/app/api/teacher-rooms/[id]/route.ts:120` |
| `ROOM_IN_USE_RACE` | `src/services/room-deletion.ts:120` (`ROOM_IN_USE_RACE_CODE`, used at `rooms/[id]/route.ts:109` and `teacher-rooms/[id]/route.ts:192`) |
| `NOT_FOUND` | `src/app/api/rooms/[id]/publish/route.ts:54`, `:98`, `:106` |
| `NOT_ROOM_CREATOR` | `src/app/api/rooms/[id]/publish/route.ts:57`, `:100` |
| `ALREADY_SHARED` | `src/app/api/rooms/[id]/publish/route.ts:61`, `:102` |
| `DUPLICATE` | `src/app/api/teacher-rooms/route.ts:69`, `:96` |

**Client-side code readers in the group: exactly one file.** `src/components/settings/share-room-button.tsx:100` reads `ALREADY_SHARED` and `:109` reads `NOT_ROOM_CREATOR` and `NOT_FOUND`. No client reads `DUPLICATE_ROOM`, `NOW_SHARED`, `ROOM_IN_USE`, `ROOM_IN_USE_RACE` or `DUPLICATE`.

Service reasons that routes drop instead of relaying as codes:
- `WaitlistJoinError.reason` and `WaitlistPromotionError.reason` (waitlist.ts:45-50, :61-65). `wl:64` and `wl/claim:34` relay only `err.message`.
- `removeFromWaitlist`'s `'NOT_FOUND' | 'NOT_WAITING'` (waitlist.ts:410), which is mapped to prose at wl/[id]:49-51.
- `ArchiveRoomResult.reason` (room-archive.ts:80-84).

### Surprises and contradictions
1. **Retries that answer with "someone else" wording.**
   - POST /api/registrations answers the student's own retried booking with `Class is full` when that booking took the last seat (reg:175-189 check order). The comment at `src/app/api/registrations/route.test.ts:391-392` says the retry "would be refused as already registered", which is true only when seats remain.
   - POST /api/waitlist/claim answers the student's own retried claim with `The spot has already been claimed`. **WA:268-278 pins exactly that**, as "a second claim on the same now-filled spot".
2. **The cooldown message invites a duplicate.** `A reminder for this payment was just sent. Try again in a couple of minutes.` is reached when the reminder *was* sent, and `send-reminder-button` shows it in red.
3. **Retried deletes answer 404 in red.**
   - DELETE /api/rooms/[id] answers `Room not found` and `delete-room-button.tsx` shows it in red.
   - DELETE /api/teacher-rooms/[id] answers `Teacher-room not found` and `unlink-room-button.tsx` shows it in red.
   - POST /api/teacher-rooms answers `Teacher-room link already exists` (DUPLICATE) and `room-settings-step.tsx` shows it in red.
   - The code exists in all these cases, but only `share-room-button` branches on one.
4. **Every payment refusal is status-only in integration tests.** The DEV prose is pinned only by service unit tests (PS) and by component tests.
   - Component tests mock server bodies that the server never sends:
     - `src/components/class/mark-unpaid-button.test.tsx:208,227` uses `Cannot undo: … Must be "paid".`; the service now says `… "paid" or "not charged".`
     - `src/components/class/outstanding-payment-row.test.tsx:414,517` uses a string-shaped `error` (`'Payment already marked paid'`).
     - `src/components/class/add-walk-in.test.tsx:204` uses `'Class is full.'` with status 400; the server sends 409 with no period.
   - These tests pin already-state refusals rendered as red `role=alert`.
5. `markPaymentOverdue` (payments.ts:116-137) has no non-test caller. Its DEV string at payments.ts:126, named in the dispatch, never reaches the wire. Its not-found string is at :121.
6. **Races and dead branches.**
   - `Payment not found: ${paymentId}` (payments.ts:99/162/197/267) reaches a client only in the race between the route's ownership read and the service call. It interpolates a UUID at status 409, where the route's own not-found is a 404.
   - The race-fallback 403s at `rooms/[id]/route.ts:222` and `publish/route.ts:100` are unreachable in current code, because nothing in `src/` writes `Room.createdById` after create (rooms:108).
7. **Untested codes.** No test asserts `ROOM_IN_USE_RACE` or `NOW_SHARED`.
8. **Inconsistent code source.** `teacher-rooms/[id]/route.ts:120` writes `'ROOM_IN_USE'` inline rather than using `ROOM_IN_USE_CODE`. DELETE /api/teacher-rooms/[id] also answers "cannot be deleted. Archive it instead." for the UI's **Unlink** action.
9. **500s where a 404 fits (fallback, not deliberate).** Unscoped `findUniqueOrThrow`/`update` calls reach `classifyApiError`'s P2025 → 500 `Internal server error`:
   - POST /api/waitlist/claim with an unknown or deleted `classId` (waitlist.ts:647, after `lockClassRow` finds nothing).
   - PUT /api/teacher-rooms/[id] (tr/[id]:67) and PATCH (room-archive.ts:235) if the link is deleted after the read.
10. **Deliberate reliance on `classifyApiError` fallbacks (not rows).**
    - POST /api/registrations lets an unmatched P2002 fall to the code-less 409 `Resource already exists` (reg:334-340).
    - Lock timeouts become 503 by design in these places:
      - POST /api/registrations: RA:693.
      - POST /api/waitlist and /claim: WA:705 and WA:731.
      - DELETE /api/waitlist/[id]: comment at waitlist.ts:428-430.
      - PATCH /api/teacher-rooms/[id]: comment at room-archive.ts:207-208.
11. **Wording mismatches.**
    - `Student is already registered for this class` is third person even on the student's own booking (booking-flow).
    - PUT attendance answers a `late_cancel → no_show` request with "You can mark them **attended** once the class has started."
12. **Background check.** Nothing in the background contradicts what I found:
    - `respondError` is at `api-utils.ts:35` and `classifyApiError` at `api-errors.ts:433`.
    - `readErrorMessage` and `readError` are at `client-errors.ts:7` and `:30`.
    - One addition: both client helpers also accept a string-shaped `error` body.
