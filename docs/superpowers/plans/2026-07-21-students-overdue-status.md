# Students List Overdue Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-student overdue-payment count ("2 overdue", danger text) in the teacher's students list, with seed data demonstrating a 1/2/3 gradient.

**Architecture:** `GET /api/students` gains an `overduePayments` field computed by one `registration.groupBy` per page, teacher-scoped like the existing class count. `StudentDirectory` renders it as a danger caption stacked under the class count. The seed adds two completed past classes whose payments put Iris at 3 overdue, Hugo at 2, Greta at 1.

**Tech Stack:** Next.js App Router route handler, Prisma, Tailwind v4 tokens, Vitest integration tests (they hit the live app on :3000 — keep `npm run dev` running; hot reload picks up edits).

**Spec:** `docs/superpowers/specs/2026-07-21-students-overdue-status-design.md`

## Global Constraints

- Copy is exactly `{n} overdue` (no pluralization change), hidden when n = 0.
- Danger is text-only: `type-caption text-danger`, never a badge or background.
- List order stays `firstName asc`; no sorting/filtering changes.
- Count only `Payment.status = 'overdue'`, only for classes owned by the requesting teacher.
- TypeScript strict — no `any`.
- Branch: `feat/students-overdue-status` (already created, spec committed).

---

### Task 1: API — `overduePayments` on GET /api/students

**Files:**
- Modify: `tests/integration/students-api.test.ts` (append a new describe block at end of file, after the last existing describe)
- Modify: `src/app/api/students/route.ts:62-81`

