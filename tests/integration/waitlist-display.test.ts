import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #199. Two display reads qualified one side of the `WaitlistEntry`
 * relationship and forgot the other: `/bookings` filtered the entry's status
 * and not its class's, and the teacher's class detail counted every entry
 * status. `src/services/waitlist.ts` already refuses a non-`open` class in
 * `addToWaitlist:178`, `promoteNext:391`, `claimSpot:523` and
 * `handleSpotFreed:635` — these tests pin the same rule on the reads.
 *
 * Every fixture class is dated 2099 deliberately. The dev server serving these
 * requests runs the scheduler (`src/instrumentation.ts`), and
 * `autoCompleteClasses` sweeps EVERY `in_progress` class with no date filter —
 * a present-dated `in_progress` fixture would be completed underneath the
 * assertion, turning a real failure into a passing one for the wrong reason.
 */

// Distinct `startTime` per class: `Class_teacher_slot_unique` is
// (teacherId, date, startTime) WHERE status <> 'cancelled', so three of the
// four classes below would collide on a shared literal time.
function slot(n: number): string {
  const minute = String(n).padStart(2, '0');
  return `09:${minute}`;
}

const CLASS_DATE = new Date('2099-06-01');

let teacherId = '';
let teacherRoomId = '';
let teacherToken = '';
let studentToken = '';
const classIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];

// The four statuses a `waiting` row can be stranded on, plus the one it is
// legitimately on. `draft` is excluded: a draft class cannot hold a
// registration, so it cannot reach `maxStudents` and cannot form a queue.
const openType = `w199-open-${suffix}`;
const inProgressType = `w199-inprogress-${suffix}`;
const completedType = `w199-completed-${suffix}`;
const cancelledType = `w199-cancelled-${suffix}`;

async function makeClass(
  classType: string,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
  slotIndex: number,
): Promise<string> {
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType,
      date: CLASS_DATE,
      startTime: slot(slotIndex),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 2,
      status,
    },
  });
  classIds.push(cls.id);
  return cls.id;
}

// Returns both ids rather than pushing and letting the caller dig the account
// id back out of `accountIds` — `noUncheckedIndexedAccess` makes that an
// index access needing a `!`, and it would silently break if the push order
// ever changed.
async function makeStudent(tag: string): Promise<{ id: string; accountId: string }> {
  const email = `w199-${tag}-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'W199',
      lastName: tag,
      email,
      claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  // `Student.accountId` is nullable in the schema (CRM-created students stay
  // unclaimed); this fixture always creates the account inline, so the cast
  // is the established idiom (`accountId as string` — see the other files in
  // this suite).
  const accountId = student.accountId as string;
  accountIds.push(accountId);
  return { id: student.id, accountId };
}

beforeAll(async () => {
  await prisma.$connect();

  const teacherEmail = `w199-teacher-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'W199',
      lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: 'W199 fixture teacher',
      pageSlug: `w199-${suffix}`,
    },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountIds.push(teacher.accountId);
  teacherToken = await seedSession(prisma, teacher.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'W199 Studio',
      address: `${suffix} Waitlist St`,
      city: 'Testville',
      postcode: '1234CA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  // A student-only account: `getSession` resolves `teacherId` first when an
  // account carries both profiles (`lib/auth/session.ts:100-106`), so a hybrid
  // fixture would still reach `/bookings` but would muddy what is being tested.
  const strip = await makeStudent('strip');
  studentToken = await seedSession(prisma, strip.accountId);

  const statuses: Array<[string, 'open' | 'in_progress' | 'completed' | 'cancelled']> = [
    [openType, 'open'],
    [inProgressType, 'in_progress'],
    [completedType, 'completed'],
    [cancelledType, 'cancelled'],
  ];

  for (const [i, [classType, status]] of statuses.entries()) {
    const classId = await makeClass(classType, status, i);
    // Written directly, not via `addToWaitlist`: that service throws on a
    // non-`open` class, which is the invariant under test one layer down.
    await prisma.waitlistEntry.create({
      data: { classId, studentId: strip.id, position: 1, status: 'waiting' },
    });
  }
});

afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('GET /bookings (page) — the waitlist strip', () => {
  it('shows a waiting entry on an open class and hides every entry whose class has left open', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Proves the fetch reached `/bookings` with a live session rather than a
    // redirect to `/login`, which would satisfy all three absences for free.
    expect(html).toContain(openType);

    // `cancelled` is the case #199 was filed about. `in_progress` and
    // `completed` are the cases that make this test discriminate: the
    // predicate the issue proposed, `not: 'cancelled'`, passes a test whose
    // only dead fixture is a cancelled class.
    expect(html).not.toContain(inProgressType);
    expect(html).not.toContain(completedType);
    expect(html).not.toContain(cancelledType);
  });
});
