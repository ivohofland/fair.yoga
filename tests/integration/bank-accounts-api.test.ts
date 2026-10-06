import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, type Currency } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

async function makeTeacher(currency: Currency = 'EUR'): Promise<{ id: string; token: string }> {
  const s = uniqueSuffix();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Bank', lastName: 'Route', email: `bank-route-${s}@test.local`, currency,
      account: { create: { email: `bank-route-${s}@test.local` } }, bio: '', pageSlug: `bank-route-${s}`,
    },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { id: t.id, token: await seedSession(prisma, t.accountId) };
}

function send(method: 'PUT' | 'DELETE', teacherId: string, currency: string, token: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE_URL}/api/teachers/${teacherId}/bank-accounts/${currency}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

afterAll(async () => {
  if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('PUT /api/teachers/[id]/bank-accounts/[currency]', () => {
  it('saves the account and answers it', async () => {
    const t = await makeTeacher();
    const data = await expectApplied(await send('PUT', t.id, 'EUR', t.token, { holderName: 'A. Teacher', iban: 'NL91 ABNA 0417 1643 00' }));
    expect(data).toMatchObject({ currency: 'EUR', holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: null });
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: t.id } })).toBe(1);
  });

  // The form omits a blank field from the body rather than sending null.
  it('clears a stored BIC when a replacing save omits it', async () => {
    const t = await makeTeacher();
    await expectApplied(await send('PUT', t.id, 'EUR', t.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }));
    const data = await expectApplied(await send('PUT', t.id, 'EUR', t.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }));
    expect(data).toMatchObject({ bic: null });
    expect(await prisma.teacherBankAccount.findMany({ where: { teacherId: t.id }, select: { bic: true } })).toEqual([{ bic: null }]);
  });

  it('answers 200 to concurrent saves in one currency and keeps one row', async () => {
    const t = await makeTeacher();
    const holders = ['A. Teacher', 'B. Teacher', 'C. Teacher', 'D. Teacher'];
    const responses = await Promise.all(
      holders.map((holderName) => send('PUT', t.id, 'EUR', t.token, { holderName, iban: 'NL91ABNA0417164300' })),
    );
    expect(responses.map((r) => r.status)).toEqual(holders.map(() => 200));
    const rows = await prisma.teacherBankAccount.findMany({ where: { teacherId: t.id }, select: { holderName: true } });
    expect(rows).toHaveLength(1);
    expect(holders).toContain(rows[0]?.holderName);
  });

  it('refuses a non-EEA euro IBAN without a BIC with BIC_REQUIRED', async () => {
    const t = await makeTeacher();
    await expectRefusal(await send('PUT', t.id, 'EUR', t.token, { holderName: 'A. Teacher', iban: 'CH9300762011623852957' }), 'BIC_REQUIRED');
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: t.id } })).toBe(0);
  });

  it('answers another invalid field with a 400 naming that field', async () => {
    const t = await makeTeacher('GBP');
    const res = await send('PUT', t.id, 'GBP', t.token, { holderName: 'A. Teacher', sortCode: '12', accountNumber: '12345678' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBeUndefined();
    expect(body.error.message.startsWith('sortCode: ')).toBe(true);
  });

  it('refuses another teacher with 403 and stores nothing', async () => {
    const owner = await makeTeacher();
    const other = await makeTeacher();
    const res = await send('PUT', owner.id, 'EUR', other.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(res.status).toBe(403);
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: owner.id } })).toBe(0);
  });

  it('answers 404 for a currency segment that names no currency', async () => {
    const t = await makeTeacher();
    const res = await send('PUT', t.id, 'XYZ', t.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/teachers/[id]/bank-accounts/[currency]', () => {
  it('removes the account', async () => {
    const t = await makeTeacher();
    await expectApplied(await send('PUT', t.id, 'EUR', t.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }));
    await expectApplied(await send('DELETE', t.id, 'EUR', t.token));
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: t.id } })).toBe(0);
  });

  it('answers unchanged when there is no account in that currency', async () => {
    const t = await makeTeacher();
    await expectUnchanged(await send('DELETE', t.id, 'GBP', t.token));
  });

  it('refuses another teacher with 403 and removes nothing', async () => {
    const owner = await makeTeacher();
    const other = await makeTeacher();
    await expectApplied(await send('PUT', owner.id, 'EUR', owner.token, { holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }));
    const res = await send('DELETE', owner.id, 'EUR', other.token);
    expect(res.status).toBe(403);
    expect(await prisma.teacherBankAccount.count({ where: { teacherId: owner.id } })).toBe(1);
  });
});
