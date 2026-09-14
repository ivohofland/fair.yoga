# Past-class Payment Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A completed class under **Past classes** on `/bookings` gets a "Where your payment goes" disclosure showing Room, Teacher, Class total, Students and Your share, read from the completion snapshot.

**Architecture:** A pure resolver in `src/lib/` decides whether a row shows the breakdown and computes its lines in integer cents from `Prisma.Decimal` values; a presentational server component renders them; the bookings page wires the two and logs when a completed class has no snapshot. Same resolver/renderer split as #433's `resolvePriceLine` / `ClassPriceLine`.

**Tech Stack:** Next.js 16 App Router (server components), TypeScript strict, Prisma 6 (`Prisma.Decimal`), Vitest projects `unit` / `components` (jsdom + Testing Library) / `integration`.

**Spec:** `docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md` — read it before starting any task; it carries the reasoning this plan does not repeat.

## Global Constraints

- TypeScript `strict: true`; no `any`, no casts to silence the compiler.
- Money is integer cents derived from `Prisma.Decimal` (`value.mul(100).toNumber()`); never subtract euros as floats.
- A negative amount renders with U+2212 before the euro sign: `−€4.00`, never `€-4.00` or `-€4.00`.
- Summary copy exactly `Where your payment goes`; its `aria-label` exactly `` `Where your payment goes — ${classType}, ${formatDayHeader(date)}` ``.
- Row labels exactly, in order: `Room`, `Teacher`, `Class total`, `Students`, `Your share`.
- No tier sentence, no tier number, no tier label anywhere in the breakdown.
- A `not_charged` payment shows no breakdown.
- Design system: no badges, no icons, no shadows; the panel reuses "How to pay"'s `bg-sand-soft border border-border rounded-field p-4`.
- Comment Discipline (CLAUDE.md): comments annotate the code they sit on; no counts or member lists in prose; anything about another module links to the spec instead.
- Stage exact paths, never `git add -A` / `git add .`; quote paths containing `(student)`.
- Never kill or restart a dev server on `:3000`. Integration tests in this worktree run against its own app: `pnpm run worktree:up` (already provisioned by `worktree:setup`).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Mutation protocol, every guard:** commit first; apply the mutation by hand-editing; run the named test; record the exact failure text in the task report; restore by hand-editing (never `git checkout`, which discards sibling edits); re-run to green; confirm `git diff --stat` is empty. For integration mutations, warm the route after each edit (`curl -s -o /dev/null -w '%{http_code}\n' http://localhost:<port>/bookings`, port from `worktree:up`) before judging RED/GREEN — `next dev` compiles lazily and a compile can read as a timeout.

**Task order is load-bearing:** Task 2 imports Task 1's type; Task 3 imports both.

---

### Task 1: `resolvePaymentBreakdown` — the gate and the cents

**Files:**
- Create: `src/lib/payment-breakdown.ts`
- Test: `src/lib/payment-breakdown.test.ts`

