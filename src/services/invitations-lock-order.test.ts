import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { acceptInvitation, unlinkTeacher } from './invitations';
import { resolveInvitationOnLink } from './link-consent';
import { hhmmToTime } from '@/lib/time-of-day';

/**
 * Lock-ORDER invariants for the two table pairs #174 task 7 fixed:
 * `{Invitation, TeacherStudent}` and `{StudentPrivacy, TeacherStudent}`.
 *
 * These are database invariants, not HTTP ones — nothing here calls the app
 * on `:3000`, there is no `BASE_URL`, no session, no `fetch`. They provoke
 * real `40P01` deadlocks, hold transactions open for hundreds of
 * milliseconds, and create and delete `Teacher`/`Student`/`Account` rows.
 *
 * That is why they live here rather than in `tests/integration/`, where they
 * first landed. The `integration` project deliberately runs against the
 * database the app on `:3000` reads — dev, locally (`docs/test-database.md`)
 * — because its fixtures have to be visible to that process. `vitest.config
 * .ts` gives it no `DATABASE_URL` override for exactly that reason. The
 * `unit` project is the one forced onto the isolated `DATABASE_URL_TEST` by
 * `tests/setup/unit-db.ts`. Two commits earlier this same branch moved
 * `class-terminal-status.test.ts` out of `tests/integration/` on precisely
 * this reasoning, and its docblock spells it out; these two describes were
 * written before that and stayed behind.
 */
const prisma = new PrismaClient();

