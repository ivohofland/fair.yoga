/**
 * The eight doors of #296: one teacher, one slot, across both class families.
 *
 * Every route that can make a row live at a `(teacherId, date, startTime)` — or
 * a template live at a `(teacherId, dayOfWeek, startTime)` — must answer 409
 * with copy naming the family that HOLDS the slot, not a 500 and not the
 * within-family sentence.
 *
 * One file rather than three, deliberately. The plan's file list names the
 * existing per-route suites, but this is one story with one fixture set: a
 * teacher who owns a class, a studio class, a class template and a studio
 * template, all at known slots. Scattering it means writing that fixture three
 * times and reading the invariant nowhere.
 *
 * **Both the status AND the message are asserted at every door.** A pre-check
 * and a trigger both answer 409, so a status assertion cannot tell them apart —
 * that is the defect #103 shipped past review, where `if (false && …)` in two
 * routes left every test green because the catch answered a byte-identical 409.
 * Here the message also pins WHICH family is named, and swapping the two
 * families' sentences is a real mistake no status check could see.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { getNextOccurrences } from '@/services/class-generator';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let accountId: string;
let token: string;
let roomId: string;
let teacherRoomId: string;

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A far-future date so nothing here collides with seed or dev data. */
const DATE = '2031-05-06';
const dateAt = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const classBody = (startTime: string, date = DATE) => ({
  teacherRoomId,
  classType: 'Cross Family Class',
  date,
  startTime,
  durationMinutes: 60,
  roomCost: 20,
  minRate: 30,
  targetRate: 60,
  minStudents: 3,
  maxStudents: 10,
});

const studioBody = (startTime: string, date = DATE) => ({
  classType: 'Cross Family Studio',
  date,
  startTime,
  durationMinutes: 60,
  location: 'Elsewhere',
  hourlyRate: 40,
});

const templateBody = (dayOfWeek: number, startTime: string) => ({
  teacherRoomId,
  classType: 'Cross Family Template',
  dayOfWeek,
  startTime,
  durationMinutes: 60,
  roomCost: 20,
  minRate: 30,
  targetRate: 60,
  minStudents: 3,
  maxStudents: 10,
});

const studioTemplateBody = (dayOfWeek: number, startTime: string) => ({
  classType: 'Cross Family Studio Template',
  dayOfWeek,
  startTime,
  durationMinutes: 60,
  location: 'Elsewhere',
  hourlyRate: 40,
});

