import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { syncTemplateInstances } from './template-sync';
import { getNextOccurrences, generateInstancesForTemplate } from './class-generator';
import { classStartInstant } from '@/lib/timezone';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
let templateId: string;

/** Next occurrence of `dayOfWeek` at least `weeksOut` weeks ahead (UTC midnight). */
function futureDate(dayOfWeek: number, weeksOut: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7 * weeksOut);
  while (d.getUTCDay() !== dayOfWeek) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function mkInstance(date: Date, opts: { locked?: boolean; status?: 'draft' | 'open' | 'in_progress' } = {}) {
  return prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      templateId,
      classType: 'Sync Flow',
      date,
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15),
      targetRate: new Prisma.Decimal(25),
      minStudents: 2,
      maxStudents: 10,
      status: opts.status ?? 'open',
      settingsLocked: opts.locked ?? false,
    },
  });
}

describe('syncTemplateInstances', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Sync',
        lastName: 'Teacher',
        email: `sync-${uniqueSuffix}@test.local`,
        account: { create: { email: `sync-${uniqueSuffix}@test.local` } },
        bio: 'template sync tests',
        pageSlug: `sync-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: {
        venueName: 'Sync Studio',
        address: `${uniqueSuffix} Sync St`,
        city: 'Amsterdam',
        postcode: '1234SY',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 20 },
    });
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Sync Flow',
        dayOfWeek: 1, // Tuesday (schema convention: 0 = Monday)
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: false, // keep the generator out of these tests
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.classTemplate.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('updates mutable future instances, keeps locked and started ones', async () => {
    const tpl = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const day = tpl.dayOfWeek;

    const mutable = await mkInstance(futureDate(dayInstanceWeekday(day), 1));
    const locked = await mkInstance(futureDate(dayInstanceWeekday(day), 2), { locked: true });
    const started = await mkInstance(futureDate(dayInstanceWeekday(day), 3), {
      status: 'in_progress',
    });

    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { startTime: '10:30', targetRate: new Prisma.Decimal(30), classType: 'Sync Flow II' },
    });

    const result = await prisma.$transaction((tx) => syncTemplateInstances(tx, templateId));
    expect(result.synced).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.regenerated).toBe(0);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: mutable.id } });
    expect(updated.startTime).toBe('10:30');
    expect(Number(updated.targetRate)).toBe(30);
    expect(updated.classType).toBe('Sync Flow II');

    const keptRow = await prisma.class.findUniqueOrThrow({ where: { id: locked.id } });
    expect(keptRow.startTime).toBe('09:00'); // bookings freeze settings
    const startedRow = await prisma.class.findUniqueOrThrow({ where: { id: started.id } });
    expect(startedRow.startTime).toBe('09:00');
  });

  it('a day change deletes mutable wrong-day instances and keeps locked ones', async () => {
    // Move the template to a different weekday than every existing instance.
    const tpl = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const newDay = (tpl.dayOfWeek + 3) % 7;
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { dayOfWeek: newDay },
    });

    const before = await prisma.class.findMany({ where: { templateId } });
    const mutableBefore = before.filter(
      (c) => !c.settingsLocked && (c.status === 'draft' || c.status === 'open'),
    );
    expect(mutableBefore.length).toBeGreaterThanOrEqual(1);

    const result = await prisma.$transaction((tx) => syncTemplateInstances(tx, templateId));
    expect(result.regenerated).toBe(mutableBefore.length);
    expect(result.kept).toBe(2); // locked + in_progress survive on the old day

    const after = await prisma.class.findMany({ where: { templateId } });
    // Template inactive → no refill; only the untouchable rows remain.
    expect(after.length).toBe(2);
    expect(after.every((c) => c.settingsLocked || c.status === 'in_progress')).toBe(true);
    // A paused template skips the refill entirely, so nothing was added and
    // nothing was blocked — `regenerated` above is a delete count on its own.
    expect(result.refilled).toBe(0);
    expect(result.blockedByCancelled).toBe(0);
    expect(result.slotTaken).toBe(0);
  });

  /**
   * The reason `refilled` exists as a separate number from `regenerated`.
   *
   * `regenerated` counts instances DELETED from the old day. Until #196's slot
   * pre-check, the refill created one row per deleted one, so rendering the
   * delete count as "N rescheduled to the new day" happened to be true. It is
   * not any more: if the teacher already has a class at that time on the new
   * day, every candidate date is `slot_taken` and the refill creates nothing —
   * four classes destroyed, four waitlists cascaded, and the old message said
   * they had moved.
   */
  it('reports deletes and refills separately when the new day is already occupied', async () => {
    // Self-contained: the preceding test leaves this template with no mutable
    // instances, so this one generates its own window before moving it. A test
    // that depends on a sibling's leftovers is how the first draft of this
    // asserted `regenerated > 0` against a zero.
    await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: true } });
    const seed = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    const seeded = await generateInstancesForTemplate(prisma, seed);
    expect(seeded.created).toBeGreaterThan(0);

    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const newDay = (template.dayOfWeek + 2) % 7;

    // Occupy every candidate slot on the new day with classes of no template.
    const targets = getNextOccurrences(newDay, new Date(), 5)
      .filter((d) => classStartInstant(d, template.startTime, 'UTC') > new Date())
      .slice(0, 4);
    for (const date of targets) {
      await prisma.class.create({
        data: {
          teacherId: template.teacherId,
          teacherRoomId: template.teacherRoomId,
          templateId: null,
          classType: 'Occupier',
          date,
          startTime: template.startTime,
          durationMinutes: 60,
          roomCost: 10,
          minRate: 5,
          targetRate: 10,
          minStudents: 1,
          maxStudents: 5,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
        },
      });
    }

    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { dayOfWeek: newDay, isActive: true },
    });

    const result = await prisma.$transaction((tx) => syncTemplateInstances(tx, templateId));

    expect(result.regenerated).toBeGreaterThan(0); // deleted from the old day
    expect(result.refilled).toBe(0); // and none created on the new one
    expect(result.slotTaken).toBe(targets.length);
    expect(result.blockedByCancelled).toBe(0);
  });

  /**
   * Before the ordered pre-lock, `future` was read from an unlocked snapshot, so
   * a registration committing between that read and the `updateMany` let the
   * propagation rewrite a class it was supposed to keep. The pre-lock plus the
   * re-read under it closes that window — this pins the re-read, not the lock.
   *
   * Forced, not timed: the hook below pauses `syncTemplateInstances` right
   * BEFORE its pre-lock `$queryRaw` executes and holds it there while a
   * separate, unhooked write locks and flips `settingsLocked` on the one
   * instance and commits — standing in for a booking that reaches the class
   * first. Only then is the sync allowed to proceed. In the real, unmutated
   * order (pre-lock before the re-read) this makes the re-read observe the
   * committed flip and correctly keep the row. The mutation that proves this
   * bites — hoisting the `class.findMany` re-read above the pre-lock, so it
   * captures the row before the flip — is spec §4's "Lock-then-re-read" row.
   * It is described there rather than performed here; running it turns the
   * `startTime` assertion below into `'11:15'`. ("The mutation below" is what
   * this said before, and there is no mutation below — only the test body.)
   *
   * Self-contained: its own template, isolated from the three tests above,
   * which leave the shared `templateId` mutated (day changed, reactivated).
   */
  it('does not propagate to a class that became settingsLocked after the pre-lock read', async () => {
    const pinTemplate = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Pin Flow',
        dayOfWeek: 2, // Wednesday (schema convention: 0 = Monday)
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: false,
      },
    });

    const instance = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId: pinTemplate.id,
        classType: 'Pin Flow',
        date: futureDate(dayInstanceWeekday(pinTemplate.dayOfWeek), 2),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
        settingsLocked: false,
      },
    });

    await prisma.classTemplate.update({
      where: { id: pinTemplate.id },
      data: { startTime: '11:15' },
    });

    let preLockReached!: () => void;
    const preLockReachedPromise = new Promise<void>((resolve) => {
      preLockReached = resolve;
    });
    let goAhead!: () => void;
    const goAheadPromise = new Promise<void>((resolve) => {
      goAhead = resolve;
    });

    // Keyed on the query's own bound value — `templateId` is the pre-lock's
    // first bind — not on call sequence, the house rule this repo's other
    // lock-order hooks follow (`invitations-lock-order.test.ts`).
    const hookedPrisma = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          if (args.values[0] === pinTemplate.id) {
            preLockReached();
            await goAheadPromise;
          }
          return query(args);
        },
      },
      // `$extends` returns a client whose own `.$transaction` callback is
      // typed against its extended `DynamicClientExtensionThis`, not the
      // plain `Prisma.TransactionClient` the `TransactionClientOnly` brand is
      // built on — `tx.account.findUnique`'s extended argument type is not
      // assignable to the plain one, so passing that `tx` straight to
      // `syncTemplateInstances` fails to compile. The cast below discards
      // only the extension's TYPE, not its behaviour: every method still
      // runs the real hook, against the real database — same cast
      // `template-lock-order.test.ts` uses for its own hooked client.
    }) as unknown as PrismaClient;

    // `syncTemplateInstances` no longer manages its own transaction (task 6,
    // atomic-template-update) — it takes a transaction client and expects
    // the caller to open one, so the hook has to wrap the call the same way
    // `updateClassTemplate` composes it in production. `hookedPrisma.
    // $transaction`'s query extension still applies inside the interactive
    // transaction it opens, so the hook still fires on the pre-lock's
    // `$queryRaw` below.
    const syncPromise = hookedPrisma.$transaction((tx) => syncTemplateInstances(tx, pinTemplate.id));
    await preLockReachedPromise;

    // The registration-shaped write, AWAITED to completion before `goAhead`.
    // The hook fires BEFORE the pre-lock's `FOR UPDATE` executes, so nothing
    // holds the row yet — this commits uncontested, standing in for a
    // booking that reached the class first. Only once it has actually landed
    // does the sync get to proceed past its own pre-lock.
    await prisma.class.update({
      where: { id: instance.id },
      data: { settingsLocked: true },
    });

    goAhead();
    const result = await syncPromise;

    const finalRow = await prisma.class.findUniqueOrThrow({ where: { id: instance.id } });
    expect(finalRow.startTime).toBe('09:00'); // kept, not overwritten to '11:15'
    expect(result.kept).toBe(1);
    expect(result.synced).toBe(0);
  });

  /**
   * The pre-lock's `WHERE` and the re-read's `WHERE` compare against
   * different SQL types, so agreeing on this deployment is not evidence they
   * agree. `syncTemplateInstances` scopes its re-read to `id: { in: lockedIds
   * }`, which makes the write set a structural subset of the LOCK set — good
   * for lock ordering, and precisely why a pre-lock that is too NARROW fails
   * silently instead of loudly: a row the pre-lock skipped is dropped from
   * `future` altogether, so it is neither updated nor deleted nor counted in
   * `kept`, and the caller is told `synced: N` for a set missing it.
   *
   * The bound is therefore truncated to the UTC calendar date (`lockBound`,
   * `template-sync.ts`) rather than bound as the raw instant. This pins that
   * choice against the comparison that motivated it.
   *
   * Deterministic by construction: the instant and the dates are fixed here
   * rather than read off the clock, so this asserts the comparison itself and
   * not whatever time of day the suite happens to run at. The old bound only
   * misbehaved in the late UTC hours, which is exactly the kind of bug a
   * clock-dependent test reports as a flake.
   *
   * `SET LOCAL` inside `$transaction` puts every statement below on one
   * connection at that `TimeZone`, which is what lets a single test cover
   * session settings the deployment does not currently use. UTC is today's
   * value (`postgres:16-alpine`'s default, unpinned by either compose file) —
   * the reason to test the others is that nothing holds it there.
   */
  /**
   * The property test below pins the COMPARISON; this pins that the code
   * actually uses it. Without this one, reverting `lockBound` to the raw
   * `now` leaves the property test green — it asserts SQL semantics, not the
   * call site, so it would go on describing a bound the function no longer
   * binds. Keyed on the third bound value of the pre-lock's own statement
   * (`templateId`, `teacherId`, then the date), identified by its first bind
   * rather than by call order, the house rule this file's other hook follows.
   */
  /**
   * `id: { in: lockedIds }` on the re-read — the structural bound that makes
   * this function's write set a subset of its lock set by construction rather
   * than by an argument that two predicates agree.
   *
   * It is the property `class-template-lifecycle.ts` cites as the reason
   * `syncTemplateInstances` does NOT share the archive's residual exposure,
   * and the atomic-template-update spec's risk list leans on it in the same
   * way — so it was reasoning holding up a documented risk assessment with
   * nothing exercising it. Deleting the clause left every test in this file
   * green.
   *
   * The case it excludes: under READ COMMITTED, with no predicate lock, a
   * `Class` row inserted and committed by a concurrent
   * `generateInstancesForTemplate` AFTER the pre-lock ran matches the
   * re-read's `templateId`/`teacherId`/`date` predicate perfectly, while never
   * having been in the pre-lock's result set. Without the id bound the
   * propagation would write to a row it never locked.
   *
   * Simulated by inserting that row directly rather than by running the
   * generator: the generator would take the template's claim lock and
   * serialise behind this very transaction, which is the reason it cannot
   * actually produce this interleaving in production. The insert is what a
   * future writer with no such claim would do, and it is the shape the
   * comment on the re-read describes.
   *
   * Harmless to exclude, which is why the assertion is "untouched" rather
   * than "kept": a row the generator just created is already built from this
   * template's current values, so skipping it costs nothing.
   */
  it('does not propagate to a class committed between the pre-lock and the re-read', async () => {
    const raceTemplate = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Race Flow',
        dayOfWeek: 3, // Thursday (schema convention: 0 = Monday)
        startTime: '08:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: false,
      },
    });

    const instanceBase = {
      teacherId,
      teacherRoomId,
      templateId: raceTemplate.id,
      classType: 'Race Flow',
      startTime: '08:00',
      durationMinutes: 60,
      roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15),
      targetRate: new Prisma.Decimal(25),
      minStudents: 2,
      maxStudents: 10,
      status: 'open' as const,
      settingsLocked: false,
    };

    const locked = await prisma.class.create({
      data: { ...instanceBase, date: futureDate(dayInstanceWeekday(raceTemplate.dayOfWeek), 2) },
    });

    await prisma.classTemplate.update({
      where: { id: raceTemplate.id },
      data: { startTime: '14:45' },
    });

    // Inserted from OUTSIDE the sync transaction, after its pre-lock has run
    // and before its re-read. A different date from `locked`, so the two
    // cannot collide on `Class_teacher_slot_unique`.
    let latecomerId: string | undefined;
    const hookedPrisma = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          const rows = await query(args);
          if (args.values[0] === raceTemplate.id && !latecomerId) {
            const latecomer = await prisma.class.create({
              data: {
                ...instanceBase,
                date: futureDate(dayInstanceWeekday(raceTemplate.dayOfWeek), 3),
              },
            });
            latecomerId = latecomer.id;
          }
          return rows;
        },
      },
      // Same cast rationale as this file's other hooks.
    }) as unknown as PrismaClient;

    const result = await hookedPrisma.$transaction((tx) =>
      syncTemplateInstances(tx, raceTemplate.id),
    );

    expect(latecomerId).toBeDefined();

    // Only the pre-locked row was propagated to.
    expect(result.synced).toBe(1);
    const lockedAfter = await prisma.class.findUniqueOrThrow({ where: { id: locked.id } });
    expect(lockedAfter.startTime).toBe('14:45');

    // The latecomer was never locked, so it is never written — it keeps the
    // value it was created with. Drop `id: { in: lockedIds }` and this becomes
    // '14:45' with `synced: 2`.
    const latecomerAfter = await prisma.class.findUniqueOrThrow({
      where: { id: latecomerId as string },
    });
    expect(latecomerAfter.startTime).toBe('08:00');
  });

  it('binds the pre-lock to UTC midnight, not the raw instant', async () => {
    let bound: unknown;
    const hookedPrisma = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          if (args.values[0] === templateId) bound = args.values[2];
          return query(args);
        },
      },
      // Same cast rationale as the hook above.
    }) as unknown as PrismaClient;

    await hookedPrisma.$transaction((tx) => syncTemplateInstances(tx, templateId));

    expect(bound).toBeInstanceOf(Date);
    const d = bound as Date;
    expect([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]).toEqual(
      [0, 0, 0, 0],
    );
  });

  it('the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone', async () => {
    // 22:30 UTC: late enough that a raw-instant bound stops covering
    // tomorrow once the session TimeZone is far enough east.
    const instant = '2026-08-15 22:30:00+00';
    const utcMidnight = '2026-08-15 00:00:00+00';

    for (const timeZone of ['UTC', 'Europe/Amsterdam', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York']) {
      const rows = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${timeZone}'`);
        return tx.$queryRawUnsafe<
          Array<{ day: string; reread: boolean; shipped: boolean; rawInstant: boolean }>
        >(`
          SELECT d::text                                        AS day,
                 (d > DATE '2026-08-15')                        AS reread,
                 (d > TIMESTAMPTZ '${utcMidnight}')             AS shipped,
                 (d > TIMESTAMPTZ '${instant}')                 AS "rawInstant"
          FROM (VALUES (DATE '2026-08-14'), (DATE '2026-08-15'), (DATE '2026-08-16')) AS t(d)
        `);
      });

      for (const row of rows) {
        // The guarantee: superset in every session TimeZone, subset in none.
        // Stated as an implication rather than equality — west of UTC the
        // shipped bound legitimately locks today as well, which the re-read
        // then excludes, and that direction is safe.
        if (row.reread) {
          expect(
            row.shipped,
            `${timeZone}: ${row.day} is wanted by the re-read but not covered by the pre-lock`,
          ).toBe(true);
        }
      }

      // The negative control, so this test cannot quietly become vacuous:
      // the bound this replaced DID drop tomorrow east of UTC. If Postgres
      // ever stopped promoting `date` through the session TimeZone, both
      // columns would agree everywhere and the assertion above would pass
      // without meaning anything.
      const tomorrow = rows.find((r) => r.day === '2026-08-16');
      if (timeZone === 'Asia/Tokyo' || timeZone === 'Pacific/Kiritimati') {
        expect(tomorrow?.rawInstant).toBe(false);
        expect(tomorrow?.shipped).toBe(true);
      }
    }
  });
});

/** Schema dayOfWeek (0=Monday) → JS getUTCDay (0=Sunday). */
function dayInstanceWeekday(templateDay: number): number {
  return (templateDay + 1) % 7;
}
