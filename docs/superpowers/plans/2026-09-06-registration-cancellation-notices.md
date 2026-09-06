# Registration Cancellation Notices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every way a registration can end tells the student it ended, with copy distinct to which way it was.

**Architecture:** Two new `NotificationType` values carry the split the delivery policy needs — `booking_cancelled` for a student ending their own registration (not essential, like the `booking_confirmed` it undoes) and `booking_removed` for a teacher ending it for them (essential, like `class_cancelled`). `DELETE /api/registrations/[id]` then sends exactly one notification per outcome, chosen by the `isStudent` flag it already computes for authorization.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (unit + integration against the dev server on `:3000`).

**Spec:** `docs/superpowers/specs/2026-09-06-registration-cancellation-notices-design.md`

## Global Constraints

- **Task order is load-bearing.** Task 2 references enum values that do not exist until Task 1 lands. Building Task 2 first fails to typecheck for reasons unrelated to its own work.
- **Every cancellation notice names the class — type, day, time.** #200's rule, applied to all three bodies here. Rendering is `formatDayHeader` (`src/lib/format.ts`) and `timeToHHmm` (`src/lib/time-of-day.ts`); `startTime` is a `@db.Time` column and arrives as a `Date`, so it is never interpolated raw.
- **Recipient is the student, always.** No teacher notification is added on any path. This is a decision, not an omission — Task 2 pins it with a test.
- **Copy, verbatim** (the three bodies, where `{class}` is `{classType} on {formatDayHeader(date)} at {timeToHHmm(startTime)}`):
  - self, on time: `Your booking for {class} is cancelled. You won't be charged for it.`
  - self, late: `Your booking for {class} is cancelled. It was past the cancellation deadline, so this class is still charged.`
  - by teacher: `Your teacher cancelled your booking for {class}. You won't be charged for it.`
- **Titles:** `Booking cancelled` for both self-cancels, `Booking cancelled by your teacher` for the removal.
- **Never edit an applied migration**, comment-only edits included — the checksum changes while `prisma migrate status` compares names, so nothing catches it until the next `prisma migrate dev` demands a reset.
- **Never `git add -A` or `git add .`** — stage exact paths.
- Run `npm run verify` before pushing (typecheck, lint, and every vitest project; needs the app live on `:3000`).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | `NotificationType` gains 2 values (10 → 12) | 1 |
| `prisma/migrations/<ts>_registration_cancellation_notices/migration.sql` | `ALTER TYPE … ADD VALUE` ×2 | 1 |
| `src/services/notification-policy.ts` | `booking_removed` joins the essential set (4 → 5); `booking_cancelled` deliberately stays out | 1 |
| `src/services/notification-policy.test.ts` | Pins the membership and the split | 1 |
| `src/lib/email-templates.ts` | `STUDENT_INTROS` is a **total** `Record<NotificationType, string>` — both values need a line or the build fails | 1 |
| `docs/data-model.md:495` | The prose type list, already stale at 8 of 10, brought current at 12 | 1 |
| `src/app/api/registrations/[id]/route.ts` | Sends one notification per cancellation outcome | 2 |
| `tests/integration/registrations-api.test.ts` | Four tests: three outcomes plus the no-teacher-notice pin | 2 |

---

### Task 1: The vocabulary and its delivery policy

Everything that must land together for the repo to stay green: the enum, its
migration, the essentiality split, the fallback-email intros the total Record
demands, and the doc line the enum change invalidates. No route behaviour
changes in this task — nothing yet sends either type.

**Files:**
- Modify: `prisma/schema.prisma` (the `NotificationType` enum, ~line 85)
- Create: `prisma/migrations/<timestamp>_registration_cancellation_notices/migration.sql` (generated)
- Modify: `src/services/notification-policy.ts:16-21`
- Modify: `src/lib/email-templates.ts:47-58`
- Modify: `docs/data-model.md:495`
- Test: `src/services/notification-policy.test.ts:12-27`, `:67-76`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the string literals `'booking_cancelled'` and `'booking_removed'`, both members of the Prisma-generated `NotificationType` union, which Task 2 passes to `createNotification`. `isEssential('booking_removed') === true`; `isEssential('booking_cancelled') === false`.

- [ ] **Step 1: Write the failing tests**

In `src/services/notification-policy.test.ts`, update the existing exact-membership assertion (it currently lists four types and will otherwise fail once the set grows — that failure is the tether working, not a regression):

