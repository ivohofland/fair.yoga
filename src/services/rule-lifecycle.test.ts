import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ClassFamily, ClassTemplate, Prisma, StudioClassTemplate } from '@prisma/client';
import {
  archiveOrUnarchiveRule,
  pauseOrResumeRule,
  type ArchiveRuleResult,
  type TemplateFamily,
  type WithSlot,
} from './rule-lifecycle';
import { CLASS_FAMILY } from './class-template-lifecycle';
import { STUDIO_FAMILY } from './studio-class-template-lifecycle';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Correlates each descriptor's own `kind` with the key it is filed under, at
 * compile time. The runtime loop this replaces could only observe a
 * disagreement after the fact; this makes it unrepresentable.
 *
 * `TKind` sits in a property position and is therefore covariant.
 */
interface ChildByKind {
  regular: ClassTemplate;
  studio: StudioClassTemplate;
}

/**
 * A third `ClassFamily` variant becomes a compile error HERE rather than a
 * silent gap — the tether `COUNT_KEYS` (`template-action-messages.ts`) and
 * `ROOM_SEARCH_SELECT` (`api/rooms/route.ts`) use, applied to families.
 *
 * `prisma/schema.prisma`'s own `ClassFamily` docblock anticipates a third
 * variant, which is why this is worth having rather than hypothetical.
 */
const FAMILY_BY_KIND = {
  regular: CLASS_FAMILY,
  studio: STUDIO_FAMILY,
} satisfies { [K in ClassFamily]: TemplateFamily<ChildByKind[K], K> };

describe('rule-lifecycle family descriptors', () => {
  it('the family without a withdraw hook says so explicitly rather than omitting it', () => {
    // `null`, not `undefined`. `TemplateFamily.withdraw` is required, so an
    // omission is a compile error — this asserts the runtime half: that the
    // studio descriptor has actually made the choice rather than inherited it.
    expect(STUDIO_FAMILY.withdraw).toBeNull();
    // `toHaveProperty`, not `not.toBeNull()`: the latter passes for
    // `undefined` too, the exact omission the assertion above exists to rule
    // out for the other family. A real `WithdrawHook` has an `around` hook —
    // asserting that is present is what actually distinguishes "declared a
    // hook" from "declared nothing".
    expect(CLASS_FAMILY.withdraw).toHaveProperty('around');
  });

  /**
   * `childTable` is spliced into a raw identifier position, so its type is the
   * only thing bounding what can land there. `Prisma.ModelName` admits every
   * model in the schema, `CalendarEntry` included, and narrowing it to the
   * template children is what makes a third family a deliberate edit rather
   * than a silent widening.
   *
   * A claim about what the compiler refuses is worth only the pin that makes
   * the compiler refuse it, which is the rule `ArchiveRuleResult`'s docblock
   * states and the non-interchangeability pin below already follows.
   */
  it('refuses a childTable that is not a template child', () => {
    // @ts-expect-error `CalendarEntry` is a model, but not a template child
    const notATemplateChild: TemplateFamily<ClassTemplate>['childTable'] = 'CalendarEntry';
    void notATemplateChild;
  });

  /**
   * `deleteWhere` and `standingWhere` have identical signatures and sit on
   * adjacent lines in both descriptors, so swapping them in either family
   * compiles clean — and in the class family that swap silently drops the
   * `registrations: { none: CHARGED }` conjunct from the delete, cascading
   * away classes a student has already been charged for. Nothing about the
   * types can catch it; the boundary is what tells them apart.
   *
   * Asserted directly rather than through a DB round trip: both predicates are
   * plain inspectable object literals, so the boundary is readable off the
   * value.
   */
  describe('the two predicates keep their boundaries', () => {
    const RULE_ID = 'rule-under-test';
    const TODAY = new Date('2026-08-27T00:00:00.000Z');

    // `date` and `classes` dropped, so what remains is the part the two
    // predicates must agree on. `kind` lives there for the studio family, and
    // a family that spelled it in only one of its predicates would count rows
    // it did not delete.
    const sharedPart = (where: Prisma.CalendarEntryWhereInput) => {
      const rest = { ...where };
      delete rest.date;
      delete rest.classes;
      return rest;
    };

    it.each(Object.entries(FAMILY_BY_KIND))(
      "the %s family's delete excludes today and its count includes it",
      (_kind, family) => {
        const del = family.deleteWhere(RULE_ID, TODAY);
        const remaining = family.standingWhere(RULE_ID, TODAY);

        // The carve-out #86/#194 rest on: a class hours from starting is
        // spared by the delete and must still be reported as standing.
        expect(del.date).toEqual({ gt: TODAY });
        expect(remaining.date).toEqual({ gte: TODAY });
        expect(sharedPart(del)).toEqual(sharedPart(remaining));
      },
    );
  });
});

