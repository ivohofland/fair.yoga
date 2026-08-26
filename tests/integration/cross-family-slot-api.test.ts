/**
 * The eight doors of #296: one teacher, one slot, across both class families.
 *
 * Every route that can make a row live at a `(teacherId, span)` — or a template
 * live at a `(teacherId, dayOfWeek, slot)` — must answer 409 with copy naming
 * the family that HOLDS the slot, not a 500 and not the within-family sentence.
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
 * Here the message also pins WHICH sentence a caller gets, and swapping two
 * doors' sentences is a real mistake no status check could see.
 *
 * ── HOW THE ROW DOORS KNOW WHICH FAMILY (#327) ────────────────────────────
 *
 * Not from the error. Both families share ONE
 * `CalendarEntry_teacher_slot_excl`; it raises `23P01` and carries no family
 * in its payload, where #296's per-family triggers raised a `YG001` a route
 * could read the family out of. The route asks instead —
 * `probeConflictingEntry` (`src/lib/entry-conflict.ts`) reads back the live
 * entry whose span overlaps — and names that row's family, START TIME and
 * DATE. So the row doors assert a WHOLE sentence here, not a family word:
 * the times and the date are the part the family alone never carried, and the
 * spilled-past-midnight case is the one that cannot be written any other way.
 *
 * `'unknown'` — the probe finding nothing, because the conflicting entry was
 * cancelled between the refusal and the probe — is exercised where it can be
 * produced deterministically, in `src/lib/entry-conflict.test.ts`.
 *
 * The TEMPLATE doors below take a different route to the same answer: they
 * report from the generator's own `SkipReason` pre-check rather than from a
 * constraint's payload, and that pre-check sees the family directly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { getNextOccurrences } from '@/services/class-generator';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';

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

/**
 * Direct-Prisma fixture seeding for `ClassTemplate` — the slot fields route
 * through the nested `scheduleRule` create now (issue 298); `templateBody`
 * above stays flat because it is the WIRE body these tests also POST.
 */
const directClassTemplateData = (
  dayOfWeek: number,
  startTime: string,
  opts: { isActive?: boolean; isArchived?: boolean } = {},
) => ({
  scheduleRule: {
    create: {
      teacherId,
      kind: 'regular' as const,
      classType: 'Cross Family Template',
      dayOfWeek,
      startTime: hhmmToTime(startTime),
      durationMinutes: 60,
      ...opts,
    },
  },
  teacherRoom: { connect: { id: teacherRoomId } },
  roomCost: 20,
  minRate: 30,
  targetRate: 60,
  minStudents: 3,
  maxStudents: 10,
});

/** Direct-Prisma fixture seeding for `StudioClassTemplate` — see `directClassTemplateData`. */
const directStudioTemplateData = (
  dayOfWeek: number,
  startTime: string,
  opts: { isActive?: boolean; isArchived?: boolean } = {},
) => ({
  scheduleRule: {
    create: {
      teacherId,
      kind: 'studio' as const,
      classType: 'Cross Family Studio Template',
      dayOfWeek,
      startTime: hhmmToTime(startTime),
      durationMinutes: 60,
      ...opts,
    },
  },
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
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
  // `ScheduleRule` (issue 298), so one delete clears both families.
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
});

afterAll(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
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
    await createStudioClassFixture(prisma, { teacherId, ...studioBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });

    const res = await send('POST', '/api/classes', classBody('09:00'));

    await expect409(res, 'DUPLICATE_CLASS_SLOT', /^You already have a studio class at 09:00 on 6 May 2031\.$/);
  });

  it('PUT /api/classes/[id] — moved onto a held slot', async () => {
    await createStudioClassFixture(prisma, { teacherId, ...studioBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });
    const created = await send('POST', '/api/classes', classBody('11:00'));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await send('PUT', `/api/classes/${data.id}`, { startTime: '09:00' });

    await expect409(res, 'DUPLICATE_CLASS_SLOT', /^You already have a studio class at 09:00 on 6 May 2031\.$/);
  });

  it('POST /api/class-templates', async () => {
    await prisma.studioClassTemplate.create({
      data: directStudioTemplateData(2, '07:00'),
    });

    const res = await send('POST', '/api/class-templates', templateBody(2, '07:00'));

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });

  it('PUT /api/class-templates/[id] — moved onto a held slot', async () => {
    await prisma.studioClassTemplate.create({
      data: directStudioTemplateData(2, '07:00'),
    });
    const template = await prisma.classTemplate.create({
      data: directClassTemplateData(4, '07:00'),
    });

    const res = await send('PUT', `/api/class-templates/${template.id}`, { dayOfWeek: 2 });

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });

  it('PATCH /api/class-templates/[id]?state=unarchived — re-entering a held slot', async () => {
    // Archiving withdraws the slot; un-archiving claims it back, and the other
    // family can have taken it meanwhile. That is the door #275 is about.
    const template = await prisma.classTemplate.create({
      data: directClassTemplateData(2, '07:00', { isArchived: true, isActive: false }),
    });
    await prisma.studioClassTemplate.create({
      data: directStudioTemplateData(2, '07:00'),
    });

    const res = await send('PATCH', `/api/class-templates/${template.id}?state=unarchived`);

    await expect409(res, 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT', /recurring studio class/i);
  });
});

