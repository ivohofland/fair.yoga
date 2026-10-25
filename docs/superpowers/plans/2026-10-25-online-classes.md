# Online Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can make a class or a class template online: no room, room cost 0, an optional video link that only students with a live registration ever see. The link reaches them in the app and by email, and a notice goes out whenever it is added or changed.

**Architecture:** A `ClassFormat` enum (`in_person | online`) on `Class` and `ClassTemplate`, a nullable `teacherRoomId`, and a nullable `videoUrl`. One hand-authored shape CHECK per table ties each format to its columns. The existing room foreign keys are `MATCH SIMPLE`, so `*_live_needs_open_room` is left untouched. Readers never touch `teacherRoom` directly any more. They consume one projection (`classLocation`), and a separate public projection type has no `videoUrl` member at all, so a leak onto a public page is a compile error. Emails never store the link. A link-bearing notification's email reads the class's current link at send time, the way `studentPaymentEmailGuidance` already reads pay guidance at send time.

**Tech Stack:** Next.js 16 App Router, Prisma + PostgreSQL, zod, Vitest (projects `unit`, `unit-sweeps`, `components`, `integration`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-25-online-classes-design.md`

## Global Constraints

- TypeScript `strict`, no `any`. Every compile-time pin this plan touches is satisfied by **classifying** the new field or member, never by widening or deleting a pin.
- Migrations go through `pnpm exec prisma migrate dev --name <name>`, never `db push`. CHECKs are hand-added to the generated SQL, following `prisma/migrations/20260721061528_student_claim_link_check/`. An applied migration is never edited, comments included. Prose about the migration goes in `docs/data-model.md`.
- `*_live_needs_open_room` and both `*_teacherRoomId_roomArchived_fkey` constraints are **not** modified.
- `videoUrl` is **never** a member of `LOCKED_FIELDS`. `format` is fixed at creation on a `Class` (the class edit body accepts no `format` and no room, as it accepts no room today). It is editable on a `ClassTemplate`.
- A template is a stamp (#194, #284). No code path writes `format`, `videoUrl` or the room onto an existing `Class` from its template.
- The link is **never** written into a `Notification`'s `title` or `body`, and never into a push payload.
- "Live registration" means `status in ACTIVE_REGISTRATION_STATUSES` (`src/lib/registration-status.ts`). Waitlist entries are never live registrations.
- Copy, verbatim (wording may be polished in review, but not changed in meaning):
  - format choice labels: `In a room` / `Online`;
  - public word for the location: `Online`;
  - video link field label: `Video link (optional)`;
  - template link hint: `Every class from this template gets this link. Use one that works each week, like a personal meeting room. If you make a new link for each class, leave this empty and add it to each class instead.`;
  - one-off class link hint: `Only students who have booked see this link.`;
  - template notice when the link changed: `Classes already on your schedule keep their current link.`;
  - teacher nudge on class detail: `No video link yet`, in the attention (gold) style;
  - student, link pending: `Your teacher will share the video link before class.`;
  - link button, in the app and in email: `Join the class`;
  - link notice title: `Video link for {classType}`. Body: `{classType} on {day} at {time}: the video link is on your booking.`;
  - teacher class reminder, appended when an online class has no link: ` No video link yet — add one so your students can join.`
- Comment discipline (CLAUDE.md). No counts or rosters in comments, and a comment annotates the code it sits on.
- Never kill or restart the dev server on :3000. Integration tests need it live (`.claude/skills/verify/`).

## Review Focus

1. **A template switched between formats.** Going online → in person with a link set, or in person → online with a room cost set, must be refused or normalised by the request and merged-row checks. It must never reach the CHECK and come back as a 500. Pinned in Task 3.
2. **The link in a public page's RSC payload.** Hiding it in the rendered HTML isn't enough. The serialised props of `/[slug]` and `/[slug]/book/[classId]` must not contain the URL string, even for a signed-in booked student. Pinned in Task 5.
3. **A waitlisted student.** Their `spot_available` email has no link, and their `waitlist_promoted` email does. Pinned in Task 5.
4. **A student who cancels between the notice and the email sweep** gets the email without a link (or no link button). The live-registration check runs at send time. Pinned in Task 5.
5. **An online class and the room services.** Archiving, deleting or switching a room must neither count nor move an online class or template. Pinned in Task 1.

## Task order

The order is load-bearing:
- Task 1 must land first, because every later task consumes its projection and its columns.
- Task 2 produces `previousVideoUrl`, which Task 6 consumes.
- Task 5 creates `VIDEO_LINK_EMAIL_TYPES`, which Task 6 adds its member to.
- Tasks 3 and 4 may swap.

---

### Task 1: The shape: enum, columns, CHECKs, projection, link parser, stamp, and every room reader

The tree must compile and the suite must stay green at the end of this task. Making `teacherRoomId` nullable breaks every `teacherRoom` dereference, so converting them belongs here.

**Files:**
- Modify: `prisma/schema.prisma` (`enum ClassFormat`, models `Class` and `ClassTemplate`; extend both MIRRORS docblocks with one sentence each saying a roomless row holds `roomArchived = false` by `*_format_shape`)
- Create: `prisma/migrations/<timestamp>_online_class_format/migration.sql` (generated, then the two CHECKs appended)
- Create: `src/lib/class-location.ts`
- Modify: `src/lib/payment-link.ts` (extract the https rules into `parseHttpsLink`; `parsePaymentLink` delegates and keeps its exact behaviour and messages)
- Modify: `src/lib/input-bounds.ts` (`VIDEO_URL_MAX = 500`)
- Modify: `src/services/class-generator.ts` (`createChildren`: stamp `format`, `videoUrl`)
- Modify: every `teacherRoom` dereference on a class or template. Re-derive the set with `grep -rnE "\.teacherRoom\.(room|isArchived)" src | grep -v test`. At `64ac841c` it is `components/settings/template-list.tsx`, `components/schedule/class-card.tsx`, `components/class/class-info.tsx`, `(student)/bookings/page.tsx`, `(public)/[slug]/page.tsx`, `(public)/[slug]/book/[classId]/page.tsx`, and `services/class-lifecycle.ts` (the publish refusal, `cls.teacherRoom.isArchived`). Also every prop type declared as `teacherRoom: TeacherRoom & { room: Room }`.
- Modify: `docs/data-model.md` (Class and ClassTemplate tables, plus a Design Notes paragraph on `*_format_shape` and why the room FKs needed no change: `MATCH SIMPLE`)
- Test: `src/services/class-room-constraint.test.ts`, `src/services/template-room-constraint.test.ts` (extend), `src/lib/class-location.test.ts` (create), `src/lib/payment-link.test.ts` (extend), the existing `class-generator` / `entry-generation` tests (extend), and one room-archive, room-deletion and room-switch test each with an online row present.

**Interfaces:**
- Produces:
  - Prisma `ClassFormat`, `Class.format`, `Class.videoUrl: string | null`, `Class.teacherRoomId: string | null`, and the same three on `ClassTemplate`.
  - `src/lib/class-location.ts`:
    ```ts
    export type RoomPlace = { roomName: string | null; venueName: string };
    export type ClassLocation =
      | { format: 'in_person'; room: RoomPlace; roomArchived: boolean }
      | { format: 'online'; videoUrl: string | null };
    export type PublicClassLocation =
      | { format: 'in_person'; room: RoomPlace }
      | { format: 'online' };
    export const classLocationSelect; // Prisma select: format, videoUrl, teacherRoom { isArchived, room { roomName, venueName } }
    export function classLocation(row: LocationRow): ClassLocation;      // exhaustive switch, `never` default; throws on a row violating *_format_shape
    export function publicClassLocation(row: LocationRow): PublicClassLocation; // never reads videoUrl
    export function locationLabel(loc: ClassLocation | PublicClassLocation): string; // formatRoomLocation for a room, 'Online' otherwise
    ```
    Match `RoomPlace`'s field types to what `formatRoomLocation(roomName, venueName)` accepts (`src/lib/format.ts:7`). Public and pre-booking pages accept only `PublicClassLocation`.
  - `src/lib/payment-link.ts`: `parseHttpsLink(raw: string, max: number): ({ ok: true; url: string; host: string }) | { ok: false; error: PaymentLinkFailure }`, plus `VIDEO_LINK_MESSAGES` (same keys, video wording, e.g. `required` is never shown because the field is optional).

- [ ] **Step 1: Write the failing constraint tests.** Extend `class-room-constraint.test.ts` and `template-room-constraint.test.ts` with raw inserts or updates proving each arm of `*_format_shape`, asserting SQLSTATE `23514` and the constraint name:
  - `in_person` with `teacherRoomId` NULL is refused;
  - `in_person` with a `videoUrl` is refused;
  - `online` with a `teacherRoomId` is refused;
  - `online` with `roomCost` 10 is refused;
  - `online` with `roomArchived = true` is refused;
  - `online`, no room, `roomCost` 0, `videoUrl` NULL is **accepted**;
  - `online` with a `videoUrl` is accepted;
  - a live, published online class is accepted (so `*_live_needs_open_room` does not refuse a roomless row).
- [ ] **Step 2: Run them; expect failure** (column `format` does not exist): `pnpm exec vitest run --project unit src/services/class-room-constraint.test.ts src/services/template-room-constraint.test.ts`. If these files sit in a different vitest project, run them under that project instead; the project is decided by `vitest.config.ts`.
- [ ] **Step 3: Schema and migration.** Add `enum ClassFormat { in_person online }`. On both models add `format ClassFormat @default(in_person)` and `videoUrl String? @db.Text`, and make `teacherRoomId String?` and the relation `TeacherRoom?`. Run `pnpm exec prisma migrate dev --name online_class_format --create-only`, then append:
  ```sql
  ALTER TABLE "Class" ADD CONSTRAINT "Class_format_shape" CHECK (
    ("format" = 'in_person' AND "teacherRoomId" IS NOT NULL AND "videoUrl" IS NULL)
    OR ("format" = 'online' AND "teacherRoomId" IS NULL AND NOT "roomArchived" AND "roomCost" = 0));
  ```
  Add the same CHECK as `ClassTemplate_format_shape`. Then run `pnpm exec prisma migrate dev`.
- [ ] **Step 4: Prove each CHECK bites.** Run Step 1 green. Then, in a `psql` session inside `fairyoga-db-1`, for each refused arm: `BEGIN; ALTER TABLE "Class" DROP CONSTRAINT "Class_format_shape";`, run that arm's violating `INSERT`/`UPDATE` and see it **succeed**, then `ROLLBACK;`. Do the same for `ClassTemplate`. That shows the CHECK, not some other constraint, is what refuses each one. Record the statements and outputs for the PR body. Nothing persists, because every drop is rolled back.
- [ ] **Step 5: Projection tests, then projection.** `class-location.test.ts`:
  - each format maps to its union member;
  - `publicClassLocation` of an online row with a link returns exactly `{ format: 'online' }` (`toStrictEqual`);
  - `classLocation` throws on an `in_person` row with a null room;
  - `locationLabel` returns `'Online'` and the `formatRoomLocation` string.
  
  Implement `class-location.ts`.
- [ ] **Step 6: Link parser tests, then the extraction.** In `payment-link.test.ts`:
  - `parseHttpsLink('https://us02web.zoom.us/j/123?pwd=abc', VIDEO_URL_MAX)` is ok and keeps the query;
  - `http://` gives `not_https`;
  - userinfo gives `has_userinfo`;
  - `VIDEO_URL_MAX + 1` characters gives `too_long`;
  - every existing `parsePaymentLink` test still passes unchanged.
- [ ] **Step 7: Stamp test, then stamp.** Extend the generator test: an online template with a link generates online classes with that link, `teacherRoomId` null and `roomCost` 0. A template whose link is later changed leaves already-generated classes' `videoUrl` unchanged (the stamp rule). Then add `format` and `videoUrl` to `createChildren`.
- [ ] **Step 8: Convert every reader** to `classLocation` / `publicClassLocation` / `locationLabel`. The publish refusal reads `loc.format === 'in_person' && loc.roomArchived`. Public `/[slug]` and the booking page are typed on `PublicClassLocation` only.
- [ ] **Step 9: Room-service tests.** With an online class and an online template owned by the same teacher present, one test each:
  - `setTeacherRoomArchived` archives a room the online rows don't hold;
  - room deletion counts zero blockers from them;
  - `switchToSharedRoom` leaves them untouched (same `teacherRoomId` null, same `updatedAt`).
  
  If any service needs a code change, make it here and say so in the report.
- [ ] **Step 10: Run** `pnpm exec tsc --noEmit` and the touched unit and integration files. Expect them green.
- [ ] **Step 11: Commit** `feat(#911): ClassFormat, shape CHECKs, location projection, stamp` with exact paths. Quote any path with parentheses.

---

### Task 2: Class create and edit API

**Files:**
- Modify: `src/lib/schemas.ts` (`createClassSchema`, `updateClassSchema`)
- Modify: `src/app/api/classes/route.ts` (POST)
- Modify: `src/services/class-lifecycle.ts` (`updateClass`, `TeacherEditableClassField`, `UpdateClassResult`)
- Modify: `src/app/api/classes/[id]/route.ts` (PUT: map the new refusal; return `previousVideoUrl` to the caller for Task 6)
- Test: `tests/integration/classes-api.test.ts`

**Interfaces:**
- Consumes: `parseHttpsLink`, `VIDEO_URL_MAX` (Task 1).
- Produces:
  - `createClassSchema` becomes a discriminated union on `format` (default `in_person` when the key is absent, so old clients still work). The `in_person` arm keeps every field it has today. The `online` arm has no `teacherRoomId`, has `videoUrl?: string | null`, and accepts `roomCost` only as `0` or absent.
  - `updateClassSchema` gains `videoUrl?: string | null`.
  - `UpdateClassResult` gains `{ ok: false; reason: 'video_url_on_room_class' }`. On success the result carries `previousVideoUrl: string | null` beside `cls`.

- [ ] **Step 1: Failing integration tests.**
  - POST an online class with a link: 201, stored `format: 'online'`, `teacherRoomId: null`, `roomCost: '0'`.
  - POST online without a link: 201.
  - POST with no `format` key: an in-person class, as today.
  - POST online with `teacherRoomId`: 400.
  - POST online with `roomCost: 15`: 400.
  - POST in person with `videoUrl`: 400.
  - POST online with `http://` link: 400.
  - PUT `videoUrl` on an online booked class: 200, and the value is stored (not locked).
  - PUT `videoUrl` on an `in_progress` online class: 200.
  - PUT `videoUrl` on a completed class: 409, existing terminal code.
  - PUT `videoUrl` on an in-person class: refused, asserting its code.
  - PUT `{ format: 'online' }`: 400 (strict schema).
  - PUT `videoUrl: null` clears it.
- [ ] **Step 2: Run them; expect failure**: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts`.
- [ ] **Step 3: Implement.** For `video_url_on_room_class`, follow the error-response rules in `docs/technical-architecture.md` (The Services Layer, Error responses). If it is a 409 it needs a registered code in `src/lib/api-error-codes.ts`. If it is better expressed as a 400 field error the way `invalid_economics` is, use that, and say which in the report. Normalise the stored URL to `parseHttpsLink`'s `url`.
- [ ] **Step 4: Run green**, plus `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(#911): create and edit online classes`.

---

### Task 3: Template create and edit API

**Files:**
- Modify: `src/lib/schemas.ts` (`createClassTemplateSchema`, `updateClassTemplateSchema`)
- Modify: `src/services/class-template-lifecycle.ts` (`createClassTemplate`, `updateClassTemplate`, `CLASS_FAMILY.updateChild`)
- Modify: `src/services/rule-lifecycle.ts` (`RoomDescriptor` and `updateRule`'s room validation: an online template has no room to validate)
- Modify: `src/app/api/class-templates/route.ts`, `src/app/api/class-templates/[id]/route.ts` (including the resume refusal that reads `roomArchived`)
- Modify: `src/components/settings/template-action-messages.ts` (the "keep their current link" notice. If this module has a `satisfies` tether such as `COUNT_KEYS`, classify the new member there.)
- Test: `tests/integration/class-templates-api.test.ts`, `src/components/settings/template-action-messages.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2's schema shapes. Reuse the same discriminated-union helper for the create arm instead of writing a second.
- Produces:
  - `updateClassTemplateSchema` gains `format?`, `videoUrl?: string | null`, and `teacherRoomId?: string | null`.
  - The **merged row** (stored row + patch) is checked in the service against the shape rules before the write: in person needs a room and no link; online needs no room and room cost 0. A violation answers a field error (400), never a `23514`.
  - The edit response carries `linkChangedWithScheduledClasses: boolean`: true when `videoUrl` changed and at least one non-terminal future class from this template exists.

- [ ] **Step 1: Failing tests.**
  - Create an online template with a link: 201.
  - Edit it to in person with a room but without clearing `videoUrl`: 400, not 500.
  - Edit it to in person sending `{ format: 'in_person', teacherRoomId, videoUrl: null, roomCost }`: 200.
  - In person → online sending `{ format: 'online', teacherRoomId: null }` while the stored room cost is 20: 400 naming `roomCost`.
  - The same with `roomCost: 0`: 200.
  - Changing `videoUrl` with generated future classes present: `linkChangedWithScheduledClasses: true`, and those classes keep their old link.
  - Changing `description` only: false.
  - Resuming a paused online template is not refused by the room-archive resume check.
  - `template-action-messages` renders the copy from Global Constraints.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, plus `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(#911): online class templates`.

---

### Task 4: Teacher forms and class detail

**Files:**
- Modify: `src/app/(teacher)/class/new/new-class-form.tsx`
- Modify: `src/components/settings/template-form.tsx`
- Modify: `src/components/class/class-edit-form.tsx` (and the page that builds `ClassEditInitial`): a `Video link (optional)` field for online classes only
- Modify: `src/components/class/class-info.tsx` (the `No video link yet` nudge, and the link itself shown to the teacher)
- Modify: `src/components/class/pricing-preview.tsx`, `src/components/class/pricing-breakdown.tsx`, `src/components/landing/pricing-preview-result.tsx` if it receives a class (find each with `grep -rn "roomCost" src/components`): omit the room line when the class is online
- Test: the components tests beside each form (`new-class-form.test.tsx`, `template-form.test.tsx`, `class-edit-form.test.tsx`, `class-info` tests)

**Interfaces:**
- Consumes: the request shapes from Tasks 2 and 3, `ClassLocation` (Task 1).

- [ ] **Step 1: Failing component tests.**
  - New-class form, choosing `Online`:
    - the room picker and room cost field are gone;
    - `Video link (optional)` with the one-off hint is shown;
    - the POST payload is `format: 'online'`, has no `teacherRoomId` and has `roomCost: 0`;
    - the max-students validation no longer clamps to room capacity.
  - Template form:
    - the same, with the template hint verbatim;
    - an edit switching online → in person sends `videoUrl: null`;
    - an edit switching in person → online sends `teacherRoomId: null, roomCost: 0`.
  - Edit form: the link field appears only for an online class and sends `videoUrl` only when changed (the #910 "send only a change" pattern, `64ac841c`).
  - Class info: an online class without a link shows `No video link yet`, and with one shows the link.
  - Pricing breakdown: no room line for an online class.
- [ ] **Step 2: Run; expect failure**: `pnpm exec vitest run --project components <files>`.
- [ ] **Step 3: Implement.** Follow `docs/design-brief.md` for the choice control. Use an existing segmented or radio pattern in the codebase if there is one; otherwise two radio rows at ≥44px. Add no new component library. Rephrase the max-students copy for online so it doesn't mention the room.
- [ ] **Step 4: Run green.**
- [ ] **Step 5: Commit** `feat(#911): Room / Online in the class and template forms`.

---

### Task 5: The link for students: bookings, emails, reminders

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx` (`Join the class` button for an online class with a link and a live registration, or the pending copy when no link has been set yet)
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx` (`Online` only; a signed-in booked student is pointed to `/bookings`)
- Modify: `src/lib/email-templates.ts` (`NotificationEmailInput.videoLink?: string | null`; render a `Join the class` button with the **external** href, not `baseUrl`-prefixed, for the link-bearing types)
- Create: `src/services/video-link-for-email.ts` (`videoLinkForEmail`)
- Modify: `src/services/email-fallback.ts` (resolve `videoLink` at send time, beside `studentPaymentEmailGuidance`)
- Modify: `src/services/class-reminders.ts` (student reminder email carries the link, resolved at send time; teacher reminder body gets the no-link sentence for an online class without a link)
- Modify: `src/lib/notification-links.ts` (link-bearing types on an online class open `/bookings`)
- Modify: the writers of `booking_confirmed`, `waitlist_promoted` and `walk_in_added` only if their body needs the pending sentence. Find them with `grep -rn "type: 'booking_confirmed'\|type: 'waitlist_promoted'\|type: 'walk_in_added'" src`.
- Test: `src/services/video-link-for-email.test.ts` (create), `src/lib/email-templates.test.ts`, `src/services/email-fallback.test.ts`, `src/services/class-reminders.test.ts`, `tests/integration/bookings-page.test.ts`, and a new `tests/integration/online-class-link-privacy.test.ts`

**Interfaces:**
- Consumes: `classLocation`, `publicClassLocation` (Task 1).
- Produces:
  ```ts
  export const VIDEO_LINK_EMAIL_TYPES: ReadonlySet<NotificationType>; // booking_confirmed, waitlist_promoted, walk_in_added, class_reminder, + Task 6's type
  export async function videoLinkForEmail(
    db: PrismaClient,
    n: { recipientType: string; recipientId: string; type: NotificationType; relatedClassId: string | null },
  ): Promise<string | null>; // null unless: student recipient, type in the set, class online with a link, class not terminal, recipient holds a live registration on it
  ```
  Tether `VIDEO_LINK_EMAIL_TYPES` to `NotificationType` the way the policy sets in `src/services/notification-policy.ts` are, if they are. Otherwise a test iterates the enum and asserts each member's classification.

- [ ] **Step 1: Failing tests.** `videoLinkForEmail` returns:
  - the link for a registered student;
  - null for a waitlisted student;
  - null for a `cancelled` registration;
  - null for a teacher recipient;
  - null for `spot_available`;
  - null for a completed class;
  - null for an in-person class;
  - the **current** link after the class's link changed since the notification was written.

  Email rendering: an external `Join the class` button whose href is exactly the link, and no button when `videoLink` is null.

  Reminders:
  - the student reminder email contains the link while the inbox row body does not;
  - the teacher reminder body for an online class without a link ends with the no-link sentence.

  `online-class-link-privacy.test.ts` (integration): with a distinctive link (`https://example.invalid/online-911-<random>`), fetch:
  - `/{slug}` anonymous;
  - `/{slug}/book/{classId}` anonymous;
  - the booking page signed in as a registered student;
  - the booking page signed in as a waitlisted student.

  Each response body, RSC payload included, must **not** contain the string. `/bookings` for the registered student **does** contain it, and for the waitlisted student does not.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Prove the privacy guard bites.** Temporarily pass `classLocation` instead of `publicClassLocation` on the booking page with a cast. Confirm `tsc` errors without the cast and the privacy test fails with it. Record both outputs, restore, re-run green.
- [ ] **Step 5: Run green**, plus `pnpm exec tsc --noEmit`.
- [ ] **Step 6: Commit** `feat(#911): the video link reaches booked students`.

---

### Task 6: The link notice

**Files:**
- Modify: `prisma/schema.prisma` (`NotificationType` gains `video_link_updated`) and a migration `--name video_link_notification`
- Modify: `src/services/notification-policy.ts` (`ESSENTIAL_NOTIFICATION_TYPES`, `IMMEDIATE_EMAIL_TYPES`, and every other `satisfies` / exhaustive classification the compiler now demands)
- Modify: the push group mapping (find with `grep -rln "NotificationType" src/lib/push`): a booking-group member, no money line
- Modify: `src/lib/email-templates.ts` (`STUDENT_INTROS`, `STUDENT_ACTION_LINKS` → `/bookings`)
- Create: `src/services/video-link-notice.ts`
- Modify: `src/app/api/classes/[id]/route.ts` (call it after a successful PUT)
- Test: `src/services/video-link-notice.test.ts`, `tests/integration/classes-api.test.ts`, `src/services/notification-policy.test.ts`

**Interfaces:**
- Consumes: `previousVideoUrl` from `updateClass` (Task 2), `VIDEO_LINK_EMAIL_TYPES` (Task 5; add the new member).
- Produces: `notifyVideoLinkChanged(db: PrismaClient, input: { classId: string; previous: string | null; next: string | null }): Promise<number>`. It sends nothing when `next` is null or equal to `previous`. Otherwise it creates one `video_link_updated` notification per student with a live registration (via `createBulkNotifications`), with the title and body from Global Constraints and no URL in either, and returns the count. Whether it is awaited or a `FireAndForget` follows `docs/technical-architecture.md` (The Services Layer → Work that must not be awaited). The PUT response must not wait on, or reveal, delivery.

- [ ] **Step 1: Failing tests.**
  - Null → link: 2 registered students notified; the waitlisted one and a cancelled one are not.
  - Link → other link: notified.
  - Link → same link: 0.
  - Link → null: 0.
  - The body contains no `https://`.
  - The policy test classifies `video_link_updated` as essential and immediate.
  - Integration: PUT a new link on a booked online class, then rows exist for the registered students only.
  - Two quick PUTs give two rows, and the email of each (via `videoLinkForEmail`) carries the second link.
- [ ] **Step 2: Run; expect failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run green**, plus `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(#911): notify booked students when the video link changes`.

---

### Task 7: Docs and the whole branch

**Files:**
- Modify: `CLAUDE.md` (Data Model: one bullet for `ClassFormat` / `*_format_shape` / the link's visibility, pointing at the spec. Class Lifecycle: format fixed at creation on a class and `videoUrl` not locked.)
- Modify: `docs/data-model.md` (`video_link_updated`; whatever Task 1 did not already cover)
- Modify: `docs/technical-architecture.md` only if Task 6's delivery shape is a new instance of a rule it documents

- [ ] **Step 1:** Run `grep -rn "teacherRoomId" docs CLAUDE.md` and `grep -rn "always has a room\|every class has a room" docs src`. Give each hit a verdict and fix any claim now false.
- [ ] **Step 2:** Run `pnpm run verify` (needs :3000 live). Expect green. Record the per-project counts for the PR body.
- [ ] **Step 3:** Run `pnpm exec prisma validate`, `pnpm exec prisma migrate status` and `pnpm run build`. Expect them clean. `build` catches a server-only import leaking into a client form.
- [ ] **Step 4:** Drive it once in the running app with the `verify` skill:
  - create an online one-off with a link, then book it as a student;
  - see the link under `/bookings` and not on the booking page;
  - change the link, and see the notice in the student's inbox.
- [ ] **Step 5: Commit** `docs(#911): online classes in CLAUDE.md and the data model`.
