import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PAYMENT_LINK_MESSAGES } from '@/lib/payment-link';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

async function makeTeacher(paymentLink: string | null = null): Promise<{ id: string; token: string }> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Link', lastName: 'Route', email: `link-route-${s}@test.local`, paymentLink,
      account: { create: { email: `link-route-${s}@test.local` } }, bio: '', pageSlug: `link-route-${s}`,
    },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { id: t.id, token: await seedSession(prisma, t.accountId) };
}

function send(method: 'PUT' | 'DELETE', teacherId: string, token: string | null, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}/api/teachers/${teacherId}/payment-link`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token === null ? {} : cookie(token)) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function storedLink(teacherId: string): Promise<string | null> {
  const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentLink: true } });
  return t.paymentLink;
}

async function errorMessage(res: Response): Promise<{ status: number; message: unknown }> {
  const body = (await res.json()) as { error?: { message?: unknown } };
  return { status: res.status, message: body.error?.message };
}

afterAll(async () => {
  if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('PUT /api/teachers/[id]/payment-link', () => {
  it('saves the link and answers it', async () => {
    const t = await makeTeacher();
    const data = await expectApplied(await send('PUT', t.id, t.token, { paymentLink: 'https://revolut.me/anna' }));
    expect(data).toEqual({ paymentLink: 'https://revolut.me/anna' });
    expect(await storedLink(t.id)).toBe('https://revolut.me/anna');
  });

  it('answers unchanged when the same link is saved again', async () => {
    const t = await makeTeacher();
    await expectApplied(await send('PUT', t.id, t.token, { paymentLink: 'https://revolut.me/anna' }));
    const data = await expectUnchanged(await send('PUT', t.id, t.token, { paymentLink: 'https://revolut.me/anna' }));
    expect(data).toEqual({ paymentLink: 'https://revolut.me/anna' });
    expect(await storedLink(t.id)).toBe('https://revolut.me/anna');
  });

  it.each([
    ['http://revolut.me/anna', PAYMENT_LINK_MESSAGES.not_https],
    ['paypal.me/anna', PAYMENT_LINK_MESSAGES.invalid],
    ['https://revolut.me@evil.example/', PAYMENT_LINK_MESSAGES.has_userinfo],
    ['   ', PAYMENT_LINK_MESSAGES.required],
  ])('refuses %j with 400 naming the field, and stores nothing', async (paymentLink, message) => {
    const t = await makeTeacher();
    expect(await errorMessage(await send('PUT', t.id, t.token, { paymentLink }))).toEqual({
      status: 400,
      message: `paymentLink: ${message}`,
    });
    expect(await storedLink(t.id)).toBeNull();
  });

  it('refuses a body with an extra key with 400', async () => {
    const t = await makeTeacher();
    const res = await send('PUT', t.id, t.token, { paymentLink: 'https://revolut.me/anna', amount: 10 });
    expect(res.status).toBe(400);
    expect(await storedLink(t.id)).toBeNull();
  });

  it('refuses another teacher with 403 and stores nothing', async () => {
    const owner = await makeTeacher();
    const other = await makeTeacher();
    const res = await send('PUT', owner.id, other.token, { paymentLink: 'https://revolut.me/anna' });
    expect(res.status).toBe(403);
    expect(await storedLink(owner.id)).toBeNull();
  });

  it('refuses a request without a session with 401', async () => {
    const t = await makeTeacher();
    const res = await send('PUT', t.id, null, { paymentLink: 'https://revolut.me/anna' });
    expect(res.status).toBe(401);
    expect(await storedLink(t.id)).toBeNull();
  });
});

describe('DELETE /api/teachers/[id]/payment-link', () => {
  it('removes the link', async () => {
    const t = await makeTeacher('https://revolut.me/anna');
    const data = await expectApplied(await send('DELETE', t.id, t.token));
    expect(data).toEqual({ paymentLink: null });
    expect(await storedLink(t.id)).toBeNull();
  });

  it('answers unchanged when there is no link', async () => {
    const t = await makeTeacher();
    const data = await expectUnchanged(await send('DELETE', t.id, t.token));
    expect(data).toEqual({ paymentLink: null });
  });

  it('refuses another teacher with 403 and removes nothing', async () => {
    const owner = await makeTeacher('https://revolut.me/anna');
    const other = await makeTeacher();
    const res = await send('DELETE', owner.id, other.token);
    expect(res.status).toBe(403);
    expect(await storedLink(owner.id)).toBe('https://revolut.me/anna');
  });
});
