import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #199. Two display reads qualified one side of the `WaitlistEntry`
 * relationship and forgot the other: `/bookings` filtered the entry's status
 * and not its class's, and the teacher's class detail counted every entry
 * status. `src/services/waitlist.ts` already refuses a non-`open` class in
 * `addToWaitlist`, `promoteNext`, `claimSpot` and `handleSpotFreed` — these
 * tests pin the same rule on the reads. (Named, not cited by line: #212 moved
 * every one of them and the four line numbers that used to be here all landed
 * mid-expression.)
 *
 * Every fixture class is dated 2099 deliberately, and the date is load-bearing
 * for all three class-transition sweeps. The dev server serving these requests
 * runs the scheduler (`src/instrumentation.ts`), and every one of them would
 * otherwise reach these rows:
 *
 * - `autoTransitionToInProgress` — its query filters `date: { lte: now + 24h }`,
 *   so a 2099 row is never even fetched.
 * - `autoCancelClasses` — **its query has no date filter either**
 *   (`where: { status: 'open' }`), so these five open rows ARE fetched every 60
 *   seconds and skipped per-class. The `minStudents` pre-filter does not save
 *   them: every fixture class has `minStudents: 1` and ZERO registrations. Only
 *   `inCancelWindow` does. This is the one most likely to bite.
 * - `autoCompleteClasses` — EVERY `in_progress` class, no date filter; only the
 *   computed end instant holds it off.
 *
 * (All three live in `src/services/class-transitions.ts`; grep the predicate
 * rather than trusting a line number, which is what rotted last time.)
 *
 * Any of the three rewrites a status underneath an assertion, and the absence
 * assertions below would still pass — from a status the fixture never set.
 * That is #138's failure mode: a check that runs when both paths agree.
 */

// Distinct `startTime` per class: `CalendarEntry_teacher_slot_excl` is
// (teacherId WITH =, span WITH &&) WHERE "cancelledAt" IS NULL, so four of the
// five classes below would collide on a shared literal time — the four
// uncancelled ones. Add a class here and give it its own index.
//
// A minute apart, and the fixture's DURATION below is a minute to match:
// #327 made the constraint refuse an OVERLAP where the key it replaced refused
// only an identical start time.
function slot(n: number): string {
  const minute = String(n).padStart(2, '0');
  return `09:${minute}`;
}

/**
 * The rendered page, with the two things that split a sentence in the markup
 * taken out: React's text-node `<!-- -->` separators and its HTML-escaping of
 * an apostrophe.
 *
 * The entity half was added in #327 and the reason is worth keeping. These
 * assertions used to match `didn't get a spot` against the RSC flight payload
 * in the trailing `self.__next_f.push` scripts, where the apostrophe is raw —
 * not against the `<p>` that actually renders it, where React writes
 * `&#x27;`. That worked only while the payload happened to keep the whole
 * sentence inside one push chunk, and this branch changed the page's props
 * (the calendar identity moved to `CalendarEntry`, so the serialized tree
 * differs), which moved the chunk boundary into the middle of the sentence.
 * Normalising here makes the assertion about the rendered element, which is
 * what these tests are actually named for.
 */
function normalise(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&#x27;', "'");
}

const CLASS_DATE = new Date('2099-06-01');

// Deliberately initialised to `''`, never left `undefined`: Prisma treats an
// `undefined` filter value as NO FILTER, so a `beforeAll` that threw before the
// teacher create would turn `teacherRoom.deleteMany({ where: { teacherId } })`
// in the teardown into a delete-everything against the shared dev database.
let teacherId = '';
let teacherRoomId = '';
let teacherToken = '';
let studentToken = '';
let onlyDeadToken = '';
let countClassId = '';
let openClassId = '';
let completedClassId = '';
const classIds: string[] = [];
const accountIds: string[] = [];
const studentIds: string[] = [];

