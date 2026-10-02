import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, freshIp } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

const accountIds: string[] = [];
let tokenA: string;
let tokenB: string;
let accountIdA: string;
let accountIdB: string;

function post(token: string | null, body: unknown) {
  return fetch(`${BASE_URL}/api/push/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...freshIp(), ...(token ? cookie(token) : {}) },
    body: JSON.stringify(body),
  });
}
function del(token: string | null, endpoint: string) {
  return fetch(`${BASE_URL}/api/push/subscriptions`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...freshIp(), ...(token ? cookie(token) : {}) },
    body: JSON.stringify({ endpoint }),
  });
}

const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
// a real P-256 point: the route rejects one that is not on the curve
const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') };
const endpoint = (tag: string) => `https://fcm.googleapis.com/fcm/send/${suffix}-${tag}`;

/**
 * The row's `xmin`: Postgres gives every UPDATE a new one, even an update
 * that writes the values already stored, so an equal `xmin` means no write.
 */
async function rowVersion(ep: string): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ xmin: string }>>`SELECT xmin::text AS xmin FROM "PushSubscription" WHERE endpoint = ${ep}`;
  expect(rows).toHaveLength(1);
  return rows[0]!.xmin;
}

describe('POST/DELETE /api/push/subscriptions', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const studentA = await prisma.student.create({
      data: {
        firstName: 'PushStudentA',
        lastName: 'Test',
        email: `push-api-${suffix}-a@test.local`,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: `push-api-${suffix}-a@test.local` } },
      },
    });
    const studentB = await prisma.student.create({
      data: {
        firstName: 'PushStudentB',
        lastName: 'Test',
        email: `push-api-${suffix}-b@test.local`,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email: `push-api-${suffix}-b@test.local` } },
      },
    });
    accountIdA = studentA.accountId!;
    accountIdB = studentB.accountId!;
    accountIds.push(accountIdA, accountIdB);
    tokenA = await seedSession(prisma, accountIdA);
    tokenB = await seedSession(prisma, accountIdB);
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  it('rejects an unauthenticated POST', async () => {
    const res = await post(null, { endpoint: endpoint('unauth'), keys });
    expect(res.status).toBe(401);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint('unauth') } });
    expect(row).toBeNull();
  });

  it('rejects an unauthenticated DELETE', async () => {
    const res = await del(null, endpoint('unauth'));
    expect(res.status).toBe(401);
  });

  it('A subscribes, creating one row', async () => {
    const res = await post(tokenA, { endpoint: endpoint('a'), keys });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('created');
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint('a') } });
    expect(row.accountId).toBe(accountIdA);
  });

  it('A re-posting the identical subscription answers unchanged and writes nothing', async () => {
    const before = await rowVersion(endpoint('a'));
    const res = await post(tokenA, { endpoint: endpoint('a'), keys });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('unchanged');
    expect(body.data.status).toBe('unchanged');
    expect(await rowVersion(endpoint('a'))).toBe(before);
    const rows = await prisma.pushSubscription.findMany({ where: { endpoint: endpoint('a') } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountIdA);
  });

  it('A re-posting the same endpoint with new keys updates the row', async () => {
    const rotated = crypto.createECDH('prime256v1');
    rotated.generateKeys();
    const newKeys = { p256dh: rotated.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 2).toString('base64url') };
    const res = await post(tokenA, { endpoint: endpoint('a'), keys: newKeys });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBeUndefined();
    expect(body.data.status).toBe('updated');
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint('a') } });
    expect(row).toMatchObject({ accountId: accountIdA, p256dh: newKeys.p256dh, auth: newKeys.auth });

    // Back to the shared keys, so the cases below post the stored subscription.
    const restore = await post(tokenA, { endpoint: endpoint('a'), keys });
    expect((await restore.json()).data.status).toBe('updated');
  });

  it('rejects an http: endpoint', async () => {
    const bad = `http://fcm.googleapis.com/fcm/send/${suffix}-http`;
    const res = await post(tokenA, { endpoint: bad, keys });
    expect(res.status).toBe(400);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: bad } });
    expect(row).toBeNull();
  });

  it('rejects a non-URL endpoint', async () => {
    const res = await post(tokenA, { endpoint: 'not-a-url', keys });
    expect(res.status).toBe(400);
  });

  it('rejects a p256dh of the wrong decoded length', async () => {
    const bad = endpoint('bad-p256dh-length');
    const res = await post(tokenA, { endpoint: bad, keys: { p256dh: Buffer.alloc(64, 4).toString('base64url'), auth: keys.auth } });
    expect(res.status).toBe(400);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: bad } });
    expect(row).toBeNull();
  });

  it('rejects a 65-byte p256dh that is not a P-256 point', async () => {
    const bad = endpoint('off-curve');
    const res = await post(tokenA, { endpoint: bad, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: keys.auth } });
    expect(res.status).toBe(400);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: bad } });
    expect(row).toBeNull();
  });

  it('rejects an auth of the wrong decoded length', async () => {
    const bad = endpoint('bad-auth-length');
    const res = await post(tokenA, { endpoint: bad, keys: { p256dh: keys.p256dh, auth: Buffer.alloc(15, 1).toString('base64url') } });
    expect(res.status).toBe(400);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: bad } });
    expect(row).toBeNull();
  });

  it("B posting A's endpoint moves the row to B", async () => {
    const res = await post(tokenB, { endpoint: endpoint('a'), keys });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('moved');
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint('a') } });
    expect(row.accountId).toBe(accountIdB);
  });

  it("A deleting B's endpoint answers unchanged, row untouched", async () => {
    const res = await del(tokenA, endpoint('a'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('unchanged');
    expect(body.data.removed).toBe(false);
    const row = await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: endpoint('a') } });
    expect(row.accountId).toBe(accountIdB);
  });

  it('B deletes it, then deleting again is unchanged', async () => {
    const res = await del(tokenB, endpoint('a'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBeUndefined();
    expect(body.data.removed).toBe(true);
    const row = await prisma.pushSubscription.findUnique({ where: { endpoint: endpoint('a') } });
    expect(row).toBeNull();

    const res2 = await del(tokenB, endpoint('a'));
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.outcome).toBe('unchanged');
  });
});