```ts
describe('essential types', () => {
  it('covers exactly the booking-critical types', () => {
    expect([...ESSENTIAL_NOTIFICATION_TYPES].sort()).toEqual([
      'booking_removed',
      'class_cancelled',
      'payment_request',
      'spot_available',
      'waitlist_promoted',
    ]);
  });

  it('classifies announcements and reminders as optional', () => {
    expect(isEssential('announcement')).toBe(false);
    expect(isEssential('reminder')).toBe(false);
    expect(isEssential('class_cancelled')).toBe(true);
  });

  // The two cancellation types differ on exactly this, and nothing else
  // distinguishes them at the policy layer. A future edit that "tidies" the
  // pair into agreement has to delete this test to do it.
  it('splits the cancellation pair: a removal is essential, a self-cancel is not', () => {
    expect(isEssential('booking_removed')).toBe(true);
    expect(isEssential('booking_cancelled')).toBe(false);
  });
});
```

And in the `shouldEmailStudent` block, append:

```ts
  it('mails a teacher-removed booking past the opt-out, but not a self-cancel', () => {
    expect(shouldEmailStudent('booking_removed', false)).toBe(true);
    expect(shouldEmailStudent('booking_cancelled', false)).toBe(false);
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/services/notification-policy.test.ts`

Expected: FAIL. The membership test reports the received array missing
`booking_removed`; the split test reports `isEssential('booking_removed')`
returned `false`. (The two new literals are not yet in the `NotificationType`
union, so TypeScript would also object — vitest strips types without checking,
so the run still produces the assertion failures above.)

- [ ] **Step 3: Add the enum values**

In `prisma/schema.prisma`, the `NotificationType` enum, placing the pair beside
the booking type they relate to:

```prisma
enum NotificationType {
  booking_confirmed
  booking_cancelled
  booking_removed
  class_cancelled
  payment_received
  payment_request
  waitlist_promoted
  spot_available
  reminder
  missed_you
  announcement
  teacher_invitation
}
```

Order in this file is cosmetic and need not match the database's own value
order: `payment_request` sits fourth here while having been appended by
`ALTER TYPE … ADD VALUE` in `20260717204036_add_payment_request_notification`,
and the drift check has been green ever since.

- [ ] **Step 4: Generate the migration**

Run: `npx prisma migrate dev --name registration_cancellation_notices`

Expected: a new `prisma/migrations/<timestamp>_registration_cancellation_notices/migration.sql`
containing the two `ALTER TYPE "NotificationType" ADD VALUE …` statements, applied
to the dev database, with the Prisma client regenerated. Neither value is
consumed by a statement in its own migration, so the Postgres restriction on
using a new enum value inside the transaction that added it does not apply.

Read the generated file and confirm it contains exactly the two `ADD VALUE`
statements and nothing else. If it proposes anything destructive, stop and
report — an unrelated drift is in the dev database, not in this change.

- [ ] **Step 5: Make the policy split real**

In `src/services/notification-policy.ts`:

```ts
export const ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'class_cancelled',
  // Someone else ended the booking, so the student may otherwise turn up to a
  // class they believe they are in — the same reason `class_cancelled` is
  // here. Its sibling `booking_cancelled` is deliberately absent: that one is
  // the student's own cancellation coming back to them, and a receipt should
  // not be louder than the `booking_confirmed` it undoes, which is also
  // absent.
  'booking_removed',
  'waitlist_promoted',
  'spot_available',
  'payment_request',
]);
```

- [ ] **Step 6: Give both types a fallback-email intro**

`STUDENT_INTROS` in `src/lib/email-templates.ts` is
`Record<NotificationType, string>` — total, so this is required for the build,
not optional polish. Add the two entries beside `booking_confirmed`:

```ts
const STUDENT_INTROS: Record<NotificationType, string> = {
  booking_confirmed: 'Your booking is confirmed.',
  booking_cancelled: 'Your booking was cancelled.',
  booking_removed: 'Your teacher cancelled your booking.',
  class_cancelled: 'A class was cancelled.',
  payment_received: 'A payment was received.',
  payment_request: 'A class has been priced — here is your share.',
  waitlist_promoted: 'Good news from the waitlist.',
  spot_available: 'A spot opened up.',
  reminder: 'A gentle reminder.',
  missed_you: 'We missed you.',
  announcement: 'A message from your teacher.',
  teacher_invitation: 'A teacher would like to connect with you.',
};
```

