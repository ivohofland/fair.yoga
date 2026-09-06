import { describe, it, expect } from 'vitest';
import { migrationSqlFiles, stripSqlComments, untracedDataChanges } from '../../tests/migration-sql';

/**
 * The line this rule starts at: everything sorting at or before it is exempt,
 * everything after it is bound. It does not advance — `docs/lock-order.md`
 * says why, and the silencing assertion below reddens if it is moved.
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
 * The `DELETE` half of the rule, which no live migration exercises on its own:
 * the one migration in the tree holding a `DELETE FROM "…"` also holds an
 * `UPDATE "…"`, so deleting that whole alternative from the pattern left every
 * test green. These two rows are the only thing standing behind it.
 */
const UNTRACED_DELETE_SQL = `
DELETE FROM "Registration" r
 WHERE r."classId" IN (SELECT c."id" FROM "Class" c WHERE c."status" = 'draft');
`;

/** The same write in the case a hand-authored migration may well use. */
const UNTRACED_DELETE_LOWERCASE_SQL = `
delete from "Registration" r
 where r."classId" in (select c."id" from "Class" c where c."status" = 'draft');
`;

/**
 * `ONLY` between the verb and its table — legal, single-table, and invisible to
 * a pattern demanding the quote immediately after the verb.
 */
const UPDATE_ONLY_SQL = `
UPDATE ONLY "Class" SET "status" = 'draft' WHERE "status" = 'open';
`;

/** A real notice, in lowercase — the `/i` on the notice side, pinned. */
const LOWERCASE_NOTICE_SQL = `
DO $$ BEGIN
  UPDATE "TeacherRoom" SET "isArchived" = false WHERE "isArchived";
  raise notice 'un-archived the rooms';
END $$;
`;

/**
 * The marker in lowercase. It is this rule's own spelling rather than SQL's, so
 * unlike the two patterns it is case-SENSITIVE and this exempts nothing.
 */
const MARKER_IN_LOWERCASE_SQL = `
-- dml without notice: backfills a column added two lines above.
UPDATE "ClassTemplate" SET "kind" = 'regular';
`;

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
 * The same remediation in lowercase, which Postgres accepts exactly as readily
 * and which a case-sensitive pattern would read as no write at all.
 */
const UNTRACED_LOWERCASE_SQL = `
update "ScheduleRule" sr set "isActive" = false
  from "ClassTemplate" ct join "TeacherRoom" tr on tr."id" = ct."teacherRoomId"
 where ct."scheduleRuleId" = sr."id" and sr."isActive" and tr."isArchived";
`;

/**
 * A block comment holding a `--`, immediately in front of a data change and on
 * its line. Stripping line comments first would take the block's closing
 * delimiter and the `UPDATE` behind it together.
 */
const DASH_DASH_IN_A_BLOCK_COMMENT_SQL =
  '/* -- */ UPDATE "ScheduleRule" SET "isActive" = false;';

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
 * The two phrases a careless pattern would read as data changes, in the forms
 * they actually take: `ON UPDATE CASCADE` on a generated foreign key, and the
 * `FOR UPDATE OF` this codebase locks rows with (`src/lib/db-locks.ts` writes a
 * bare alias; a quoted identifier would be equally correct). The quote rather
 * than the verb is what keeps them out, which is what makes them safe to match
 * case-insensitively — so both appear here lowercase as well. This migration
 * changes no data at all.
 */