describe('the studio family refuses a slot the class family holds', () => {
  it('POST /api/studio-classes', async () => {
    await createClassFixture(prisma, { teacherId, ...classBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });

    const res = await send('POST', '/api/studio-classes', studioBody('09:00'));

    await expect409(res, 'DUPLICATE_STUDIO_SLOT', /^You already have a class at 09:00 on 6 May 2031\.$/);
  });

  it('PUT /api/studio-classes/[id] — moved onto a held slot', async () => {
    await createClassFixture(prisma, { teacherId, ...classBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });
    const created = await send('POST', '/api/studio-classes', studioBody('11:00'));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await send('PUT', `/api/studio-classes/${data.id}`, { startTime: '09:00' });

    await expect409(res, 'DUPLICATE_STUDIO_SLOT', /^You already have a class at 09:00 on 6 May 2031\.$/);
  });

  it('PUT /api/studio-classes/[id] — un-cancelled back into a held slot', async () => {
    // `cancelledAt: null` re-enters the partial index and re-fires the guard,
    // which is the #275 Restore door this invariant governs.
    const studio = await createStudioClassFixture(prisma, { teacherId, ...studioBody('09:00'), date: dateAt(DATE), cancelledAt: new Date(), startTime: hhmmToTime('09:00') });
    await createClassFixture(prisma, { teacherId, ...classBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });

    const res = await send('PUT', `/api/studio-classes/${studio.id}`, { cancelledAt: null });

    await expect409(res, 'DUPLICATE_STUDIO_SLOT', /^You already have a class at 09:00 on 6 May 2031\.$/);
  });

  it('POST /api/studio-class-templates', async () => {
    await prisma.classTemplate.create({
      data: directClassTemplateData(2, '07:00'),
    });

    const res = await send('POST', '/api/studio-class-templates', studioTemplateBody(2, '07:00'));

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });

  it('PUT /api/studio-class-templates/[id] — moved onto a held slot', async () => {
    await prisma.classTemplate.create({
      data: directClassTemplateData(2, '07:00'),
    });
    const template = await prisma.studioClassTemplate.create({
      data: directStudioTemplateData(4, '07:00'),
    });

    const res = await send('PUT', `/api/studio-class-templates/${template.id}`, { dayOfWeek: 2 });

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });

  it('PATCH /api/studio-class-templates/[id]?state=unarchived — re-entering a held slot', async () => {
    const template = await prisma.studioClassTemplate.create({
      data: directStudioTemplateData(2, '07:00', { isArchived: true, isActive: false }),
    });
    await prisma.classTemplate.create({
      data: directClassTemplateData(2, '07:00'),
    });

    const res = await send('PATCH', `/api/studio-class-templates/${template.id}?state=unarchived`);

    await expect409(res, 'CROSS_FAMILY_CLASS_TEMPLATE_SLOT', /recurring class/i);
  });
});

