import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { mintSignupTicket, peekSignupTicket, consumeSignupTicket } from './signup-ticket';

const db = new PrismaClient();
const email = 'ticket-family@example.com';

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

afterEach(async () => {
  await db.magicLinkToken.deleteMany({ where: { email: { endsWith: '@example.com' } } });
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