const NO_DATA_CHANGE_SQL = `
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherRoomId_fkey"
  FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id")
  on delete restrict on update cascade;

CREATE OR REPLACE FUNCTION synthetic_lock() RETURNS void AS $$
BEGIN
  PERFORM 1 FROM "Class" c WHERE c."id" = 'x' FOR UPDATE OF c;
  PERFORM 1 FROM "Class" "Class" WHERE "Class"."id" = 'x' FOR UPDATE OF "Class";
  PERFORM 1 FROM "Class" "Class" WHERE "Class"."id" = 'x' for update of "Class";
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
   * with a bare `UPDATE` and left no trace an operator can query. What it did,
   * why it cannot be repaired where it sits, and what an operator can still
   * run are in `docs/lock-order.md`, under "The migration comments that this
   * document owns".
   *
   * Reads files; touches no database.
   */
  it('reports nothing after the cutoff', () => {
    expect(untracedDataChanges(migrationSqlFiles(), CUTOFF)).toEqual([]);
  });

  /**
   * NON-VACUITY, and these two are what keep the one above honest.
   *
   * Migrations do sort after the cutoff, and one of them rewrites rows and is
   * clean only because it announces it — so the assertion above exercises both
   * the data-change detection and the `RAISE NOTICE` exemption against real
   * SQL rather than passing on an empty set.
   *
   * Two ways to lose that, and one assertion each. A cutoff naming no
   * directory is a typo; a cutoff moved past the last migration carrying a
   * data change is the bump a future author reaches for to silence a red
   * build. The second test neutralises every `RAISE NOTICE` in the tree and
   * runs the rule at the same cutoff: with the exemption withdrawn the rule
   * must report something, which it can only do if a bound migration writes.
   */
  it('has a cutoff that names a migration in the tree', () => {
    expect(migrationSqlFiles().map((m) => m.name)).toContain(CUTOFF);
  });

  it('has a cutoff that still binds a migration carrying a data change', () => {
    const files = migrationSqlFiles();
    expect(files.filter((m) => m.name > CUTOFF)).not.toHaveLength(0);

    const silenced = files.map(({ name, sql }) => ({
      name,
      sql: sql.replace(/RAISE\s+NOTICE/gi, 'RAISE_NOTHING'),
    }));
    expect(untracedDataChanges(silenced, CUTOFF)).not.toEqual([]);
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
   * fixture.
   *
   * `20260825065109_schedule_rule_backfill` names `RAISE NOTICE` in a comment
   * saying `prisma db execute` swallows one, and raises none. What it does
   * raise is a `RAISE EXCEPTION` pre-flight, which aborts the migration rather
   * than reporting what its `UPDATE`s did — so a detector reading raw text
   * would exempt it on the strength of the comment.
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
    ['the same data change in lowercase', UNTRACED_LOWERCASE_SQL, ['20990101000000_case']],
    ['a RAISE NOTICE that is only a comment', NOTICE_ONLY_IN_A_COMMENT_SQL, ['20990101000000_case']],
    ['the marker with no reason after the colon', MARKED_WITHOUT_A_REASON_SQL, ['20990101000000_case']],
    ['the marker spelled in lowercase', MARKER_IN_LOWERCASE_SQL, ['20990101000000_case']],
    ['a DELETE with neither notice nor marker', UNTRACED_DELETE_SQL, ['20990101000000_case']],
    ['the same DELETE in lowercase', UNTRACED_DELETE_LOWERCASE_SQL, ['20990101000000_case']],
    ['a write hidden behind UPDATE ONLY', UPDATE_ONLY_SQL, ['20990101000000_case']],
    ['a real RAISE NOTICE', REAL_NOTICE_SQL, []],
    ['a real RAISE NOTICE in lowercase', LOWERCASE_NOTICE_SQL, []],
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

  /**
   * STRICTLY after, which is the half the case above cannot see: relaxing the
   * comparison to `<` would bind the named migration itself and still pass
   * every other assertion here, because the migration `CUTOFF` names carries no
   * data change of its own.
   */
  it('does not report the migration the cutoff itself names', () => {
    expect(untracedDataChanges([{ name: CUTOFF, sql: UNTRACED_SQL }], CUTOFF)).toEqual([]);
  });
});

/**
 * The stripper the rule reads through, tested directly because the two things
 * its docblock calls load-bearing — the strip ORDER and what a stripped comment
 * leaves behind — are otherwise reachable only through a sweep that a wrong
 * answer here leaves green.
 */
describe('stripSqlComments', () => {
  /**
   * THE STRIP ORDER, PINNED. Swap the two `.replace` calls and the `--` inside
   * the block comment swallows the block's closing delimiter and the `UPDATE`
   * behind it, leaving text that writes nothing.
   */
  it('keeps a statement a block comment holding a `--` sits in front of', () => {
    expect(stripSqlComments(DASH_DASH_IN_A_BLOCK_COMMENT_SQL)).toContain('UPDATE "ScheduleRule"');
  });

  /** And the consequence that matters: the rule still reports that write. */
  it('leaves such a statement visible to the rule', () => {
    const migration = [{ name: '20990101000000_case', sql: DASH_DASH_IN_A_BLOCK_COMMENT_SQL }];

    expect(untracedDataChanges(migration, CUTOFF)).toEqual(['20990101000000_case']);
  });

  /**
   * A block becomes one space rather than nothing, so a comment between two
   * tokens cannot fuse them into a third no pattern matches; a line comment
   * keeps its newline for the same reason.
   */
  it.each<[string, string, string]>([
    ['a block comment becomes a single space', 'UPDATE/* c */"X"', 'UPDATE "X"'],
    // Non-greedy, pinned: one greedy match would run from the first `/*` to the
    // last `*/` and take the statement between them with it.
    ['two block comments do not swallow the statement between them', '/* a */UPDATE "X"/* b */', ' UPDATE "X" '],
    ['a line comment keeps its newline', '-- UPDATE "X"\nSELECT 1;', '\nSELECT 1;'],
  ])('%s', (_case, sql, expected) => {
    expect(stripSqlComments(sql)).toBe(expected);
  });
});
