/**
 * Both generators, driven through a REAL `$transaction` — the configuration
 * every production caller uses — at a CROSS-FAMILY collision, which is the
 * combination no other test in this repo exercises.
 *
 * Both halves matter, and the first draft of this sentence overstated it.
 * Other tests in `class-generator.test.ts` and `studio-class-generator.test.ts`
 * DO drive the generators through `$transaction` — the sweep entry points
 * always do. What none of them did was stage a cross-family collision inside
 * one: every cross-family case uses a bare `prisma`. The collision is what
 * raises, so the transaction semantics only bite where the two overlap.
 *
 * This file exists because of a defect that shipped on #296's branch and was
 * caught in PR review. A `catch` around `createManyAndReturn` retried the
 * insert per date so that one raced date would not cost the whole window. It
 * was mutation-tested and reported healthy. It could not work:
 *
 *   - every production caller passes a TRANSACTION client (both hourly sweeps,
 *     both template POST routes, both pause/resume services);
 *   - Prisma takes no savepoint per statement inside `$transaction`;
 *   - so the trigger's `RAISE EXCEPTION` leaves the Postgres transaction
 *     aborted, and the first retried `create` returns `25P02`, which
 *     `isCrossFamilySlotConflict` correctly declines — costing the whole
 *     window anyway AND replacing the `YG001` that the two template POST
 *     catches match with a `25P02` that neither does. A wordable 409 became a
 *     500. Two, not the ten endpoints answering a cross-family 409 overall:
 *     those two are the only ones that wrap generation, so they are the only
 *     ones an error escaping a generator can reach.
 *
 * The mutation had reported healthy because the unit tests call the generators
 * with a bare `PrismaClient`, where every statement is its own transaction and
 * a retry after an abort is perfectly legal. The guard answered honestly; the
 * harness asked it about a world production never runs in.
 *
 * So the rule this file enforces is narrow and load-bearing: **whatever escapes
 * a generator on a cross-family collision must still be recognisable to
 * `isCrossFamilySlotConflict` after passing through `$transaction`.** Anything
 * that runs another statement post-abort breaks that, and no bare-client test
 * can see it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { generateInstancesForTemplate, getNextOccurrences } from './class-generator';
import { generateStudioInstancesForTemplate } from './studio-class-generator';
import { classStartInstant } from '@/lib/timezone';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = `gentx-${Date.now()}`;

let teacherId: string;
let accountId: string;
let teacherRoomId: string;

const ZONE = 'Europe/Amsterdam';
const DAY = 3;
const TIME = '08:45';

/**
 * Hides the OTHER family's occupancy read from the generator while leaving
 * every other statement real, which stages the race deterministically: the
 * pre-check sees a free date, the insert meets the trigger.
 *
 * A proxy rather than a full stub on purpose — the insert, the own-occupancy
 * read and the week read all have to be genuine, or the test stops exercising
 * the transaction semantics that are the whole point.
 */
function blindTo(tx: Prisma.TransactionClient, model: 'calendarEntry') {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop !== model) return Reflect.get(target, prop, receiver);
      const real = Reflect.get(target, prop, receiver) as unknown as Record<string | symbol, unknown>;
      return new Proxy(real, {
        get(delegate, key) {
          if (key === 'findMany') return async () => [];
          const value = Reflect.get(delegate, key) as unknown;
          return typeof value === 'function' ? value.bind(delegate) : value;
        },
      });
    },
  }) as Prisma.TransactionClient;
}

const candidates = (now: Date) =>
  getNextOccurrences(DAY, now, 5)
    .filter((d) => classStartInstant({ date: d, startTime: hhmmToTime(TIME) }, ZONE) > now)
    .slice(0, 4);

beforeAll(async () => {
  const email = `${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'GenTx', lastName: 'Teacher', email,
      account: { create: { email } }, bio: 'transaction-shape generation',
      pageSlug: suffix, defaultTimezone: ZONE,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  const room = await prisma.room.create({
    data: {
      venueName: 'GenTx Venue', address: `${suffix} Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  teacherRoomId = (
    await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
    })
  ).id;
});

afterAll(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
  // `ScheduleRule` (issue 298), so deleting the rules removes both
  // families' templates with them.
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

async function freshClassTemplate() {
  // Both families, because they share `(teacherId, dayOfWeek, startTime)` and
  // the TEMPLATE-level guard would refuse this create over a leftover sibling
  // — correctly, but before the test reaches the instance-level collision it
  // is about. (Observed: the studio case failed exactly this way first.)
  // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
  // `ScheduleRule` (issue 298), so one delete clears both families.
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  return prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId, kind: 'regular', classType: 'GenTx', dayOfWeek: DAY,
          startTime: hhmmToTime(TIME), durationMinutes: 60,
        },
      },
      teacherRoom: { connect: { id: teacherRoomId } },
      roomCost: 20, minRate: 30, targetRate: 60,
      minStudents: 3, maxStudents: 10,
    },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });
}

