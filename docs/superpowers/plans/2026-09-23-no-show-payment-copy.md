# No-show and late-cancel payment copy Implementation Plan (#661)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell a no-show or late-cancelling student why they are still being charged, inside the one payment message they already receive, and retire the never-sent `missed_you` notification type.

**Architecture:** `completeClass` (`src/services/class-lifecycle.ts`) already sends one `payment_request` per charged registration. Its student body moves into a pure function that chooses wording from the registration's status, with an exhaustive `switch`. `missed_you` leaves the `NotificationType` enum through a migration, and the exhaustive `Record<NotificationType, …>` maps make the compiler find every remaining use.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, Vitest (`unit` project; `class-lifecycle.test.ts` runs there against the test DB).

**Spec:** none (bounded; the design was agreed in the brainstorm). The decisions it recorded:
- Option C: no separate `missed_you` message. The payment message carries the explanation, one message per student.
- `no_show` and `late_cancel` are handled the same way (both explained). `registered` (never marked) and `attended` keep today's wording, because nobody recorded an absence.
- No-show wording opens with "We missed you".
- Sent at completion, as today. A correction made after completion (#234) does not resend. Accepted, and noted on #234.
- The deadline-aware cancel confirm is **#664**, out of scope here.

## Global Constraints

- Copy, verbatim (`{when}` = `{classType} class on {formatDayHeader(date)} at {timeToHHmm(startTime)}`, `{price}` = `formatEuro(price)`):
  - `registered`, `attended`: `Your price for {when} is {price}. Pay your teacher directly.` (unchanged)
  - `no_show`: `We missed you at {when}. Booked spots share the class cost, so your price is {price}. Pay your teacher directly — if this isn't right, talk to your teacher.`
  - `late_cancel`: `You cancelled your booking for {when} after the cancellation deadline. Booked spots share the class cost, so your price is {price}. Pay your teacher directly — if this isn't right, talk to your teacher.`
- The title stays `Payment requested` for every status. The teacher's summary notification is unchanged.
- Never edit an applied migration. Create with `--create-only`, hand-edit, then apply.
- Stage exact paths; never `git add -A`.
- Comment Discipline (CLAUDE.md): no counts or rosters in comments.

## Review Focus

1. **An unmarked student (`registered`) gets the neutral wording, never "We missed you".** Pinned by the unit test and the DB test.
2. **A `late_cancel` row gets the late-cancel wording, not the no-show one.** The two branches are easy to swap. Pinned by the unit test, plus a mutation swapping them.
3. **Exactly one `payment_request` per charged student.** No second notification of any type for a no-show. Pinned by the DB test counting every notification per student.
4. **The enum migration succeeds on a DB that holds a `missed_you` row.** The `DELETE` must come before the cast. Pinned by the manual check in Task 2, Step 4.
5. **A `cancelled` status handed to the builder throws rather than producing a charge message.** Pinned by the unit test.

---

### Task 1: Status-aware payment-request body

**Files:**
- Create: `src/lib/payment-request-copy.ts`
- Test: `src/lib/payment-request-copy.test.ts`
- Modify: `src/services/class-lifecycle.ts` (the `notifications` map in `completeClass`, around `type: 'payment_request'`)
- Test: `src/services/class-lifecycle.test.ts` (`describe('completeClass (DB)')`, new `it`)
- Modify: `docs/product-concept.md` (the `**No-shows:**` sentence in §3)

**Interfaces:**
- Produces: `studentPaymentRequestBody(status: RegistrationStatus, cls: PaymentRequestClass, price: number): string` and `interface PaymentRequestClass { classType: string; date: Date; startTime: Date }`.

- [ ] **Step 1: Write the failing unit test** — `src/lib/payment-request-copy.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime } from '@/lib/time-of-day';
import { studentPaymentRequestBody } from './payment-request-copy';

const cls = { classType: 'Vinyasa', date: new Date('2026-10-06'), startTime: hhmmToTime('19:00') };
const when = `Vinyasa class on ${formatDayHeader(cls.date)} at 19:00`;
const TAIL = "Pay your teacher directly — if this isn't right, talk to your teacher.";

describe('studentPaymentRequestBody', () => {
  it.each(['registered', 'attended'] as const)('keeps the neutral wording for %s', (status) => {
    expect(studentPaymentRequestBody(status, cls, 12.4)).toBe(
      `Your price for ${when} is €12.40. Pay your teacher directly.`,
    );
  });

  it('opens a no-show with "We missed you" and explains the charge', () => {
    expect(studentPaymentRequestBody('no_show', cls, 12.4)).toBe(
      `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL}`,
    );
  });

  it('tells a late cancel it was after the deadline', () => {
    expect(studentPaymentRequestBody('late_cancel', cls, 12.4)).toBe(
      `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL}`,
    );
  });

  it('refuses a cancelled registration, which is never charged', () => {
    expect(() => studentPaymentRequestBody('cancelled', cls, 12.4)).toThrow(/not charged/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run --project unit src/lib/payment-request-copy.test.ts`
