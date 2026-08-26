import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { probeConflictingEntry, entryConflictMessage } from './entry-conflict';
import { hhmmToTime } from './time-of-day';

const prisma = new PrismaClient();
const suffix = `entry-conflict-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;
const accountIds: string[] = [];

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Conflict', lastName: tag, email, bio: 'entry conflict fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  accountIds.push(t.accountId);
  return t.id;
}

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type PlantFields = Partial<Prisma.CalendarEntryUncheckedCreateInput> & {
  date: Date;
  startTime: Date;
};

/**
 * A BARE entry, with no child of either family. Legal: disjoint occupancy is
 * declarative and totality deliberately is not (stage B design §1.3.1, §8), and
 * the probe reads the parent alone.
 *
 * Each case below owns its own calendar day, so no fixture can occupy another
 * case's slot — the same isolation `slot-constraints.test.ts` uses, and the
 * only one available when the constraint under test is what would refuse the
 * overlap.
 */
function plant(over: PlantFields) {
  return prisma.calendarEntry.create({
    data: {
      teacherId,
      kind: 'regular',
      classType: 'Probe Fixture',
      durationMinutes: 60,
      ...over,
    },
  });
}

describe('probeConflictingEntry', () => {
  it('names the overlapping entry, not merely its family', async () => {
    const holder = await plant({
      date: day('2033-03-01'), startTime: hhmmToTime('19:00'), durationMinutes: 90,
    });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-01'), startTime: hhmmToTime('19:30'), durationMinutes: 60,
    });

    expect(conflict).not.toBeNull();
    expect(conflict?.id).toBe(holder.id);
    expect(conflict?.kind).toBe('regular');
    // Read back as the column types the caller has to render, not as strings:
    // `date` is `@db.Date` and `startTime` is `@db.Time`, and a raw `Date` in a
    // teacher-facing sentence prints as a full timestamp.
    expect(conflict?.date.toISOString().slice(0, 10)).toBe('2033-03-01');
    expect(conflict?.startTime.getUTCHours()).toBe(19);
    expect(conflict?.startTime.getUTCMinutes()).toBe(0);
    expect(conflict?.durationMinutes).toBe(90);
  });

  it('names a studio entry as studio', async () => {
    await plant({
      date: day('2033-03-02'), startTime: hhmmToTime('10:00'), kind: 'studio',
    });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-02'), startTime: hhmmToTime('10:30'), durationMinutes: 30,
    });

    expect(conflict?.kind).toBe('studio');
  });

  /**
   * The `'unknown'` state, exercised honestly rather than by timing. A cancelled
   * entry is outside `CalendarEntry_teacher_slot_excl`'s partial scope, so the
   * conflicting row really can vanish between the refusal and this probe — and
   * naming the wrong half of a teacher's schedule is worse than naming neither.
   */
  it('answers null when the only overlapping entry was cancelled', async () => {
    await plant({
      date: day('2033-03-03'), startTime: hhmmToTime('09:00'), cancelledAt: new Date(),
    });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-03'), startTime: hhmmToTime('09:00'), durationMinutes: 60,
    });

    expect(conflict).toBeNull();
    // What the route then answers: its own family's sentence, naming no time
    // and no date — no digit reaches the teacher, because every digit this
    // message could carry would come from the row the probe did not find.
    const message = entryConflictMessage(conflict, 'studio');
    expect(message).toBe('You already have a studio class that overlaps that time.');
    expect(message).not.toMatch(/\d/);
  });

  it('answers null for another teacher\'s overlapping entry', async () => {
    await prisma.calendarEntry.create({
      data: {
        teacherId: otherTeacherId, kind: 'regular', classType: 'Probe Fixture',
        date: day('2033-03-04'), startTime: hhmmToTime('09:00'), durationMinutes: 60,
      },
    });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-04'), startTime: hhmmToTime('09:00'), durationMinutes: 60,
    });

    expect(conflict).toBeNull();
  });

  /**
   * A reschedule probes AFTER its own write rolled back, so the row it was
   * moving still holds its OLD span. Without the exclusion it reports itself as
   * the holder — and the time it would then name is the one the teacher was
   * moving away from.
   */
  it('excludes the entry being rescheduled', async () => {
    const mover = await plant({ date: day('2033-03-05'), startTime: hhmmToTime('09:00') });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-05'), startTime: hhmmToTime('09:30'), durationMinutes: 60,
      excludeEntryId: mover.id,
    });

    expect(conflict).toBeNull();
  });

  it('answers null for an entry starting exactly where the probe ends — half-open', async () => {
    // The entry occupies [10:00, 11:00); the probe asks about [09:00, 10:00).
    // `'[)'` → `'[]'` in either bound makes these touch, and this case is what
    // holds the probe's bound to the constraint's own.
    await plant({ date: day('2033-03-06'), startTime: hhmmToTime('10:00') });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-06'), startTime: hhmmToTime('09:00'), durationMinutes: 60,
    });

    expect(conflict).toBeNull();
  });

  /**
   * The case a family discriminator could never have served: the conflicting
   * row is not on the date being edited, so a teacher told only which family
   * holds the slot looks at the wrong day.
   */
  it('finds a conflict that spilled past midnight from the previous day', async () => {
    await plant({ date: day('2033-03-07'), startTime: hhmmToTime('23:30') });

    const conflict = await probeConflictingEntry(prisma, teacherId, {
      date: day('2033-03-08'), startTime: hhmmToTime('00:15'), durationMinutes: 30,
    });

    expect(conflict?.date.toISOString().slice(0, 10)).toBe('2033-03-07');
    expect(conflict?.startTime.getUTCHours()).toBe(23);
  });

  /**
   * Every caller runs this inside the `catch` block of a write the database has
   * already refused, so a throw here would escape to `withErrorHandler` and
   * answer 5xx — reporting a correctly refused write as one that may have
   * happened. Contention is when slot conflicts occur, so a pool or lock
   * timeout on this extra query is the realistic failure, not a hypothetical.
   */
  it('answers null rather than throwing when the query itself fails', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(probeConflictingEntry(prisma, teacherId, {
        date: day('2033-03-09'), startTime: hhmmToTime('09:00'), durationMinutes: 60,
      })).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('entryConflictMessage', () => {
  const conflict = {
    id: 'e1',
    date: day('2027-09-01'),
    startTime: hhmmToTime('19:00'),
    durationMinutes: 90,
  };

  it('names the HOLDER\'s family, time and date — not the caller\'s', () => {
    expect(entryConflictMessage({ ...conflict, kind: 'regular' }, 'studio'))
      .toBe('You already have a class at 19:00 on 1 Sep 2027.');
    expect(entryConflictMessage({ ...conflict, kind: 'studio' }, 'regular'))
      .toBe('You already have a studio class at 19:00 on 1 Sep 2027.');
  });

  // The fallback claims an OVERLAP and not a shared date and start time. Under
  // `CalendarEntry_teacher_slot_excl`'s range predicate (#327) the holder need
  // share neither — a neighbour running past midnight collides from the
  // previous calendar date — so the narrower sentence would be a guess.
  it('falls back to the CALLER\'s family, and claims only an overlap', () => {
    expect(entryConflictMessage(null, 'regular'))
      .toBe('You already have a class that overlaps that time.');
    expect(entryConflictMessage(null, 'studio'))
      .toBe('You already have a studio class that overlaps that time.');
  });
});