async function freshStudioTemplate() {
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  return prisma.studioClassTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId, kind: 'studio', classType: 'GenTx Studio', dayOfWeek: DAY,
          startTime: hhmmToTime(TIME), durationMinutes: 60,
        },
      },
      location: 'Elsewhere', hourlyRate: 40,
    },
    include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
  });
}

describe('generation inside a real $transaction (DB)', () => {
  /**
   * WHAT #327 DID TO THIS PAIR, recorded rather than quietly re-pointed.
   *
   * These two cases used to prove that a cross-family collision reaching the
   * INSERT escaped as a `YG001` — the SQLSTATE the two template POST catches
   * recognise — rather than as the `25P02` a caught-and-retried error would
   * have left behind. Both halves of that premise are gone:
   *
   *  - `YG001` had one raiser, the four cross-family triggers, and #327's
   *    migration dropped all four. Occupancy is one `EXCLUDE USING gist` on
   *    `CalendarEntry` now, which raises `23P01`.
   *  - `ON CONFLICT DO NOTHING` — which `createManyAndReturn({ skipDuplicates:
   *    true })` compiles to, with no conflict target — covers an EXCLUSION
   *    constraint as well as a unique key. So the collision is ABSORBED at the
   *    insert: the date is skipped, nothing is raised, and nothing escapes.
   *
   * That is strictly better than what it replaced (#301 was the 500 the
   * escaping error produced at eight of the ten endpoints), and it is why
   * these cases now assert absorption. What survives unchanged is the
   * property this FILE is named for and the reason it drives a real
   * `$transaction`: the transaction is never poisoned, so the other three
   * dates commit and no `25P02` appears anywhere.
   *
   * `blindTo` now blinds `calendarEntry` rather than the per-family table:
   * one table, one occupancy read.
   */
  it('absorbs a cross-family collision at the insert, without poisoning the transaction', async () => {
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await createStudioClassFixture(prisma, {
        teacherId, scheduleRuleId: null, classType: 'Holder', date: blocked,
        startTime: hhmmToTime(TIME), durationMinutes: 60, location: 'Elsewhere', hourlyRate: 40,
      });
    const template = await freshClassTemplate();

    let caught: unknown;
    const result = await prisma
      .$transaction(async (tx) =>
        generateInstancesForTemplate(blindTo(tx, 'calendarEntry'), template, now),
      )
      .catch((err: unknown) => {
        caught = err;
        return null;
      });

    // Nothing escaped — and `25P02` is named explicitly, because a poisoned
    // transaction is the failure this file exists to keep out and it would
    // also satisfy a bare `toBeNull`.
    expect(caught === undefined || !String(caught).includes('25P02')).toBe(true);
    expect(caught).toBeUndefined();

    // Blinded, the pre-check offers all four dates; the constraint declines
    // the one the holder occupies and the insert skips it. Three commit.
    expect(result?.created).toBe(3);
    expect(result?.skipped.map((s) => s.reason)).toEqual(['raced']);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: template.id } } } } } })).toBe(3);
  });

  it('absorbs the mirror collision on the studio side the same way', async () => {
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await createClassFixture(prisma, {
        teacherId, teacherRoomId, scheduleRuleId: null, classType: 'Holder', date: blocked,
        startTime: hhmmToTime(TIME), durationMinutes: 60, roomCost: 20, minRate: 30,
        targetRate: 60, minStudents: 3, maxStudents: 10,
      });
    const template = await freshStudioTemplate();

    let caught: unknown;
    const result = await prisma
      .$transaction(async (tx) =>
        generateStudioInstancesForTemplate(blindTo(tx, 'calendarEntry'), template, now),
      )
      .catch((err: unknown) => {
        caught = err;
        return null;
      });

    expect(caught).toBeUndefined();
    expect(result?.created).toBe(3);
    expect(result?.skipped.map((s) => s.reason)).toEqual(['raced']);
    expect(await prisma.studioClass.count({ where: { calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: template.id } } } } } })).toBe(3);
  });

  it('does not reach the trigger at all when the pre-check can see the row', async () => {
    // The other half of the contract, and the reason the loss above is
    // acceptable: unblinded, the pre-check declines the one date and the
    // transaction commits the other three. This is the realistic path.
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await createStudioClassFixture(prisma, {
        teacherId, scheduleRuleId: null, classType: 'Holder', date: blocked,
        startTime: hhmmToTime(TIME), durationMinutes: 60, location: 'Elsewhere', hourlyRate: 40,
      });
    const template = await freshClassTemplate();

    const result = await prisma.$transaction(async (tx) =>
      generateInstancesForTemplate(tx, template, now),
    );

    expect(result.created).toBe(3);
    expect(result.skipped).toEqual([{ date: blocked, reason: 'blocked_by_overlap' }]);
  });
});
