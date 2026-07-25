/**
 * `/api/studio-class-templates` and `/api/studio-classes` — the second template
 * family #53 named, and the last of its route inventory.
 *
 * `StudioClass` is documented as "disconnected from Room/Student — pure
 * calendar + income tracking", so unlike the class family there is no booking,
 * no pricing engine and no cross-teacher surface. What that leaves worth
 * pinning, per `docs/technical-architecture.md`, is the bespoke ownership chain
 * (every row is scoped to one teacher) and the state guards on the toggles —
 * not a 401/403 ladder re-testing `requireTeacher` on six more verbs.
 *
 * The two template families were compared before writing this, per #53's own
 * advice. They share their shape but diverged in one place that mattered: the
 * class family refuses to activate an archived template AND filters archived
 * ones out of the generator, while the studio family did neither. That was a
 * live bug — a shelved studio template could be toggled active and the cron
 * sweep would materialise classes for it. Both guards now match; the
 * generator half is pinned in `src/services/studio-class-generator.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerId: string;
let ownerAccountId: string;
let ownerToken: string;
let otherId: string;
let otherAccountId: string;
let otherToken: string;

/** Owned by `owner` — the subject of the ownership cases. */
let templateId: string;
let studioClassId: string;

async function makeTeacher(tag: string) {
  const email = `studioapi-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Studio',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Studio API tests',
      pageSlug: `studioapi-${tag}-${suffix}`,
    },
  });
  return {
    id: teacher.id,
    accountId: teacher.accountId,
    token: await seedSession(prisma, teacher.accountId),
  };
}

const send = (method: string, token: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const makeTemplate = (teacherId: string, classType: string, extra = {}) =>
  prisma.studioClassTemplate.create({
    data: {
      teacherId,
      classType,
      dayOfWeek: 3,
      startTime: '18:00',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
      ...extra,
    },
  });

beforeAll(async () => {
  await prisma.$connect();

  const owner = await makeTeacher('owner');
  ownerId = owner.id;
  ownerAccountId = owner.accountId;
  ownerToken = owner.token;

  const other = await makeTeacher('other');
  otherId = other.id;
  otherAccountId = other.accountId;
  otherToken = other.token;

  templateId = (await makeTemplate(ownerId, 'Owner Template')).id;

  studioClassId = (
    await prisma.studioClass.create({
      data: {
        teacherId: ownerId,
        classType: 'Owner Studio Class',
        date: new Date('2099-06-03'),
        startTime: '18:00',
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      },
    })
  ).id;
});

afterAll(async () => {
  const teacherIds = [ownerId, otherId];
  await prisma.studioClass.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.session.deleteMany({
    where: { accountId: { in: [ownerAccountId, otherAccountId] } },
  });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: [ownerAccountId, otherAccountId] } } });
  await prisma.$disconnect();
});

describe('POST /api/studio-class-templates', () => {
  // Ride-along, not a ladder — the shared guard is covered in
  // src/lib/api-utils.test.ts.
  it('rejects an unauthenticated create', async () => {
    const res = await fetch(`${BASE_URL}/api/studio-class-templates`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('creates the template against the calling teacher, not a teacherId in the body', async () => {
    const res = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Created Via API',
      dayOfWeek: 1,
      startTime: '09:00',
      durationMinutes: 90,
      location: 'Other Studio',
      hourlyRate: 60,
      // Ignored: the route takes the teacher from the session. `.strict()` is
      // absent on the create schema, so this is dropped rather than rejected —
      // either way it must not land.
      teacherId: otherId,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string; teacherId: string } };
    expect(data.teacherId).toBe(ownerId);
  });
});

describe('/api/studio-class-templates/[id] — ownership', () => {
  // One case, three verbs: a single bespoke guard repeated. Every studio row is
  // scoped to one teacher, so this chain is the whole authorization model here.
  it("another teacher cannot read, edit or toggle the owner's template", async () => {
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { hourlyRate: 1 }],
      ['PATCH', undefined],
    ] as const) {
      const res = await send(method, otherToken, `/api/studio-class-templates/${templateId}`, body);
      expect(res.status, `${method} should be 403`).toBe(403);
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(Number(after.hourlyRate)).toBe(45);
    expect(after.isActive).toBe(true);
  });

  it('404s an id that does not exist', async () => {
    const res = await send(
      'GET',
      ownerToken,
      '/api/studio-class-templates/00000000-0000-0000-0000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('rejects an empty PUT rather than issuing a no-op write', async () => {
    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${templateId}`, {});
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/studio-class-templates/[id]', () => {
  it('toggles active, and archiving forces inactive', async () => {
    const id = (await makeTemplate(ownerId, 'Toggle Target')).id;

    const paused = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}`);
    expect(paused.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(false);

    const active = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}`);
    expect(active.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(true);

    // Archiving is a distinct action and shelves the template outright.
    const archived = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${id}?action=archive`,
    );
    expect(archived.status).toBe(200);
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isArchived).toBe(true);
    expect(after.isActive).toBe(false);
  });

  // The bug this coverage pass found. Without the guard, a teacher could
  // toggle a shelved template back to active — and `generateStudioClassInstances`
  // filtered on `isActive` alone, so the cron sweep would materialise classes
  // for something the teacher had deliberately put away. The class family
  // guards this in both places; the studio family guarded it in neither.
  it('refuses to activate an archived template — no classes for shelved things', async () => {
    const id = (await makeTemplate(ownerId, 'Shelved', { isArchived: true, isActive: false })).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}`);
    expect(res.status).toBe(409);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isActive).toBe(false);
    expect(after.isArchived).toBe(true);
  });

  it('un-archiving is still possible, and leaves the template paused rather than live', async () => {
    const id = (await makeTemplate(ownerId, 'Unarchive Me', { isArchived: true, isActive: false }))
      .id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?action=archive`);
    expect(res.status).toBe(200);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isArchived).toBe(false);
    // Explicit activation is the separate, deliberate step.
    expect(after.isActive).toBe(false);
  });
});

describe('/api/studio-classes', () => {
  it('creates against the calling teacher', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Cover Shift',
      date: '2099-07-01',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { teacherId: string } };
    expect(data.teacherId).toBe(ownerId);
  });

  it("another teacher cannot read or edit the owner's studio class", async () => {
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { hourlyRate: 1 }],
    ] as const) {
      const res = await send(method, otherToken, `/api/studio-classes/${studioClassId}`, body);
      expect(res.status, `${method} should be 403`).toBe(403);
    }

    const after = await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId } });
    expect(Number(after.hourlyRate)).toBe(45);
  });

  // `cancelledAt` is the one field the route transforms rather than passes
  // through — a string becomes a Date, and null clears it.
  it('sets and clears cancelledAt', async () => {
    const cancel = await send('PUT', ownerToken, `/api/studio-classes/${studioClassId}`, {
      cancelledAt: '2099-06-02T10:00:00.000Z',
    });
    expect(cancel.status).toBe(200);
    expect(
      (await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId } })).cancelledAt,
    ).not.toBeNull();

    const restore = await send('PUT', ownerToken, `/api/studio-classes/${studioClassId}`, {
      cancelledAt: null,
    });
    expect(restore.status).toBe(200);
    expect(
      (await prisma.studioClass.findUniqueOrThrow({ where: { id: studioClassId } })).cancelledAt,
    ).toBeNull();
  });
});
