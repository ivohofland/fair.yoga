import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Bite tests for `Teacher_payment_link_check` (#785). Each case writes
 * straight through Prisma, bypassing Zod and `parsePaymentLink`, so a pass
 * means the DATABASE refuses the row. The `toThrow` assertions match the
 * constraint's own name, so an unrelated failure cannot satisfy them.
 */
const prisma = new PrismaClient();
const uniqueSuffix = `paylink-check-${Date.now()}`;

let teacherId: string;
let accountId: string;

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Pay',
      lastName: 'Link',
      email: `${uniqueSuffix}@test.local`,
      account: { create: { email: `${uniqueSuffix}@test.local` } },
      bio: 'Test teacher for the payment link CHECK constraint tests',
      pageSlug: uniqueSuffix,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
});

afterAll(async () => {
  // Guarded: an undefined id must not widen the delete.
  if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  if (accountId) await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

function setLink(paymentLink: string | null) {
  return prisma.teacher.update({ where: { id: teacherId }, data: { paymentLink } });
}

describe('Teacher_payment_link_check', () => {
  it('refuses a link that is not https', async () => {
    await expect(setLink('http://x.example/')).rejects.toThrow('Teacher_payment_link_check');
  });

  it('refuses a link over the bound', async () => {
    await expect(setLink(`https://${'a'.repeat(500)}`)).rejects.toThrow('Teacher_payment_link_check');
  });

  it('accepts an https link at the bound, and no link', async () => {
    const atBound = `https://${'a'.repeat(492)}`;
    expect(atBound).toHaveLength(500);
    await expect(setLink(atBound)).resolves.toMatchObject({ paymentLink: atBound });
    await expect(setLink('https://x.example/')).resolves.toMatchObject({ paymentLink: 'https://x.example/' });
    await expect(setLink(null)).resolves.toMatchObject({ paymentLink: null });
  });
});
