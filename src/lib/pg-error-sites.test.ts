/**
 * @serial-tier lock-contention — holds uncommitted twins while a route's or a
 * service's own create waits on the same unique key, and asserts that the
 * waiter parked, via `pg_blocking_pids`. Lock noise from a neighbour in the
 * parallel tier would stretch that wait past the window the assertion allows.
 *
 * Each case produces one named unique collision at an `isUniqueConflictOn`
 * call site and asserts the site's answer, so a name dropped from that call
 * line turns its case into a 500. The ticket-path cases need no race: nothing
 * reads ahead of their insert.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { createPrismaClient } from '@/lib/prisma-client';
import { mintSignupTicket, SIGNUP_TICKET_COOKIE } from '@/lib/auth/signup-ticket';
import { inviteContact } from '@/services/invitations';
import { POST as postStudentProfile } from '@/app/api/account/student-profile/route';
import { POST as postTeacherProfile } from '@/app/api/account/teacher-profile/route';
import { POST as postTeacherRoom } from '@/app/api/teacher-rooms/route';
import { cookie, seedSession } from '../../tests/helpers';
import { expectRefusal, expectUnchanged } from '../../tests/api-assertions';
import { raceBehindHolder } from '../../tests/holder-race';

const prisma = createPrismaClient();
const run = `pgsites-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let seq = 0;

function tag(label: string): string {
  return `${run}-${label}-${seq++}`;
}

function emailOf(t: string): string {
  return `${t}@test.local`;
}

function request(path: string, headers: Record<string, string>, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function ticketCookie(ticket: string): Record<string, string> {
  return { Cookie: `${SIGNUP_TICKET_COOKIE}=${ticket}` };
}

/** A signed-in account with a live teacher side and no student side. */
async function teacherAccount(label: string) {
  const t = tag(label);
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Sites', lastName: 'Teacher', email: emailOf(t), bio: 'pg-error-sites fixture', pageSlug: t,
      account: { create: { email: emailOf(t) } },
    },
    select: { id: true, accountId: true },
  });
  return { tag: t, email: emailOf(t), teacherId: teacher.id, accountId: teacher.accountId, token: await seedSession(prisma, teacher.accountId) };
}

/** A signed-in account with a live student side and no teacher side. */
async function studentAccount(label: string) {
  const t = tag(label);
  const student = await prisma.student.create({
    data: { firstName: 'Sites', lastName: 'Student', email: emailOf(t), claimedAt: new Date(), account: { create: { email: emailOf(t) } } },
    select: { accountId: true },
  });
  if (student.accountId === null) throw new Error('fixture student has no account');
  return { tag: t, email: emailOf(t), accountId: student.accountId, token: await seedSession(prisma, student.accountId) };
}