**Interfaces:**
- Consumes: `ClassStatus`, `PaymentStatus`, `Prisma` (types) from `@prisma/client`.
- Produces:
  ```ts
  export interface PaymentBreakdownLines {
    roomCents: number; teacherCents: number; totalCents: number; students: number; shareCents: number;
  }
  export type PaymentBreakdownResult =
    | { kind: 'shown'; lines: PaymentBreakdownLines }
    | { kind: 'hidden' }
    | { kind: 'snapshot_missing' };
  export interface ResolvePaymentBreakdownInput {
    classStatus: ClassStatus;
    roomCost: Prisma.Decimal;
    totalRevenue: Prisma.Decimal | null;
    totalStudents: number | null;
    payment: { status: PaymentStatus; amount: Prisma.Decimal } | null;
  }
  export function resolvePaymentBreakdown(input: ResolvePaymentBreakdownInput): PaymentBreakdownResult;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/payment-breakdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { resolvePaymentBreakdown, type ResolvePaymentBreakdownInput } from './payment-breakdown';

const d = (value: string) => new Prisma.Decimal(value);

const COMPLETED: ResolvePaymentBreakdownInput = {
  classStatus: 'completed',
  roomCost: d('40.00'),
  totalRevenue: d('56.25'),
  totalStudents: 9,
  payment: { status: 'pending', amount: d('7.50') },
};

describe('resolvePaymentBreakdown', () => {
  it('shows every line from the snapshot, in cents', () => {
    expect(resolvePaymentBreakdown(COMPLETED)).toEqual({
      kind: 'shown',
      lines: { roomCents: 4000, teacherCents: 1625, totalCents: 5625, students: 9, shareCents: 750 },
    });
  });

  it.each(['pending', 'paid', 'overdue'] as const)('shows the breakdown for a %s payment', (status) => {
    const result = resolvePaymentBreakdown({ ...COMPLETED, payment: { status, amount: d('7.50') } });
    expect(result.kind).toBe('shown');
  });

  it('hides the breakdown for a not_charged payment', () => {
    const result = resolvePaymentBreakdown({
      ...COMPLETED,
      payment: { status: 'not_charged', amount: d('7.50') },
    });
    expect(result).toEqual({ kind: 'hidden' });
  });

  it.each(['draft', 'open', 'in_progress'] as const)('hides the breakdown on a %s class', (classStatus) => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, classStatus })).toEqual({ kind: 'hidden' });
  });

  it('hides the breakdown when the registration has no payment', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, payment: null })).toEqual({ kind: 'hidden' });
  });

  it('reports a completed class with no totalRevenue as a missing snapshot', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, totalRevenue: null })).toEqual({ kind: 'snapshot_missing' });
  });

  it('reports a completed class with no totalStudents as a missing snapshot', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, totalStudents: null })).toEqual({ kind: 'snapshot_missing' });
  });

  it('reports a missing snapshot even on a row that would hide its breakdown', () => {
    expect(
      resolvePaymentBreakdown({
        ...COMPLETED,
        totalRevenue: null,
        payment: { status: 'not_charged', amount: d('7.50') },
      }),
    ).toEqual({ kind: 'snapshot_missing' });
  });

  it('does not report a missing snapshot on a class that is not completed', () => {
    expect(
      resolvePaymentBreakdown({ ...COMPLETED, classStatus: 'open', totalRevenue: null, totalStudents: null }),
    ).toEqual({ kind: 'hidden' });
  });

  it('derives the teacher line as total minus room, negative when the teacher covered part of the room', () => {
    const result = resolvePaymentBreakdown({ ...COMPLETED, roomCost: d('42.60'), totalRevenue: d('38.60') });
    expect(result).toMatchObject({ kind: 'shown', lines: { teacherCents: -400 } });
  });

  it('keeps cents exact where float subtraction drifts', () => {
    // In floating point, 56.30 - 40.10 is 16.199999999999996.
    const result = resolvePaymentBreakdown({ ...COMPLETED, roomCost: d('40.10'), totalRevenue: d('56.30') });
    expect(result).toMatchObject({
      kind: 'shown',
      lines: { roomCents: 4010, teacherCents: 1620, totalCents: 5630 },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/payment-breakdown.test.ts`
Expected: FAIL — the suite cannot resolve `./payment-breakdown`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/payment-breakdown.ts`:

```ts
import type { ClassStatus, PaymentStatus, Prisma } from '@prisma/client';

/** The lines of a completed class's breakdown, in whole cents. */
export interface PaymentBreakdownLines {
  roomCents: number;
  teacherCents: number;
  totalCents: number;
  students: number;
  shareCents: number;
}

export type PaymentBreakdownResult =
  | { kind: 'shown'; lines: PaymentBreakdownLines }
  | { kind: 'hidden' }
  | { kind: 'snapshot_missing' };

export interface ResolvePaymentBreakdownInput {
  classStatus: ClassStatus;
  roomCost: Prisma.Decimal;
  totalRevenue: Prisma.Decimal | null;
  totalStudents: number | null;
  payment: { status: PaymentStatus; amount: Prisma.Decimal } | null;
}

