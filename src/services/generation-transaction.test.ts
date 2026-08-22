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
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { classStartInstant } from '@/lib/timezone';

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
function blindTo(tx: Prisma.TransactionClient, model: 'studioClass' | 'class') {
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
    .filter((d) => classStartInstant(d, TIME, ZONE) > now)
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
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.studioClass.deleteMany({ where: { teacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
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
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
  return prisma.classTemplate.create({
    data: {
      teacherId, teacherRoomId, classType: 'GenTx', dayOfWeek: DAY, startTime: TIME,
      durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
      minStudents: 3, maxStudents: 10,
    },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}

async function freshStudioTemplate() {
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  return prisma.studioClassTemplate.create({
    data: {
      teacherId, classType: 'GenTx Studio', dayOfWeek: DAY, startTime: TIME,
      durationMinutes: 60, location: 'Elsewhere', hourlyRate: 40,
    },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}

describe('generation inside a real $transaction (DB)', () => {
  it('lets the class generator escape a cross-family collision as YG001, not 25P02', async () => {
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.studioClass.create({
      data: {
        teacherId, templateId: null, classType: 'Holder', date: blocked,
        startTime: TIME, durationMinutes: 60, location: 'Elsewhere', hourlyRate: 40,
      },
    });
    const template = await freshClassTemplate();

    let caught: unknown;
    await prisma
      .$transaction(async (tx) => {
        await generateInstancesForTemplate(blindTo(tx, 'studioClass'), template, now);
      })
      .catch((err: unknown) => {
        caught = err;
      });

    // THE assertion. `25P02` also fails `toBeUndefined`, so a count-based or
    // truthiness-based check would pass against the defect this file exists
    // for — what matters is that the escaping error is still the one the two
    // template POST catches recognise. (Two, not ten: pass 2 corrected that
    // conflation in this file's header and in both generators and missed this
    // body comment, which is why the header now states the number once and
    // this line points at it.)
    expect(caught).toBeDefined();
    expect(isCrossFamilySlotConflict(caught)).toBe(true);
    expect((caught as Error).message).not.toContain('25P02');

    // The accepted cost, stated rather than implied: the transaction rolled
    // back whole, so the window is lost for this run. The next sweep's
    // pre-check sees the committed studio class and skips only that date.
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(0);
  });

  it('lets the studio generator escape the mirror collision the same way', async () => {
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.class.create({
      data: {
        teacherId, teacherRoomId, templateId: null, classType: 'Holder', date: blocked,
        startTime: TIME, durationMinutes: 60, roomCost: 20, minRate: 30,
        targetRate: 60, minStudents: 3, maxStudents: 10,
      },
    });
    const template = await freshStudioTemplate();

    let caught: unknown;
    await prisma
      .$transaction(async (tx) => {
        await generateStudioInstancesForTemplate(blindTo(tx, 'class'), template, now);
      })
      .catch((err: unknown) => {
        caught = err;
      });

    expect(caught).toBeDefined();
    expect(isCrossFamilySlotConflict(caught)).toBe(true);
    expect((caught as Error).message).not.toContain('25P02');
    expect(await prisma.studioClass.count({ where: { templateId: template.id } })).toBe(0);
  });

  it('does not reach the trigger at all when the pre-check can see the row', async () => {
    // The other half of the contract, and the reason the loss above is
    // acceptable: unblinded, the pre-check declines the one date and the
    // transaction commits the other three. This is the realistic path.
    const now = new Date();
    const blocked = candidates(now)[1]!;
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.studioClass.create({
      data: {
        teacherId, templateId: null, classType: 'Holder', date: blocked,
        startTime: TIME, durationMinutes: 60, location: 'Elsewhere', hourlyRate: 40,
      },
    });
    const template = await freshClassTemplate();

    const result = await prisma.$transaction(async (tx) =>
      generateInstancesForTemplate(tx, template, now),
    );

    expect(result.created).toBe(3);
    expect(result.skipped).toEqual([{ date: blocked, reason: 'blocked_by_other_family' }]);
  });
});
