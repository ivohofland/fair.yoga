import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient, type MagicLinkPurpose } from '@prisma/client';
import {
  mintSignupTicket,
  peekSignupTicket,
  consumeSignupTicket,
  signupTicketFor,
  signupTicketIsLive,
} from './signup-ticket';
import { generateMagicLinkToken } from './magic-link';
import { TEACHER_PROFILE_PATH } from '@/lib/schemas';
import { log } from '@/lib/log';

const db = new PrismaClient();
const email = 'ticket-family@example.com';

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

afterEach(async () => {
  await db.magicLinkToken.deleteMany({ where: { email } });
  vi.restoreAllMocks();
});

describe('signup ticket families', () => {
  it('peeks a ticket under its own family and refuses it under the other', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    expect(await peekSignupTicket(db, token, 'teacher')).toBeNull();
    expect(await peekSignupTicket(db, token, 'student')).toBe(email);
  });

  it('consumes a ticket under its own family', async () => {
    const token = await mintSignupTicket(db, email, 'teacher');
    expect(await consumeSignupTicket(db, token, 'teacher')).toBe(email);
    // Single-use: the row is gone, so a second attempt finds nothing.
    expect(await consumeSignupTicket(db, token, 'teacher')).toBeNull();
  });

  it('refuses a cross-family ticket at consume, and spends it doing so', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    expect(await consumeSignupTicket(db, token, 'teacher')).toBeNull();
    // `verifyMagicLinkToken` deletes before there is a purpose to compare,
    // so the wrong-family attempt destroys the ticket. Asserted rather than
    // merely noted: it is the behaviour a future "check first" refactor
    // would change, and that refactor would reopen the double-submit race
    // the atomic delete closes.
    expect(await peekSignupTicket(db, token, 'student')).toBeNull();
  });

  it('refuses a ticket whose row has expired', async () => {
    const token = await mintSignupTicket(db, email, 'student');
    await db.magicLinkToken.updateMany({
      where: { email },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await peekSignupTicket(db, token, 'student')).toBeNull();
  });
});

// PR #427 review, C3: `signupTicketFor` was two `if`s over a five-member
// union, not a `switch` a future member fails to compile against — and its
// `null` case (a verified `student_signup` token with no usable redirect)
// answered a false "Account not found" with nothing logged. Every branch of
// the switch below, including both `log.error` paths, previously had no
// direct test at all — it was only ever exercised transitively through the
// `verify`/`claim` integration suites.
describe('signupTicketFor', () => {
  it('names the teacher family and its fixed destination for a teacher_signup token', () => {
    expect(signupTicketFor('teacher_signup', null)).toEqual({
      family: 'teacher',
      dest: TEACHER_PROFILE_PATH,
    });
    // The teacher destination never depends on the token's own redirect.
    expect(signupTicketFor('teacher_signup', '/some/other/path')).toEqual({
      family: 'teacher',
      dest: TEACHER_PROFILE_PATH,
    });
  });

  it('names the student family and the token redirect for a student_signup token with a safe redirect', () => {
    expect(signupTicketFor('student_signup', '/some-teacher/book/some-class')).toEqual({
      family: 'student',
      dest: '/some-teacher/book/some-class',
    });
  });

  it('refuses (and logs) a student_signup token with no redirect', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    expect(signupTicketFor('student_signup', null)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'student_signup', hasRedirect: false }),
      expect.stringContaining('redirect is missing or unsafe'),
    );
  });

  it('refuses (and logs) a student_signup token whose redirect is unsafe', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    expect(signupTicketFor('student_signup', 'https://evil.example/steal')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'student_signup', hasRedirect: true }),
      expect.stringContaining('redirect is missing or unsafe'),
    );
  });

  it('mints no ticket for the three non-signup purposes, silently', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    expect(signupTicketFor('sign_in', '/anywhere')).toBeNull();
    expect(signupTicketFor('teacher_profile_pending', '/anywhere')).toBeNull();
    expect(signupTicketFor('student_profile_pending', '/anywhere')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs and refuses a purpose the switch does not recognize', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    // The `never` assignment in `signupTicketFor`'s `default` case is what
    // makes an unhandled sixth `MagicLinkPurpose` a compile error, not a
    // silent `null` — this cast is the only way to exercise that branch
    // without actually adding one to the schema.
    const bogusPurpose = 'bogus_purpose' as unknown as MagicLinkPurpose;
    expect(signupTicketFor(bogusPurpose, '/anywhere')).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: bogusPurpose }),
      expect.stringContaining('unhandled MagicLinkPurpose'),
    );
  });
});

describe('signupTicketIsLive', () => {
  it('is true for an unexpired ticket of either family', async () => {
    const liveEmail = `live-ticket-${Date.now()}@test.local`;
    const token = await mintSignupTicket(db, liveEmail, 'teacher');
    expect(await signupTicketIsLive(db, token)).toBe(true);
    await db.magicLinkToken.deleteMany({ where: { email: liveEmail } });
  });

  it('is false for an expired ticket', async () => {
    const deadEmail = `dead-ticket-${Date.now()}@test.local`;
    const token = await mintSignupTicket(db, deadEmail, 'student');
    await db.magicLinkToken.updateMany({
      where: { email: deadEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await signupTicketIsLive(db, token)).toBe(false);
    await db.magicLinkToken.deleteMany({ where: { email: deadEmail } });
  });

  it('is false for a token that is not a signup ticket at all', async () => {
    // A sign-in link is not a pending signup; reporting one as cancelled
    // would tell the user we discarded something we never held.
    const notTicketEmail = `not-a-ticket-${Date.now()}@test.local`;
    const token = await generateMagicLinkToken(db, notTicketEmail, { purpose: 'sign_in' });
    expect(await signupTicketIsLive(db, token)).toBe(false);
    await db.magicLinkToken.deleteMany({ where: { email: notTicketEmail } });
  });
});
