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
import { lockClassRow, setLockTimeout } from '@/lib/db-locks';
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
  // is the whole point of `Invitation` being a separate table. The match
  // below needs no case-normalisation: all six email columns — Account,
  // Teacher, Student, MagicLinkToken, Invitation, TeacherBlock — are
  // lowercase by `*_email_lowercase_check` (#170).
  const subjectEmail = student.email;
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
  // was never applied half-way — and is safe to retry: THIS function is one
  // transaction end to end (its only work outside it is the post-commit
  // `handleSpotFreed` loop, which swallows its own errors), so a throw means
  // nothing landed. `api/account/route.ts`'s `erasureFailure` relies on
  // exactly that to tell this caller "Nothing was changed", and says why the
  // teacher erasure cannot claim the same. A retryable failure, not a silent
  // or partial one. See the transaction's `timeout` option below for the
  // ceiling this count still has to respect.
  const waitingCount = await db.waitlistEntry.count({ where: { studentId, status: 'waiting' } });

  const freedClassIds = await db.$transaction(async (tx) => {
    // FIRST statement, unconditionally — not left to `lockClassRow` below.
    //
    // The bound used to arrive only as a side effect of the lock loop, which
    // runs only when `sortedWaitingClassIds` is non-empty. A student waiting
    // in zero classes — the common case — therefore got an UNBOUNDED wait on
    // every statement in this transaction, including a `registration
    // .updateMany` that can contend with the 60-second transitions sweep, and
    // the erasure hung with no feedback until Prisma's own transaction
    // timeout eventually refused to start the NEXT statement. That timeout
    // cannot roll back a statement already blocked inside Postgres, only
    // decline to begin another one, which is what made the `Math.min` ceiling
    // below a wish rather than a guarantee for exactly those erasures. Round 2
    // review measured both halves of that asymmetry directly (see the
    // `timeout` option's own comment); it was recorded there as intended,
    // which it was not — nothing in the GDPR-clock rationale for bounding
    // this transaction depends on the subject being on a waitlist.
    //
    // Idempotent with the lock loop's own `SET LOCAL`: a later one overwrites
    // the earlier rather than stacking (`db-locks.ts`, and `db-locks.test.ts`
    // checks it).
    await setLockTimeout(tx);

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
    // `withdrawWaitingEntriesForTeacher`'s docblock (`waitlist.ts`)
    // documents as "a correctness requirement rather than a style note,"
    // now for the same reason there as here.
    //
    // Not covered by the escape argument in `waitlist.ts`'s
    // `withdrawWaitingEntriesForTeacher` docblock: that argument turns on
    // only ever moving an entry OUT of `waiting`, and this renumbers rows
    // belonging to OTHER students, racing the six other writers of
    // `WaitlistEntry.position` on the same class, all of which also lock it
    // (`addToWaitlist`, `removeFromWaitlist`, `promoteNext`, `claimSpot`,
    // `withdrawWaitingEntriesForTeacher`, `POST /api/registrations`).
    //
    // Sorted, not "in the order the read above returned them" — that read
    // has no `orderBy`, so trusting return order would let two concurrent
    // erasures lock the same pair of classes in opposite sequences,
    // recreating the exact inversion this sort exists to prevent.
    //
    // Ascending by id is this project's intended order for taking more than
    // one `Class` row. Five sites do; three take it — this sort,
    // `withdrawWaitingEntriesForTeacher`'s ordered `FOR UPDATE OF c`
    // (`waitlist.ts`), and `deleteTeacherAccount`'s cancel loop below — and
    // two do NOT: `syncTemplateInstances` (`template-sync.ts`) and
    // `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) lock in
    // heap order, and THIS function cycles against both for real. Do not read
    // the sort below as making that safe; `docs/lock-order.md`, "The two that
    // do not", has the reproduction and why it is recorded rather than fixed.
    //
    // `deleteTeacherAccount` did NOT sort until the whole-branch review of
    // #174 — an earlier version of this very comment asserted it did, which
    // was false for the one pairing it named, and the cycle was real:
    // reproduced as `40P01`, now pinned by the test "does not deadlock when
    // a teacher erasure and a student erasure overlap on two classes"
    // (`gdpr.test.ts`). A later version of it then asserted all three sites
    // that take multiple `Class` rows now agree — false the same way, and it
    // missed the two above. JS `[...].sort()` and SQL `ORDER BY id` agree here
    // because these ids are uuid-shaped `text`; see `docs/lock-order.md`,
    // "Ordering WITHIN `Class`", for that check and for the rule itself.
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

    // `StudentPrivacy` BEFORE `TeacherStudent` — this project's one order
    // for these two tables (#174 task 7; see `docs/lock-order.md`).
    // `unlinkTeacher` (services/invitations.ts) used to take them the other
    // way round, and racing it against this transaction deadlocked for
    // real — not a theoretical inversion, a reproduced `40P01 deadlock
    // detected` — because `unlinkTeacher`'s own `StudentPrivacy` write is
    // never an empty upsert (six real columns), so it always takes the row
    // lock. `unlinkTeacher` now takes them in this same order.
    await tx.studentPrivacy.deleteMany({ where: { studentId } });
    await tx.teacherStudent.deleteMany({ where: { studentId } });
    await tx.waitlistEntry.deleteMany({ where: { studentId } });

    // Invitations are keyed by address, not by `studentId` — a teacher can
    // hold a CRM contact for someone with no Student row at all — so this
    // matches on the address directly, with no normalisation needed: all six
    // email columns are lowercase by CHECK constraint (#170).
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
    // already lowercase — true of every `deleted-<uuid>@deleted.invalid`
    // write in this file, so it equally satisfies the matching CHECK on
    // `Account`, `Student` and `Teacher`) and
    // `Invitation_responded_at_status_check` (this write touches neither
    // side of it). It also stays unique per teacher, so a student invited by
    // several teachers anonymises to one value without colliding on
    // `@@unique([teacherId, email])`.
    await tx.invitation.updateMany({
      where: { email: student.email },
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
    // `Student`, `StudentPrivacy`, `Teacher`, `TeacherStudent`,
    // `WaitlistEntry`, `Invitation`, `Notification`, `Session`,
    // `PasskeyCredential`, `Account` and `MagicLinkToken`. Not all of that is
    // indexed on the column it filters by, and this comment used to claim
    // otherwise: `waitlistEntry.findMany`/`deleteMany` and
    // `teacherStudent.deleteMany` key on `studentId` alone (`WaitlistEntry`
    // only has `(classId, studentId)` and `(classId, position)`;
    // `TeacherStudent` only has `(teacherId, studentId)`),
    // `magicLinkToken.deleteMany` keys on `email` (only `tokenHash` and the
    // PK are indexed), and the teacher-notification `updateMany` further
    // down filters on `body: { startsWith }`. Those four run as sequential
    // scans, not index scans — verified against
    // `prisma/migrations/*/migration.sql` directly, not assumed. The 5_000ms
    // figure is proven headroom empirically (this whole set, unindexed
    // statements included, already ran inside it before this task), not a
    // claim that it is indexed, and it is NOT a claim that none of these
    // writes are lock-contended either: several of them can and do wait on
    // other transactions (that contention is exactly what the class-lock
    // ordering above resolves) — the claim is narrower, that this specific
    // set of statements already fit inside 5s before this task added
    // anything. `waitingCount * 2_000` covers the lock loop's own worst
    // case: `lockClassRow`'s `SET LOCAL lock_timeout` bounds each class's
    // `FOR UPDATE` wait to 2s, and N contended classes can burn that in
    // sequence.
    //
    // That term does not cover everything the 2s bound applies to, though —
    // in two different directions. First, `SET LOCAL lock_timeout` governs
    // every statement left in this transaction, not just `FOR UPDATE`s — so
    // `registration.updateMany` and every other write between here and the
    // reorder loop also waits at most 2s on any row it contends for, whether
    // or not that row has anything to do with a class this transaction
    // locked. Round 2 review measured that with a lock on the erased
    // student's own `Registration` row, unrelated to any waitlist:
    // `registration.updateMany` failed at ~2086ms with Postgres `55P03
    // canceling statement due to lock timeout`.
    //
    // That measurement had a second half, and the second half was a defect
    // rather than a design: with the student waiting in NO classes, the lock
    // loop never ran, so `SET LOCAL` was never issued, and the same
    // contention waited out the full ~3s hold and succeeded — unbounded. It
    // was written down as intended, which it was not; nothing in the
    // GDPR-clock rationale for bounding this transaction depends on the
    // subject being on a waitlist, and it is the wait-in-zero-classes case
    // that has the least reason to hang. The `setLockTimeout` call at the
    // top of this transaction removes the asymmetry, and with it the caveat
    // on the `Math.min` ceiling: that ceiling is enforceable rather than
    // nominal only while a per-statement bound is already active, because
    // Prisma's own interactive-transaction timeout cannot roll back a
    // statement already blocked inside Postgres, only refuse to start a new
    // one. Bounded beats unbounded for a time-bound erasure regardless of
    // which row is contended: the abort is atomic and retryable, and
    // `api/account/route.ts` now tells the caller exactly that, with a 503
    // and retry advice rather than a bare 500. Second, in the other
    // direction,
    // `reorderWaitingEntries`'s (`waitlist.ts`) own `findMany` plus up to M
    // individual `UPDATE`s per class, run after the lock loop above, also
    // inherit the same 2s bound — adding real, uncounted time on top of
    // `waitingCount * 2_000` regardless of how often any single one of them
    // actually waits (round 1 review, I2 — also names two writers elsewhere
    // that flip `WaitlistEntry.status` from `waiting` to `removed` without
    // going through `lockClassRow`, `transition/route.ts`'s cancel branch
    // and `deleteTeacherAccount`'s CAS loop below; both still take a
    // conflicting lock on the Class row first, via their own
    // `class.updateMany`, which is what the ordering fix above protects
    // against — but that leaves the per-row cost of this loop, not the wait
    // before it starts, as the part this formula still doesn't price in).
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
      //
      // `log`, not `console.error` — it is imported and used elsewhere in
      // this file, and a bare `console.error` writes a line with no level, no
      // request context and no structured fields, so it is invisible to every
      // filtered view an operator actually reads.
      log.error(
        { teacherId, classId: cls.id, reason: result.error },
        'teacher erasure: could not complete an in-progress class first',
      );
    }
  }

  await db.$transaction(
    async (tx) => {
      // Cancel every upcoming class and tell the people in them.
      //
      // `orderBy` is load-bearing, not tidiness: the loop below takes one
      // `Class` row lock per iteration (the CAS `UPDATE`), so the order this
      // read returns IS this transaction's lock acquisition order. Ascending
      // by id is what `deleteStudentAccount` above and
      // `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) also take; the two
      // template sites named in `deleteStudentAccount`'s comment take no order
      // at all, and this function's disagreement with those two is inherited,
      // unfixed, and recorded in `docs/lock-order.md` under "The two that do
      // not". Without this `orderBy` this read fell back to whatever the
      // heap returned, which for a fresh pair of classes is insertion order —
      // and when that disagreed with ascending, a teacher erasure and a
      // student erasure overlapping on two classes formed an AB-BA cycle and
      // Postgres killed one of them with `40P01`. Reproduced by the test
      // "does not deadlock when a teacher erasure and a student erasure
      // overlap on two classes" (`gdpr.test.ts`), which fails with exactly
      // that error if this `orderBy` is removed. See `docs/lock-order.md`,
      // "Ordering WITHIN `Class`".
      //
      // No `include` of registrations any more: the recipient list is read
      // inside the loop, under the lock the CAS takes — see there.
      const upcoming = await tx.class.findMany({
        where: { teacherId, status: { in: ['draft', 'open', 'in_progress'] } },
        orderBy: { id: 'asc' },
        select: { id: true, classType: true },
      });

      for (const cls of upcoming) {
        // Compare-and-swap against the same statuses the read above filtered
        // on. The read is not under the row lock, so a class can reach
        // `completed` between it and here — a sweep's `completeClass` doing
        // exactly that is the window `email-fallback.ts` describes. Cancelling
        // it anyway would strip a class that already has Payment rows and
        // students who have been asked to pay.
        //
        // Skipping the CANCEL is the right handling: a completed class is one
        // erasure deliberately leaves standing (see this function's
        // docblock), so landing on one late is not an error, it is the same
        // outcome by a different route.
        //
        // Skipping SILENTLY was not. `count === 0` has four distinct causes —
        // the class completed concurrently, it was cancelled concurrently,
        // the row was deleted, or something nobody has thought of — and a
        // bare `continue` distinguished none of them, emitted nothing, and
        // returned `void`, so from outside this function the difference
        // between "erased 12 classes" and "erased 12 classes and skipped one
        // it could not explain" was invisible. Re-read to say WHICH cause
        // fired, following the precedent `updateClass` (`class-lifecycle.ts`)
        // sets for its own second check. `warn`, not `error`: the two
        // expected causes are races this CAS exists to lose gracefully.
        const cancelled = await tx.class.updateMany({
          where: { id: cls.id, status: { in: ['draft', 'open', 'in_progress'] } },
          data: { status: 'cancelled' },
        });

        if (cancelled.count === 0) {
          const observed = await tx.class.findUnique({
            where: { id: cls.id },
            select: { status: true },
          });
          // The `continue` below skips the waitlist sweep too, deliberately —
          // "does not touch the waitlist" is exactly what the test "leaves a
          // class that completed after the erasure read alone, and still
          // erases" pins, because a HALF-applied skip (CAS refused, waitlist
          // and notifications applied anyway) would tell a student their
          // class was cancelled after `completeClass` had already asked them
          // to pay for it. The cost is a residual: any `waiting` entry on
          // that class survives, on a class that can never promote anyone,
          // belonging to a teacher who no longer exists. Counted into this
          // line rather than left invisible — an operator seeing a non-zero
          // `waitingEntriesLeft` knows there is a row to clean up, which is
          // the whole difference between a known residual and a silent one.
          const waitingEntriesLeft = await tx.waitlistEntry.count({
            where: { classId: cls.id, status: 'waiting' },
          });
          log.warn(
            {
              teacherId,
              classId: cls.id,
              observedStatus: observed?.status ?? 'row-deleted',
              waitingEntriesLeft,
            },
            'teacher erasure: class cancel CAS matched nothing',
          );
          continue;
        }

        // #112. Read before closing them: `updateMany` returns a count, not
        // rows, and these students are recipients. The update itself is
        // unchanged — this path has always closed the queue correctly and has
        // simply never told anyone it had.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        await tx.waitlistEntry.updateMany({
          where: { classId: cls.id, status: 'waiting' },
          data: { status: 'removed' },
        });

        // Read HERE, under the row lock the CAS above just took — not from
        // the `findMany` at the top of this transaction, which took no lock
        // and whose snapshot is already stale by the time the CAS lands. A
        // student who registered in that gap had their class cancelled by the
        // statement above and, from the old eager-loaded list, was never told.
        // The same defect and the same fix as `autoCancelClasses`
        // (`class-transitions.ts`), for the same reason its comment gives: a
        // cancelled class nobody was told about is worse than one that stays
        // open one more sweep. Under the lock, a registration writer either
        // committed before the CAS — and is in this read — or is blocked
        // behind it until this transaction ends.
        //
        // `status: 'registered'` only, deliberately narrower than the sibling
        // site's `registered`/`attended`/`no_show`: this predicate is
        // unchanged from the eager-load it replaces, and widening who an
        // erasure emails is a product decision, not a lock-discipline fix.
        const registrations = await tx.registration.findMany({
          where: { classId: cls.id, status: 'registered' },
          select: { studentId: true },
        });
        // Guard on the CONCATENATED list, not on `registrations`. A class
        // whose only audience is its queue has no registrations at all, and
        // that is precisely the case #112 exists to cover — keying this on
        // `registrations.length` drops the notification for exactly the
        // student it was added for, and every fixture with both audiences
        // passes anyway.
        const recipients = [...registrations, ...waiting];
        if (recipients.length > 0) {
          const notifications: CreateNotificationInput[] = recipients.map((r) => ({
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
      // `StudentPrivacy` BEFORE `TeacherStudent` — the same order
      // `deleteStudentAccount` above and `unlinkTeacher`
      // (services/invitations.ts) both take these two rows in (#174 task 7;
      // see `docs/lock-order.md`). `unlinkTeacher` used to disagree and
      // deadlocked for real against this table pair; not repeating that
      // inversion here is the whole point of writing the order down.
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
