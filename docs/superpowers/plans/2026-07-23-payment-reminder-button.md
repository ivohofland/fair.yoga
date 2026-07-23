# Payment Reminder Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing `POST /api/payments/[id]/remind` endpoint into the two doc-promised surfaces with a visible "Reminded …" history, plus the route's first HTTP tests.

**Architecture:** One standalone client component `SendReminderButton` (sibling to `MarkPaidButton`/`MarkUnpaidButton`, own local state, no `usePaymentActions` extension, no `router.refresh`), mounted on unpaid rows of the class payment checklist and the `/settings/payments` Outstanding section. `PaymentItem` gains `reminderSentAt`.

**Tech Stack:** Next.js client component, existing `timeAgo`/`readErrorMessage` helpers, vitest HTTP integration tests, Playwright e2e in the serial teacher-journey chain.

**Spec:** `docs/superpowers/specs/2026-07-23-payment-reminder-button-design.md`

## Global Constraints

- TypeScript strict; no `any`; no non-null assertions where narrowing works.
- Design brief: the button is words only ("Send reminder", "Sending..." while busy), the reminded state is `type-caption` text — never a badge; no icons.
- No `router.refresh` anywhere in this feature.
- Integration tests need the dev server on `:3000` and Postgres up (`docker compose start db`; `nohup npm run dev > /tmp/dev.log 2>&1 &` if nothing listens).
- Commits: lowercase `feat:`/`test:` style with footer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: HTTP integration tests for the remind route

**Files:**
- Create: `tests/integration/payments-api.test.ts`

**Interfaces:**
- Consumes: the existing route `POST /api/payments/[id]/remind` and service `sendPaymentReminder` (already implemented — these tests pin behavior, so they should pass immediately; a failure means a real bug, stop and report).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the tests**