beforeAll(async () => {
  const email = `crossfam-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Cross',
      lastName: 'Family',
      email,
      account: { create: { email } },
      bio: 'Cross-family slot exclusivity',
      pageSlug: `crossfam-${suffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  token = await seedSession(prisma, accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'Cross Family Venue',
      address: `${suffix} Cross Street`,
      city: 'Amsterdam',
      postcode: '1011AB',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 12,
      isPublic: false,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  teacherRoomId = (
    await prisma.teacherRoom.create({
      data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
    })
  ).id;
});

beforeEach(async () => {
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.studioClass.deleteMany({ where: { teacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.studioClass.deleteMany({ where: { teacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.session.deleteMany({ where: { accountId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

/**
 * `respondError` (`lib/api-utils.ts`) nests: `{ error: { message, code } }`.
 * Read through one helper so a shape change lands in one place — and asserted
 * rather than destructured blind, because `body.error` being a STRING is what
 * a flat-envelope reader would silently get `undefined` from.
 */
async function expect409(res: Response, code: string, messagePattern: RegExp) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error?: { message?: string; code?: string } };
  expect(body.error?.code).toBe(code);
  expect(body.error?.message).toMatch(messagePattern);
  return { code: body.error?.code, message: body.error?.message };
}

describe('the class family refuses a slot the studio family holds', () => {
  it('POST /api/classes', async () => {
    await prisma.studioClass.create({
      data: { teacherId, ...studioBody('09:00'), date: dateAt(DATE) },
    });

    const res = await send('POST', '/api/classes', classBody('09:00'));

    await expect409(res, 'CROSS_FAMILY_STUDIO_SLOT', /studio class/i);
  });

  it('PUT /api/classes/[id] — moved onto a held slot', async () => {
    await prisma.studioClass.create({
      data: { teacherId, ...studioBody('09:00'), date: dateAt(DATE) },
    });
    const created = await send('POST', '/api/classes', classBody('11:00'));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await send('PUT', `/api/classes/${data.id}`, { startTime: '09:00' });

    await expect409(res, 'CROSS_FAMILY_STUDIO_SLOT', /studio class/i);
  });

  it('POST /api/class-templates', async () => {
    await prisma.studioClassTemplate.create({
      data: { teacherId, ...studioTemplateBody(2, '07:00') },
    });

    const res = await send('POST', '/api/class-templates', templateBody(2, '07:00'));

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });

  it('PUT /api/class-templates/[id] — moved onto a held slot', async () => {
    await prisma.studioClassTemplate.create({
      data: { teacherId, ...studioTemplateBody(2, '07:00') },
    });
    const template = await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(4, '07:00') },
    });

    const res = await send('PUT', `/api/class-templates/${template.id}`, { dayOfWeek: 2 });

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });

  it('PATCH /api/class-templates/[id]?state=unarchived — re-entering a held slot', async () => {
    // Archiving withdraws the slot; un-archiving claims it back, and the other
    // family can have taken it meanwhile. That is the door #275 is about.
    const template = await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(2, '07:00'), isArchived: true, isActive: false },
    });
    await prisma.studioClassTemplate.create({
      data: { teacherId, ...studioTemplateBody(2, '07:00') },
    });

    const res = await send('PATCH', `/api/class-templates/${template.id}?state=unarchived`);

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });
});

describe('the studio family refuses a slot the class family holds', () => {
  it('POST /api/studio-classes', async () => {
    await prisma.class.create({
      data: { teacherId, ...classBody('09:00'), date: dateAt(DATE) },
    });

    const res = await send('POST', '/api/studio-classes', studioBody('09:00'));

    await expect409(res, 'CROSS_FAMILY_CLASS_SLOT', /already have a class/i);
  });

  it('PUT /api/studio-classes/[id] — moved onto a held slot', async () => {
    await prisma.class.create({
      data: { teacherId, ...classBody('09:00'), date: dateAt(DATE) },
    });
    const created = await send('POST', '/api/studio-classes', studioBody('11:00'));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await send('PUT', `/api/studio-classes/${data.id}`, { startTime: '09:00' });

    await expect409(res, 'CROSS_FAMILY_CLASS_SLOT', /already have a class/i);
  });

  it('PUT /api/studio-classes/[id] — un-cancelled back into a held slot', async () => {
    // `cancelledAt: null` re-enters the partial index and re-fires the guard,
    // which is the #275 Restore door this invariant governs.
    const studio = await prisma.studioClass.create({
      data: { teacherId, ...studioBody('09:00'), date: dateAt(DATE), cancelledAt: new Date() },
    });
    await prisma.class.create({
      data: { teacherId, ...classBody('09:00'), date: dateAt(DATE) },
    });

    const res = await send('PUT', `/api/studio-classes/${studio.id}`, { cancelledAt: null });

    await expect409(res, 'CROSS_FAMILY_CLASS_SLOT', /already have a class/i);
  });

  it('POST /api/studio-class-templates', async () => {
    await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(2, '07:00') },
    });

    const res = await send('POST', '/api/studio-class-templates', studioTemplateBody(2, '07:00'));

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });

  it('PUT /api/studio-class-templates/[id] — moved onto a held slot', async () => {
    await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(2, '07:00') },
    });
    const template = await prisma.studioClassTemplate.create({
      data: { teacherId, ...studioTemplateBody(4, '07:00') },
    });

    const res = await send('PUT', `/api/studio-class-templates/${template.id}`, { dayOfWeek: 2 });

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });

  it('PATCH /api/studio-class-templates/[id]?state=unarchived — re-entering a held slot', async () => {
    const template = await prisma.studioClassTemplate.create({
      data: { teacherId, ...studioTemplateBody(2, '07:00'), isArchived: true, isActive: false },
    });
    await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(2, '07:00') },
    });

    const res = await send('PATCH', `/api/studio-class-templates/${template.id}?state=unarchived`);

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });
});