Leave `TEACHER_INTROS` and `STUDENT_ACTION_LINKS` untouched — both are
`Partial<Record<…>>`, no teacher receives either type, and the inbox row's own
link (via `relatedClassId`) is what these notices need rather than an email
action button.

- [ ] **Step 7: Run the tests and the typecheck**

Run: `npx vitest run --project unit src/services/notification-policy.test.ts`
Expected: PASS, all four assertions in the two blocks above.

Run: `npx tsc --noEmit`
Expected: clean. A failure naming `STUDENT_INTROS` means Step 6 was skipped —
that is the total Record doing its job.

- [ ] **Step 8: Prove the policy guard bites**

Two mutations, applied one at a time, each reverted before the next:

1. Add `'booking_cancelled'` to `ESSENTIAL_NOTIFICATION_TYPES`. Re-run the unit
   file. Expected: FAIL — both the exact-membership test and the split test.
   Record the exact error text. Revert; re-run; green.
2. Remove `'booking_removed'` from the set. Re-run. Expected: FAIL — same two
   tests, opposite direction. Record the error text. Revert; re-run; green.

The `STUDENT_INTROS` entries need no mutation: omitting either is a compile
error, which Step 7 already demonstrated is enforced.

- [ ] **Step 9: Bring the data-model type list current**

`docs/data-model.md:495` lists eight types; the enum held ten before this
change (`payment_request` and `teacher_invitation` were both added without
updating this line). Replace the line with all twelve rather than appending two
to a list that is wrong in two other places:

```markdown
Notification types: booking_confirmed, booking_cancelled, booking_removed, class_cancelled, payment_received, payment_request, waitlist_promoted, spot_available, reminder, missed_you, announcement, teacher_invitation.
```

Re-derive with: `grep -n "enum NotificationType" -A 20 prisma/schema.prisma`

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/notification-policy.ts src/services/notification-policy.test.ts src/lib/email-templates.ts docs/data-model.md
git commit -m "feat(notifications): two cancellation types, split by who ended the booking (#434)"
```

---

### Task 2: The handler tells the student

**Depends on Task 1** — both string literals must be members of
`NotificationType` before this compiles.

**Note on the dev server:** Task 1 regenerated the Prisma client. If the app on
`:3000` is already running it may hold the pre-migration client and reject the
new enum values, which surfaces here as an integration failure that looks like
a route bug. Check whether `:3000` is up and whose it is before touching it —
never kill or restart it unilaterally; ask the user to restart it if the new
values are not recognised.

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts` — imports, the `DELETE`
  handler's `include` (`:199-217`), its two write branches (`:267-276`,
  `:283-295`), plus two new module-level helpers
- Test: `tests/integration/registrations-api.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `'booking_cancelled'` / `'booking_removed'` from Task 1;
  `createNotification(db, input): Promise<Notification>` and the
  `CreateNotificationInput` type from `@/services/notifications`;
  `isEssential(type): boolean` from `@/services/notification-policy` (used by
  the tests only).
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/registrations-api.test.ts`. The file's imports
need three additions at the top — `formatDayHeader` from `@/lib/format`,
`timeToHHmm` alongside the existing `hhmmToTime` from `@/lib/time-of-day`, and
`isEssential` from `@/services/notification-policy`:

```ts
describe('DELETE /api/registrations/[id] — the student is told their booking ended (#434)', () => {
  /**
   * Every assertion on a body derives its expected strings from the STORED
   * row rather than restating the fixture's literals — the idiom
   * `classes-api.test.ts`'s cancellation-notice test documents. Hard-coded
   * copies fail on a fixture change while the route is perfectly correct, and
   * only a value rendered from what the column actually returned can catch
   * the route drifting off UTC midnight.
   */
  async function storedEntry(classId: string) {
    const cls = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { calendarEntry: { select: { classType: true, date: true, startTime: true } } },
    });
    return cls.calendarEntry;
  }

  function expectNamesTheClass(body: string, entry: { classType: string; date: Date; startTime: Date }) {
    expect(body).toContain(entry.classType);
    expect(body).toContain(formatDayHeader(entry.date));
    expect(body).toContain(timeToHHmm(entry.startTime));
  }

  it('tells a student who cancelled before the deadline, without claiming a charge', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: studentIds[0]!,
        relatedClassId: classId,
        type: 'booking_cancelled',
      },
    });
    expectNamesTheClass(note.body, await storedEntry(classId));
    expect(note.body).toContain("won't be charged");
    expect(note.body).not.toContain('still charged');
  });

  it('tells a student who cancelled late that the class is still charged', async () => {
    // Offset 60: `makeLateCancelClass` callers must not overlap, and 0, 20
    // and 40 are taken by tests above.
    const classId = await makeLateCancelClass(5, 60);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('late_cancel');

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: studentIds[0]!,
        relatedClassId: classId,
        type: 'booking_cancelled',
      },
    });
    expectNamesTheClass(note.body, await storedEntry(classId));
    expect(note.body).toContain('still charged');
  });

  it('tells a student their teacher ended it, as the louder of the two types', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[1]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: studentIds[1]!,
        relatedClassId: classId,
        type: 'booking_removed',
      },
    });
    expectNamesTheClass(note.body, await storedEntry(classId));
    expect(note.body).toContain('Your teacher cancelled');
    expect(note.body).toContain("won't be charged");
    // The route's type choice and the delivery policy are decided in different
    // files; this is the one assertion that holds them together, so a removal
    // demoted to the opt-out-able type fails here rather than in silence.
    expect(isEssential(note.type)).toBe(true);
  });

  it('tells only the student — a cancellation notifies no teacher', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);

    // Not an empty list: booking the seat DID notify the teacher
    // (`booking_confirmed`, sent by POST /api/registrations). Asserting the
    // exact set is what distinguishes "cancellation adds none" from "this
    // fixture never notified the teacher at all".
    const teacherNotes = await prisma.notification.findMany({
      where: { recipientType: 'teacher', recipientId: ownerId, relatedClassId: classId },
    });
    expect(teacherNotes.map((n) => n.type)).toEqual(['booking_confirmed']);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`

Expected: the first three FAIL on `findFirstOrThrow` finding no matching row
(`NotFoundError`/`No Notification found`); the fourth PASSES already, since
nothing sends a teacher notice today. Record that the fourth is green from the
start — it is a regression pin, and its value is proven by the mutation in
Step 6 rather than by failing now.

- [ ] **Step 3: Add the imports and the class-naming helper**

At the top of `src/app/api/registrations/[id]/route.ts`, beside the existing
imports:

```ts
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { createNotification, type CreateNotificationInput } from '@/services/notifications';
```

And, at module level beside `promoteAfterCancel`:

```ts
/**
 * The class a cancellation notice is about, named the way every cancellation
 * notice names one: type, day, time. `startTime` is a `@db.Time` column, so
 * it arrives as a `Date` and needs rendering rather than interpolating.
 */
function classPhrase(entry: { classType: string; date: Date; startTime: Date }): string {
  return `${entry.classType} on ${formatDayHeader(entry.date)} at ${timeToHHmm(entry.startTime)}`;
}

/**
 * Sends the student their cancellation notice, after the cancel has committed.
 *
 * Swallowed for the same reason `promoteAfterCancel` swallows: the status
 * write has already landed, and a throw from here would answer 500 for a
 * cancellation that fully succeeded — the student would see an error, retry,
 * and be told their booking is already cancelled.
 *
 * `error` rather than `warn`, even for a transient failure, and unlike the
 * waitlist hook next door: nothing sweeps for missing notifications, so a loss
 * here is permanent. The student is simply never told.
 */
async function notifyCancellation(input: CreateNotificationInput): Promise<void> {
  try {
    await createNotification(prisma, input);
  } catch (err) {
    log.error(
      { err, recipientId: input.recipientId, type: input.type, classId: input.relatedClassId },
      'cancellation notice not sent — the student was not told their booking ended',
    );
  }
}
```

`log` and `prisma` are already imported in this file.

- [ ] **Step 4: Select the one field the bodies need**

The `DELETE` handler's read (`:199-217`) already selects `date` and
`startTime` on the entry but not `classType`. Add it to that same
`calendarEntry.select` — no new query, no second round trip:

```ts
          calendarEntry: {
            select: {
              teacherId: true,
              classType: true,
              date: true,
              startTime: true,
              cancelledAt: true,
              teacher: { select: { defaultTimezone: true } },
            },
          },
```

- [ ] **Step 5: Send one notice per outcome**

In the late-cancel branch, after the `updated.count === 0` guard returns and
beside the existing `promoteAfterCancel` call:

