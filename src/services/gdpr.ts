/**
 * GDPR — data export (Art. 15/20) and account erasure (Art. 17).
 *
 * Erasure strategy: ANONYMIZE, don't cascade-delete. Registrations,
 * payments, and completed classes are the *other party's* bookkeeping
 * (Art. 17(3)(b) legal-obligation grounds) — hard deletes would destroy a
 * teacher's revenue history or a student's payment obligations. Personal
 * fields are wiped and the rows keep their financial meaning; anonymized
 * data falls outside the GDPR (Recital 26).
 */

import { DEFAULT_INCOME_TIER } from '@/lib/tiers';
import type { PrismaClient } from '@prisma/client';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { completeClass } from './class-lifecycle';
import { handleSpotFreed, reorderWaitingEntries } from './waitlist';
import { lockClassRow } from '@/lib/db-locks';
import { log } from '@/lib/log';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Everything we hold about a student, in portable JSON. */
export async function exportStudentData(db: PrismaClient, studentId: string) {
  const student = await db.student.findUniqueOrThrow({
    where: { id: studentId },
    include: {
      studentPrivacy: {
        include: { teacher: { select: { firstName: true, lastName: true, pageSlug: true } } },
      },
      teacherStudents: {
        include: { teacher: { select: { firstName: true, lastName: true, pageSlug: true } } },
      },
      registrations: {
        include: {
          class: {
            select: {
              classType: true,
              date: true,
              startTime: true,
              status: true,
              teacher: { select: { firstName: true, lastName: true } },
            },
          },
          payment: { select: { amount: true, status: true, method: true, paidAt: true } },
        },
      },
      waitlistEntries: {
        include: { class: { select: { classType: true, date: true, startTime: true } } },
      },
    },
  });

  const notifications = await db.notification.findMany({
    where: { recipientType: 'student', recipientId: studentId },
    select: { type: true, title: true, body: true, isRead: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  // Keyed by address, not by `studentId` — a teacher can type an address into
  // their CRM before (or without) the owner ever holding a Student row, which
  // is the whole point of `Invitation` being a separate table. `.toLowerCase()`
  // bridges the two normalisations: `Invitation.email`/`TeacherBlock.email` are
  // lowercase by CHECK constraint, `Student.email` is stored exactly as typed.
  // Miss it and the export silently omits the rows for anyone whose address
  // carries uppercase — the failure mode of an omission is a quiet, complete
  // absence, which is why it is worth stating.
  const subjectEmail = student.email.toLowerCase();
  const invitations = await db.invitation.findMany({
    where: { email: subjectEmail },
    select: {
      status: true,
      firstName: true,
      lastName: true,
      createdAt: true,
      respondedAt: true,
      teacher: { select: { firstName: true, lastName: true, pageSlug: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const blocks = await db.teacherBlock.findMany({
    where: { email: subjectEmail },
    select: {
      createdAt: true,
      teacher: { select: { firstName: true, lastName: true, pageSlug: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return {
    exportedAt: new Date().toISOString(),
    format: 'fair.yoga student data export v1',
    profile: {
      firstName: student.firstName,
      lastName: student.lastName,
      email: student.email,
      incomeTier: student.incomeTier,
      phone: student.phone,
      birthday: student.birthday,
      address: student.address,
      reminderPref: student.reminderPref,
      emailNotifications: student.emailNotifications,
      createdAt: student.createdAt,
    },
    privacySettings: student.studentPrivacy.map((p) => ({
      teacher: `${p.teacher.firstName} ${p.teacher.lastName}`,
      shareFullName: p.shareFullName,
      shareEmail: p.shareEmail,
      sharePhone: p.sharePhone,
      shareBirthday: p.shareBirthday,
      shareAddress: p.shareAddress,
      receiveComms: p.receiveComms,
    })),
    teachers: student.teacherStudents.map((t) => ({
      teacher: `${t.teacher.firstName} ${t.teacher.lastName}`,
      page: t.teacher.pageSlug,
      since: t.createdAt,
    })),
    bookings: student.registrations.map((r) => ({
      class: r.class.classType,
      teacher: `${r.class.teacher.firstName} ${r.class.teacher.lastName}`,
      date: r.class.date,
      startTime: r.class.startTime,
      status: r.status,
      tierAtBooking: r.tierAtBooking,
      price: r.price,
      payment: r.payment,
      registeredAt: r.registeredAt,
    })),
    waitlist: student.waitlistEntries.map((w) => ({
      class: w.class.classType,
      date: w.class.date,
      status: w.status,
      position: w.position,
    })),
    // Records held ABOUT the subject rather than created by them: a teacher
    // typed their address into a CRM and guessed at their name. `nameTheyUsed`
    // is that guess — it is not the subject's own profile name and can differ
    // from it, so the export has to show it rather than fold it into
    // `profile`.
    invitations: invitations.map((i) => ({
      teacher: `${i.teacher.firstName} ${i.teacher.lastName}`,
      page: i.teacher.pageSlug,
      nameTheyUsed: `${i.firstName} ${i.lastName}`.trim(),
      status: i.status,
      invitedAt: i.createdAt,
      respondedAt: i.respondedAt,
    })),
    blockedTeachers: blocks.map((b) => ({
      teacher: `${b.teacher.firstName} ${b.teacher.lastName}`,
      page: b.teacher.pageSlug,
      since: b.createdAt,
    })),
    notifications,
  };
}

/** Everything we hold about a teacher, in portable JSON. */
export async function exportTeacherData(db: PrismaClient, teacherId: string) {
  const teacher = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    include: {
      teacherRooms: { include: { room: true } },
      classTemplates: true,
      classes: { include: { _count: { select: { registrations: true } } } },
      studioClasses: true,
      studioClassTemplates: true,
      announcements: true,
    },
  });

  const notifications = await db.notification.findMany({
    where: { recipientType: 'teacher', recipientId: teacherId },
    select: { type: true, title: true, body: true, isRead: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return {
    exportedAt: new Date().toISOString(),
    format: 'fair.yoga teacher data export v1',
    profile: {
      firstName: teacher.firstName,
      lastName: teacher.lastName,
      email: teacher.email,
      bio: teacher.bio,
      pageSlug: teacher.pageSlug,
      defaultCurrency: teacher.defaultCurrency,
      defaultTimezone: teacher.defaultTimezone,
      bankIban: teacher.bankIban,
      bankAccountName: teacher.bankAccountName,
      createdAt: teacher.createdAt,
    },
    rooms: teacher.teacherRooms.map((tr) => ({
      venue: tr.room.venueName,
      room: tr.room.roomName,
      address: `${tr.room.address}, ${tr.room.city}`,
      rentalRate: tr.rentalRate,
      capacity: tr.capacityOverride,
    })),
    recurringTemplates: teacher.classTemplates,
    classes: teacher.classes.map((c) => ({
      classType: c.classType,
      date: c.date,
      startTime: c.startTime,
      status: c.status,
      registrations: c._count.registrations,
      totalRevenue: c.totalRevenue,
      effectiveTeacherRate: c.effectiveTeacherRate,
    })),
    studioClasses: teacher.studioClasses,
    studioClassTemplates: teacher.studioClassTemplates,
    announcements: teacher.announcements.map((a) => ({
      message: a.message,
      sentAt: a.sentAt,
    })),
    notifications,
  };
}

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * Deletes a student account: personal data wiped, financial history kept.
 * - profile fields anonymized, email replaced with an unroutable unique one
 * - privacy rows, roster links, waitlist entries, notifications, sessions,
 *   magic-link tokens: deleted
 * - `Invitation` rows naming this address anonymized in place, so a teacher's
 *   refusal tombstones survive without the identity behind them
 * - `TeacherBlock` rows left standing on purpose; the tension is written down
 *   at the site and in `docs/data-model.md`
 * - upcoming registrations cancelled (teachers see the spot free up);
 *   charged/past registrations and payments remain, attributed to
 *   "Deleted Student"
 */
export async function deleteStudentAccount(db: PrismaClient, studentId: string): Promise<void> {
  const student = await db.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { email: true, firstName: true, accountId: true },
  });

  // Sizes the transaction's own `timeout` below — see that option for the
  // arithmetic. `WaitlistEntry` only enforces one entry per class per
  // student (`@@unique([classId, studentId])`); nothing caps how many
  // distinct classes one student can simultaneously be `waiting` in, so a
  // fixed transaction budget can't be "sized to the worst case" honestly.
  // This count is read outside any lock (cheap: no transaction, no FOR
  // UPDATE) purely to size that budget, and it can drift low if a waitlist
  // join for this same student lands in the gap before the transaction
  // opens below — the account is still live until that transaction commits.
  // Worst case the transaction's own query for `waitingClassIds` (below)
  // then finds more rows than this counted, the timeout undershoots, and
  // Prisma throws P2028. That rolls the whole erasure back atomically — it
  // was never applied half-way — and is safe to retry: `deleteStudentAccount`
  // is idempotent (`api/account/route.ts`'s docblock: "Both erasures are
  // safely re-runnable, so a retry finishes the job"). A retryable failure,
  // not a silent or partial one. See the transaction's `timeout` option
  // below for the ceiling this count still has to respect.
  const waitingCount = await db.waitlistEntry.count({ where: { studentId, status: 'waiting' } });

  const freedClassIds = await db.$transaction(async (tx) => {
    // Record which open classes free a spot — the waitlist hook runs on
    // them after the erasure commits. A read, so it carries no lock-ordering
    // obligation — see the lock loop below for what does.
    const upcoming = await tx.registration.findMany({
      where: {
        studentId,
        status: 'registered',
        class: { status: { in: ['draft', 'open'] } },
      },
      select: { classId: true, class: { select: { status: true } } },
    });

    // Queues the student was waiting in need their positions closed up once
    // the entries are gone. Read here, before this transaction's first
    // write — not where this used to sit, immediately before the reorder
    // loop — so the lock loop below can run before any write. See that loop
    // for why the order matters, not just the fact of locking.
    const waitingClassIds = (
      await tx.waitlistEntry.findMany({
        where: { studentId, status: 'waiting' },
        select: { classId: true },
      })
    ).map((w) => w.classId);
    const sortedWaitingClassIds = [...waitingClassIds].sort();

    // Locked here, before this transaction's first write below — not merely
    // before the reorder loop the lock used to sit beside. Round 1 review
    // reproduced why placement matters: `promoteNext` drops a stale head and
    // `withdrawWaitingEntriesForTeacher` clears every entry, and both take
    // the Class row's lock BEFORE writing `WaitlistEntry`. Locking after
    // this transaction's own writes (the previous version of this fix) let
    // this transaction hold a `WaitlistEntry` row lock — from, e.g., the
    // `waitlistEntry.deleteMany` below — while *requesting* the Class lock,
    // at the same moment one of those functions held the Class lock while
    // *requesting* that same `WaitlistEntry` row: transaction A holds row
    // lock 1 and waits on lock 2; transaction B holds lock 2 and waits on
    // lock 1. Postgres detects that cycle and kills one side with error
    // `40P01 deadlock detected` — reproduced against the previous version of
    // this fix, and the victim can be this erasure or a student's booking,
    // Postgres's choice, not this code's. Locking every affected class here,
    // before any write, makes this transaction's acquisition order match
    // theirs (Class row, then its children) — the same convention
    // `waitlist.ts:703–707` documents as "a correctness requirement rather
    // than a style note," now for the same reason there as here.
    //
    // Not covered by the escape argument in `waitlist.ts`'s
    // `withdrawWaitingEntriesForTeacher` docblock: that argument turns on
    // only ever moving an entry OUT of `waiting`, and this renumbers rows
    // belonging to OTHER students, racing the six other writers of
    // `WaitlistEntry.position` on the same class (`addToWaitlist`,
    // `removeFromWaitlist`, `promoteNext`, `claimSpot`,
    // `withdrawWaitingEntriesForTeacher`, `POST /api/registrations`).
    //
    // Sorted, not "in the order the read above returned them" — that read
    // has no `orderBy`, so trusting return order would let two concurrent
    // erasures lock the same pair of classes in opposite sequences,
    // recreating the exact inversion this sort exists to prevent. Matches
    // `withdrawWaitingEntriesForTeacher`'s own ordered `FOR UPDATE OF c`,
    // for the same reason: two concurrent erasures then take multiple
    // classes in the same sequence and cannot cycle against each other.
    for (const classId of sortedWaitingClassIds) {
      await lockClassRow(tx, classId);
    }

    // Cancel upcoming registrations so open classes free the spots.
    await tx.registration.updateMany({
      where: {
        studentId,
        status: 'registered',
        class: { status: { in: ['draft', 'open'] } },
      },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    await tx.studentPrivacy.deleteMany({ where: { studentId } });
    await tx.teacherStudent.deleteMany({ where: { studentId } });
    await tx.waitlistEntry.deleteMany({ where: { studentId } });

    // Invitations are keyed by address, not by `studentId` — a teacher can
    // hold a CRM contact for someone with no Student row at all — so this
    // matches on the address and lowercases it first (`Invitation.email` is
    // lowercase by CHECK constraint, `Student.email` is stored as typed).
    //
    // Anonymised rather than deleted, and the reason is the teacher's side:
    // a `declined` row is the tombstone that stops that teacher re-inviting
    // this address, so deleting it would hand back the re-invite the refusal
    // exists to deny — an erasure request would double as a way to clear
    // every refusal anyone ever made. `status` and `respondedAt` therefore
    // stay exactly as they are; only the three columns holding the person's
    // identity change.
    //
    // The replacement satisfies both constraints the branch added:
    // `Invitation_email_lowercase_check` (uuid + `@deleted.invalid` is
    // already lowercase) and `Invitation_responded_at_status_check` (this
    // write touches neither side of it). It also stays unique per teacher,
    // so a student invited by several teachers anonymises to one value
    // without colliding on `@@unique([teacherId, email])`.
    await tx.invitation.updateMany({
      where: { email: student.email.toLowerCase() },
      data: {
        email: `deleted-${studentId}@deleted.invalid`,
        firstName: 'Deleted',
        lastName: 'Student',
      },
    });

    // `TeacherBlock` is DELIBERATELY not touched here, and the omission is
    // undecided rather than settled — see `docs/data-model.md`
    // (TeacherBlock). Scrubbing the address breaks the block, because every
    // lookup is `teacherId` + exact `email` and the erased person's real
    // mailbox still exists in the world: the teacher could re-type that
    // address and the invitation would actually be delivered. Retaining it
    // keeps a plaintext address for someone who asked to be forgotten, on a
    // row they can no longer reach to clear (their account email is rewritten
    // and their sessions are gone, so the unlink UI is unreachable for
    // them). `CLAUDE.md` parks GDPR/legal review for proper consultation and
    // this is exactly that call. Do not resolve it from in here.
    await tx.notification.deleteMany({ where: { recipientType: 'student', recipientId: studentId } });
    // Sessions and passkeys belong to the account. They die with the
    // erased profile unless a live teacher profile still uses the account.
    if (student.accountId) {
      const teacherOnAccount = await tx.teacher.findFirst({
        where: { accountId: student.accountId, deletedAt: null },
        select: { id: true },
      });
      if (!teacherOnAccount) {
        await tx.session.deleteMany({ where: { accountId: student.accountId } });
        await tx.passkeyCredential.deleteMany({ where: { accountId: student.accountId } });
        // Last live profile erased: the account email is PII too.
        await tx.account.update({
          where: { id: student.accountId },
          data: { email: `deleted-${student.accountId}@deleted.invalid` },
        });
      }
    }
    await tx.magicLinkToken.deleteMany({ where: { email: student.email } });

    // The teacher's "X booked …" notifications carry the student's first
    // name — scrub them for the classes this student booked. Matching by
    // body prefix can catch a same-named classmate; anonymizing that copy
    // too is the safe direction to err in.
    const bookedClassIds = (
      await tx.registration.findMany({
        where: { studentId },
        select: { classId: true },
      })
    ).map((r) => r.classId);
    if (bookedClassIds.length > 0) {
      await tx.notification.updateMany({
        where: {
          recipientType: 'teacher',
          type: 'booking_confirmed',
          relatedClassId: { in: bookedClassIds },
          body: { startsWith: `${student.firstName} booked ` },
        },
        data: { body: 'A student (account since deleted) booked this class.' },
      });
    }

    // The lock for each of these classes was already taken above, before
    // this transaction's first write — see that loop for why placement, not
    // just the fact of locking, matters here. Renumbering here rather than
    // there only changes when the write happens; the lock has been held
    // since before this transaction wrote anything at all.
    for (const classId of sortedWaitingClassIds) {
      await reorderWaitingEntries(tx, classId);
    }

    await tx.student.update({
      where: { id: studentId },
      data: {
        firstName: 'Deleted',
        lastName: 'Student',
        email: `deleted-${studentId}@deleted.invalid`,
        phone: null,
        birthday: null,
        address: null,
        incomeTier: DEFAULT_INCOME_TIER,
        emailNotifications: false,
        deletedAt: new Date(),
      },
    });

    return upcoming.filter((r) => r.class.status === 'open').map((r) => r.classId);
  }, {
    // Arithmetic (see `waitingCount` above for why the base term can't be a
    // flat constant): 5_000ms matches Prisma's own default transaction
    // timeout, which is the budget every read and write above already ran
    // inside before this task — reads and writes on `Registration`,
    // `StudentPrivacy`, `TeacherStudent`, `WaitlistEntry`, `Invitation`,
    // `Notification`, `Session`, `PasskeyCredential`, `Account` and
    // `MagicLinkToken`, all over indexed columns — so it's proven headroom
    // for that part, not a guess. It is NOT a claim that none of those
    // writes are lock-contended: several of them can and do wait on other
    // transactions (that contention is exactly what the class-lock ordering
    // above resolves) — the claim is narrower, that this specific set of
    // statements already fit inside 5s before this task added anything.
    // `waitingCount * 2_000` covers the lock loop's own worst case:
    // `lockClassRow`'s `SET LOCAL lock_timeout` bounds each class's `FOR
    // UPDATE` wait to 2s, and N contended classes can burn that in sequence.
    //
    // That term does not cover everything the 2s bound applies to, though.
    // `SET LOCAL lock_timeout` governs every statement left in this
    // transaction, not just each class's `FOR UPDATE` — including
    // `reorderWaitingEntries`'s (`waitlist.ts`) own `findMany` plus up to M
    // individual `UPDATE`s per class, run after the lock loop above. Every
    // one of those M statements inherits the same 2s bound, adding real,
    // uncounted time on top of `waitingCount * 2_000` regardless of how
    // often any single one of them actually waits (round 1 review, I2 —
    // also names two writers elsewhere that flip `WaitlistEntry.status` from
    // `waiting` to `removed` without going through `lockClassRow`,
    // `transition/route.ts`'s cancel branch and `deleteTeacherAccount`'s CAS
    // loop below; both still take a conflicting lock on the Class row first,
    // via their own `class.updateMany`, which is what the ordering fix above
    // protects against — but that leaves the per-row cost of this loop, not
    // the wait before it starts, as the part this formula still doesn't
    // price in).
    //
    // The `Math.min` below is the backstop for both gaps at once — the
    // uncounted per-row time just described, and `waitingCount` itself
    // having no upper bound (I3: nothing caps how many distinct classes a
    // student can be `waiting` in, and that count is attacker-influenceable
    // by joining more waitlists before requesting erasure). 20_000ms:
    // generous enough that the realistic case — this is a single-teacher
    // CRM tool with no plausible legitimate student waiting in more than a
    // handful of classes at once — always gets its full honestly-sized
    // budget (covers up to 7 fully-contended classes via the formula above
    // before the cap binds). Bounded enough that a pathological N can no
    // longer hold this app's single Postgres connection pool — the whole
    // deployment runs on one 2GB VPS (`CLAUDE.md`: "VPS budget") — for more
    // than 20s, versus the 105s an uncapped 50-class case would have taken.
    // When the cap binds, the erasure aborts with P2028 instead of stalling
    // further: a safe, retryable failure (every write lives inside this same
    // transaction, so a rollback leaves nothing partially applied and a
    // retry is byte-identical to a first attempt — verified end to end in
    // round 1 review), not a correctness problem.
    timeout: Math.min(5_000 + waitingCount * 2_000, 20_000),
  });

  // The seats are freed and the erasure is committed — a promotion failure
  // must not undo either, so errors are logged and swallowed.
  for (const classId of freedClassIds) {
    try {
      await handleSpotFreed(db, classId);
    } catch (err) {
      log.error({ err, classId }, 'gdpr: spot-freed hook failed after erasure');
    }
  }
}

/**
 * Deletes a teacher account: upcoming classes are cancelled with student
 * notifications, personal/business data wiped; completed classes and
 * payments remain so students keep their payment records.
 */
export async function deleteTeacherAccount(db: PrismaClient, teacherId: string): Promise<void> {
  const teacher = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { email: true, accountId: true },
  });

  // A class already underway has happened — complete it (pricing, payment
  // records, notifications) instead of pretending it was cancelled
  // mid-session. The billing is the students' payment history too.
  const inProgress = await db.class.findMany({
    where: { teacherId, status: 'in_progress' },
    select: { id: true },
  });
  for (const cls of inProgress) {
    // `completeClass` now opens with `lockClassRow`'s 2s `lock_timeout`
    // (#174), narrower than the ~5s default Prisma gives the transaction
    // that lock sits in, so this call can now fail faster than it used to.
    // The kind of failure is unchanged — it could always throw, and that is
    // deliberately left uncaught here, not wrapped in a try — but bounded
    // beats unbounded, and the next reader should not have to re-derive why
    // the window moved.
    const result = await completeClass(db, cls.id);
    if (!result.ok) {
      // Fall through: the cancel sweep below still picks the class up.
      console.error(
        `[gdpr] could not complete in-progress class ${cls.id} before erasure: ${result.error}`,
      );
    }
  }

  await db.$transaction(
    async (tx) => {
      // Cancel every upcoming class and tell the people in them.
      const upcoming = await tx.class.findMany({
        where: { teacherId, status: { in: ['draft', 'open', 'in_progress'] } },
        include: {
          registrations: {
            where: { status: 'registered' },
            select: { studentId: true },
          },
        },
      });

      for (const cls of upcoming) {
        // Compare-and-swap against the same statuses the read above filtered
        // on. The read is not under the row lock, so a class can reach
        // `completed` between it and here — a sweep's `completeClass` doing
        // exactly that is the window `email-fallback.ts` describes. Cancelling
        // it anyway would strip a class that already has Payment rows and
        // students who have been asked to pay.
        //
        // Skipping is the whole handling: a completed class is one erasure
        // deliberately leaves standing (see this function's docblock), so
        // landing on one late is not an error, it is the same outcome by a
        // different route.
        const cancelled = await tx.class.updateMany({
          where: { id: cls.id, status: { in: ['draft', 'open', 'in_progress'] } },
          data: { status: 'cancelled' },
        });
        if (cancelled.count === 0) continue;

        await tx.waitlistEntry.updateMany({
          where: { classId: cls.id, status: 'waiting' },
          data: { status: 'removed' },
        });
        if (cls.registrations.length > 0) {
          const notifications: CreateNotificationInput[] = cls.registrations.map((r) => ({
            recipientType: 'student' as const,
            recipientId: r.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `${cls.classType} has been cancelled — the teacher closed their account.`,
            relatedClassId: cls.id,
          }));
          await createBulkNotifications(tx, notifications);
        }
      }

      await tx.classTemplate.updateMany({ where: { teacherId }, data: { isActive: false, isArchived: true } });
      await tx.studioClassTemplate.updateMany({ where: { teacherId }, data: { isActive: false, isArchived: true } });
      await tx.studentPrivacy.deleteMany({ where: { teacherId } });
      await tx.teacherStudent.deleteMany({ where: { teacherId } });
      // The teacher's CRM contacts — every one an address and a name they
      // typed about somebody ELSE. Deleted rather than anonymized, unlike the
      // student-side scrub above: the only thing an `Invitation` row means is
      // "this teacher may/may not invite this address", and with the teacher
      // erased there is nobody left to invite anyone. A tombstone guarding a
      // door that no longer exists is just a retained address. Safe on the
      // read side too — `listPendingInvitations` and `acceptInvitation` both
      // filter `deletedAt: null`, so these rows were already invisible to
      // every invitee the moment `deletedAt` below is set.
      //
      // `TeacherBlock` is NOT swept with them, and the asymmetry is
      // deliberate: this is a soft delete (`deletedAt` below, row retained),
      // so the rows have to survive a hypothetical restore. A restored
      // teacher whose contacts are gone simply re-types them; a restored
      // teacher whose blocks are gone has been silently un-refused by every
      // student who walked away. Erring toward the refusal is the only
      // direction that cannot hurt the person the block protects. The
      // student-erasure side of the same question is genuinely open — see
      // `deleteStudentAccount` above.
      await tx.invitation.deleteMany({ where: { teacherId } });
      await tx.notification.deleteMany({ where: { recipientType: 'teacher', recipientId: teacherId } });
      // Sessions and passkeys belong to the account. They die with the
      // erased profile unless a live student profile still uses the account.
      {
        const studentOnAccount = await tx.student.findFirst({
          where: { accountId: teacher.accountId, deletedAt: null },
          select: { id: true },
        });
        if (!studentOnAccount) {
          await tx.session.deleteMany({ where: { accountId: teacher.accountId } });
          await tx.passkeyCredential.deleteMany({ where: { accountId: teacher.accountId } });
          // Last live profile erased: the account email is PII too.
          await tx.account.update({
            where: { id: teacher.accountId },
            data: { email: `deleted-${teacher.accountId}@deleted.invalid` },
          });
        }
      }
      await tx.magicLinkToken.deleteMany({ where: { email: teacher.email } });

      await tx.teacher.update({
        where: { id: teacherId },
        data: {
          firstName: 'Deleted',
          lastName: 'Teacher',
          email: `deleted-${teacherId}@deleted.invalid`,
          photoUrl: null,
          bio: '',
          pageSlug: `deleted-${teacherId}`,
          bankIban: null,
          bankAccountName: null,
          customDomain: null,
          processorType: null,
          processorAccountId: null,
          deletedAt: new Date(),
        },
      });
    },
    // The `classTemplate.updateMany`/`studioClassTemplate.updateMany` below
    // take the same row locks `claimTemplateForGeneration` /
    // `claimStudioTemplateForGeneration` (class-generator.ts,
    // studio-class-generator.ts) hold for the duration of their own
    // per-template transactions (#95) — always for the sweep, and now for the
    // studio family's own resume too (#94) — so account erasure can now block
    // on a sweep or a resume in progress the same way an archive or pause
    // click can. This site needs the matching 10s budget more than those four
    // do, not just for symmetry: by the time this transaction opens,
    // `deleteTeacherAccount` has already run `completeClass` for every
    // in-progress class above — pricing, payments, and notifications
    // committed outside this transaction, not inside it. A P2028 here rolls
    // back the erasure but not that billing, leaving the two halves of one
    // account-deletion request permanently out of sync, and it surfaces as an
    // opaque 500 on `DELETE /api/account` rather than a merely-failed archive
    // click the teacher can just retry. This transaction is also already the
    // longest of the five sites: it loops over every upcoming class doing an
    // update plus bulk notifications before it ever reaches the template
    // rows, so it has less headroom against Prisma's 5s default than the
    // archive/pause sites did even before a lock wait enters the picture.
    { timeout: 10_000 },
  );
}
