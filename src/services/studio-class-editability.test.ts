import { describe, expect, it } from 'vitest';
import {
  STUDIO_CLASS_EDIT_REFUSALS,
  studioClassEditability,
  type StudioClassEditVerdict,
} from './studio-class-editability';

const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** A `@db.Date` value — midnight UTC of the calendar date, as Prisma returns one. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const EDITABLE: StudioClassEditVerdict = { scheduleEditable: true, dateEditable: true };
const INCOME_RECORD: StudioClassEditVerdict = { scheduleEditable: false, dateEditable: false };

describe('studioClassEditability', () => {
  // 2026-06-15T12:00Z is 08:00 in New York and 14:00 in Amsterdam — the same
  // local calendar date in both zones, so this block isolates the past axis
  // from the zone axis, which gets its own describe below.
  const now = new Date('2026-06-15T12:00:00.000Z');

  describe('the boundary matrix', () => {
    for (const zone of [NYC, AMS]) {
      it(`refuses a class dated yesterday in ${zone} — an income record`, () => {
        expect(studioClassEditability({ templateId: null, date: d('2026-06-14') }, now, zone)).toEqual(
          INCOME_RECORD,
        );
      });

      it(`keeps a class dated today in ${zone} editable — attendance is logged after the fact`, () => {
        expect(studioClassEditability({ templateId: null, date: d('2026-06-15') }, now, zone)).toEqual(
          EDITABLE,
        );
      });

      it(`keeps a class dated tomorrow in ${zone} editable`, () => {
        expect(studioClassEditability({ templateId: null, date: d('2026-06-16') }, now, zone)).toEqual(
          EDITABLE,
        );
      });
    }

    it('is strictly-before: today is not past', () => {
      // The whole point of D1's "strictly": a today-dated class is not yet
      // money. One hour either side of midnight would be a start-instant
      // question; the calendar-date rule has no such seam.
      expect(
        studioClassEditability({ templateId: 'tpl-1', date: d('2026-06-15') }, now, NYC),
      ).toEqual({ scheduleEditable: true, dateEditable: false });
    });
  });

  describe('manual vs generated — only `date` moves differently', () => {
    it('a manual row may move its date', () => {
      expect(studioClassEditability({ templateId: null, date: d('2026-06-16') }, now, AMS)).toEqual(
        EDITABLE,
      );
    });

    it('a generated row keeps its schedule editable but its date pinned to the sweep', () => {
      expect(studioClassEditability({ templateId: 'tpl-1', date: d('2026-06-16') }, now, AMS)).toEqual({
        scheduleEditable: true,
        dateEditable: false,
      });
    });

    it('a generated income record loses both — the two gates compose', () => {
      expect(studioClassEditability({ templateId: 'tpl-1', date: d('2026-06-14') }, now, AMS)).toEqual(
        INCOME_RECORD,
      );
    });
  });

  /**
   * THE ZONE DECIDES WHICH DAY IS TODAY, NOT UTC — both directions,
   * deliberately (the sibling deletion suite explains why one direction
   * proves nothing). At each instant below, UTC's calendar date and the
   * teacher's disagree by exactly one day, so a UTC-naive comparison
   * (`sc.date` against `now`'s UTC date) answers the opposite verdict.
   */
  describe('where the zones disagree about today', () => {
    it('west of UTC: New York still holds 06-14 while UTC holds 06-15, so the 14th stays editable', () => {
      // 02:30Z on the 15th is 22:30 on the 14th in New York. A UTC reading
      // calls the 14th "yesterday" and would freeze a class the teacher still
      // considers today's.
      const earlyUtcMorning = new Date('2026-06-15T02:30:00.000Z');
      expect(
        studioClassEditability({ templateId: null, date: d('2026-06-14') }, earlyUtcMorning, NYC),
      ).toEqual(EDITABLE);
      expect(
        studioClassEditability({ templateId: 'tpl-1', date: d('2026-06-14') }, earlyUtcMorning, NYC),
      ).toEqual({ scheduleEditable: true, dateEditable: false });
    });

    it('west of UTC: the actual NY-yesterday is already frozen', () => {
      const earlyUtcMorning = new Date('2026-06-15T02:30:00.000Z');
      expect(
        studioClassEditability({ templateId: null, date: d('2026-06-13') }, earlyUtcMorning, NYC),
      ).toEqual(INCOME_RECORD);
    });

    it('east of UTC: Amsterdam has rolled onto the 16th while UTC holds the 15th, so the 15th is frozen', () => {
      // 22:30Z on the 15th is 00:30 on the 16th in Amsterdam. A UTC reading
      // calls the 15th "today" and would keep editing open on what is already
      // this teacher's yesterday.
      const lateUtcNight = new Date('2026-06-15T22:30:00.000Z');
      expect(
        studioClassEditability({ templateId: null, date: d('2026-06-15') }, lateUtcNight, AMS),
      ).toEqual(INCOME_RECORD);
      expect(
        studioClassEditability({ templateId: null, date: d('2026-06-16') }, lateUtcNight, AMS),
      ).toEqual(EDITABLE);
    });
  });

  /**
   * THE INVARIANT THE VERDICT SHAPE CLAIMS: `dateEditable` is
   * `scheduleEditable` AND manual, so no cell of the matrix may answer
   * `{ scheduleEditable: false, dateEditable: true }`. Asserted over every
   * combination rather than spot cells, because a refactor could satisfy each
   * describe above while breaking the composition somewhere unvisited.
   */
  it('never lets dateEditable stand without scheduleEditable, across the whole matrix', () => {
    const nows = [
      new Date('2026-06-15T12:00:00.000Z'),
      new Date('2026-06-15T02:30:00.000Z'),
      new Date('2026-06-15T22:30:00.000Z'),
    ];
    const dates = ['2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16'].map(d);
    const templateIds: (string | null)[] = [null, 'tpl-1'];

    for (const at of nows) {
      for (const zone of [NYC, AMS]) {
        for (const date of dates) {
          for (const templateId of templateIds) {
            const verdict = studioClassEditability({ templateId, date }, at, zone);
            expect(
              verdict.dateEditable && !verdict.scheduleEditable,
              `${zone} ${at.toISOString()} ${date.toISOString()} templateId=${templateId} → ${JSON.stringify(verdict)}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  /**
   * FAIL CLOSED, PINNED RATHER THAN INHERITED — both shapes of row, because
   * the guard must close BOTH doors: without it, `date > NaN` is false, so an
   * unreadable date reads as "not past" and opens editing on a value nobody
   * could read.
   */
  it('fails closed when the date cannot be read — manual or generated', () => {
    const unreadable = new Date('nonsense');
    expect(studioClassEditability({ templateId: null, date: unreadable }, now, AMS)).toEqual(
      INCOME_RECORD,
    );
    expect(studioClassEditability({ templateId: 'tpl-1', date: unreadable }, now, AMS)).toEqual(
      INCOME_RECORD,
    );
  });

  it('carries the refusal codes the route answers with', () => {
    // Codes only. The MESSAGES are asserted through the wire in
    // `tests/integration/studio-api.test.ts`, where a substring match proves
    // the teacher receives them; `length > 0` here proved nothing a one-letter
    // string would not also pass.
    expect(STUDIO_CLASS_EDIT_REFUSALS.income_record.code).toBe('STUDIO_CLASS_INCOME_RECORD');
    expect(STUDIO_CLASS_EDIT_REFUSALS.generated_date.code).toBe('STUDIO_CLASS_GENERATED_DATE');
    expect(STUDIO_CLASS_EDIT_REFUSALS.past_date.code).toBe('STUDIO_CLASS_PAST_DATE');
  });

  /**
   * THE ENTIRE ALARM — DO NOT DELETE THIS CASE. The same directive the sibling
   * `studio-class-deletion.test.ts` carries, for the identical reason.
   *
   * The predicate's docblock says callers hand it only what it may read. The
   * parameter type cannot enforce that alone: an OPTIONAL new field compiles
   * at every call site in this repo — measured — so a widening that made the
   * verdict read cancellation or template state would ship silently. This
   * directive is what fails `tsc` when the signature widens, as TS2578
   * (unused '@ts-expect-error') pointing here.
   */
  it('refuses a widened row at the type level', () => {
    studioClassEditability(
      // @ts-expect-error cancellation is recoverable and must not reach the verdict
      { templateId: null, date: d('2026-06-16'), cancelledAt: new Date() },
      now,
      AMS,
    );
  });
});

/**
 * The union's own pin. `dateEditable ⇒ scheduleEditable` is held by the TYPE,
 * not merely by the one producer — the matrix sweep above still runs because
 * it also pins zone behaviour, but it is no longer the only thing standing
 * between a second producer and an illegal verdict.
 */
// @ts-expect-error dateEditable cannot stand without scheduleEditable
const _illegalVerdict: StudioClassEditVerdict = { scheduleEditable: false, dateEditable: true };
void _illegalVerdict;