describe('the count reaches the teacher, not just the reducer', () => {
  /**
   * PR #300 review, G8 + G5. `blockedByOtherFamily` was asserted in exactly two
   * places — the pure reducer (`generation.test.ts`) and the pure copy layer
   * (`template-action-messages.test.ts`), both hand-fed. No service result, no
   * HTTP body and no rendered component ever carried a non-zero value, so the
   * one path where this count reaches a teacher had no test at any hop in the
   * middle. That is the same chain #194 shipped broken at exactly this hop.
   *
   * G5 rides along: `respondOk<T>` is generic and both buttons read through an
   * unchecked `as`, so nothing pins the wire shape at compile time. Three of
   * the four `counts` producers had no runtime assertion either — revert any of
   * them to the pre-#296 flat spread and the suite stayed green while the copy
   * layer fell to `null` and the teacher got silence.
   */
  const DAY = 5; // Saturday, clear of the fixtures above
  const TIME = '06:30';

  /** The same dates the generator will choose, computed the same way it does. */
  const window = () => getNextOccurrences(DAY, new Date(), 6).slice(0, 6);

  async function holdWholeWindowWithStudioClasses() {
    for (const date of window()) {
      await prisma.studioClass.create({
        data: {
          teacherId,
          templateId: null,
          classType: 'Window Holder',
          date,
          startTime: TIME,
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 40,
        },
      });
    }
  }

  it('POST /api/class-templates carries a non-zero blockedByOtherFamily on the wire', async () => {
    await holdWholeWindowWithStudioClasses();

    const res = await send('POST', '/api/class-templates', templateBody(DAY, TIME));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { added: number; counts: Record<string, number> };
    };
    // Nested under `counts`, which is the shape the forms and both resolvers
    // read. A flat `blockedByOtherFamily` on the body would leave this
    // undefined and the copy layer silent.
    expect(body.data.counts).toBeDefined();
    expect(body.data.counts.blockedByOtherFamily).toBeGreaterThan(0);
    // Distinct from its neighbours at a DIFFERENT value, so a hop wired to the
    // wrong member cannot pass by coincidence.
    expect(body.data.counts.slotTaken).toBe(0);
    expect(body.data.counts.blockedByCancelled).toBe(0);
    expect(body.data.added).toBe(0);
  });

  it('PATCH ?state=active carries it too, through the resume path', async () => {
    // The hop #194 shipped broken: measured by the generator, reaching the
    // service, and stopping at the route.
    const template = await prisma.classTemplate.create({
      data: { teacherId, ...templateBody(DAY, TIME), isActive: false },
    });
    await holdWholeWindowWithStudioClasses();

    const res = await send('PATCH', `/api/class-templates/${template.id}?state=active`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { action: string; counts: Record<string, number> };
    };
    expect(body.data.action).toBe('active');
    expect(body.data.counts.blockedByOtherFamily).toBeGreaterThan(0);
    expect(body.data.counts.slotTaken).toBe(0);
  });

  it('POST /api/studio-class-templates carries the mirror', async () => {
    for (const date of window()) {
      await prisma.class.create({
        data: { teacherId, ...classBody(TIME), date },
      });
    }

    const res = await send('POST', '/api/studio-class-templates', studioTemplateBody(DAY, TIME));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { added: number; counts: Record<string, number> };
    };
    expect(body.data.counts.blockedByOtherFamily).toBeGreaterThan(0);
    expect(body.data.added).toBe(0);
  });
});

describe('the two sentences are not interchangeable', () => {
  /**
   * The swap a status assertion cannot see. Each family must name the OTHER
   * one, and the within-family 409 must keep its own sentence — three distinct
   * messages behind one status code.
   */
  it('names the studio family to a class caller and the class family to a studio caller', async () => {
    await prisma.studioClass.create({
      data: { teacherId, ...studioBody('09:00'), date: dateAt(DATE) },
    });
    const toClass = await send('POST', '/api/classes', classBody('09:00'));
    const classBody409 = await expect409(toClass, 'CROSS_FAMILY_STUDIO_SLOT', /studio class/i);

    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.class.create({
      data: { teacherId, ...classBody('09:00'), date: dateAt(DATE) },
    });
    const toStudio = await send('POST', '/api/studio-classes', studioBody('09:00'));
    const studioBody409 = await expect409(toStudio, 'CROSS_FAMILY_CLASS_SLOT', /already have a class/i);

    expect(classBody409.message).not.toBe(studioBody409.message);
    expect(classBody409.message).toMatch(/studio/i);
    expect(studioBody409.message).not.toMatch(/studio/i);
  });

  it('leaves the WITHIN-family 409 saying something different again', async () => {
    await prisma.class.create({
      data: { teacherId, ...classBody('09:00'), date: dateAt(DATE) },
    });

    const res = await send('POST', '/api/classes', classBody('09:00'));

    // Same status, same family named — but a different code, because the
    // remedy is inside this family rather than across the two.
    await expect409(res, 'DUPLICATE_CLASS_SLOT', /already have a class/i);
  });
});