/**
 * Whether a payment in this status shows the class's breakdown. A waived
 * payment does not — its row shows only the waiver. Exhaustive over the enum,
 * so a new status is a compile error here until it is decided.
 */
const SHOWS_BREAKDOWN = {
  pending: true,
  paid: true,
  overdue: true,
  not_charged: false,
} as const satisfies Record<PaymentStatus, boolean>;

/** A `Decimal(10,2)` value as whole cents; `mul` keeps it exact. */
function toCents(value: Prisma.Decimal): number {
  return value.mul(100).toNumber();
}

/**
 * Whether a past-class row shows where the student's payment went, and the
 * lines it shows — read from the completion snapshot, never recomputed.
 *
 * The snapshot check sits before the payment checks so a completed class with
 * no snapshot is reported whatever its payment's status. Why the teacher line
 * is a subtraction, and why a missing snapshot is a defect rather than a
 * hidden row: docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md.
 */
export function resolvePaymentBreakdown(input: ResolvePaymentBreakdownInput): PaymentBreakdownResult {
  const { classStatus, roomCost, totalRevenue, totalStudents, payment } = input;

  if (classStatus !== 'completed') return { kind: 'hidden' };
  if (totalRevenue === null || totalStudents === null) return { kind: 'snapshot_missing' };
  if (payment === null || !SHOWS_BREAKDOWN[payment.status]) return { kind: 'hidden' };

  const roomCents = toCents(roomCost);
  const totalCents = toCents(totalRevenue);
  return {
    kind: 'shown',
    lines: {
      roomCents,
      teacherCents: totalCents - roomCents,
      totalCents,
      students: totalStudents,
      shareCents: toCents(payment.amount),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/payment-breakdown.test.ts`
Expected: PASS, every test.

Run: `pnpm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/payment-breakdown.ts src/lib/payment-breakdown.test.ts
git commit -m "feat(bookings): resolve a completed class's payment breakdown (#576)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Prove every guard bites**

Follow the mutation protocol (Global Constraints). For each row, record the failing test name(s) and the exact error text.

| # | Mutation in `src/lib/payment-breakdown.ts` | Must fail |
|---|---|---|
| 1.1 | Delete the `classStatus !== 'completed'` line | `hides the breakdown on a %s class` (all three); `does not report a missing snapshot on a class that is not completed` |
| 1.2 | Snapshot check becomes `if (totalStudents === null)`; pass `totalRevenue!` to `toCents` | `reports a completed class with no totalRevenue as a missing snapshot` |
| 1.3 | Snapshot check becomes `if (totalRevenue === null)`; `students: totalStudents!` | `reports a completed class with no totalStudents as a missing snapshot` |
| 1.4 | Move the snapshot check below the payment check | `reports a missing snapshot even on a row that would hide its breakdown` |
| 1.5 | `not_charged: true` | `hides the breakdown for a not_charged payment` |
| 1.6 | Delete the `not_charged` key | `pnpm run typecheck` (a compile error naming `not_charged`) |
| 1.7 | Payment check becomes `if (!SHOWS_BREAKDOWN[payment!.status])` | `hides the breakdown when the registration has no payment` |
| 1.8 | `teacherCents: roomCents - totalCents` | `shows every line from the snapshot, in cents`; the negative teacher-line test |
| 1.9 | `teacherCents: (totalRevenue.toNumber() - roomCost.toNumber()) * 100` | `keeps cents exact where float subtraction drifts` (received `1619.9999999999995`) |

After the last restore: unit file green, `pnpm run typecheck` exit 0, `git diff --stat` empty.

---

### Task 2: `PaymentBreakdown` — the disclosure

**Files:**
- Create: `src/components/student/payment-breakdown.tsx`
- Test: `src/components/student/payment-breakdown.test.tsx`

**Interfaces:**
- Consumes: `PaymentBreakdownLines` (type) from `@/lib/payment-breakdown` (Task 1); `formatDayHeader(date: Date): string` from `@/lib/format`.
- Produces:
  ```ts
  export function PaymentBreakdown(props: { lines: PaymentBreakdownLines; classType: string; date: Date });
  ```
  A server component (no `'use client'`) rendering a closed `<details>`. No return-type annotation — React 19's types have no global `JSX` namespace.

- [ ] **Step 1: Write the failing tests**

Create `src/components/student/payment-breakdown.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatDayHeader } from '@/lib/format';
import { PaymentBreakdown } from './payment-breakdown';

const DATE = new Date('2026-06-01T00:00:00.000Z');
const LINES = { roomCents: 4000, teacherCents: 1625, totalCents: 5625, students: 9, shareCents: 750 };

/** The value rendered beside a label in the breakdown's description list. */
function valueFor(label: string): string | null {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

describe('PaymentBreakdown', () => {
  it('renders each line beside its label', () => {
    render(<PaymentBreakdown lines={LINES} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Room')).toBe('€40.00');
    expect(valueFor('Teacher')).toBe('€16.25');
    expect(valueFor('Class total')).toBe('€56.25');
    expect(valueFor('Students')).toBe('9');
    expect(valueFor('Your share')).toBe('€7.50');
  });

  it('renders a negative teacher line with a minus sign before the euro sign', () => {
    render(<PaymentBreakdown lines={{ ...LINES, teacherCents: -400 }} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Teacher')).toBe('−€4.00');
  });

  it('pads single-digit cents', () => {
    render(<PaymentBreakdown lines={{ ...LINES, shareCents: 5 }} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Your share')).toBe('€0.05');
  });

  it('names the class and day in the summary, so several past classes stay distinguishable', () => {
    render(<PaymentBreakdown lines={LINES} classType="Vinyasa" date={DATE} />);
    expect(
      screen.getByLabelText(`Where your payment goes — Vinyasa, ${formatDayHeader(DATE)}`),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project components src/components/student/payment-breakdown.test.tsx`
Expected: FAIL — the suite cannot resolve `./payment-breakdown`.

- [ ] **Step 3: Write the implementation**

Create `src/components/student/payment-breakdown.tsx`:

```tsx
import { formatDayHeader } from '@/lib/format';
import type { PaymentBreakdownLines } from '@/lib/payment-breakdown';

interface PaymentBreakdownProps {
  lines: PaymentBreakdownLines;
  classType: string;
  date: Date;
}

/**
 * Euros from whole cents, without a float round-trip. A negative amount takes
 * U+2212 before the euro sign.
 */
function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '−' : ''}€${euros}.${rest}`;
}

/**
 * Where a student's payment for a completed class went. Whether a row renders
 * this at all is `resolvePaymentBreakdown`'s decision.
 */
export function PaymentBreakdown({ lines, classType, date }: PaymentBreakdownProps) {
  const rows: ReadonlyArray<{ label: string; value: string; emphasis: boolean }> = [
    { label: 'Room', value: formatCents(lines.roomCents), emphasis: false },
    { label: 'Teacher', value: formatCents(lines.teacherCents), emphasis: false },
    { label: 'Class total', value: formatCents(lines.totalCents), emphasis: false },
    { label: 'Students', value: String(lines.students), emphasis: false },
    { label: 'Your share', value: formatCents(lines.shareCents), emphasis: true },
  ];

  return (
    <details className="mt-2">
      <summary
        className="type-label text-teal cursor-pointer"
        aria-label={`Where your payment goes — ${classType}, ${formatDayHeader(date)}`}
      >
        Where your payment goes
      </summary>
      <dl className="mt-2 bg-sand-soft border border-border rounded-field p-4">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 py-1">
            <dt className="type-body">{row.label}</dt>
            <dd className={row.emphasis ? 'type-number' : 'tabular-nums text-ink'}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project components src/components/student/payment-breakdown.test.tsx`
Expected: PASS, every test.

Run: `pnpm run typecheck && pnpm run lint`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/student/payment-breakdown.tsx src/components/student/payment-breakdown.test.tsx
git commit -m "feat(bookings): payment breakdown disclosure component (#576)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Prove every guard bites**

Mutation protocol as in Global Constraints; record failing test and exact error text per row.

| # | Mutation in `src/components/student/payment-breakdown.tsx` | Must fail |
|---|---|---|
| 2.1 | `'−'` becomes `'-'` | `renders a negative teacher line with a minus sign before the euro sign` |
| 2.2 | Sign after the euro sign: `` `€${cents < 0 ? '−' : ''}${euros}.${rest}` `` | same test |
| 2.3 | Drop `.padStart(2, '0')` | `pads single-digit cents`; `renders each line beside its label` |
| 2.4 | `aria-label` loses `, ${formatDayHeader(date)}` | `names the class and day in the summary…` |
| 2.5 | Room row reads `lines.teacherCents`, Teacher row reads `lines.roomCents` | `renders each line beside its label` |

After the last restore: component file green, `git diff --stat` empty.

---

### Task 3: Wire the breakdown into `/bookings` past classes

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx` — imports; the `past.map` row (currently the block starting `const outstanding = payment ? isOutstanding(payment.status) : false;`, and the "How to pay" `</details>` that closes the row's payment section)
- Test: `tests/integration/bookings-page.test.ts` — append one `describe` at the end of the file

**Interfaces:**
- Consumes: `resolvePaymentBreakdown` (Task 1); `PaymentBreakdown` (Task 2); `log` from `@/lib/log` (already imported by the page).
- Produces: nothing later tasks use.

- [ ] **Step 1: Start the worktree's app**

Run: `pnpm run worktree:up`
Expected: `[worktree:up] dev server running at http://localhost:<port>` (or `already running at …`). Note the port for route warming. The integration project reads `INTEGRATION_BASE_URL` automatically. The dev server's output goes to `worktree-dev.log` in the worktree root.

- [ ] **Step 2: Write the failing integration tests**

Append to `tests/integration/bookings-page.test.ts`. Add `import { formatDayHeader } from '@/lib/format';` to the file's imports.

```ts
/**
 * `/bookings` — the past-class payment breakdown (#576).
 *
 * Each class carries snapshot values no other row on the page renders, so a
 * value's presence or absence is attributable to that class's disclosure. The
 * accessible name carries the class type for the same reason.
 */
describe('GET /bookings (page) — past-class payment breakdown', () => {
  const suffixB = uniqueSuffix();

  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';

  const pendingClass = { classType: `Breakdown Pending ${suffixB}`, date: new Date('2026-06-02T00:00:00.000Z') };
  const paidClass = { classType: `Breakdown Paid ${suffixB}`, date: new Date('2026-06-03T00:00:00.000Z') };
  const waivedClass = { classType: `Breakdown Waived ${suffixB}`, date: new Date('2026-06-04T00:00:00.000Z') };
  const unsnapshottedClass = {
    classType: `Breakdown Unsnapshotted ${suffixB}`,
    date: new Date('2026-06-05T00:00:00.000Z'),
  };

  const breakdownLabel = (c: { classType: string; date: Date }) =>
    `Where your payment goes — ${c.classType}, ${formatDayHeader(c.date)}`;

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `breakdown-teacher-${suffixB}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Breakdown',
        lastName: 'Teacher',
        email: teacherEmail,
        bio: 'Breakdown fixture teacher',
        pageSlug: `breakdown-teacher-${suffixB}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Breakdown Studio',
        address: `${suffixB} Breakdown St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 25 },
    });

    const studentEmail = `breakdown-student-${suffixB}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Breakdown',
        lastName: 'Student',
        email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const completedClassWithPayment = async (
      c: { classType: string; date: Date },
      economics: {
        roomCost: number;
        minRate: number;
        targetRate: number;
        minStudents: number;
        maxStudents: number;
        effectiveTeacherRate: number | null;
        totalStudents: number | null;
        totalRevenue: number | null;
      },
      payment: { amount: number; status: 'pending' | 'paid' | 'not_charged' },
    ) => {
      const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: c.classType,
        date: c.date,
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        status: 'completed',
        ...economics,
      });
      const registration = await prisma.registration.create({
        data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
      });
      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: payment.amount,
          status: payment.status,
          paidAt: payment.status === 'paid' ? new Date() : null,
          notChargedAt: payment.status === 'not_charged' ? new Date() : null,
        },
      });
    };

    // 7 students at maxStudents: rate = targetRate 16.25; 41.30 + 16.25 = 57.55.
    await completedClassWithPayment(
      pendingClass,
      { roomCost: 41.3, minRate: 10, targetRate: 16.25, minStudents: 3, maxStudents: 7,
        effectiveTeacherRate: 16.25, totalStudents: 7, totalRevenue: 57.55 },
      { amount: 8.15, status: 'pending' },
    );
    // 5 students at minStudents: rate = minRate -4.00; 42.60 - 4.00 = 38.60.
    await completedClassWithPayment(
      paidClass,
      { roomCost: 42.6, minRate: -4, targetRate: 20, minStudents: 5, maxStudents: 10,
        effectiveTeacherRate: -4, totalStudents: 5, totalRevenue: 38.6 },
      { amount: 7.7, status: 'paid' },
    );
    // 6 students at maxStudents: rate = targetRate 17.35; 43.90 + 17.35 = 61.25.
    await completedClassWithPayment(
      waivedClass,
      { roomCost: 43.9, minRate: 10, targetRate: 17.35, minStudents: 3, maxStudents: 6,
        effectiveTeacherRate: 17.35, totalStudents: 6, totalRevenue: 61.25 },
      { amount: 10.2, status: 'not_charged' },
    );
    // A state `completeClass` cannot produce: completed with no snapshot.
    await completedClassWithPayment(
      unsnapshottedClass,
      { roomCost: 44.7, minRate: 10, targetRate: 20, minStudents: 3, maxStudents: 10,
        effectiveTeacherRate: null, totalStudents: null, totalRevenue: null },
      { amount: 9.35, status: 'pending' },
    );

    // Warm the route: `next dev` compiles a page lazily on its first request.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registration: { studentId } } });
    await prisma.registration.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  async function bookingsHtml(): Promise<string> {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    return res.text();
  }

  it('shows a pending payment the room, teacher and class total behind it', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(breakdownLabel(pendingClass));
    expect(html).toContain('€41.30');
    expect(html).toContain('€16.25');
    expect(html).toContain('€57.55');
  });

  it('shows a paid payment its breakdown, with a negative teacher line when the teacher covered part of the room', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(breakdownLabel(paidClass));
    expect(html).toContain('€42.60');
    expect(html).toContain('−€4.00');
    expect(html).toContain('€38.60');
  });

  it('shows a not_charged payment no breakdown', async () => {
    const html = await bookingsHtml();
    // The row itself renders, so the absences below are about its disclosure.
    expect(html).toContain(waivedClass.classType);
    expect(html).not.toContain(breakdownLabel(waivedClass));
    expect(html).not.toContain('€43.90');
    expect(html).not.toContain('€61.25');
  });

  it('renders a completed class with no snapshot without a breakdown, and the page still loads', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(unsnapshottedClass.classType);
    expect(html).not.toContain(breakdownLabel(unsnapshottedClass));
    expect(html).not.toContain('€44.70');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: the two "shows … breakdown" tests FAIL (`expected … to contain 'Where your payment goes — Breakdown Pending …'`); the two absence tests PASS already — they are pinned by mutations 3.2 and 3.3 below, not by this RED run. Every pre-existing test in the file still PASSES.

- [ ] **Step 4: Wire the page**

In `src/app/(student)/bookings/page.tsx`, add the imports beside the existing ones:

```tsx
import { PaymentBreakdown } from '@/components/student/payment-breakdown';
import { resolvePaymentBreakdown } from '@/lib/payment-breakdown';
```

In the `past.map((reg) => { … })` callback, directly after `const outstanding = payment ? isOutstanding(payment.status) : false;`, add:

```tsx
            const breakdown = resolvePaymentBreakdown({
              classStatus: cls.status,
              roomCost: cls.roomCost,
              totalRevenue: cls.totalRevenue,
              totalStudents: cls.totalStudents,
              payment,
            });
            if (breakdown.kind === 'snapshot_missing') {
              log.warn(
                { classId: cls.id, registrationId: reg.id },
                'completed class has no pricing snapshot; payment breakdown not rendered',
              );
            }
```

Directly after the "How to pay" block's closing `)}` (the `{payment && outstanding && ( <details …> … </details> )}` expression) and before the row's closing `</div>`, add:

```tsx
                {breakdown.kind === 'shown' && (
                  <PaymentBreakdown
                    lines={breakdown.lines}
                    classType={cls.calendarEntry.classType}
                    date={cls.calendarEntry.date}
                  />
                )}