/**
 * `ArchiveRuleResult`'s docblock (`rule-lifecycle.ts`) claims that being
 * generic in the child leaves the two families' results non-interchangeable,
 * because `template` differs. A claim about what the compiler refuses is worth
 * only the pin that makes the compiler refuse it — the shape
 * `template-action-messages.test.ts` uses for the `templateKind` discriminator
 * this is modelled on ("the two toggle payloads are not interchangeable").
 *
 * `{} as WithSlot<…>` because `template` is the only field carrying the
 * difference and nothing here reads the row; building two real ones would put
 * the schema's own columns into a test about assignability.
 */
describe("the two families' archive results are not interchangeable", () => {
  it('rejects each family result where the other family is required', () => {
    const takesStudio = (r: ArchiveRuleResult<StudioClassTemplate>) => r.ok;
    const takesClass = (r: ArchiveRuleResult<ClassTemplate>) => r.ok;

    const classResult: ArchiveRuleResult<ClassTemplate> = {
      ok: true,
      action: 'unarchived',
      template: {} as WithSlot<ClassTemplate>,
    };
    const studioResult: ArchiveRuleResult<StudioClassTemplate> = {
      ok: true,
      action: 'unarchived',
      template: {} as WithSlot<StudioClassTemplate>,
    };

    // @ts-expect-error a class archive result must never satisfy the studio one
    takesStudio(classResult);
    // @ts-expect-error a studio archive result must never satisfy the class one
    takesClass(studioResult);

    // Each at its own family, so the two functions above are exercised rather
    // than merely declared.
    expect(takesStudio(studioResult)).toBe(true);
    expect(takesClass(classResult)).toBe(true);
  });
});

