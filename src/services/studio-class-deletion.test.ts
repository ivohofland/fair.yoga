import { describe, it, expect } from 'vitest';
import { studioClassDeletability } from './studio-class-deletion';

const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** A `@db.Date` value — midnight UTC of the calendar date, as Prisma returns one. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('studioClassDeletability', () => {
  // 2026-06-15T12:00Z is 14:00 in Amsterdam and 08:00 in New York — the same
  // calendar date in both, so it isolates the template/past axis from the zone
  // axis, which gets its own describe below.
  const now = new Date('2026-06-15T12:00:00.000Z');

  describe('the matrix', () => {
    it('allows a manual class that has not started', () => {
      expect(
        studioClassDeletability({ templateId: null, date: d('2026-06-20') }, now, AMS),
      ).toEqual({ deletable: true });
    });

    it('allows a manual class dated today, which no date rule may refuse', () => {
      // The first disjunct short-circuits, so the calendar-date rule below never
      // runs. This is the case that separates "manual" from "past": a teacher
      // who mislogged this morning's studio class clears it this morning.
      expect(
        studioClassDeletability({ templateId: null, date: d('2026-06-15') }, now, AMS),
      ).toEqual({ deletable: true });
    });

    it('refuses a generated class dated in the future, because the sweep would create it again', () => {
      expect(
        studioClassDeletability({ templateId: 'tpl-1', date: d('2026-06-20') }, now, AMS),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows a generated class dated before today, which the sweep cannot reach', () => {
      expect(
        studioClassDeletability({ templateId: 'tpl-1', date: d('2026-06-10') }, now, AMS),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * THE CASE THIS RULE EXISTS FOR, and the one a start-instant rule got wrong.
   *
   * The predicate cannot ask "has this class started", because the class's
   * `startTime` is a STAMP and the generator filters on the TEMPLATE's current
   * one (`studio-class-generator.ts:141`, `:177`). Editing a template moves the
   * template's and leaves the class's untouched — "a template is a stamp, not a
   * live link" — so the two disagree by design, and the start-instant reading
   * answered from the wrong one.
   *
   * Worked: template moved Wed 09:00 → 19:00. The standing class keeps 09:00.
   * At 10:30 its own start has passed, so the old rule allowed removal — and
   * the sweep, filtering on 19:00, found that instant still ahead, found
   * `(templateId, date)` freed by the removal, and re-inserted on the same date
   * within the hour. A delete that undid itself.
   *
   * The calendar-date rule is immune rather than merely careful: the latest
   * instant any start time can name on a date is 23:59 local, which precedes
   * the next local midnight. So if the date is strictly before the teacher's
   * today, EVERY start time on it has passed and the generator's `> now` filter
   * excludes the date whatever the template says. No `startTime` is consulted,
   * which is why the parameter no longer carries one.
   */
  describe('a generated class dated today is refused, whatever its start time', () => {
    it('refuses one whose own start passed hours ago', () => {
      // 09:00 Amsterdam on 2026-06-15 is 07:00Z; `now` is 12:00Z. Started, and
      // still refused, because the template may name a later hour today.
      expect(
        studioClassDeletability({ templateId: 'tpl-1', date: d('2026-06-15') }, now, AMS),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('refuses one at the last minute of the teacher’s day', () => {
      // 23:58 local Amsterdam — the date is still today, so still refused.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T21:58:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows it once the teacher’s day has rolled over', () => {
      // 00:30 Amsterdam on the 16th. The 15th is now strictly past, locally.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T22:30:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * BOTH DIRECTIONS, DELIBERATELY. A single zone proves nothing: run only the
   * east-of-UTC case and a UTC-naive implementation still fails it, but run
   * only a case where local and UTC agree and every implementation passes.
   * `prisma/seed.ts:622-625` records that exact failure for the class family.
   *
   * Both instants below are chosen so the teacher's calendar date DISAGREES
   * with UTC's — comparing `sc.date` against `new Date()` gets each one wrong,
   * in opposite directions.
   */
  describe('the zone decides which day is today, not UTC', () => {
    it('east of UTC: past midnight in Amsterdam, yesterday is removable though UTC still calls it today', () => {
      // 2026-06-15T22:30Z is 00:30 on the 16th in Amsterdam. A UTC reading puts
      // "today" at the 15th and refuses a class dated the 15th.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15') },
          new Date('2026-06-15T22:30:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('west of UTC: still the 14th in New York, so the 14th is refused though UTC calls it yesterday', () => {
      // 2026-06-15T02:30Z is 22:30 on the 14th in New York. A UTC reading puts
      // "today" at the 15th and would allow removing a class dated the 14th —
      // which is still today for this teacher, and still a generator candidate.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-14') },
          new Date('2026-06-15T02:30:00.000Z'),
          NYC,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });
  });

  /**
   * FAIL CLOSED, PINNED RATHER THAN INHERITED. Without the explicit guard this
   * happens to be correct by the polarity of the comparison — `NaN > date` is
   * false, so it falls through to the refusal. That is a property a refactor
   * can invert while looking equivalent: rewriting the last two lines as
   * `if (startOfLocalDay(...) <= sc.date) return refuse; return allow;` reads
   * the same and silently removes classes with an unreadable date.
   */
  it('refuses a generated class whose date cannot be read', () => {
    expect(
      studioClassDeletability({ templateId: 'tpl-1', date: new Date('nonsense') }, now, AMS),
    ).toEqual({ deletable: false, reason: 'regenerates' });
  });

  /**
   * THE PARAMETER TYPE IS THE GUARD, and this is the ONLY place that can prove
   * it — see the docblock in `studio-class-deletion.ts`.
   *
   * Not because of excess-property checking: an OPTIONAL widening
   * (`template?: …`) is legal to supply and legal to omit, so every production
   * call site compiles either way, literal or variable. What catches it is this
   * directive. Under a widening the line below stops being an error, and an
   * unused `@ts-expect-error` is itself `TS2578` — so `tsc` fails here, and
   * measurably nowhere else.
   *
   * DO NOT DELETE THIS CASE. It is the entire alarm.
   */
  it('refuses template state at the type level', () => {
    studioClassDeletability(
      // @ts-expect-error template state is reversible and must not reach the predicate
      { templateId: 'tpl-1', date: d('2026-06-10'), template: { isArchived: true } },
      now,
      AMS,
    );
  });
});