// The three statuses a `waiting` row can be stranded on, plus the one it is
// legitimately on. `draft`, the remaining `ClassStatus` value, is excluded for a
// stronger reason than "a draft class holds no registrations": no transition
// targets it. `VALID_TRANSITIONS` (`class-lifecycle.ts`) lists `draft` as a
// source only, so `sourceStatesFor('draft')` is empty and the CAS matches
// nothing — a class cannot re-enter `draft`, and `addToWaitlist` only ever
// writes against an `open` one. `cancelled` is reachable in principle but not
// in practice since #195 closed all three cancel paths' queues to `removed`;
// its fixture below is a defensive pin against a fourth cancel path that
// forgets to, not a reproduction of live data.
const openType = `w199-open-${suffix}`;
const inProgressType = `w199-inprogress-${suffix}`;
const completedType = `w199-completed-${suffix}`;
const cancelledType = `w199-cancelled-${suffix}`;

async function makeClass(
  classType: string,
  status: 'open' | 'in_progress' | 'completed' | 'cancelled',
  slotIndex: number,
): Promise<string> {
  const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType,
      date: CLASS_DATE,
      startTime: hhmmToTime(slot(slotIndex)),
      durationMinutes: 1,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 2,
      status: status === 'cancelled' ? 'open' : status,
      cancelledAt: status === 'cancelled' ? new Date() : null,
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
  // `Student.accountId` is nullable in the schema; this fixture always creates
  // the account inline, so the cast is the established idiom in this suite
  // (`accountId as string` — `invitations-api.test.ts`, `account-api.test.ts`,
  // `privacy-page.test.ts`, `registrations-api.test.ts`). Deliberately not
  // restating WHY the column is nullable: the reason next to it in the schema
  // has already rotted once, and a second copy here would rot with it.
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

  // Student-only accounts: `validateSession` resolves `teacherId` first when an
  // account carries both profiles (`lib/auth/session.ts:100-106`, reached
  // through the `getSession` wrapper in `lib/session.ts`), so a hybrid fixture
  // would still reach `/bookings` but would muddy what is being tested.
  const strip = await makeStudent('strip');
  studentToken = await seedSession(prisma, strip.accountId);

  // A second student who holds ONLY dead entries, which pins two things the
  // first student cannot.
  //
  // 1. That the filter lives in the QUERY, not the render. Move it into the
  //    map — leave `where` unfiltered and wrap the row in
  //    `cls.status === 'open' &&` — and every assertion about `strip` still
  //    passes, while this student gets a "Waitlist" heading above zero rows AND
  //    loses the empty state, because line 102's condition reads
  //    `waitlistEntries.length`. That phantom section is the outcome spec §3.1
  //    exists to prevent, so it must not be able to ship green.
  // 2. That the ENTRY-status half of the predicate still bites. Delete
  //    `status: 'waiting'` and this student's `removed` entry on the OPEN class
  //    starts rendering, so the empty state disappears. Otherwise that half is
  //    pinned only by Playwright, which `npm run verify` does not run.
  const onlyDead = await makeStudent('only-dead');
  onlyDeadToken = await seedSession(prisma, onlyDead.accountId);

  const statuses: Array<[string, 'open' | 'in_progress' | 'completed' | 'cancelled']> = [
    [openType, 'open'],
    [inProgressType, 'in_progress'],
    [completedType, 'completed'],
    [cancelledType, 'cancelled'],
  ];

  for (const [i, [classType, status]] of statuses.entries()) {
    const classId = await makeClass(classType, status, i);
    if (status === 'open') openClassId = classId;
    if (status === 'completed') completedClassId = classId;
    // Written directly, not via `addToWaitlist`: that service throws on a
    // non-`open` class — the invariant under test one layer down — and on this
    // fixture's `open` class too, since `class_not_full` rejects a join while
    // the class has seats and these classes carry zero registrations.
    await prisma.waitlistEntry.create({
      data: { classId, studentId: strip.id, position: 1, status: 'waiting' },
    });
  }

  // The `only-dead` student's two entries. `removed` on the OPEN class and
  // `waiting` on the COMPLETED one, so each of the predicate's two halves is
  // the sole thing excluding one of them.
  await prisma.waitlistEntry.createMany({
    data: [
      { classId: openClassId, studentId: onlyDead.id, position: 2, status: 'removed' },
      { classId: completedClassId, studentId: onlyDead.id, position: 2, status: 'waiting' },
    ],
  });

  // The count fixture: one class carrying one entry in each of five states —
  // `waiting`, `promoted`, `claimed`, `removed`, `expired`. Every property is
  // load-bearing, and each was added because a wrong predicate survived
  // without it:
  //
  // - FIVE entries against ONE `waiting` makes the filtered and unfiltered
  //   counts differ by four, so no off-by-one predicate reproduces the right
  //   answer. A symmetric fixture is the shape that let #39 ship three guards
  //   that could not fail.
  // - `promoted` kills `status: { not: 'removed' }` — a natural mistake
  //   ("removed means gone") that renders 1 against `1 waiting + 2 removed`,
  //   which is what this fixture was before review.
  // - `claimed` kills `status: { notIn: ['removed', 'promoted'] }`, the same
  //   negative enumeration one step further out. It is not hypothetical:
  //   `api/registrations/route.ts` writes `claimed` when a queued student books
  //   directly, so it is the second of the two double-counts the production
  //   comment names.
  // - `removed` stays represented: it is the state every queue #195 closed now
  //   sits in.
  //
  // - `expired` kills `status: { notIn: ['removed','promoted','claimed'] }`,
  //   the negative enumeration one step further out again. No longer
  //   hypothetical: `closeQueueOnStart` (`waitlist.ts`, #216) writes it every
  //   time a class starts with an unfulfilled queue, which is the ordinary
  //   case for any class that filled. Unlike `promoted` and `claimed`, this
  //   is not a double-count — `closeQueueOnStart` writes no `Registration`,
  //   it only flips the entry's status, so an `expired` student is counted
  //   once when they should not be counted at all. The leak has a simpler
  //   cause: a negative enumeration cannot exclude a state that did not
  //   exist when it was written, which is exactly what just happened on
  //   this branch.
  //
  // The closed rows deliberately carry no `registrationId`: in production
  // `promoteNext` and `claimSpot` write one (`activateRegistration`, linked on
  // the entry update), but the count query never reads it, and fixture
  // `Registration`s would add entities to this graph to assert nothing.
  // `promotedAt` is set so the rows are not obviously synthetic.
  countClassId = await makeClass(`w199-count-${suffix}`, 'open', 4);
  const waiting = await makeStudent('count-waiting');
  const seated = await makeStudent('count-promoted');
  const booked = await makeStudent('count-claimed');
  const gone = await makeStudent('count-gone');
  const lapsed = await makeStudent('count-expired');
  await prisma.waitlistEntry.createMany({
    data: [
      { classId: countClassId, studentId: waiting.id, position: 1, status: 'waiting' },
      {
        classId: countClassId,
        studentId: booked.id,
        position: 4,
        status: 'claimed',
        promotedAt: new Date(),
      },
      {
        classId: countClassId,
        studentId: seated.id,
        position: 2,
        status: 'promoted',
        promotedAt: new Date(),
      },
      { classId: countClassId, studentId: gone.id, position: 3, status: 'removed' },
      {
        classId: countClassId,
        studentId: lapsed.id,
        position: 5,
        status: 'expired',
        promotedAt: new Date(),
      },
    ],
  });
});

afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
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

  it('shows the empty state to a student holding only dead entries, so the filter cannot live in the render', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(onlyDeadToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The whole point of asserting the empty state rather than an absence: a
    // render-time filter also hides the rows, but leaves `waitlistEntries`
    // non-empty, so the "Waitlist" heading renders above nothing AND this
    // condition (`upcoming/past/waitlistEntries` all empty) stops holding.
    expect(html).toContain('No bookings yet');
    expect(html).not.toContain('Waitlist');

    // This student's other entry is `removed` on the OPEN class, so the
    // entry-status half of the predicate is the only thing hiding it. Without
    // that half the row renders and the empty state disappears — otherwise
    // that half is pinned only by Playwright, which `npm run verify` never runs.
    expect(html).not.toContain(openType);
  });
});

describe('GET /class/[id] (page) — the waitlist count', () => {
  it('counts waiting entries only — neither a closed queue nor a seated student inflates it', async () => {
    const res = await fetch(`${BASE_URL}/class/${countClassId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);

    // React's SSR splices `<!-- -->` around a dynamic text node that sits
    // beside a static one, and `class-info.tsx`'s `{waitlistCount} on waitlist`
    // is exactly that shape. The raw HTML therefore reads
    // `1<!-- --> on waitlist`, and a plain `toContain('1 on waitlist')` fails
    // against correct output. Stripping the markers asserts on what a reader
    // sees. (`privacy-page.test.ts` needs no such step because the page it
    // checks builds its name as one template string.)
    const html = normalise(await res.text());

    expect(html).toContain('1 on waitlist');

    // Each number names a predicate that would produce it: 5 unfiltered, 4
    // under `not: 'removed'`, 3 under `notIn: ['removed','promoted']`, 2
    // under `notIn: ['removed','promoted','claimed']`. All four keep counting
    // students who hold a live registration on this same page — in
    // production, not in this fixture, whose closed rows carry no
    // `registrationId` deliberately. The discrimination lives in the fixture;
    // these assertions document it.
    expect(html).not.toContain('5 on waitlist');
    expect(html).not.toContain('4 on waitlist');
    expect(html).not.toContain('3 on waitlist');
    expect(html).not.toContain('2 on waitlist');
  });

  /**
   * Whole-branch review of #216/#182. A fresh class+fixture, not the
   * shared `countClassId` above: that one is deliberately `open`, and its
   * `expired` row proves the OPPOSITE of this test — that `expired` must NOT
   * be folded into the count there. `in_progress` is the one status where it
   * must, because a teacher can still walk a queued student in at the door
   * (`api/registrations/route.ts` now matches `waiting` OR `expired`), and
   * the count is the only cue that anyone was waiting when the class started.
   */
  it('counts every claimable entry while in_progress, and names the set it counted', async () => {
    const inProgressCountClassId = await makeClass(`w199-inprog-count-${suffix}`, 'in_progress', 5);
    const waitingHere = await makeStudent('inprog-waiting');
    const expiredHere = await makeStudent('inprog-expired');
    const removedHere = await makeStudent('inprog-removed');
    await prisma.waitlistEntry.createMany({
      data: [
        { classId: inProgressCountClassId, studentId: waitingHere.id, position: 1, status: 'waiting' },
        {
          classId: inProgressCountClassId,
          studentId: expiredHere.id,
          position: 2,
          status: 'expired',
          promotedAt: new Date(),
        },
        // The third row is what makes this a boundary rather than a total.
        // `removed` is deliberately OUTSIDE `CLAIMABLE_WAITLIST_STATUSES` — that
        // student left, so no walk-in can resolve them — and the count beside
        // the **Add walk-in** button must agree with what the button can
        // actually consume. Without this row, widening the page's count to
        // every status is green while the resolver stays narrow, and those two
        // disagreeing is precisely the #216 regression.
        {
          classId: inProgressCountClassId,
          studentId: removedHere.id,
          position: 3,
          status: 'removed',
        },
      ],
    });

    const res = await fetch(`${BASE_URL}/class/${inProgressCountClassId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    // Both rows counted — `waiting` AND `expired`, the two members of
    // `CLAIMABLE_WAITLIST_STATUSES` — because both can still be walked in.
    //
    // "didn't get a spot", not "2 on waitlist" (#199's defect: a present-tense
    // claim about a queue that can no longer be joined) and not "2 were on the
    // waitlist" either, which would assert a historical total this number is
    // not — it excludes anyone promoted before the class started, and it falls
    // as the teacher walks people in. The sentence has to describe the set that
    // was actually counted.
    expect(html).toContain("2 didn't get a spot");
    expect(html).not.toContain('2 on waitlist');
    // Three entries exist; only the two claimable ones are counted.
    expect(html).not.toContain("3 didn't get a spot");
  });

  it('drops the count once the class can no longer consume its queue', async () => {
    // The completed class carries two `waiting` entries (one per student), so
    // an ungated render reads "2 on waitlist" on a class that has finished —
    // the teacher-side twin of the defect #199 was filed about, and the reason
    // filtering the entry status alone was only half the fix. Nothing can
    // promote or walk in a waiter here: `promoteNext`, `claimSpot` and
    // `handleSpotFreed` all require `open`, and so does a non-teacher booking.
    const res = await fetch(`${BASE_URL}/class/${completedClassId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    // Proves the page rendered rather than redirecting — `class-info.tsx`
    // always emits this clause, and only for a class this teacher owns.
    expect(html).toContain('registered · needs');
    expect(html).not.toContain('on waitlist');
  });
});