```

No query change: the registrations query already includes `payment: true` and the class's scalar columns.

The file's first `describe` ("payment status gate") builds a completed class with no snapshot, so after this change the page logs the warning during that suite too. That fixture is out of this issue's scope; leave it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: PASS, every test in the file.

Run: `grep -c 'completed class has no pricing snapshot' worktree-dev.log`
Expected: a non-zero count — the warning fires for the unsnapshotted fixtures. This is the only check on the log line; no test observes the dev server's output. Record the count in the task report.

Run: `pnpm run typecheck && pnpm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git commit -m "feat(bookings): show where a past class's payment went (#576)" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Prove every guard bites**

Mutation protocol as in Global Constraints, warming `/bookings` after each edit. Record failing test and exact error text per row.

| # | Mutation | Must fail |
|---|---|---|
| 3.1 | Page: delete the `{breakdown.kind === 'shown' && ( <PaymentBreakdown … /> )}` expression | both "shows … breakdown" tests |
| 3.2 | `src/lib/payment-breakdown.ts`: `not_charged: true` | `shows a not_charged payment no breakdown` |
| 3.3 | Page: pass `totalRevenue: cls.totalRevenue ?? cls.roomCost` and `totalStudents: cls.totalStudents ?? 0` | `renders a completed class with no snapshot without a breakdown…` |
| 3.4 | Page: pass `totalRevenue: cls.roomCost` | `shows a pending payment the room, teacher and class total behind it` (`€16.25` / `€57.55` missing) |