Expected: FAIL, cannot resolve `./payment-request-copy`.

- [ ] **Step 3: Implement** — `src/lib/payment-request-copy.ts`

```ts
import type { RegistrationStatus } from '@prisma/client';
import { formatDayHeader, formatEuro } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';

export interface PaymentRequestClass {
  classType: string;
  date: Date;
  startTime: Date;
}

const SHARED_COST = 'Booked spots share the class cost, so your price is';
const PAY_OR_ASK = "Pay your teacher directly — if this isn't right, talk to your teacher.";

/**
 * The student's `payment_request` body. A student marked absent, or who
 * cancelled after the deadline, is told why they are still charged; an
 * unmarked `registered` row gets the neutral wording, because nobody has
 * recorded an absence. Exhaustive over `RegistrationStatus`, so a new status
 * does not compile until its wording is decided.
 */
export function studentPaymentRequestBody(
  status: RegistrationStatus,
  cls: PaymentRequestClass,
  price: number,
): string {
  const when = `${cls.classType} class on ${formatDayHeader(cls.date)} at ${timeToHHmm(cls.startTime)}`;
  const amount = formatEuro(price);
  switch (status) {
    case 'registered':
    case 'attended':
      return `Your price for ${when} is ${amount}. Pay your teacher directly.`;
    case 'no_show':
      return `We missed you at ${when}. ${SHARED_COST} ${amount}. ${PAY_OR_ASK}`;
    case 'late_cancel':
      return `You cancelled your booking for ${when} after the cancellation deadline. ${SHARED_COST} ${amount}. ${PAY_OR_ASK}`;
    case 'cancelled':
      throw new Error('A cancelled registration is not charged and gets no payment request.');
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled registration status: ${String(unreachable)}`);
    }
  }
}
```

- [ ] **Step 4: Run it and confirm it passes** (same command). Expected: PASS.

- [ ] **Step 5: Write the failing DB test** — a new `it` in `describe('completeClass (DB)')` in `src/services/class-lifecycle.test.ts`, placed after the negative-earnings test. It uses `makeClass` and the first four `studentIds` from the block's `beforeAll`. Import `studentPaymentRequestBody` from `@/lib/payment-request-copy`.

```ts
it('explains the charge to no-shows and late cancels, in the one payment message each student gets', async () => {
  const cls = await makeClass({ status: 'in_progress' });
  const statuses = ['attended', 'registered', 'no_show', 'late_cancel'] as const;
  for (const [i, status] of statuses.entries()) {
    await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId: studentIds[i]!,
        status,
        tierAtBooking: i + 1,
        ...(status === 'late_cancel' ? { cancelledAt: new Date() } : {}),
      },
    });
  }

  const result = await completeClass(prisma, cls.id, { finishedEarly: true });
  expect(result.ok).toBe(true);

  const entry = cls.calendarEntry; // createClassFixture returns ClassWithEntry
  for (const [i, status] of statuses.entries()) {
    const reg = await prisma.registration.findFirstOrThrow({
      where: { classId: cls.id, studentId: studentIds[i]! },
    });
    // Every notification this student got about this class: exactly one, the payment request.
    const notes = await prisma.notification.findMany({
      where: { relatedClassId: cls.id, recipientType: 'student', recipientId: studentIds[i]! },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe('payment_request');
    expect(notes[0]!.title).toBe('Payment requested');
    expect(notes[0]!.body).toBe(
      studentPaymentRequestBody(status, entry, Number(reg.price)),
    );
  }

  // Literal anchors, so the test does not only compare the builder with itself.
  const noShow = await prisma.notification.findFirstOrThrow({
    where: { relatedClassId: cls.id, recipientId: studentIds[2]! },
  });
  expect(noShow.body.startsWith('We missed you at ')).toBe(true);
  const lateCancel = await prisma.notification.findFirstOrThrow({
    where: { relatedClassId: cls.id, recipientId: studentIds[3]! },
  });
  expect(lateCancel.body.startsWith('You cancelled ')).toBe(true);
  const unmarked = await prisma.notification.findFirstOrThrow({
    where: { relatedClassId: cls.id, recipientId: studentIds[1]! },
  });
  expect(unmarked.body.startsWith('Your price for ')).toBe(true);

  await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "explains the charge"`
Expected: FAIL on the `no_show` body (`Your price for …` received, `We missed you at …` expected).

- [ ] **Step 7: Wire the builder into `completeClass`.** Replace the student `body:` template literal with:

```ts
        body: studentPaymentRequestBody(reg.status, cls.calendarEntry, s.price),
```

and add `import { studentPaymentRequestBody } from '@/lib/payment-request-copy';`. Leave the now-unused imports (`formatDayHeader`, `timeToHHmm`, `formatEuro`) alone: the teacher notification still uses all three.

- [ ] **Step 8: Run the whole file.** Command: `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts`. Expected: PASS, including the existing `calculates pricing…` test, whose four `registered` rows keep `Pay your teacher directly.`

- [ ] **Step 9: Prove the guards bite.** Commit first (*git checkout eats sibling edits*), then apply each mutation, run both test files, record the exact failure text in the task report, and restore with `git checkout -- src/lib/payment-request-copy.ts`:
  1. Move `case 'no_show':` up to sit with `registered`/`attended`. Both files must fail.
  2. Swap the `no_show` and `late_cancel` return strings. Both files must fail.
  3. In `completeClass`, pass `'registered'` in place of `reg.status`. The DB test must fail; the unit test stays green (expected: it does not see the call site).

  End with `git status` clean.

- [ ] **Step 10: Update the product concept.** In `docs/product-concept.md` §3, replace the `**No-shows:**` paragraph with:

```markdown
**No-shows:** treated the same as late cancellations — included in the distribution and charged accordingly. There is no separate message: the payment request sent when the class completes tells a student marked as a no-show "We missed you" and explains that booked spots share the class cost, and tells a late canceller the same about their cancellation. A student the teacher never marked gets the ordinary payment request.
```

- [ ] **Step 11: Commit**

```bash
git add src/lib/payment-request-copy.ts src/lib/payment-request-copy.test.ts src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts docs/product-concept.md
git commit -m "feat(payments): explain the charge to no-shows and late cancels (#661)"
```

---

### Task 2: Retire `missed_you`

**Files:**
- Modify: `prisma/schema.prisma` (enum `NotificationType`)
- Create: `prisma/migrations/<timestamp>_retire_missed_you/migration.sql`
- Modify: `src/lib/email-templates.ts` (`STUDENT_INTROS`)
- Modify: `src/lib/notification-retention.ts` (`NOTIFICATION_RETENTION_DAYS`)
- Modify: `src/lib/notification-retention.test.ts` (the `keeps missed_you briefly` case)
- Modify: `docs/data-model.md` (the `Notification types:` line and the retention paragraph below it)
- Modify: `docs/visual/data-model.html` (the `Types:` field-note)

**Interfaces:** none consumed or produced. Order after Task 1: that task's product-concept edit is what makes removing the type honest.

- [ ] **Step 1: Worktree DB.** If not already done: `pnpm install --frozen-lockfile`, then `pnpm run worktree:setup`.

- [ ] **Step 2: Remove `missed_you` from the enum** in `prisma/schema.prisma`, then create the migration without applying it:

Run: `pnpm exec prisma migrate dev --create-only --name retire_missed_you`

- [ ] **Step 3: Hand-edit the generated `migration.sql`** so that, whatever Prisma generated, it reads:

```sql
-- missed_you is retired (#661); the explanation now lives in the payment_request body.
-- Delete before the cast: a row holding a value the new type lacks would fail it.
DELETE FROM "Notification" WHERE "type" = 'missed_you';

ALTER TYPE "NotificationType" RENAME TO "NotificationType_old";
CREATE TYPE "NotificationType" AS ENUM ('booking_confirmed', 'booking_cancelled', 'booking_removed', 'class_cancelled', 'payment_received', 'payment_request', 'waitlist_promoted', 'spot_available', 'reminder', 'announcement', 'teacher_invitation');
ALTER TABLE "Notification" ALTER COLUMN "type" TYPE "NotificationType" USING "type"::text::"NotificationType";
DROP TYPE "NotificationType_old";
```

Check that the value list matches `schema.prisma`'s enum after Step 2, in order. `Notification.type` has no default, so there is no `DROP DEFAULT` / `SET DEFAULT` pair (compare `20260410200000_remove_full_class_status`).

- [ ] **Step 4: Prove the `DELETE` is needed, before applying.** On the worktree DB, insert one `missed_you` row, run the migration with the `DELETE` line commented out, and record the cast error. Then roll back: `prisma migrate reset` on the worktree DB only, restore the line, insert the row again, apply, and confirm the row is gone and the migration succeeded. Record both outcomes in the task report. After this step the file is final and applied; it is immutable from here on.

Run to apply: `pnpm exec prisma migrate dev`
Expected: migration applied, client regenerated.

- [ ] **Step 5: Let the compiler find the rest.** Run: `pnpm exec tsc --noEmit`
Expected: errors at `email-templates.ts` (`STUDENT_INTROS`) and `notification-retention.ts` (`NOTIFICATION_RETENTION_DAYS`), as unknown-property errors on `missed_you`. Record the text. Delete both `missed_you` lines, and delete the `keeps missed_you briefly` case from `notification-retention.test.ts`. Re-run: clean.

- [ ] **Step 6: Docs.** Remove `missed_you` from:
  - `docs/data-model.md`, the `Notification types:` line
  - `docs/data-model.md`, the retention paragraph: `` `spot_available` and `missed_you` keep 30 days `` → `` `spot_available` keeps 30 days ``
  - `docs/visual/data-model.html`, the `Types:` field-note

  Leave `docs/superpowers/plans/*` and `specs/*` alone; they are records.

- [ ] **Step 7: Sweep for what was removed.** Run: `grep -rn "missed_you\|We missed you\." src prisma/schema.prisma docs --exclude-dir=superpowers`
Expected: no hits outside `prisma/migrations/`. The builder's `We missed you at` must not match; the pattern ends in a full stop so it only finds the retired email intro. Give any other hit a verdict in the report.

- [ ] **Step 8: Verify.** Run `pnpm run worktree:up`, then `pnpm run verify`. Expected: green. Record the per-project counts for the PR body. Then run `pnpm exec prisma migrate status` (expected: up to date).

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/<timestamp>_retire_missed_you/migration.sql src/lib/email-templates.ts src/lib/notification-retention.ts src/lib/notification-retention.test.ts docs/data-model.md docs/visual/data-model.html
git commit -m "refactor(notifications): retire the never-sent missed_you type (#661)"
```

---

## Finish (controller)

- Whole-branch review (2 tasks), one fix wave, scoped re-review, per the `solve-issue` skill.
- Comment on #234 (`--body-file`): once post-completion attendance editing exists, a correction does not resend or amend the payment request already sent; the no-show and late-cancel wording is chosen at completion from the status held then.
- PR body: the premise (`missed_you` never created; a no-show already got a `payment_request` identical to an attendee's), the decisions above, each mutation's recorded failure text, the migration's `DELETE` proof, and the `verify` arithmetic. **#234 and #664 are unaffected.**
