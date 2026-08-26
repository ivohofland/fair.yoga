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

  /**
   * THE `ORDER BY`, which had a comment and no test.
   *
   * A candidate span can overlap more than one live entry, and the query's own
   * docblock says the ordering exists so "a test that plants two holders gets
   * the earlier one every run instead of whichever the index happened to reach
   * first". No such test existed, so dropping `ORDER BY "date", "startTime"`
   * cost nothing.
   *
   * TWO HOLDERS ON DIFFERENT DATES, not two on one, and that is what makes the
   * `date` half of the ordering observable at all: the earlier holder spills
   * past midnight into the probed day. Planted in the WRONG order — the later
   * one first — so an unordered `LIMIT 1` that simply followed insertion or the
   * index would be as likely to answer the other.
   *
   * The spans: the earlier holder runs 22:00 + 780 minutes, ending 11:00 the
   * next day; the later starts at 11:00 that day for an hour. They meet
   * exactly on the half-open bound, so both are live and
   * `CalendarEntry_teacher_slot_excl` admits the pair — which it must, since
   * two holders that could not coexist could not both be found. The probe is
   * 10:00 + 120 minutes on the second day, which reaches into both.
   */
  it('names the EARLIER of two overlapping holders, every run', async () => {
    const later = await plant({
      date: day('2033-03-11'), startTime: hhmmToTime('11:00'), durationMinutes: 60,
    });
    const earlier = await plant({
      date: day('2033-03-10'), startTime: hhmmToTime('22:00'), durationMinutes: 780,
    });

    // The premise: both really do overlap the probe, so the ordering is what
    // chooses between them rather than one of them simply not matching.
    const probe = {
      date: day('2033-03-11'), startTime: hhmmToTime('10:00'), durationMinutes: 120,
    };
    const withoutEarlier = await probeConflictingEntry(prisma, teacherId, {
      ...probe, excludeEntryId: earlier.id,
    });
    expect(withoutEarlier?.id).toBe(later.id);

    const conflict = await probeConflictingEntry(prisma, teacherId, probe);
    expect(conflict?.id).toBe(earlier.id);
  });
});

/**
 * `probeConflictingEntry` takes a `PrismaClient` and NOT a
 * `Prisma.TransactionClient`, and that is a contract rather than a preference:
 * a statement that fails inside a Postgres transaction aborts it, so a probe
 * issued on the caller's aborted `tx` answers `25P02` rather than answering.
 * Every call site has to sit after its own transaction's closing `)`.
 *
 * It is true today only by the shape of `Omit`: `Prisma.TransactionClient` is
 * `Omit<PrismaClient, ITXClientDenyList>`, so it is MISSING `$transaction` and
 * friends and is therefore not assignable to the full client. Nothing keeps
 * that true — a signature widened to `PrismaClient | Prisma.TransactionClient`
 * (which `probeOverlappingCandidates` beside it deliberately IS) would compile
 * every call site unchanged and break only in production, under contention.
 *
 * The same device `db-locks.test.ts` keeps eight of, and for the same reason:
 * `tsconfig.json` includes every `.ts` file in the repo, so weakening the
 * parameter makes `tsc --noEmit` fail on an unused `@ts-expect-error` rather
 * than leaving a green suite. Never called, so it costs nothing at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _theProbeRejectsATransactionClient(tx: Prisma.TransactionClient): Promise<void> {
  // @ts-expect-error A transaction client must never satisfy this parameter:
  // the probe runs AFTER its caller's transaction closed, and on an aborted
  // one it would answer 25P02 instead of naming the holder.
  await probeConflictingEntry(tx, 'never-called', {
    date: new Date('2033-01-01T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    durationMinutes: 60,
  });
}

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
