import { describe, it, expect } from 'vitest';
import { migrationSqlFiles, untracedDataChanges } from '../../tests/migration-sql';

/**
 * The last migration on `main` when this rule landed, and the only thing
 * standing between the rule and every migration that came before it.
 *
 * A CUTOFF RATHER THAN A ROSTER OF GRANDFATHERED NAMES. Everything sorting at
 * or before this is frozen by policy — an applied migration is immutable here,
 * comments included — so no migration can ever be added below the line and the
 * exemption list can never grow. A roster would have to be edited whenever an
 * old migration was re-read and understood; this constant never is.
 *
 * `untracedDataChanges` compares directory names, and Prisma prefixes each
 * with a timestamp, so the string comparison is chronological.
 */
const CUTOFF = '20260903195051_student_signup_purposes';

/** Runs the rule over every migration, no matter when it landed. */
const UNBOUNDED = '';

/**
 * A remediation of the shape this issue is about: it rewrites rows and says
 * nothing about having done so.
 */
const UNTRACED_SQL = `
UPDATE "ScheduleRule" sr SET "isActive" = false
  FROM "ClassTemplate" ct JOIN "TeacherRoom" tr ON tr."id" = ct."teacherRoomId"
 WHERE ct."scheduleRuleId" = sr."id" AND sr."isActive" AND tr."isArchived";
`;

/**
 * The hazard the `RAISE NOTICE` detection has to survive, transcribed from the
 * real shape rather than invented: PR #462's
 * `20260905120000_class_room_archive_invariant` carries this comment ABOVE a
 * real notice, so the literal text appears twice and only one of them
 * announces anything. Here the real one is removed and the comment left, which
 * is the migration a careless author actually ships.
 */
const NOTICE_ONLY_IN_A_COMMENT_SQL = `
-- \`prisma db execute\` surfaces RAISE EXCEPTION and swallows RAISE NOTICE;
-- \`prisma migrate deploy\` (what CI and the test suite's global setup run)
-- does not.
DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "TeacherRoom" tr SET "isArchived" = false WHERE tr."isArchived";
  GET DIAGNOSTICS affected = ROW_COUNT;
END $$;
`;

/** The same migration with the announcement it was missing. */
const REAL_NOTICE_SQL = `
-- \`prisma db execute\` surfaces RAISE EXCEPTION and swallows RAISE NOTICE;
-- \`prisma migrate deploy\` (what CI and the test suite's global setup run)
-- does not.
DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE "TeacherRoom" tr SET "isArchived" = false WHERE tr."isArchived";
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE NOTICE 'issue 339 remediation: un-archived % room(s)', affected;
  END IF;
END $$;
`;

/** The other way out: say why no announcement is owed. */
const MARKED_SQL = `
-- DML WITHOUT NOTICE: backfills a column this migration adds two lines above,
-- so there is no pre-existing value it can overwrite.
ALTER TABLE "ClassTemplate" ADD COLUMN "kind" "RuleKind";
UPDATE "ClassTemplate" SET "kind" = 'regular';
`;

/** The marker with nothing after the colon — a gesture, not a reason. */
const MARKED_WITHOUT_A_REASON_SQL = `
-- DML WITHOUT NOTICE:
ALTER TABLE "ClassTemplate" ADD COLUMN "kind" "RuleKind";
UPDATE "ClassTemplate" SET "kind" = 'regular';
`;

/**
 * The two phrases this tree is full of that a careless pattern would read as
 * data changes, both here in the forms they actually take: every generated
 * foreign key in `prisma/migrations/` ends `ON UPDATE CASCADE`, and
 * `src/lib/db-locks.ts` writes `FOR UPDATE OF` with a bare alias and would be
 * equally correct writing a quoted one. This migration changes no data at all.
 */
const NO_DATA_CHANGE_SQL = `
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherRoomId_fkey"
  FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION synthetic_lock() RETURNS void AS $$
BEGIN
  PERFORM 1 FROM "Class" c WHERE c."id" = 'x' FOR UPDATE OF c;
  PERFORM 1 FROM "Class" "Class" WHERE "Class"."id" = 'x' FOR UPDATE OF "Class";
END;
$$ LANGUAGE plpgsql;
`;