After the last restore: the integration file green, `git diff --stat` empty.

---

## After the tasks

- Whole-branch review (the plan has three tasks), one fix wave, one scoped re-review — per `solve-issue` §5.
- `pnpm run verify` green before pushing. Its integration tier runs against this worktree's app.
- `pnpm run worktree:down` when done.
- PR body: name `tests/integration/bookings-page.test.ts` as the one integration file touched; carry the mutation ledger from all three tasks; record that the `snapshot_missing` log line is checked only by the `worktree-dev.log` grep in Task 3; **#598 is unaffected**; the tier-adjustment sentence is deferred with `docs/product-concept.md` left as future direction.

## Spec coverage

| Spec section | Task |
|---|---|
| When the disclosure renders (completed, payment, status record, snapshot present) | 1 (gate), 3 (end to end) |
| Exhaustive `Record<PaymentStatus, boolean>` tether | 1 (mutation 1.6) |
| Null snapshot: no disclosure, warning, no throw | 1 (`snapshot_missing`), 3 (log + page 200) |
| Where each number comes from; teacher = total − room | 1 |
| Integer cents; U+2212 minus | 1 (cents), 2 (formatting) |
| Units: resolver / component / page | 1 / 2 / 3 |
| Presentation: after "How to pay", summary copy, `aria-label`, panel classes, rows | 2, 3 |
| Privacy: reads only the class snapshot and the student's own payment | 3 (the page passes only `cls` columns and `reg.payment`) |
| Testing: unit / component / integration; every guard broken once | 1, 2, 3 |
