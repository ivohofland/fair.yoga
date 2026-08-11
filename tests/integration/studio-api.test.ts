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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';
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

// dayOfWeek/startTime default to 3/'18:00' for the one template this file
// creates in beforeAll ('Owner Template'), which lives for the whole suite
// and is never archived. StudioClassTemplate_teacher_slot_unique is
// (teacherId, dayOfWeek, startTime) WHERE isArchived = false, so every other
// call below that creates a template unarchived for `ownerId` — or archives
// it at creation but later un-archives it — passes its own `startTime`
// through `extra` to land on a slot 'Owner Template' isn't holding.
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

// Template-generated studio classes occupy per-teacher slots under #196's
// occupancy rule, so the window one resume test generates would block a
// sibling resume. The beforeAll `studioClassId` row has `templateId: null`
// and is exempt. Clearing template-scoped rows before every test keeps this
// file order-independent and re-runnable against a dev DB that accumulates
// rows between runs.
beforeEach(async () => {
  await prisma.studioClass.deleteMany({
    where: { teacherId: { in: [ownerId, otherId] }, templateId: { not: null } },
  });
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

  /**
   * #120. The class family's POST has generated inside its own transaction
   * since #56; the studio POST was a plain `create`, so a new template sat
   * `isActive: true` with an empty window until the next hourly sweep — up to
   * 60 minutes during which the only control the teacher can see ("Resume
   * studio class") answers `200 unchanged` and generates nothing.
   */
  it('fills the window, so a new template is not empty until the next sweep', async () => {
    const res = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Generates On Create',
      dayOfWeek: 2,
      startTime: '11:00',
      durationMinutes: 60,
      location: 'Generating Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    expect(await prisma.studioClass.count({ where: { templateId: data.id } })).toBe(4);
  });

  /**
   * Atomicity, ported from the class family's proven pattern in
   * `class-templates-api.test.ts`: force a *deterministic* FK failure (P2003)
   * rather than the P2002 the generator hedges and swallows, and assert the
   * whole transaction rolled back. A template that persists while its window
   * does not is the state #56 removed for the class family.
   */
  it('rolls the template back when generation fails', async () => {
    const before = await prisma.studioClassTemplate.count({ where: { teacherId: ownerId } });

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.studioClassTemplate.create({
          data: {
            teacherId: ownerId,
            classType: 'Rolls Back',
            dayOfWeek: 4,
            startTime: '12:00',
            durationMinutes: 60,
            location: 'Doomed Studio',
            hourlyRate: 40,
          },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        // A teacherId no Teacher row has: `studioClass.create` fails its FK
        // check with P2003, which nothing in the generator catches.
        await generateStudioInstancesForTemplate(tx, {
          ...created,
          teacherId: '00000000-0000-0000-0000-000000000000',
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.studioClassTemplate.count({ where: { teacherId: ownerId } })).toBe(before);
    expect(
      await prisma.studioClass.count({ where: { location: 'Doomed Studio' } }),
    ).toBe(0);
  });
});

describe('/api/studio-class-templates/[id] — ownership', () => {
  // One case, three verbs: a single bespoke guard repeated. Every studio row is
  // scoped to one teacher, so this chain is the whole authorization model here.
  it("another teacher cannot read, edit or toggle the owner's template", async () => {
    for (const [method, body, query] of [
      ['GET', undefined, ''],
      ['PUT', { hourlyRate: 1 }, ''],
      // A valid `state` is required so this reaches the service's ownership
      // check rather than tripping the query-schema's own 400 first — the
      // route validates `state` before it ever looks the template up.
      ['PATCH', undefined, '?state=paused'],
    ] as const) {
      const res = await send(
        method,
        otherToken,
        `/api/studio-class-templates/${templateId}${query}`,
        body,
      );
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
  it('reaches paused then active as named, and archiving forces inactive', async () => {
    const id = (await makeTemplate(ownerId, 'Toggle Target', { startTime: '18:01' })).id;

    const paused = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    expect(paused.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(false);

    const active = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);
    expect(active.status).toBe(200);
    expect(
      (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } })).isActive,
    ).toBe(true);

    // Archiving is a distinct action and shelves the template outright.
    const archived = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${id}?state=archived`,
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

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);
    expect(res.status).toBe(409);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isActive).toBe(false);
    expect(after.isArchived).toBe(true);
  });

  it('un-archiving is still possible, and leaves the template paused rather than live', async () => {
    // Distinct startTime: this row un-archives before the test ends, joining
    // the isArchived=false slot-uniqueness set alongside 'Owner Template'.
    const id = (
      await makeTemplate(ownerId, 'Unarchive Me', {
        isArchived: true,
        isActive: false,
        startTime: '18:02',
      })
    ).id;

    const res = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${id}?state=unarchived`,
    );
    expect(res.status).toBe(200);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isArchived).toBe(false);
    // Explicit activation is the separate, deliberate step.
    expect(after.isActive).toBe(false);
  });

  // #86, mirroring class-templates-api.test.ts's equivalent case: archiving
  // must withdraw the future window, not just flip the flag.
  it('archiving deletes the unbooked future window and reports the counts', async () => {
    const template = await makeTemplate(ownerId, 'Archive Window', { startTime: '18:03' });
    const makeInstance = (date: string) =>
      prisma.studioClass.create({
        data: {
          teacherId: ownerId,
          templateId: template.id,
          classType: 'Archive Window',
          date: new Date(date),
          startTime: '18:00',
          durationMinutes: 60,
          location: 'Community Studio',
          hourlyRate: 45,
        },
      });
    await makeInstance('2099-08-05');
    await makeInstance('2099-08-12');

    const res = await send(
      'PATCH',
      ownerToken,
      `/api/studio-class-templates/${template.id}?state=archived`,
    );
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { deleted: number; remaining: number } };
    expect(data.deleted).toBe(2);
    expect(data.remaining).toBe(0);
    expect(await prisma.studioClass.count({ where: { templateId: template.id } })).toBe(0);
  });

  it('pausing removes nothing and reports the last scheduled class', async () => {
    const template = await makeTemplate(ownerId, 'Pause Window', { startTime: '18:04' });
    const later = await prisma.studioClass.create({
      data: {
        teacherId: ownerId,
        templateId: template.id,
        classType: 'Pause Window',
        date: new Date('2099-09-01'),
        startTime: '19:00',
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      },
    });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${template.id}?state=paused`);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { lastScheduled: { startTime: string } | null };
    };
    // `toBeNull()` alone also passes on `undefined` — assert the seeded value.
    expect(data.lastScheduled?.startTime).toBe('19:00');
    expect(await prisma.studioClass.count({ where: { id: later.id } })).toBe(1);
  });

  it('rejects a PATCH with no state parameter', async () => {
    const id = (await makeTemplate(ownerId, 'No State', { startTime: '18:05' })).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}`);
    expect(res.status).toBe(400);

    // The row is untouched — a rejected request must not have toggled anything.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isActive).toBe(true);
  });

  it('rejects an unrecognised state value', async () => {
    const id = (await makeTemplate(ownerId, 'Bad State', { startTime: '18:06' })).id;

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=sideways`);
    expect(res.status).toBe(400);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isActive).toBe(true);
  });

  /**
   * The #98 case, mirroring class-templates-api.test.ts's equivalent: two
   * identical requests must reach the same state, not opposite ones.
   */
  it('is idempotent: pausing twice leaves the template paused', async () => {
    const id = (await makeTemplate(ownerId, 'Twice Paused', { startTime: '18:07' })).id;

    const pause = () =>
      send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);

    const first = await pause();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('paused');

    const second = await pause();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.isActive).toBe(false);
  });

  /**
   * The sharpest half of #98: archiving withdraws unbooked future classes, so
   * a second archive that fell through to un-archive would un-shelve the
   * template. It must be a no-op — and must NOT withdraw a second time.
   */
  it('is idempotent: archiving twice does not withdraw twice', async () => {
    const template = await makeTemplate(ownerId, 'Twice Archived', { startTime: '18:08' });
    await prisma.studioClass.create({
      data: {
        teacherId: ownerId,
        templateId: template.id,
        classType: 'Twice Archived',
        date: new Date('2099-10-01'),
        startTime: '18:00',
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      },
    });

    const archive = () =>
      send('PATCH', ownerToken, `/api/studio-class-templates/${template.id}?state=archived`);

    const first = await archive();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { action: string; deleted: number } };
    expect(firstBody.data.action).toBe('archived');

    const survivors = await prisma.studioClass.count({ where: { templateId: template.id } });

    const second = await archive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isArchived).toBe(true);
    expect(await prisma.studioClass.count({ where: { templateId: template.id } })).toBe(survivors);
  });

  /**
   * #94 end to end: the bug was a teacher resuming and finding an empty
   * schedule, so the assertion is on what the schedule holds afterwards, not
   * on the response body alone.
   */
  it('resuming fills the window rather than waiting for the hourly sweep', async () => {
    const id = (await makeTemplate(ownerId, 'Resume Fills Window', { startTime: '18:09' })).id;

    await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    // Start from a genuinely empty window, so the count below can only come
    // from the resume itself and not from generation at some earlier step.
    await prisma.studioClass.deleteMany({ where: { templateId: id } });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { action: string } }).data.action).toBe('active');
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });
});

describe('PATCH /api/studio-class-templates/[id] — resume reporting', () => {
  /**
   * #119. The service produced this number and four layers dropped it, ending
   * at `setMessage('')`. This is the wire half of that chain.
   */
  it('carries what the window holds and what the resume added', async () => {
    const t = await makeTemplate(ownerId, 'Resume Reports', { startTime: '18:10' });
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${t.id}?state=active`);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { action: string; scheduled: number; added: number };
    };
    expect(data.action).toBe('active');
    expect(data.added).toBe(4);
    expect(data.scheduled).toBe(4);
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

  // #148. Both keys reached prisma.studioClass.create through a `{ date, ...rest }`
  // spread, so neither name appeared anywhere in the handler — a grep for the
  // key names found nothing, which is how this stayed hidden.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const victimTemplate = await makeTemplate(otherId, 'Victim Studio Template');

    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Squat Attempt',
      date: '2099-07-02',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      templateId: victimTemplate.id,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.templateId).toBeNull();

    // Both assertions rest on an absence, and `StudioClass.templateId` is
    // `onDelete: SetNull` — so a cascaded template delete would produce the
    // same null and the same zero count. Not reachable today; this removes the
    // ambiguity anyway.
    expect(
      await prisma.studioClassTemplate.findUnique({ where: { id: victimTemplate.id } }),
    ).not.toBeNull();
    expect(
      await prisma.studioClass.count({ where: { templateId: victimTemplate.id } }),
    ).toBe(0);
  });

  // Not a security gap — a teacher can set this on their own row via
  // PUT /api/studio-classes/[id]. It is dead surface at create time: the form
  // does not send it and student-count-editor.tsx sets it afterwards.
  it('ignores studentCount at create time', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Count At Create',
      date: '2099-07-03',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      studentCount: 12,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.studentCount).toBeNull();
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

  describe('POST /api/studio-classes is retry-safe on the slot key (#196)', () => {
    // '2027-04-12' is a date no fixture above touches, so ownerId's slot
    // uniqueness ((teacherId, date, startTime) WHERE cancelledAt IS NULL) has
    // nothing to collide with. The top-level afterAll clears every StudioClass
    // row for ownerId regardless of classType, so these need no nested one.
    const slotBody = () => ({
      classType: 'Slot Studio', date: '2027-04-12', startTime: '11:00',
      durationMinutes: 60, location: 'Some Studio', hourlyRate: 45,
    });

    it('answers a repeated identical create with 409 and leaves exactly one row', async () => {
      const first = await send('POST', ownerToken, '/api/studio-classes', slotBody());
      expect(first.status).toBe(201);

      const second = await send('POST', ownerToken, '/api/studio-classes', slotBody());
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const rows = await prisma.studioClass.findMany({
        where: { teacherId: ownerId, date: new Date('2027-04-12'), startTime: '11:00' },
      });
      expect(rows).toHaveLength(1);
    });

    it('leaves exactly one row when two identical creates are in flight at once', async () => {
      const body = { ...slotBody(), startTime: '11:30' };
      const [a, b] = await Promise.all([
        send('POST', ownerToken, '/api/studio-classes', body),
        send('POST', ownerToken, '/api/studio-classes', body),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const loser = a.status === 409 ? a : b;
      expect((await loser.json()).error.code).toBe('DUPLICATE_STUDIO_SLOT');

      const rows = await prisma.studioClass.findMany({
        where: { teacherId: ownerId, date: new Date('2027-04-12'), startTime: '11:30' },
      });
      expect(rows).toHaveLength(1);
    });
  });
});
