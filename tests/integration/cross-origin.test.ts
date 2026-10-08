import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, freshIp, seedSession, uniqueSuffix } from '../helpers';
import { expectRefusal } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const email = `json-only-teacher-${suffix}@test.local`;
const venueName = `JSON-only venue ${suffix}`;
let token = '';

beforeAll(async () => {
  const account = await prisma.account.create({
    data: {
      email,
      teachers: { create: { firstName: 'Json', lastName: 'Only', email, bio: '', pageSlug: `json-only-${suffix}` } },
    },
  });
  token = await seedSession(prisma, account.id);
});

afterAll(async () => {
  // Keyed by the literal venue name and address, never by an id beforeAll assigns.
  await prisma.teacherRoom.deleteMany({ where: { room: { venueName } } });
  await prisma.room.deleteMany({ where: { venueName } });
  const accounts = await prisma.account.findMany({ where: { email }, select: { id: true } });
  await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.id) } } });
  await prisma.teacher.deleteMany({ where: { email } });
  await prisma.account.deleteMany({ where: { email } });
  await prisma.$disconnect();
});

const ID = '00000000-0000-0000-0000-000000000000';

// Two of the bodyless POST handlers that never call parseBody — the CSRF
// surface only this check covers.
const BODYLESS = [`/api/classes/${ID}/cancel`, `/api/payments/${ID}/unpaid`];

describe('Origin check', () => {
  for (const path of BODYLESS) {
    it(`${path}: a foreign Origin is refused before auth`, async () => {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { ...freshIp(), origin: 'https://evil.example' },
      });
      await expectRefusal(res, 'CROSS_ORIGIN');
    });
  }

  it('Sec-Fetch-Site: cross-site is refused', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site' },
    });
    await expectRefusal(res, 'CROSS_ORIGIN');
  });

  it('the app’s own Origin reaches the route (401, not 403)', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, {
      method: 'POST',
      headers: { ...freshIp(), origin: new URL(BASE_URL).origin },
    });
    expect(res.status).toBe(401);
  });

  it('no Origin reaches the route as today', async () => {
    const res = await fetch(`${BASE_URL}${BODYLESS[0]}`, { method: 'POST', headers: freshIp() });
    expect(res.status).toBe(401);
  });

  it('a cross-site GET is not refused', async () => {
    // /api/teacher-rooms is wrapped in withErrorHandler and needs a session, so
    // reaching its own 401 shows the wrapper let the read through.
    const res = await fetch(`${BASE_URL}/api/teacher-rooms`, {
      headers: { ...freshIp(), 'sec-fetch-site': 'cross-site', origin: 'https://mail.example' },
    });
    expect(res.status).toBe(401);
  });
});

describe('JSON-only bodies', () => {
  const room = { venueName, address: 'Keizersgracht 1', city: 'Amsterdam', postcode: '1015CJ', maxCapacity: 12 };

  function createRoom(contentType: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      headers: { ...freshIp(), ...cookie(token), 'Content-Type': contentType },
      body: JSON.stringify(room),
    });
  }

  it('a signed-in write sent as text/plain is refused with 415 and writes nothing', async () => {
    await expectRefusal(await createRoom('text/plain'), 'UNSUPPORTED_MEDIA_TYPE');
    expect(await prisma.room.count({ where: { venueName } })).toBe(0);
  });

  it('the same body sent as JSON is written', async () => {
    // The control: the refusal above is the content type, not the body.
    expect((await createRoom('application/json')).status).toBe(201);
    expect(await prisma.room.count({ where: { venueName } })).toBe(1);
  });
});