describe('the shared lifecycle verbs (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  // A slot per template, spaced a full `durationMinutes` apart:
  // `ScheduleRule_teacher_slot_excl` (issue 298) excludes on RANGE overlap,
  // and every archive in this block is rolled back by the guard it is testing
  // — so no template here is ever left archived, and each one holds its slot
  // for the rest of the run.
  let makeTemplateCounter = 0;
  const makeTemplate = () => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType: `Guard ${makeTemplateCounter}`,
            dayOfWeek: 3,
            startTime: hhmmToTime(`${String(8 + makeTemplateCounter).padStart(2, '0')}:00`),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      include: { scheduleRule: true },
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    const email = `rule-guard-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Guard',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Teacher for the archive record guard',
        pageSlug: `rule-guard-${uniqueSuffix}`,
        // Pinned rather than left to the schema default, for the reason #123
        // put the same pin in both lifecycle test files: the archive derives
        // its boundary from `startOfLocalDay(now, defaultTimezone)`, and a
        // zone that disagrees with the fixture's UTC dates moves that boundary
        // by a day at some hours of the evening.
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    const room = await prisma.room.create({
      data: {
        venueName: 'Guard Venue',
        address: `${uniqueSuffix} Guard St`,
        city: 'Testville',
        postcode: '1234TP',
        floor: '1',
        roomName: 'Loft',
        maxCapacity: 10,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298),
    // so deleting the rule removes the template with it.
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The record guard inside `archiveOrUnarchiveRule` — that a family's
   * `withdraw` hook runs the shared delete exactly once.
   *
   * It protects `withdrawnCount` (#97), the durable record of what a teacher is
   * told was withdrawn, and it holds for both shipped families vacuously:
   * `STUDIO_FAMILY.withdraw` is `null`, so that family never reaches the
   * callback at all, and `CLASS_FAMILY`'s hook is correct. Nothing shipped can
   * turn the guard red, so a synthetic family is what makes it fail — deleting
   * the guard has to break something.
   *
   * The count itself needs no guard: `around` returns `void`, so the number that
   * reaches `withdrawnCount` comes out of the shared delete's own closure and no
   * hook can substitute one. That is a mutation nobody can write, which beats a
   * mutation this file would have to catch.
   *
   * `CLASS_FAMILY` spread whole, so everything except the hook is the real
   * archive — the read, the child row lock, the CAS, both predicates. One case
   * per way the call count can be wrong: never run, run twice, and run but
   * never completed.
   */
  const cases: Array<[string, TemplateFamily<ClassTemplate>]> = [
    ['never runs the shared delete at all', { ...CLASS_FAMILY, withdraw: { around: async () => {} } }],
    [
      'runs the shared delete twice',
      {
        ...CLASS_FAMILY,
        withdraw: {
          around: async (_tx, _ctx, deleteEntries) => {
            await deleteEntries();
            await deleteEntries();
          },
        },
      },
    ],
    [
      'swallows a failure from the shared delete',
      {
        ...CLASS_FAMILY,
        withdraw: {
          around: async (tx, _ctx, deleteEntries) => {
            // Aborts the Postgres transaction (`22012`), so the shared delete
            // below cannot complete. Every later statement raises `25P02`
            // until rollback, which is what would surface WITHOUT the guard:
            // an opaque 500 from the `count` two statements on, naming a
            // failure nowhere near the hook that caused it.
            await tx.$queryRaw`SELECT 1 / 0`.catch(() => undefined);
            try {
              await deleteEntries();
            } catch {
              // The shape this case exists for: a hook that hides the
              // failure and hands control back as if the delete had run.
              // The guard's counter is incremented after the statement
              // completes, so this reads as zero calls rather than one.
            }
          },
        },
      },
    ],
  ];

  it.each(cases)('refuses a withdraw hook that %s, and records nothing', async (_label, family) => {
    const template = await makeTemplate();

    await expect(
      archiveOrUnarchiveRule(prisma, family, template.id, teacherId, 'archived'),
    ).rejects.toThrow(/must run the shared delete exactly once/);

    // Refusing is half of what the guard is for; the other half is that the
    // throw rolls the transaction back whole, so the CAS that ran before the
    // hook leaves no archive behind — least of all a `withdrawnCount` the
    // teacher would be shown.
    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: template.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.archivedAt).toBeNull();
    expect(after.scheduleRule.withdrawnCount).toBeNull();
    expect(after.scheduleRule.isArchived).toBe(false);
  });

  /**
   * The shared `catch` answers `busy` for a transient error and rethrows
   * everything else. That rethrow is load-bearing, and its only other guard
   * lives in `room-archive-doors.test.ts` — a file named for the room-archive
   * lifecycle, which is not where someone editing error handling here will
   * look. Since #272 a resume onto an archived room is refused by a CHECK
   * rather than by a service guard: the CAS flips `isActive`, the constraint
   * fires, and the SQLSTATE has to reach the route, which turns it into a 409
   * a teacher can act on. Classified as transient it becomes a 503 "the system
   * was busy" instead, and the studio family — which has no such constraint —
   * shows no symptom at all.
   *
   * `23514` sits in neither transient list (`isTransientDbError`,
   * `@/lib/api-errors`), on a constraint name nothing in this schema declares,
   * so a stray match cannot make this pass for the wrong reason.
   *
   * The override is on `updateMany`, which is the CAS and nothing else here:
   * the fixture above writes through `update`, so nothing it does is
   * intercepted. Driven through `CLASS_FAMILY` because that is the family this
   * block's fixture builds rows for; the `catch` under test takes no family
   * into account.
   */
  it('rethrows a non-transient database error rather than answering busy', async () => {
    const template = await makeTemplate();
    // Paused, so `target: 'active'` is a real transition and reaches the CAS
    // rather than the already-in-that-state fast path.
    await prisma.scheduleRule.update({
      where: { id: template.scheduleRuleId },
      data: { isActive: false },
    });

    const checkViolation = Object.assign(
      new Error(
        'Raw query failed. code: "23514". Message: `ERROR: new row for relation ' +
          '"ClassTemplate" violates check constraint "__c1b_never_a_real_constraint"`',
      ),
      { code: 'P2010' },
    );

    const throwing = prisma.$extends({
      query: {
        scheduleRule: {
          async updateMany() {
            throw checkViolation;
          },
        },
      },
    }) as unknown as PrismaClient;

    // `rejects`, not a `busy` result: the identity of the error is what the
    // route reads to pick 409 over 503.
    await expect(
      pauseOrResumeRule(throwing, CLASS_FAMILY, template.id, teacherId, 'active'),
    ).rejects.toBe(checkViolation);
  });
});