```ts
      // The seat is free even though the canceller is still charged.
      await promoteAfterCancel(registration.classId);
      await notifyCancellation({
        recipientType: 'student',
        recipientId: registration.studentId,
        relatedClassId: registration.classId,
        type: 'booking_cancelled',
        title: 'Booking cancelled',
        body: `Your booking for ${classPhrase(registration.class.calendarEntry)} is cancelled. It was past the cancellation deadline, so this class is still charged.`,
      });
      return respondOk({ id, status: 'late_cancel' });
```

In the full-cancel branch, after its own `promoteAfterCancel` and before the
response:

```ts
  // Hybrid waitlist promotion: auto-promote, broadcast, or stay frozen
  // depending on how close to the deadline we are.
  await promoteAfterCancel(registration.classId);

  // Layer 1+2 of the comms model, the pair booking sends inverted — except
  // that this direction tells only the student, deliberately. TWO types
  // because the delivery policy differs on them: a removal the student did
  // not ask for is essential, their own cancellation is not
  // (`services/notification-policy.ts` carries that reasoning).
  //
  // Branched on `isStudent`, not `isTeacher`: a dual-role account cancelling
  // its own booking is self-initiated even when it also teaches, the same
  // precedence the GET handler above applies for the same reason.
  const phrase = classPhrase(registration.class.calendarEntry);
  await notifyCancellation(
    isStudent
      ? {
          recipientType: 'student',
          recipientId: registration.studentId,
          relatedClassId: registration.classId,
          type: 'booking_cancelled',
          title: 'Booking cancelled',
          body: `Your booking for ${phrase} is cancelled. You won't be charged for it.`,
        }
      : {
          recipientType: 'student',
          recipientId: registration.studentId,
          relatedClassId: registration.classId,
          type: 'booking_removed',
          title: 'Booking cancelled by your teacher',
          body: `Your teacher cancelled your booking for ${phrase}. You won't be charged for it.`,
        },
  );

  return respondOk({ id, status: 'cancelled' });
```

- [ ] **Step 6: Run the tests and verify they pass**

The route recompiles lazily, and a first request's compilation can blow a
timeout that reads exactly like an assertion failure. Warm it first:

Run: `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/registrations/warm`
Expected: `401`. The id `warm` matches the `[id]` segment, so this compiles the
very module this task edits; the unauthenticated refusal is the point reaching
the handler, not a problem to fix.

Then: `npx vitest run --project integration tests/integration/registrations-api.test.ts`

Expected: PASS, all four new tests, and the file's pre-existing tests still
green — including the two `…and nothing else` DELETE tests at `:1077` and
`:1092`, which pin the HTTP response body's keys (`['id','status']`) and are
untouched by this change.

- [ ] **Step 7: Prove the route's guards bite**

Three mutations, one at a time, each reverted and re-verified before the next.
Warm the route after applying each one, then run the integration file:

1. **Branch selector.** Change `isStudent ?` to `isTeacher ?` in Step 5's
   full-cancel notice. Expected: FAIL — the teacher-initiated test finds no
   `booking_removed` row. Record the error text.
2. **Late-cancel copy.** Delete the `It was past the cancellation deadline, so
   this class is still charged.` sentence. Expected: FAIL — the late-cancel
   test's `toContain('still charged')`. Record the error text.
3. **Recipient scope.** Add a second `notifyCancellation` call in the
   full-cancel branch with `recipientType: 'teacher'` and
   `recipientId: registration.class.calendarEntry.teacherId`. Expected: FAIL —
   the no-teacher-notice test, whose received array now carries a second type.
   Record the error text. This is the mutation that earns that test its place,
   since it passed before the feature existed.

Revert each; confirm green after each revert.

- [ ] **Step 8: Full verification**

Run: `npm run verify`
Expected: green — typecheck, lint, and every vitest project.

If anything earlier in the chain is red, `npm test`'s second invocation never
runs and the integration project reports *nothing* rather than zero failures.
While that is the case, run `npx vitest run --project integration` directly
rather than reading a red `verify` as evidence about that tier.

- [ ] **Step 9: Commit**

```bash
git add "src/app/api/registrations/[id]/route.ts" tests/integration/registrations-api.test.ts
git commit -m "feat(registrations): tell the student when their booking ends, three ways (#434)"
```

---

## After both tasks

Two tasks means a whole-branch review applies: one review on the most capable
model, one fix wave, one scoped re-review, before the PR. The specific
cross-task risk to point it at — the one neither task's own reviewer can see —
is whether the type each route branch picks agrees with the essentiality the
policy assigns it. Task 2's `isEssential(note.type)` assertion covers the
removal; nothing structurally prevents the reverse mistake on the self-cancel
side.