describe('the count reaches the teacher, not just the reducer', () => {
  /**
   * PR #300 review, G8 + G5. `blockedByOverlap` was asserted in exactly two
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
      await createStudioClassFixture(prisma, {
          teacherId,
          scheduleRuleId: null,
          classType: 'Window Holder',
          date,
          startTime: hhmmToTime(TIME),
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 40,
        });
    }
  }

  it('POST /api/class-templates carries a non-zero blockedByOverlap on the wire', async () => {
    await holdWholeWindowWithStudioClasses();

    const res = await send('POST', '/api/class-templates', templateBody(DAY, TIME));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { added: number; counts: Record<string, number> };
    };
    // Nested under `counts`, which is the shape the forms and both resolvers
    // read. A flat `blockedByOverlap` on the body would leave this
    // undefined and the copy layer silent.
    expect(body.data.counts).toBeDefined();
    expect(body.data.counts.blockedByOverlap).toBeGreaterThan(0);
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
      data: directClassTemplateData(DAY, TIME, { isActive: false }),
    });
    await holdWholeWindowWithStudioClasses();

    const res = await send('PATCH', `/api/class-templates/${template.id}?state=active`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { action: string; counts: Record<string, number> };
    };
    expect(body.data.action).toBe('active');
    expect(body.data.counts.blockedByOverlap).toBeGreaterThan(0);
    expect(body.data.counts.slotTaken).toBe(0);
  });

  it('POST /api/studio-class-templates carries the mirror', async () => {
    for (const date of window()) {
      await createClassFixture(prisma, { teacherId, ...classBody(TIME), date, startTime: hhmmToTime(TIME) });
    }

    const res = await send('POST', '/api/studio-class-templates', studioTemplateBody(DAY, TIME));

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { added: number; counts: Record<string, number> };
    };
    expect(body.data.counts.blockedByOverlap).toBeGreaterThan(0);
    expect(body.data.added).toBe(0);
  });
});

/**
 * What the probe restores, and it is more than the family (#327, stage B §3.2).
 *
 * `CalendarEntry_teacher_slot_excl` carries no family in its `23P01`, so the
 * refusal asks the database WHICH LIVE ENTRY overlaps and names that row back.
 * The family falls out of it — `kind` is a column on the row that comes back —
 * but the time and the date are the part a teacher cannot already see: the
 * Schedule tab lists both families in one list, so "go look at your studio
 * classes" points at the list they are already looking at.
 *
 * Both cases assert the WHOLE sentence rather than a fragment of it. Neither
 * the time nor the date the CALLER sent appears anywhere in either message —
 * that is the property under test — and only a whole-string assertion can see
 * a message that named the caller's own values back instead.
 */
describe('the refusal names the conflicting entry (#327)', () => {
  it('names the conflicting class, not just the family', async () => {
    await createClassFixture(prisma, {
      teacherId,
      ...classBody('19:00', '2027-09-01'),
      date: dateAt('2027-09-01'),
      startTime: hhmmToTime('19:00'),
      durationMinutes: 90,
    });

    const res = await send('POST', '/api/studio-classes', {
      ...studioBody('19:30', '2027-09-01'),
      durationMinutes: 60,
    });

    const { message } = await expect409(res, 'DUPLICATE_STUDIO_SLOT', /19:00/);
    expect(message).toBe('You already have a class at 19:00 on 1 Sep 2027.');
  });

  // The case the family discriminator could not serve: the conflict is not on
  // the date being edited, so naming only "your recurring classes" strands the
  // teacher on the wrong day.
  it('names a conflict that spilled from the previous day', async () => {
    await createClassFixture(prisma, {
      teacherId,
      ...classBody('23:30', '2027-09-03'),
      date: dateAt('2027-09-03'),
      startTime: hhmmToTime('23:30'),
      durationMinutes: 60,
    });

    const res = await send('POST', '/api/studio-classes', {
      ...studioBody('00:15', '2027-09-04'),
      durationMinutes: 30,
    });

    const { message } = await expect409(res, 'DUPLICATE_STUDIO_SLOT', /3 Sep 2027/);
    expect(message).toBe('You already have a class at 23:30 on 3 Sep 2027.');
  });
});

describe('the two sentences are the HOLDER\'s, not the caller\'s', () => {
  /**
   * The swap a status assertion cannot see, pinned in the direction the probe
   * puts it: **the sentence names the family that HOLDS the slot, whichever
   * door the caller knocked on.**
   *
   * Both halves below are cross-family, and the two messages are each other's
   * mirror — a class caller told about a studio class, a studio caller told
   * about a class. Swapping the two nouns is a real mistake, and the `studio`
   * assertions are what make it visible: they run opposite to the caller's own
   * family in both directions, so a message built from the CALLER rather than
   * the holder fails them both.
   *
   * The error CODE stays the caller's — `DUPLICATE_CLASS_SLOT` at the class
   * door either way. It answers "this slot is occupied", which is the caller's
   * condition; the message is where the holder is named.
   */
  it('gives a class caller the studio sentence when a studio class holds the slot', async () => {
    await createStudioClassFixture(prisma, { teacherId, ...studioBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });
    const toClass = await send('POST', '/api/classes', classBody('09:00'));
    const classBody409 = await expect409(toClass, 'DUPLICATE_CLASS_SLOT', /already have a studio class/i);

    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await createClassFixture(prisma, { teacherId, ...classBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });
    const toStudio = await send('POST', '/api/studio-classes', studioBody('09:00'));
    const studioBody409 = await expect409(toStudio, 'DUPLICATE_STUDIO_SLOT', /already have a class/i);

    expect(classBody409.message).not.toBe(studioBody409.message);
    // Opposite to each caller's own family, which is the whole assertion: the
    // class door names studio, the studio door does not.
    expect(classBody409.message).toMatch(/studio/i);
    expect(studioBody409.message).not.toMatch(/studio/i);
  });

  /**
   * The within-family collision, which the probe separates from the
   * cross-family one again. It was byte-identical to the case above for the
   * length of this branch — one constraint, no family in its payload — and
   * naming the holder is what re-separates them. Asserted directly rather than
   * implied, because "the two doors answer identical copy" is the state this
   * test existed to make visible in both directions.
   */
  it('answers a WITHIN-family collision by naming a class, not a studio class', async () => {
    await createClassFixture(prisma, { teacherId, ...classBody('09:00'), date: dateAt(DATE), startTime: hhmmToTime('09:00') });

    const res = await send('POST', '/api/classes', classBody('09:00'));

    const { message } = await expect409(res, 'DUPLICATE_CLASS_SLOT', /already have a class/i);
    expect(message).toBe('You already have a class at 09:00 on 6 May 2031.');
  });
});