Create `tests/integration/payments-api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const teacherToken = crypto.randomBytes(32).toString('hex');
const otherTeacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let otherTeacherId: string;
let roomId: string;
let studentId: string;
let classId: string;
let paymentId: string;

const BASE_URL = 'http://localhost:3000';
const cookie = (token: string) => ({ Cookie: `fair_yoga_session=${token}` });

async function makeTeacher(tag: string, token: string): Promise<string> {
  const email = `pay-${tag}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Pay',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher for payment API tests',
      pageSlug: `pay-${tag}-${uniqueSuffix}`,
    },
  });
  const account = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacher.id },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(token),
      accountId: account.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  return teacher.id;
}

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner', teacherToken);
  otherTeacherId = await makeTeacher('other', otherTeacherToken);

  const room = await prisma.room.create({
    data: {
      venueName: 'Payment Venue',
      address: `${uniqueSuffix} Payment St`,
      city: 'Testville',
      postcode: '1234PY',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });

  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Reminder Flow',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'completed',
    },
  });
  classId = cls.id;

  const student = await prisma.student.create({
    data: {
      firstName: 'Reminder',
      lastName: 'Student',
      email: `pay-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;

  const registration = await prisma.registration.create({
    data: { classId, studentId, tierAtBooking: 3, status: 'attended' },
  });
  const payment = await prisma.payment.create({
    data: { registrationId: registration.id, amount: 12.5, status: 'pending' },
  });
  paymentId = payment.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
  await prisma.payment.deleteMany({ where: { registration: { classId } } });
  await prisma.registration.deleteMany({ where: { classId } });
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.student.delete({ where: { id: studentId } });
  for (const id of [teacherId, otherTeacherId]) {
    const t = await prisma.teacher.findUniqueOrThrow({
      where: { id },
      select: { accountId: true, email: true },
    });
    await prisma.session.deleteMany({ where: { accountId: t.accountId } });
    await prisma.teacher.delete({ where: { id } });
    await prisma.account.deleteMany({ where: { email: t.email } });
  }
  await prisma.$disconnect();
});

describe('POST /api/payments/[id]/remind', () => {
  it('rejects a signed-out caller', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await fetch(
      `${BASE_URL}/api/payments/00000000-0000-4000-8000-000000000000/remind`,
      { method: 'POST', headers: cookie(teacherToken) },
    );
    expect(res.status).toBe(404);
  });

  it("403s another teacher's payment", async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId },
      }),
    ).toBe(0);
  });

  it('creates the notification and stamps reminderSentAt in one go', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { reminderSentAt: string | null } };
    expect(data.reminderSentAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
    expect(notification!.title).toBe('Payment outstanding');

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.reminderSentAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run tests/integration/payments-api.test.ts`
Expected: PASS 4/4 — these pin already-shipped behavior. If any fails, STOP and report the failure instead of adjusting assertions to fit.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/payments-api.test.ts
git commit -m "test: the remind route gets its first HTTP-level pins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: SendReminderButton + both mounts + e2e (TDD via e2e)

**Files:**
- Create: `src/components/class/send-reminder-button.tsx`
- Modify: `src/components/class/payment-checklist.tsx` (PaymentItem + unpaid-row cluster)
- Modify: `src/app/(teacher)/class/[id]/page.tsx` (paymentItems mapping, ~line 81)
- Modify: `src/app/(teacher)/settings/payments/page.tsx` (Outstanding row cluster, ~line 106)
- Modify: `tests/e2e/teacher-journey.spec.ts` (one new test after 'completing runs pricing and payments can be marked paid'; two assertions in 'the payments overview offers the permanent correction')

**Interfaces:**
- Consumes: `timeAgo(date: Date): string` from `@/lib/format`; `readErrorMessage(res, fallback)` from `@/lib/client-errors`; the route from Task 1.
- Produces: `SendReminderButton({ paymentId: string; studentName: string; reminderSentAt: Date | null })`.

- [ ] **Step 1: Write the failing e2e first**

In `tests/e2e/teacher-journey.spec.ts`, after the test `'completing runs pricing and payments can be marked paid'`, add:

```ts
  test('an unpaid row sends a reminder the student will hear about', async ({
    page,
    context,
  }) => {
    await signInTeacher(context);
    await page.goto(`/class/${classId}`);

    // The walk-in's payment is the unpaid row; paid rows offer nothing.
    await page.getByRole('button', { name: 'Send reminder to Walkin Guest' }).click();
    await expect(page.getByText(/Reminded just now/)).toBeVisible();

    const reminded = await prisma.payment.findFirst({
      where: { registration: { classId, studentId: walkInStudentId } },
    });
    expect(reminded?.reminderSentAt).not.toBeNull();
    // The walk-in never signs in, so the notification is pinned in the
    // DB; /updates rendering is covered by the updates e2e.
    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: walkInStudentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
  });
```

In the test `'the payments overview offers the permanent correction'`, directly after the `await expect(page.getByRole('heading', { name: 'Received' })).toBeVisible();` line, add:

```ts
    // The Outstanding row carries the reminder action, and the caption
    // from the class-page send above survives server-side.
    await expect(
      page.getByRole('button', { name: 'Send reminder to Walkin Guest' }),
    ).toBeVisible();
    await expect(page.getByText(/Reminded /)).toBeVisible();
```

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npx playwright test tests/e2e/teacher-journey.spec.ts --project=chromium --retries=0`
Expected: the new test FAILS at the `Send reminder to Walkin Guest` click (button does not exist yet). Earlier tests in the serial chain still pass.

- [ ] **Step 3: Create the component**

Create `src/components/class/send-reminder-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { timeAgo } from '@/lib/format';
import { readErrorMessage } from '@/lib/client-errors';

interface SendReminderButtonProps {
  paymentId: string;
  studentName: string;
  reminderSentAt: Date | null;
}

/**
 * The manual nudge for an unpaid payment (teacher-screens 7.2, IA Flow
 * 4). No cooldown is enforced: the visible "Reminded ..." history is
 * the calm pressure against nagging, and the stamp already spaces the
 * automatic dunning sweep server-side. Local state only — the row
 * doesn't move sections, so no router.refresh.
 */
export function SendReminderButton({
  paymentId,
  studentName,
  reminderSentAt,
}: SendReminderButtonProps) {
  const [remindedAt, setRemindedAt] = useState<Date | null>(reminderSentAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSend() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/remind`, { method: 'POST' });
      if (res.ok) {
        const json = (await res.json()) as { data: { reminderSentAt: string | null } };
        setRemindedAt(json.data.reminderSentAt ? new Date(json.data.reminderSentAt) : new Date());
      } else {
        setError(await readErrorMessage(res, 'Could not send. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {remindedAt && <span className="type-caption">Reminded {timeAgo(remindedAt)}</span>}
      <button
        type="button"
        onClick={handleSend}
        disabled={busy}
        aria-label={`Send reminder to ${studentName}`}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        {busy ? 'Sending...' : 'Send reminder'}
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 4: Mount in the payment checklist**

In `src/components/class/payment-checklist.tsx`:

Add to the `PaymentItem` interface:

```ts
  reminderSentAt: Date | null;
```

Add the import:

```ts
import { SendReminderButton } from '@/components/class/send-reminder-button';
```

In the row's right-hand action cluster, render for unpaid rows only, BEFORE the Mark paid button (find the cluster that renders Mark paid / Undo; add as its first child):

```tsx
                {!isPaid && (
                  <SendReminderButton
                    paymentId={item.paymentId}
                    studentName={item.studentName}
                    reminderSentAt={item.reminderSentAt}
                  />
                )}
```

- [ ] **Step 5: Plumb the data on the class page**

In `src/app/(teacher)/class/[id]/page.tsx`, the `paymentItems` mapping (~line 81) gains one field:

```ts
      reminderSentAt: r.payment!.reminderSentAt,
```

(The mapping already uses `r.payment!` for id/amount/status — keep the established pattern.)

- [ ] **Step 6: Mount on the settings payments page**

In `src/app/(teacher)/settings/payments/page.tsx`, add the import:

```ts
import { SendReminderButton } from '@/components/class/send-reminder-button';
```

In the Outstanding row's action cluster (`<div className="flex items-center gap-3 shrink-0">`, currently amount + `<MarkPaidButton …>`), add BEFORE `MarkPaidButton`:

```tsx
                <SendReminderButton
                  paymentId={p.id}
                  studentName={studentName(p)}
                  reminderSentAt={p.reminderSentAt}
                />
```

The Received section stays untouched.

- [ ] **Step 7: Run the e2e to verify it passes**

Run: `npx playwright test tests/e2e/teacher-journey.spec.ts --retries=0`
Expected: all pass on both projects, including the new test and the extended payments-overview assertions.

- [ ] **Step 8: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/components/class/send-reminder-button.tsx src/components/class/payment-checklist.tsx "src/app/(teacher)/class/[id]/page.tsx" "src/app/(teacher)/settings/payments/page.tsx" tests/e2e/teacher-journey.spec.ts
git commit -m "feat: the promised payment reminder button, on both surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Full gates, push, PR

**Files:** none new.

- [ ] **Step 1: Full gates, each exit-gated**

```bash
npm test
npx playwright test
npx tsc --noEmit && npx eslint
```
Expected: all green. If ANY fails, STOP — do not push.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/payment-reminder-button
gh pr create --title "feat: the promised payment reminder button, on both surfaces" --body "Closes #43.

## Summary
Spec: \`docs/superpowers/specs/2026-07-23-payment-reminder-button-design.md\`.

- \`POST /api/payments/[id]/remind\` was fully built (transactional notification + reminderSentAt stamp that also spaces the dunning cron) and promised in teacher-screens 7.2 + IA Flow 4 — but nothing ever called it. A standalone \`SendReminderButton\` (words only, sibling of MarkPaid/MarkUnpaid, local state, no router.refresh) now mounts on unpaid rows of the class payment checklist and /settings/payments Outstanding.
- No enforced cooldown: the visible \"Reminded 2h ago\" caption is the calm pressure against nagging; manual sends already delay the next automatic reminder server-side.

## Test plan
- First HTTP-level tests for the remind route (the #53 payments slice): 401/404/403 (with no-notification side-effect check) and the success path pinning notification + stamp + response.
- E2e in the teacher-journey chain: unpaid row sends → \"Reminded just now\" without reload, notification pinned in DB (recipient is the sessionless walk-in; /updates rendering is covered by the updates e2e); the payments-overview test pins the second mount and the caption surviving SSR.
- Full vitest + Playwright + tsc + eslint, exit-gated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Report the PR URL**