describe('untraced data changes in migrations', () => {
  /**
   * THE LIVE RULE. A migration landing after the cutoff that rewrites rows
   * must announce it or say why it need not.
   *
   * What this is for is the class of defect issue #463 names: #272's
   * `20260827120000_template_room_archive_invariant` paused live templates
   * with a bare `UPDATE` and left nothing behind — no notice, no audit row,
   * and not even an `updatedAt` bump, since that column is `@updatedAt` and
   * Prisma enforces it client-side where raw SQL never reaches. Nothing in
   * `.github/workflows/ci.yml` inspects migration SQL for this; this is the
   * gate, and it is the only one.
   *
   * Reads files; touches no database.
   */
  it('reports nothing after the cutoff', () => {
    expect(untracedDataChanges(migrationSqlFiles(), CUTOFF)).toEqual([]);
  });

  /**
   * NON-VACUITY, and it is the assertion that keeps the one above honest.
   *
   * No migration sorts after the cutoff today, so the sweep is green whether
   * the rule works or not. A typo in the constant, or a future author bumping
   * it forward to silence a red build, disables the rule while every other
   * assertion here stays green — the cutoff naming a real directory is the
   * cheapest thing that catches the typo, and the diff on this line is what
   * catches the bump.
   */
  it('has a cutoff that names a migration in the tree', () => {
    expect(migrationSqlFiles().map((m) => m.name)).toContain(CUTOFF);
  });

  /**
   * The rule reports the migration this issue is about, which is the only
   * proof available that it reports anything on real SQL: run against the
   * whole tree it finds #272's silent remediation.
   *
   * Containment rather than an exact set. Every migration below the cutoff is
   * frozen, so the full list cannot change — but naming it here would put a
   * roster in a test file for no gain, and the one entry that carries meaning
   * is this one.
   */
  it('reports #272’s silent remediation when run unbounded', () => {
    expect(untracedDataChanges(migrationSqlFiles(), UNBOUNDED)).toContain(
      '20260827120000_template_room_archive_invariant',
    );
  });

  /**
   * COMMENT STRIPPING ON THE DML SIDE, against real SQL rather than a fixture.
   *
   * Both of these discuss a `UPDATE "CalendarEntry" SET …` in a comment and
   * run no such statement. A detector reading raw text would report them, and
   * a reviewer would then learn to ignore this sweep's output — which is the
   * failure mode of every gate that cries wolf.
   */
  it('does not report migrations whose only data change sits in a comment', () => {
    const reported = untracedDataChanges(migrationSqlFiles(), UNBOUNDED);

    expect(reported).not.toContain('20260826182710_entry_completion_marker_guard');
    expect(reported).not.toContain('20260826200000_entry_marker_exclusivity');
  });

  /**
   * COMMENT STRIPPING ON THE NOTICE SIDE, against real SQL rather than a
   * fixture — and the correction to this branch's own design doc, which
   * recorded this migration as carrying a real `RAISE NOTICE`.
   *
   * It does not. `20260825065109_schedule_rule_backfill` names `RAISE NOTICE`
   * in a comment saying `prisma db execute` swallows one, and what it actually
   * raises is a `RAISE EXCEPTION` pre-flight that aborts the migration — an
   * abort, not a trace of the two `UPDATE`s further down. So the live tree's
   * only instance of the literal text is the hazard, not the compliance, and
   * a detector reading raw text would exempt it.
   */
  it('reports a migration whose only RAISE NOTICE sits in a comment', () => {
    expect(untracedDataChanges(migrationSqlFiles(), UNBOUNDED)).toContain(
      '20260825065109_schedule_rule_backfill',
    );
  });

  /**
   * The rule's own verdict, one case per way of being right or wrong, on
   * migrations named to sort after the cutoff.
   *
   * A guard whose failure cannot be observed certifies nothing, and the four
   * clean rows are the half that matters most here: a rule that reported
   * everything would satisfy the reported rows on its own.
   */
  it.each<[string, string, string[]]>([
    ['data change with neither notice nor marker', UNTRACED_SQL, ['20990101000000_case']],
    ['a RAISE NOTICE that is only a comment', NOTICE_ONLY_IN_A_COMMENT_SQL, ['20990101000000_case']],
    ['the marker with no reason after the colon', MARKED_WITHOUT_A_REASON_SQL, ['20990101000000_case']],
    ['a real RAISE NOTICE', REAL_NOTICE_SQL, []],
    ['the marker and a reason', MARKED_SQL, []],
    ['ON UPDATE CASCADE and FOR UPDATE OF, and no data change', NO_DATA_CHANGE_SQL, []],
  ])('%s', (_case, sql, expected) => {
    expect(untracedDataChanges([{ name: '20990101000000_case', sql }], CUTOFF)).toEqual(expected);
  });

  /**
   * The cutoff is applied rather than decorative: the same untraced migration
   * that is reported above goes unreported under a name sorting before it.
   *
   * Without this, a rule that ignored its cutoff entirely would pass every
   * synthetic case above and fail only against the live tree — where the
   * failure would read as a real defect in a frozen migration nobody can fix.
   */
  it('does not report a data change in a migration older than the cutoff', () => {
    const older = [{ name: '20260101000000_before_the_cutoff', sql: UNTRACED_SQL }];

    expect(untracedDataChanges(older, CUTOFF)).toEqual([]);
    expect(untracedDataChanges(older, UNBOUNDED)).toEqual(['20260101000000_before_the_cutoff']);
  });
});