describe('isUniqueConflictOn call sites, produced against the real database', () => {
  afterAll(async () => {
    const mine = { startsWith: run };
    await prisma.invitation.deleteMany({ where: { email: mine } });
    await prisma.teacherRoom.deleteMany({ where: { teacher: { email: mine } } });
    await prisma.room.deleteMany({ where: { createdBy: { email: mine } } });
    const accounts = await prisma.account.findMany({ where: { email: mine }, select: { id: true } });
    await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.id) } } });
    await prisma.teacher.deleteMany({ where: { email: mine } });
    await prisma.student.deleteMany({ where: { email: mine } });
    await prisma.account.deleteMany({ where: { email: mine } });
    await prisma.magicLinkToken.deleteMany({ where: { email: mine } });
    await prisma.$disconnect();
  });

  describe('behind a held, uncommitted twin', () => {
    it('student-profile session: a double-tap meets Student_email_key and answers unchanged', async () => {
      const fx = await teacherAccount('sp-tap');
      let twinId = '';
      const { result: res, parked } = await raceBehindHolder(
        async (tx) => {
          const twin = await tx.student.create({
            data: { firstName: 'Sites', lastName: 'Teacher', email: fx.email, claimedAt: new Date(), accountId: fx.accountId },
            select: { id: true },
          });
          twinId = twin.id;
        },
        () => postStudentProfile(request('/api/account/student-profile', cookie(fx.token))),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ studentId: twinId });
    }, 20_000);

    it('student-profile session: a same-account twin with another email meets Student_account_live_unique and answers unchanged', async () => {
      const fx = await teacherAccount('sp-acct');
      let twinId = '';
      const { result: res, parked } = await raceBehindHolder(
        async (tx) => {
          const twin = await tx.student.create({
            data: { firstName: 'Sites', lastName: 'Twin', email: emailOf(`${fx.tag}-other`), claimedAt: new Date(), accountId: fx.accountId },
            select: { id: true },
          });
          twinId = twin.id;
        },
        () => postStudentProfile(request('/api/account/student-profile', cookie(fx.token))),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ studentId: twinId });
    }, 20_000);

    it('teacher-profile session: a same-account twin with another email and slug meets Teacher_account_live_unique and answers ALREADY_TEACHER', async () => {
      const fx = await studentAccount('tp-acct');
      const { result: res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.create({
            data: {
              accountId: fx.accountId, email: emailOf(`${fx.tag}-other`), firstName: 'Sites', lastName: 'Twin',
              bio: 'Same bio', pageSlug: `${fx.tag}-other`,
            },
          });
        },
        () => postTeacherProfile(request('/api/account/teacher-profile', cookie(fx.token), {
          firstName: 'Sites', lastName: 'Twin', bio: 'Same bio', pageSlug: fx.tag,
        })),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'ALREADY_TEACHER');
      expect(await prisma.teacher.count({ where: { accountId: fx.accountId } })).toBe(1);
    }, 20_000);

    it('inviteContact: a twin invite meets Invitation_teacherId_email_key and answers ALREADY_INVITED', async () => {
      const fx = await teacherAccount('inv');
      const invitee = emailOf(`${fx.tag}-invitee`);
      const { result, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.invitation.create({ data: { teacherId: fx.teacherId, email: invitee, firstName: 'Holder', lastName: 'Name' } });
        },
        () => inviteContact(prisma, { teacherId: fx.teacherId, email: invitee, firstName: 'Request', lastName: 'Name' }),
      );

      expect(parked).toBe(true);
      expect(result).toEqual({ ok: false, reason: 'ALREADY_INVITED' });
    }, 20_000);

    it('teacher-rooms: a twin link with the same values meets TeacherRoom_teacherId_roomId_key and answers unchanged', async () => {
      const fx = await teacherAccount('tr');
      const room = await prisma.room.create({
        data: {
          venueName: 'Sites Venue', address: `${fx.tag} Street 1`, city: 'Amsterdam', postcode: '1011AB',
          maxCapacity: 20, isPublic: true, createdById: fx.teacherId,
        },
        select: { id: true },
      });
      const values = { capacityOverride: 12, rentalRate: 30 };
      let twinId = '';
      const { result: res, parked } = await raceBehindHolder(
        async (tx) => {
          const twin = await tx.teacherRoom.create({ data: { teacherId: fx.teacherId, roomId: room.id, ...values }, select: { id: true } });
          twinId = twin.id;
        },
        () => postTeacherRoom(request('/api/teacher-rooms', cookie(fx.token), { roomId: room.id, ...values })),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toMatchObject({ id: twinId });
    }, 20_000);
  });

  describe('on the ticket paths, against a committed row', () => {
    it('student-profile ticket: an Account holding the address meets Account_email_key and answers ACCOUNT_EXISTS', async () => {
      const email = emailOf(tag('sp-ticket-acct'));
      const ticket = await mintSignupTicket(prisma, email, 'student');
      await prisma.account.create({ data: { email } });

      const res = await postStudentProfile(request('/api/account/student-profile', ticketCookie(ticket), { firstName: 'Raced', lastName: 'Out' }));

      await expectRefusal(res, 'ACCOUNT_EXISTS');
      expect(await prisma.student.count({ where: { email } })).toBe(0);
    });

    it('student-profile ticket: a student row holding the address with no account meets Student_email_key and answers ACCOUNT_EXISTS', async () => {
      const email = emailOf(tag('sp-ticket-row'));
      const ticket = await mintSignupTicket(prisma, email, 'student');
      await prisma.student.create({ data: { firstName: 'Walk', lastName: 'In', email } });

      const res = await postStudentProfile(request('/api/account/student-profile', ticketCookie(ticket), { firstName: 'Raced', lastName: 'Out' }));

      await expectRefusal(res, 'ACCOUNT_EXISTS');
      expect(await prisma.account.count({ where: { email } })).toBe(0);
    });

    it('teacher-profile ticket: an Account holding the address meets Account_email_key and answers ACCOUNT_EXISTS', async () => {
      const t = tag('tp-ticket-acct');
      const email = emailOf(t);
      const ticket = await mintSignupTicket(prisma, email, 'teacher');
      await prisma.account.create({ data: { email } });

      const res = await postTeacherProfile(request('/api/account/teacher-profile', ticketCookie(ticket), {
        firstName: 'Raced', lastName: 'Out', bio: 'Ticket bio', pageSlug: t,
      }));

      await expectRefusal(res, 'ACCOUNT_EXISTS');
      expect(await prisma.teacher.count({ where: { email } })).toBe(0);
    });

    it('teacher-profile ticket: a teacher row holding the address with no account at it meets Teacher_email_key and answers ACCOUNT_EXISTS', async () => {
      const t = tag('tp-ticket-row');
      const email = emailOf(t);
      const ticket = await mintSignupTicket(prisma, email, 'teacher');
      // The holder's own account is at another address, so the ticket's
      // nested `Account` insert succeeds and the `Teacher` insert collides.
      await prisma.teacher.create({
        data: {
          firstName: 'Row', lastName: 'Holder', email, bio: 'holder', pageSlug: `${t}-holder`,
          account: { create: { email: emailOf(`${t}-holder`) } },
        },
      });

      const res = await postTeacherProfile(request('/api/account/teacher-profile', ticketCookie(ticket), {
        firstName: 'Raced', lastName: 'Out', bio: 'Ticket bio', pageSlug: t,
      }));

      await expectRefusal(res, 'ACCOUNT_EXISTS');
      expect(await prisma.account.count({ where: { email } })).toBe(0);
    });
  });
});