**Interfaces:**
- Consumes: existing file-level fixtures in the test file — `prisma`, `teacherId`, `studentIds`, `uniqueSuffix`, `sessionCookie`, `BASE_URL` (all already defined at top of file).
- Produces: every student row in the `GET /api/students` response gains `overduePayments: number`. Task 2 consumes this exact field name.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/students-api.test.ts` (top level, end of file):

```ts
describe('GET /api/students — overduePayments', () => {
  let otherTeacherId: string;
  let roomId: string;
  const overdueClassIds: string[] = [];

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Overdue Studio',
        address: `${uniqueSuffix} Overdue St`,
        city: 'Amsterdam',
        postcode: '1111OD',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, rentalRate: 30 },
    });

    const otherTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `crm-other-${uniqueSuffix}@test.local`,
        account: { create: { email: `crm-other-${uniqueSuffix}@test.local` } },
        bio: 'Scoping fixture for overdue counts',
        pageSlug: `crm-other-${uniqueSuffix}`,
      },
    });
    otherTeacherId = otherTeacher.id;
    const otherTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacher.id, roomId: room.id, rentalRate: 30 },
    });

    async function createCompletedClass(
      ownerTeacherId: string,
      ownerTeacherRoomId: string,
      daysBack: number,
    ) {
      const date = new Date();
      date.setDate(date.getDate() - daysBack);
      date.setHours(0, 0, 0, 0);
      const cls = await prisma.class.create({
        data: {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerTeacherRoomId,
          classType: 'Vinyasa',
          date,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'completed',
          settingsLocked: true,
        },
      });
      overdueClassIds.push(cls.id);
      return cls;
    }

    async function createChargedRegistration(
      classId: string,
      studentId: string,
      paymentStatus: 'overdue' | 'pending' | 'paid',
    ) {
      const reg = await prisma.registration.create({
        data: {
          classId,
          studentId,
          status: 'attended',
          tierAtBooking: 3,
          price: 6.11,
          tierRatio: 1.0,
        },
      });
      await prisma.payment.create({
        data: { registrationId: reg.id, amount: 6.11, status: paymentStatus },
      });
    }

    const clsA = await createCompletedClass(teacherId, teacherRoom.id, 9);
    const clsB = await createCompletedClass(teacherId, teacherRoom.id, 11);
    const clsOther = await createCompletedClass(otherTeacherId, otherTeacherRoom.id, 13);

    // Student00: two overdue payments with the requesting teacher.
    await createChargedRegistration(clsA.id, studentIds[0]!, 'overdue');
    await createChargedRegistration(clsB.id, studentIds[0]!, 'overdue');
    // Student01: overdue payment with the OTHER teacher only.
    await createChargedRegistration(clsOther.id, studentIds[1]!, 'overdue');
    // Student02: pending (not overdue) with the requesting teacher.
    await createChargedRegistration(clsA.id, studentIds[2]!, 'pending');
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { id: { in: overdueClassIds } } });
    await prisma.teacherRoom.deleteMany({ where: { roomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: { email: `crm-other-${uniqueSuffix}@test.local` },
    });
  });

  async function fetchSingleStudent(search: string) {
    const res = await fetch(`${BASE_URL}/api/students?search=${search}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    return json.data.students[0];
  }

  it('counts overdue payments for the requesting teacher', async () => {
    const student = await fetchSingleStudent('Student00');
    expect(student.overduePayments).toBe(2);
  });

  it('ignores overdue payments owed to other teachers', async () => {
    const student = await fetchSingleStudent('Student01');
    expect(student.overduePayments).toBe(0);
  });

  it('does not count pending payments', async () => {
    const student = await fetchSingleStudent('Student02');
    expect(student.overduePayments).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: the three new tests FAIL with `expected undefined to be 2` / `expected undefined to be 0` (field doesn't exist yet). All pre-existing tests in the file still pass.

- [ ] **Step 3: Implement the field in the route**

In `src/app/api/students/route.ts`, after the `Promise.all` (line 64) and before `const result = students.map(...)`, insert:

```ts
  const pageStudentIds = students.map((s) => s.id);
  const overdueGroups = pageStudentIds.length
    ? await prisma.registration.groupBy({
        by: ['studentId'],
        where: {
          studentId: { in: pageStudentIds },
          class: { teacherId: session.teacherId },
          payment: { status: 'overdue' },
        },
        _count: { _all: true },
      })
    : [];
  const overdueByStudent = new Map(
    overdueGroups.map((g) => [g.studentId, g._count._all]),
  );
```

And in the returned mapping object (after `classCount: s._count.registrations,`):

```ts
      overduePayments: overdueByStudent.get(s.id) ?? 0,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: ALL tests in the file PASS (existing + 3 new).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: exit 0.

```bash
git add tests/integration/students-api.test.ts src/app/api/students/route.ts
git commit -m "feat: students list API counts each student's overdue payments"
```

---

### Task 2: UI — danger caption under the class count

**Files:**
- Modify: `src/components/students/student-directory.tsx:11-20` (StudentRow interface) and `:117-124` (right-side block)

**Interfaces:**
- Consumes: `overduePayments: number` from Task 1's API response.
- Produces: visible caption `{n} overdue` (class `type-caption text-danger`) in each row when n > 0. Task 4 verifies it in the browser.

- [ ] **Step 1: Add the field to the row type**

In `StudentRow` (line 11), after `classCount: number;` add:

```ts
  overduePayments: number;
```

- [ ] **Step 2: Render the caption**

Replace the right-side block (currently lines 117–124):

```tsx
                <div className="flex items-center gap-3">
                  <span className="type-caption">
                    {student.classCount} {student.classCount === 1 ? 'class' : 'classes'}
                  </span>
                  {!student.claimedAt && (
                    <span className="type-caption">unlinked</span>
                  )}
                </div>
```

with:

```tsx
                <div className="flex items-center gap-3">
                  <div className="flex flex-col items-end gap-0.5">
                    <span className="type-caption">
                      {student.classCount} {student.classCount === 1 ? 'class' : 'classes'}
                    </span>
                    {student.overduePayments > 0 && (
                      <span className="type-caption text-danger">
                        {student.overduePayments} overdue
                      </span>
                    )}
                  </div>
                  {!student.claimedAt && (
                    <span className="type-caption">unlinked</span>
                  )}
                </div>
```

- [ ] **Step 3: Typecheck and commit**

Run: `npx tsc --noEmit` — expected: exit 0.

```bash
git add src/components/students/student-directory.tsx
git commit -m "feat: students list surfaces overdue payment counts in danger text"
```

---

### Task 3: Seed — overdue gradient (Iris 3, Hugo 2, Greta 1)

**Files:**
- Modify: `prisma/seed.ts` — insert after the payments loop (the `for` loop ending near line 751, before the `NOTIFICATIONS` section) and update the summary `console.log` lines at the end of `main()`.

**Interfaces:**
- Consumes: seed-local variables already in scope at the insertion point: `prisma`, `Prisma`, `ivo`, `ivoYogaschool`, `vinyasaTemplate`, `students`, `tierPriceMap`, `tierRatioMap`, `daysAgo`.
- Produces: after `npm run db:seed` the students list shows Iris `3 overdue`, Hugo `2 overdue`, Greta `1 overdue`.

- [ ] **Step 1: Insert the two completed classes**

```ts
  // ==========================================================================
  // OVERDUE GRADIENT (two more completed classes)
  // ==========================================================================
  // The students list shows per-student overdue counts; seed a visible
  // gradient: Iris 3, Hugo 2, Greta 1. Dev-visual data — per-class totals
  // are plausible, not recomputed by the pricing engine.
  const overdueClassSpecs = [
    {
      date: daysAgo(12),
      effectiveTeacherRate: '16.25',
      totalRevenue: '51.25',
      roster: [
        { student: students[8]!, payment: 'overdue' as const }, // Iris
        { student: students[7]!, payment: 'overdue' as const }, // Hugo
        { student: students[6]!, payment: 'overdue' as const }, // Greta
        { student: students[0]!, payment: 'paid' as const }, // Anna
        { student: students[4]!, payment: 'paid' as const }, // Eva
      ],
    },
    {
      date: daysAgo(14),
      effectiveTeacherRate: '15.00',
      totalRevenue: '50.00',
      roster: [
        { student: students[8]!, payment: 'overdue' as const }, // Iris
        { student: students[7]!, payment: 'overdue' as const }, // Hugo
        { student: students[1]!, payment: 'paid' as const }, // Ben
        { student: students[2]!, payment: 'paid' as const }, // Clara
      ],
    },
  ];

  for (const spec of overdueClassSpecs) {
    const overdueClass = await prisma.class.create({
      data: {
        teacherId: ivo.id,
        teacherRoomId: ivoYogaschool.id,
        templateId: vinyasaTemplate.id,
        classType: 'Vinyasa',
        description: 'Dynamic flow class suitable for all levels.',
        date: spec.date,
        startTime: '09:00',
        durationMinutes: 75,
        roomCost: new Prisma.Decimal('35.00'),
        minRate: new Prisma.Decimal('15.00'),
        targetRate: new Prisma.Decimal('25.00'),
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'completed',
        settingsLocked: true,
        effectiveTeacherRate: new Prisma.Decimal(spec.effectiveTeacherRate),
        totalStudents: spec.roster.length,
        totalRevenue: new Prisma.Decimal(spec.totalRevenue),
      },
    });

    for (const { student, payment } of spec.roster) {
      const reg = await prisma.registration.create({
        data: {
          classId: overdueClass.id,
          studentId: student.id,
          status: 'attended',
          tierAtBooking: student.incomeTier,
          price: new Prisma.Decimal(tierPriceMap[student.incomeTier]!),
          tierRatio: new Prisma.Decimal(tierRatioMap[student.incomeTier]!),
          registeredAt: new Date(spec.date.getTime() - 3 * 86400_000),
        },
      });
      await prisma.payment.create({
        data: {
          registrationId: reg.id,
          amount: reg.price!,
          status: payment,
          method: payment === 'paid' ? 'bank_transfer' : null,
          paidAt: payment === 'paid' ? spec.date : null,
          reminderSentAt: payment === 'overdue' ? daysAgo(2) : null,
        },
      });
    }
  }
```

- [ ] **Step 2: Update the summary lines**

Replace:

```ts
  console.log(`  Classes: 6 (draft, open, open+full, in_progress, completed, cancelled)`);
```

with:

```ts
  console.log(`  Classes: 8 (draft, open, open+full, in_progress, 3 completed, cancelled)`);
```

Replace:

```ts
  console.log(`  Registrations: 33`);
  console.log(`  Payments: 9 (5 paid, 3 pending, 1 overdue)`);
```

with:

```ts
  console.log(`  Registrations: 42`);
  console.log(`  Payments: 18 (9 paid, 3 pending, 6 overdue)`);
```

- [ ] **Step 3: Re-seed and verify counts**

Run: `npm run db:seed`
Expected: completes, summary prints `Payments: 18 (9 paid, 3 pending, 6 overdue)`.

Then verify per-student counts:

```bash
npx tsx --eval "
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
async function main() {
  const rows = await p.registration.groupBy({
    by: ['studentId'],
    where: { payment: { status: 'overdue' } },
    _count: { _all: true },
  })
  const students = await p.student.findMany({
    where: { id: { in: rows.map(r => r.studentId) } },
    select: { id: true, firstName: true },
  })
  console.log(rows.map(r => [students.find(s => s.id === r.studentId)?.firstName, r._count._all]))
}
main().finally(() => p.\$disconnect())
"
```

Expected: `[ [ 'Iris', 3 ], [ 'Hugo', 2 ], [ 'Greta', 1 ] ]` (any order).

- [ ] **Step 4: Commit**

```bash
git add prisma/seed.ts
git commit -m "feat: seed an overdue gradient — Iris 3, Hugo 2, Greta 1"
```

---

### Task 4: End-to-end verification and PR

**Files:**
- No new files (screenshot goes to the session scratchpad, not the repo).

**Interfaces:**
- Consumes: everything above, running dev server on :3000, seeded DB.

- [ ] **Step 1: Full test pass**

Run: `npx vitest run` — expected: unit + integration projects all pass.
Run: `npx tsc --noEmit` — expected: exit 0.
Run: `npx next lint` (or `npm run lint` if defined) — expected: no errors.

- [ ] **Step 2: Browser verification**

Mint a session for `ivo@fairyoga.dev` (account-era: `Session.accountId`), open `/students` with Playwright, screenshot, and confirm the rows read: Iris Meijer `3 overdue`, Hugo v. `2 overdue`, Greta van Dijk `1 overdue`, all in danger red under the class count; students without overdue payments show no extra caption; `unlinked` still renders for Lena/Max. Delete the minted session row afterwards.

- [ ] **Step 3: Push and open PR**

```bash
git push -u origin feat/students-overdue-status
gh pr create --title "feat: overdue payment counts in the students list" --body "<summary + test plan>"
```

Expected: PR opens against `main`, CI runs `checks` + `test` jobs green.