function uniqueSuffix(): string {
  return `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Invitation and TeacherStudent take one lock order (#174 task 7)', () => {
  const lockOrderTeacherIds: string[] = [];
  const lockOrderTeacherAccountIds: string[] = [];
  const lockOrderStudentIds: string[] = [];
  const lockOrderStudentAccountIds: string[] = [];
  const lockOrderRoomIds: string[] = [];

  afterAll(async () => {
    if (lockOrderTeacherIds.length) {
      await prisma.registration.deleteMany({
        where: { class: { teacherId: { in: lockOrderTeacherIds } } },
      });
      await prisma.class.deleteMany({ where: { teacherId: { in: lockOrderTeacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: lockOrderTeacherIds } } });
      await prisma.invitation.deleteMany({ where: { teacherId: { in: lockOrderTeacherIds } } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: lockOrderTeacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: lockOrderTeacherIds } } });
    }
    if (lockOrderStudentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: lockOrderStudentIds } } });
    }
    if (lockOrderRoomIds.length) {
      await prisma.room.deleteMany({ where: { id: { in: lockOrderRoomIds } } });
    }
    if (lockOrderTeacherIds.length) {
      await prisma.teacher.deleteMany({ where: { id: { in: lockOrderTeacherIds } } });
    }
    const accountIds = [...lockOrderTeacherAccountIds, ...lockOrderStudentAccountIds];
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });

  /**
   * An open class for one of this describe's teachers. Only the booking-race
   * test needs one — the counterparty there is `POST /api/registrations`'
   * real statement order, which opens by locking a `Class` row and inserting
   * a `Registration` before it ever reaches `TeacherStudent`, and that
   * prelude is exactly what makes the accept reach the link first.
   */
  async function makeOpenClass(teacherId: string) {
    const local = uniqueSuffix();
    const room = await prisma.room.create({
      data: {
        venueName: 'Lock Order Studio',
        address: `${local} Lock St`,
        city: 'Amsterdam',
        postcode: '1234LO',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    lockOrderRoomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Lock Order Flow',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      },
      select: { id: true },
    });
  }

  /**
   * A fresh teacher/student pair with a pending Invitation, and — when
   * `linked` — a roster link that already exists, as if the student had
   * booked a class while the invitation sat waiting.
   *
   * `linked` is not cosmetic; it decides whether `acceptInvitation`'s
   * `teacherStudent.upsert` takes a row lock at all. With the row present,
   * `upsert({ where, update: {}, create })` compiles to three plain,
   * non-locking `SELECT`s on this Prisma version (see the quirk section of
   * `docs/lock-order.md`), so the upsert never asks for the lock and the
   * write ORDER is unobservable — which is exactly what the hand-rolled
   * tests below exist to work around, by forcing a non-empty `update`.
   * Without the row, the same call genuinely `INSERT`s, and an `INSERT`
   * against a `@@unique([teacherId, studentId])` index DOES block a
   * concurrent inserter of the same key. That is the only shape in which
   * the real, unmodified `acceptInvitation` can be caught taking its two
   * rows in the wrong sequence.
   *
   * A fresh teacher AND student every call, not the file's shared
   * `teacherId`/`studentId` fixtures — more than one test below calls this,
   * and each needs its own untouched (teacherId, studentId) pair to race on,
   * not one a previous test already mutated.
   */
  async function makeLinkedStudentWithPendingInvite({ linked = true }: { linked?: boolean } = {}) {
    const local = uniqueSuffix();
    const email = `lock-order-${local}@test.local`;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock', lastName: 'Order',
        email: `lock-order-teacher-${local}@test.local`,
        account: { create: { email: `lock-order-teacher-${local}@test.local` } },
        bio: '#174 task 7 lock-order fixture teacher',
        pageSlug: `lock-order-${local}`,
      },
      select: { id: true, accountId: true },
    });
    lockOrderTeacherIds.push(teacher.id);
    lockOrderTeacherAccountIds.push(teacher.accountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'Lock', lastName: 'Order', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    lockOrderStudentIds.push(student.id);
    lockOrderStudentAccountIds.push(student.accountId as string);

    // The link exists because the student booked a class — simulated
    // directly rather than through a real booking, which this describe has
    // no need to exercise.
    if (linked) {
      await prisma.teacherStudent.create({
        data: { teacherId: teacher.id, studentId: student.id },
      });
    }

    // The invitation is still pending because the teacher added them as a
    // CRM contact separately — the second, independent precondition #174's
    // gap needs.
    const invitation = await prisma.invitation.create({
      data: { teacherId: teacher.id, email, firstName: 'Lock', lastName: 'Order' },
      select: { id: true },
    });

    return { teacherId: teacher.id, studentId: student.id, email, invitationId: invitation.id };
  }

  /**
   * The literal reproduction the brief specified (#174's acceptance 3),
   * kept as historical evidence rather than deleted once the fix landed —
   * this is WHY `acceptInvitation` still needed reordering even though it
   * does not fail this exact assertion. Run against unmodified `main` this
   * produced ZERO rejections, not the one 40P01 the brief expected: both
   * transactions committed. Confirmed by direct query logging (`DEBUG=
   * prisma:query` emits nothing at all on Prisma 6.19.3 — a standalone
   * `new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })` was
   * used instead) that `tx.teacherStudent.upsert({ where, update: {},
   * create })` compiles to three plain, non-locking `SELECT`s when the row
   * already exists, not an atomic `INSERT ... ON CONFLICT DO UPDATE` — so
   * transaction A's upsert never asks Postgres for the row lock the cycle
   * needs, and there is nothing left to deadlock over. That is an accident
   * of how Prisma compiles an empty `update` object, not a property of the
   * write order — see the next two tests for what the order alone actually
   * guarantees.
   */
  it('with the real empty-update upsert, the opposite order does not currently deadlock — the accident #174 stopped relying on', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedStudentWithPendingInvite();

    let bReady!: () => void;
    const bHasLink = new Promise<void>((r) => { bReady = r; });

    const a = prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      await bHasLink;
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId, studentId } },
        update: {},
        create: { teacherId, studentId },
      });
    }, { timeout: 15_000 });

    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.deleteMany({ where: { teacherId, studentId } });
      bReady();
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
  });

  /**
   * Pins the mechanism the test above only describes in prose: give the
   * SAME opposite order a `TeacherStudent` write with one real column in it
   * — `update: { isArchived: false }`, chosen because it is harmless and
   * already a real field on the row — and Prisma switches to the atomic
   * `INSERT ... ON CONFLICT DO UPDATE`, which DOES take the row lock. The
   * cycle re-forms and Postgres answers with `40P01` again. This is what
   * makes the empty-update protection "one payload away from vanishing"
   * rather than a permanent safety net: nothing stops a future edit to
   * `acceptInvitation`'s `update: {}` (a bookkeeping field, an
   * `updatedAt`, anything) from landing exactly here with no warning.
   */
  it('the opposite order deadlocks once the TeacherStudent write is not empty — the quirk this project stopped relying on', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedStudentWithPendingInvite();

    let bReady!: () => void;
    const bHasLink = new Promise<void>((r) => { bReady = r; });

    const a = prisma.$transaction(async (tx) => {
      await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
      await bHasLink;
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId, studentId } },
        update: { isArchived: false },
        create: { teacherId, studentId },
      });
    }, { timeout: 15_000 });

    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.deleteMany({ where: { teacherId, studentId } });
      bReady();
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    const rejections = results.filter((r) => r.status === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
  });

  /**
   * The other half of the pin: the SAME non-empty `TeacherStudent` write
   * that deadlocks above, in `unlinkTeacher`'s order — `TeacherStudent`
   * before `Invitation` — does not. This is the property the reorder in
   * `acceptInvitation` actually buys, independent of whether Prisma keeps
   * compiling an empty `update` the way it does today: even if a future
   * edit (or a future Prisma version) makes every `TeacherStudent` upsert
   * in this codebase take a real lock, the write order alone is enough to
   * prevent the cycle, because both sides now agree which row to reach for
   * first.
   *
   * No `bReady`/`bHasLink` handshake here, unlike the two tests above —
   * deliberately, not an oversight. Both transactions now reach for
   * `TeacherStudent` FIRST, so forcing A to wait for a signal from B before
   * touching it would deadlock the TEST: B's own first statement contends
   * for that same row, so if A wins the race for it, B's `deleteMany` blocks
   * waiting on A, and A is waiting on a signal only B's completed first
   * statement can send — B can never send it. (This is exactly what
   * happened on the first draft of this test: a 5s vitest timeout, not a
   * Postgres one.) A shared first resource makes the two transactions
   * strictly serialize there — whichever gets it first simply runs to
   * completion while the other waits its turn — and that serialization IS
   * the property under test, so it needs no forcing.
   */
  it('the reordered write survives the same non-empty upsert — the fix does not depend on the quirk', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedStudentWithPendingInvite();

    // TeacherStudent BEFORE Invitation — the order `acceptInvitation` now
    // uses, hand-rolled here (rather than calling the real function) so the
    // `update` payload can be forced non-empty.
    const a = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId, studentId } },
        update: { isArchived: false },
        create: { teacherId, studentId },
      });
      await tx.invitation.updateMany({
        where: { id: invitationId, status: 'pending' },
        data: { status: 'accepted', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.deleteMany({ where: { teacherId, studentId } });
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
  });

  /**
   * Kept, but demoted to what it actually is: a smoke test that the real
   * `acceptInvitation` and a real-shaped unlink coexist. It cannot fail on
   * the write order, and the four-specialist review of #174 proved that by
   * reverting the reorder in `invitations.ts` and watching it stay green.
   * The fixture is `linked`, so the upsert takes the three-`SELECT` path and
   * never requests the row lock the cycle needs — in EITHER order. The
   * falsifiable version is the test below it.
   */
  it('the real accept and a real-shaped unlink coexist on an existing link', async () => {
    const { teacherId, studentId, email, invitationId } = await makeLinkedStudentWithPendingInvite();

    const b = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.deleteMany({ where: { teacherId, studentId } });
      await new Promise((r) => setTimeout(r, 200));
      await tx.invitation.updateMany({
        where: { teacherId, email },
        data: { status: 'declined', respondedAt: new Date() },
      });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([
      acceptInvitation(prisma, { invitationId, studentId, accountEmail: email }),
      b,
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
  });

  /**
   * The primary regression test for the reorder: it observes the ORDER the
   * real, unmodified `acceptInvitation` issues its two writes in, and fails
   * the moment that order changes.
   *
   * Why the order and not a deadlock, given that the test below DOES
   * reproduce one. Because this assertion holds regardless of scheduling.
   * The cycle below needs the booking to have inserted its `TeacherStudent`
   * row before the accept reaches its own, which is one round trip wide and
   * has to be forced with a handshake. The write order is the property
   * the fix actually changed, and it is observable without racing anything.
   *
   * (An earlier version of this docblock asserted that NO counterparty could
   * make the real function deadlock under the old order — that Prisma's
   * non-atomic upsert answers `P2002` in both orders, so nothing could
   * discriminate. That was false, and false because it generalised from a
   * single arm: only the fixed order was ever run, against a counterparty
   * whose `teacherStudent.upsert` came FIRST, which is not where `POST
   * /api/registrations` puts it. See the test below for the reproduction.)
   *
   * What remains true and is worth keeping: with a link already present,
   * `upsert({ where, update: {}, create })` compiles to three non-locking
   * `SELECT`s, so the real function asks for no `TeacherStudent` lock in
   * either order — that is why the tests above hand-roll a synthetic
   * non-empty `update`, and why the previous version of THIS test passed
   * with the reorder reverted. The fixture here is unlinked so the recorded
   * upsert is the lock-taking `INSERT` path, the write whose position
   * actually matters.
   *
   * The result assertion is `{ ok: true }`, not "did not reject". The
   * previous version only checked that nothing threw, which a version of
   * `acceptInvitation` that refused every accept it was ever handed would
   * also satisfy.
   */
  it('takes TeacherStudent before Invitation, and accepts', async () => {
    const { teacherId, studentId, email, invitationId } =
      await makeLinkedStudentWithPendingInvite({ linked: false });

    // The premise, asserted rather than assumed: this records the upsert on
    // its INSERT path, which it only takes with no row already here.
    expect(
      await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId } },
      }),
    ).toBeNull();

    const writes: string[] = [];
    const recording = prisma.$extends({
      query: {
        teacherStudent: {
          async upsert({ args, query }) {
            writes.push('TeacherStudent');
            return query(args);
          },
        },
        invitation: {
          async updateMany({ args, query }) {
            writes.push('Invitation');
            return query(args);
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `acceptInvitation`'s `PrismaClient`-typed `db` parameter even though
      // every method it calls here is the real one, running against the real
      // database — the same cast the hooks in `gdpr.test.ts` and
      // `class-transitions.test.ts` take.
    }) as unknown as PrismaClient;

    const result = await acceptInvitation(recording, {
      invitationId,
      studentId,
      accountEmail: email,
    });

    expect(result).toEqual({ ok: true });
    expect(writes).toEqual(['TeacherStudent', 'Invitation']);

    // The function's actual job, checked because "the writes happened in this
    // order" is satisfied by two writes that both did nothing.
    expect(
      await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId } },
      }),
    ).not.toBeNull();
    expect(
      (await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } })).status,
    ).toBe('accepted');
  });

  /**
   * The cycle the reorder actually closes, against a real production writer.
   *
   * The counterparty is `POST /api/registrations`' own statement order,
   * copied rather than paraphrased, and the copying is the whole point: the
   * route takes the `Class` row lock, reads, inserts the `Registration`, and
   * only THEN upserts `TeacherStudent` before reaching `Invitation` through
   * `resolveInvitationOnLink`. A counterparty that upserts `TeacherStudent`
   * as its FIRST statement — which is what an earlier attempt at this test
   * used — always wins that insert, so the accept can only ever lose it with
   * `P2002` and the orders look indistinguishable. That mistake is why this
   * file briefly claimed no such reproduction existed.
   *
   * With the real order, on an unlinked pair, both transactions `INSERT` the
   * same `(teacherId, studentId)` key, and Postgres makes the second inserter
   * wait on the first's uncommitted tuple — a wait that participates in
   * deadlock detection exactly like a row lock. So:
   *
   *   old order  accept: Invitation (held) -> TeacherStudent (blocked)
   *              booking: TeacherStudent (held) -> Invitation (blocked)   40P01
   *   new order  accept: TeacherStudent first, so it never holds Invitation
   *              while asking for the link — no cycle to detect
   *
   * Measured three runs per order:
   *
   *   old: {"accept":"REJECTED 40P01","booking":"ok"}   x3
   *   new: {"accept":"REJECTED P2002","booking":"ok"}   x3
   *
   * The handshake is not optional and does not create the inversion. The
   * window between the booking's insert and the accept's is one round trip
   * wide, so unforced this is a race rather than a reproduction: with the
   * reorder reverted and the handshake removed, 1 of 6 runs deadlocked. The
   * same widen-the-window device the erasure lock tests in `gdpr.test.ts` use.
   *
   * The assertion is the ABSENCE of `40P01`, not a specific success, and that
   * is deliberate. Under the fixed order the accept still loses this race —
   * with `P2002`, because Prisma's non-atomic upsert answers a lost `INSERT`
   * race that way. That is a real, separately-filed, pre-existing bug in
   * `acceptInvitation`'s upsert and it has nothing to do with lock order;
   * pinning it here would make this test fail the day it is fixed. What this
   * test owns is the difference between a 409 the caller can act on and a
   * deadlock Postgres resolves by killing someone.
   */
  it('does not deadlock when a real accept races a real booking on an unlinked pair', async () => {
    const { teacherId, studentId, email, invitationId } =
      await makeLinkedStudentWithPendingInvite({ linked: false });
    const cls = await makeOpenClass(teacherId);

    let bookingHasLink!: () => void;
    const linkInserted = new Promise<void>((r) => { bookingHasLink = r; });

    // The accept's own upsert waits until the booking has inserted the same
    // key. Widens the window; does not change which row either side reaches
    // for first, which is the property under test.
    const accepting = prisma.$extends({
      query: {
        teacherStudent: {
          async upsert({ args, query }) {
            await linkInserted;
            return query(args);
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const booking = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
      await tx.class.findUnique({ where: { id: cls.id } });
      await tx.registration.count({
        where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
      });
      await tx.registration.create({
        data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
      });
      await tx.teacherStudent.upsert({
        where: { teacherId_studentId: { teacherId, studentId } },
        update: {},
        create: { teacherId, studentId },
      });
      bookingHasLink();
      await new Promise((r) => setTimeout(r, 300));
      // The real call, not a hand-rolled stand-in: TeacherBlock then
      // Invitation, which is where the cycle closes.
      await resolveInvitationOnLink(tx, { teacherId, studentEmail: email });
    }, { timeout: 15_000 });

    const [acceptResult, bookingResult] = await Promise.allSettled([
      acceptInvitation(accepting, { invitationId, studentId, accountEmail: email }),
      booking,
    ]);

    for (const settled of [acceptResult, bookingResult]) {
      if (settled.status === 'rejected') {
        expect(String(settled.reason)).not.toMatch(/40P01|deadlock/i);
      }
    }
  }, 30_000);

  /**
   * The reorder moved the `TeacherStudent` upsert BEFORE the pending check —
   * unconditionally, every call, whether or not the invitation turns out
   * still to be pending. A `return false` on the stale-invitation path would
   * commit that upsert regardless: the transaction reaches its end, Prisma
   * commits it, and a link now exists for an invitation nobody accepted.
   * Only a throw (`NotPendingError`, caught outside `$transaction`) rolls
   * the upsert back with the rest of the transaction. This fixture starts
   * already-declined with no `TeacherStudent` row, so `acceptInvitation`'s
   * own `updateMany` matches nothing on the very first call — no
   * concurrency needed to hit the path this guards.
   */
  it('a NOT_PENDING refusal leaves no TeacherStudent row, even though the upsert ran first', async () => {
    const local = uniqueSuffix();
    const email = `lock-order-notpending-${local}@test.local`;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Lock', lastName: 'Order',
        email: `lock-order-notpending-teacher-${local}@test.local`,
        account: { create: { email: `lock-order-notpending-teacher-${local}@test.local` } },
        bio: '#174 task 7 NOT_PENDING fixture teacher',
        pageSlug: `lock-order-notpending-${local}`,
      },
      select: { id: true, accountId: true },
    });
    lockOrderTeacherIds.push(teacher.id);
    lockOrderTeacherAccountIds.push(teacher.accountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'Lock', lastName: 'Order', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    lockOrderStudentIds.push(student.id);
    lockOrderStudentAccountIds.push(student.accountId as string);

    // No TeacherStudent row at all — the state a dropped rollback would move
    // away from. Declined, not pending — `acceptInvitation`'s own
    // `updateMany` is guaranteed to match nothing.
    const invitation = await prisma.invitation.create({
      data: {
        teacherId: teacher.id, email, firstName: 'Lock', lastName: 'Order',
        status: 'declined', respondedAt: new Date(),
      },
      select: { id: true },
    });

    const result = await acceptInvitation(prisma, {
      invitationId: invitation.id, studentId: student.id, accountEmail: email,
    });
    expect(result).toEqual({ ok: false, reason: 'NOT_PENDING' });
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: teacher.id, studentId: student.id } },
    })).toBeNull();
  });
});

describe('StudentPrivacy and TeacherStudent take one lock order (#174 task 7)', () => {
  const spTeacherIds: string[] = [];
  const spTeacherAccountIds: string[] = [];
  const spStudentIds: string[] = [];
  const spStudentAccountIds: string[] = [];

  afterAll(async () => {
    if (spTeacherIds.length) {
      await prisma.studentPrivacy.deleteMany({ where: { teacherId: { in: spTeacherIds } } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: spTeacherIds } } });
      await prisma.invitation.deleteMany({ where: { teacherId: { in: spTeacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: spTeacherIds } } });
    }
    if (spStudentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: spStudentIds } } });
    }
    if (spTeacherIds.length) {
      await prisma.teacher.deleteMany({ where: { id: { in: spTeacherIds } } });
    }
    const accountIds = [...spTeacherAccountIds, ...spStudentAccountIds];
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });

  /**
   * A fresh teacher/student pair with a real, pre-existing `StudentPrivacy`
   * row — the state a student who has shared *something* with this teacher
   * before is in, and the precondition that makes the `studentPrivacy.upsert`
   * in `unlinkTeacher` a genuine, lock-taking write (an `ON CONFLICT DO
   * UPDATE` against an existing row) rather than a plain `create`. Unlike
   * the `Invitation`/`TeacherStudent` pair, no empty-`update` quirk protects
   * this one either way: `SILENCED_PRIVACY` is six real columns, so the
   * upsert always takes the atomic path, existing row or not.
   */
  async function makeLinkedStudentWithSharedPrivacy() {
    const local = uniqueSuffix();
    const email = `sp-lock-order-${local}@test.local`;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'SP', lastName: 'Lock',
        email: `sp-lock-order-teacher-${local}@test.local`,
        account: { create: { email: `sp-lock-order-teacher-${local}@test.local` } },
        bio: '#174 task 7 StudentPrivacy/TeacherStudent lock-order fixture',
        pageSlug: `sp-lock-order-${local}`,
      },
      select: { id: true, accountId: true },
    });
    spTeacherIds.push(teacher.id);
    spTeacherAccountIds.push(teacher.accountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'SP', lastName: 'Lock', email, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    spStudentIds.push(student.id);
    spStudentAccountIds.push(student.accountId as string);

    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });
    await prisma.studentPrivacy.create({
      data: { studentId: student.id, teacherId: teacher.id, shareFullName: true },
    });

    return { teacherId: teacher.id, studentId: student.id, email };
  }

  /**
   * The six fields `unlinkTeacher`'s real `studentPrivacy.upsert` writes
   * (`SILENCED_PRIVACY`, invitations.ts) — copied rather than imported,
   * since it is not exported and re-declaring it here keeps this file from
   * needing to reach into that module's internals. What matters for this
   * describe is only that it is non-empty: unlike `TeacherStudent`'s
   * upserts, there is no empty-`update` quirk to worry about protecting
   * (accidentally or otherwise) here.
   */
  const HAND_ROLLED_SILENCED_PRIVACY = {
    shareFullName: false, shareEmail: false, sharePhone: false,
    shareBirthday: false, shareAddress: false, receiveComms: false,
  };

  /**
   * The next THREE tests are hand-rolled on both sides rather than calling
   * the real `unlinkTeacher`/`deleteStudentAccount` — deliberately, and NOT
   * because the real function can't be raced at all (a real-function test
   * follows further down; see its own docblock for why that one works). (An
   * earlier version of this paragraph said "the first two"; the
   * `deleteTeacherAccount`-order test is hand-rolled on both sides too.)
   *
   * An early draft called the real `unlinkTeacher` racing a
   * `deleteStudentAccount`-shaped transaction that used `deleteMany` on
   * `TeacherStudent`, matching the real erasure functions' own statement.
   * That surfaced a SECOND, unrelated bug: `unlinkTeacher` reads the
   * `TeacherStudent` row's id BEFORE opening its transaction, then deletes it
   * by that id (`tx.teacherStudent.delete({ where: { id: link.id } })`,
   * `invitations.ts`). When a concurrent `deleteStudentAccount` or
   * `deleteTeacherAccount` fully deletes the SAME row (and commits) while
   * `unlinkTeacher`'s own transaction is still open — which is exactly what
   * happens when `unlinkTeacher` loses the `StudentPrivacy` race this
   * describe is about — that id no longer exists, and Prisma throws `P2025
   * record not found for a delete`, which `classifyApiError`
   * (`src/lib/api-errors.ts`) falls through to its 500 branch for. That is a
   * genuine, pre-existing gap (a stale-read race, not a lock-order one — it
   * does not depend on `StudentPrivacy` at all, predates this task, and
   * reproduces exactly the same way if the two transactions share no other
   * table — see `docs/lock-order.md`'s "Related, but not a lock-order issue")
   * and it is NOT fixed here: #174 task 7 is about lock ORDER, this is about
   * a pre-transaction read going stale, and conflating the two fixes would
   * widen this task past what was asked. Filing it separately is the right
   * next step; the report has the reproduction.
   *
   * Hand-rolling both sides in the next two tests sidesteps that other bug
   * entirely and isolates the one property they exist to prove: whichever of
   * the two orders `TeacherStudent` and `StudentPrivacy` are taken in,
   * deadlock or not — independent of whichever function happens to write
   * them that way today.
   */

  /**
   * The opposite order — `TeacherStudent` then `StudentPrivacy`, what
   * `unlinkTeacher` took before this task's fix — racing
   * `deleteStudentAccount`'s real order (`StudentPrivacy` then
   * `TeacherStudent` — the two adjacent `deleteMany`s keyed on `studentId`
   * in `gdpr.ts`). Forced to interleave the same way
   * the `Invitation`/`TeacherStudent` tests above are, because unlike that
   * pair, nothing here can protect the wrong order by accident:
   * `HAND_ROLLED_SILENCED_PRIVACY` is never empty, so both transactions'
   * writes always take their row lock. Kept as historical evidence for why
   * `unlinkTeacher` needed reordering, the same way the equivalent
   * `Invitation`/`TeacherStudent` test is kept above.
   */
  it('the opposite order deadlocks — pinning why unlinkTeacher was reordered', async () => {
    const { teacherId, studentId } = await makeLinkedStudentWithSharedPrivacy();

    let bReady!: () => void;
    const bHasLink = new Promise<void>((r) => { bReady = r; });

    // A: TeacherStudent then StudentPrivacy — unlinkTeacher's OLD order.
    const a = prisma.$transaction(async (tx) => {
      await tx.teacherStudent.delete({
        where: { teacherId_studentId: { teacherId, studentId } },
      });
      await bHasLink;
      await tx.studentPrivacy.upsert({
        where: { studentId_teacherId: { studentId, teacherId } },
        update: HAND_ROLLED_SILENCED_PRIVACY,
        create: { studentId, teacherId, ...HAND_ROLLED_SILENCED_PRIVACY },
      });
    }, { timeout: 15_000 });

    // B: StudentPrivacy then TeacherStudent — deleteStudentAccount's real order.
    const b = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.deleteMany({ where: { studentId } });
      bReady();
      await new Promise((r) => setTimeout(r, 200));
      await tx.teacherStudent.deleteMany({ where: { studentId } });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    const rejections = results.filter((r) => r.status === 'rejected');
    expect(rejections).toHaveLength(1);
    expect(String((rejections[0] as PromiseRejectedResult).reason)).toMatch(/40P01|deadlock/i);
  });

  /**
   * The fix: `StudentPrivacy` then `TeacherStudent` on BOTH sides — the
   * order `unlinkTeacher` now takes, matching `deleteStudentAccount`'s real
   * order. No `bReady`/`bHasLink` handshake, for the same reason as the
   * equivalent `Invitation`/`TeacherStudent` test above: both sides now
   * reach for the same row first, so forcing one to wait on a signal only
   * the other's completed first write can send would deadlock the test
   * itself if the signalling side loses that first race. The shared first
   * resource is what serializes them without any forcing.
   */
  it('the reordered write does not deadlock against deleteStudentAccount\'s order', async () => {
    const { teacherId, studentId } = await makeLinkedStudentWithSharedPrivacy();

    // A: StudentPrivacy then TeacherStudent — unlinkTeacher's fixed order.
    const a = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.upsert({
        where: { studentId_teacherId: { studentId, teacherId } },
        update: HAND_ROLLED_SILENCED_PRIVACY,
        create: { studentId, teacherId, ...HAND_ROLLED_SILENCED_PRIVACY },
      });
      await tx.teacherStudent.deleteMany({
        where: { teacherId, studentId },
      });
    }, { timeout: 15_000 });

    // B: StudentPrivacy then TeacherStudent — deleteStudentAccount's real order.
    const b = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.deleteMany({ where: { studentId } });
      await new Promise((r) => setTimeout(r, 200));
      await tx.teacherStudent.deleteMany({ where: { studentId } });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
  });

  /**
   * The third site: `deleteTeacherAccount` already took `StudentPrivacy`
   * before `TeacherStudent` — it was never the outlier, only `unlinkTeacher`
   * was — but it shares the same two tables, so the fix has to hold against
   * it too. Same no-handshake reasoning as the test above.
   */
  it('the reordered write does not deadlock against deleteTeacherAccount\'s order', async () => {
    const { teacherId, studentId } = await makeLinkedStudentWithSharedPrivacy();

    // A: StudentPrivacy then TeacherStudent — unlinkTeacher's fixed order.
    const a = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.upsert({
        where: { studentId_teacherId: { studentId, teacherId } },
        update: HAND_ROLLED_SILENCED_PRIVACY,
        create: { studentId, teacherId, ...HAND_ROLLED_SILENCED_PRIVACY },
      });
      await tx.teacherStudent.deleteMany({
        where: { teacherId, studentId },
      });
    }, { timeout: 15_000 });

    // B: StudentPrivacy then TeacherStudent — deleteTeacherAccount's real
    // order, scoped by teacherId rather than studentId.
    const b = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.deleteMany({ where: { teacherId } });
      await new Promise((r) => setTimeout(r, 200));
      await tx.teacherStudent.deleteMany({ where: { teacherId } });
    }, { timeout: 15_000 });

    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
  });

  /**
   * The real `unlinkTeacher` racing a real erasure-shaped counterparty —
   * closing the gap the two hand-rolled tests above left open. Nothing in
   * this describe called the real function until now, so nothing failed if
   * someone restored the old order in `unlinkTeacher` itself: reverting the
   * source and running this file was the check, and until this test existed
   * that revert passed 62/62 (round-1 review of this task).
   *
   * The counterparty is shaped like `deleteStudentAccount`'s order —
   * `StudentPrivacy` then `TeacherStudent` — but writes `TeacherStudent` with
   * `updateMany`, not the real function's `deleteMany`. That is not a
   * simplification for convenience; it is what makes a real-function test
   * possible at all. `unlinkTeacher` reads the `TeacherStudent` row's id
   * BEFORE its own transaction opens and later deletes it BY that id (see
   * the docblock a few tests up, and `docs/lock-order.md`'s "Related, but
   * not a lock-order issue"). A counterparty that DELETES the row can — on
   * the interleaving where `unlinkTeacher` loses the `StudentPrivacy` race —
   * finish and commit before `unlinkTeacher` ever reaches its own delete,
   * leaving that id pointing at nothing and throwing `P2025`, a real but
   * SEPARATE bug this describe does not test. `updateMany` never removes the
   * row, so the id stays valid for `unlinkTeacher`'s own delete regardless of
   * which side wins the race — isolating the one property under test:
   * does the real function deadlock against the real lock order.
   *
   * Whichever side wins `StudentPrivacy`, both settle: the winner completes
   * normally, and the loser's next write finds the row it needs (a
   * `StudentPrivacy` row to upsert, a `TeacherStudent` row that still exists
   * either way) rather than a lock it can never get past.
   */
  it('does not deadlock when the real unlinkTeacher races an erasure-shaped transaction that leaves TeacherStudent in place', async () => {
    const { teacherId, studentId, email } = await makeLinkedStudentWithSharedPrivacy();

    // Shaped like deleteStudentAccount's real order — StudentPrivacy then
    // TeacherStudent — but updateMany rather than deleteMany on the second
    // write, for the reason in the docblock above.
    const erasureShaped = prisma.$transaction(async (tx) => {
      await tx.studentPrivacy.deleteMany({ where: { studentId } });
      await new Promise((r) => setTimeout(r, 200));
      await tx.teacherStudent.updateMany({
        where: { teacherId, studentId },
        data: { isArchived: true },
      });
    }, { timeout: 15_000 });

    const [unlinkResult, erasureResult] = await Promise.allSettled([
      unlinkTeacher(prisma, { teacherId, studentId, accountEmail: email }),
      erasureShaped,
    ]);
    expect(unlinkResult).toEqual({ status: 'fulfilled', value: { ok: true } });
    expect(erasureResult.status).toBe('fulfilled');
  });

  /**
   * #174 four-specialist review, Important 6 — the counterparty the test
   * above had to avoid, now handled instead of avoided.
   *
   * `unlinkTeacher` reads the `TeacherStudent` row's id with a plain
   * `findUnique` BEFORE opening its transaction and later deletes it BY that
   * id. A concurrent `deleteStudentAccount`/`deleteTeacherAccount` that
   * deletes and commits the same row in the gap leaves that id pointing at
   * nothing, and Prisma throws `P2025` — which `classifyApiError` has no
   * branch for, so it reached a student-facing route as a bare 500. The route
   * already models the right answer: `DELETE /api/teacher-links/[teacherId]`
   * returns 404 for `NOT_LINKED`, which is exactly what "the link is not
   * there" means however it got that way.
   *
   * The delete is interposed in the pre-transaction `findUnique` hook, so it
   * lands in the precise gap the bug lives in. `docs/lock-order.md` calls
   * this a stale-read race and not a lock-order one, and that is why: it does
   * not depend on `StudentPrivacy`, or on locks, or on any ordering — the
   * shortest version of it is "the erasure committed first".
   */
  it('reports NOT_LINKED when an erasure deletes the link between the read and the delete', async () => {
    const { teacherId, studentId, email } = await makeLinkedStudentWithSharedPrivacy();

    let hookCalls = 0;
    const racing = prisma.$extends({
      query: {
        teacherStudent: {
          async findUnique({ args, query }) {
            // Shape-keyed: `unlinkTeacher`'s pre-transaction read is the one
            // on the composite `(teacherId, studentId)` key.
            const where = args.where as { teacherId_studentId?: unknown } | undefined;
            if (!where?.teacherId_studentId) return query(args);

            hookCalls += 1;
            const row = await query(args);
            // Committed now — after the id has been handed back, before the
            // transaction that deletes by it opens.
            await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId } });
            return row;
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const result = await unlinkTeacher(racing, { teacherId, studentId, accountEmail: email });

    expect(hookCalls).toBe(1);
    // Pre-fix this REJECTS with `P2025 An operation failed because it depends
    // on one or more records that were required but not found`.
    expect(result).toEqual({ ok: false, reason: 'NOT_LINKED' });

    // The whole transaction rolled back with the throw, so the silencing
    // writes did not half-land either. That matters: a `TeacherBlock` written
    // for an unlink that reported failure would refuse a re-invite the
    // student never asked to refuse.
    expect(
      await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email } },
      }),
    ).toBeNull();
  });
});
