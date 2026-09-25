import { describe, it, expect } from 'vitest';
import {
  teacherVisibleName,
  projectStudentForTeacher,
  type StudentProjectionInput,
} from './student-visibility';

const TEACHER = 'teacher-1';
/** A second teacher, to whom this student shares everything. */
const OTHER_TEACHER = 'teacher-2';

const ALL_FALSE = {
  teacherId: TEACHER,
  shareFullName: false,
  shareEmail: false,
  sharePhone: false,
  shareBirthday: false,
  shareAddress: false,
};

const ALL_TRUE_FOR_OTHER = {
  teacherId: OTHER_TEACHER,
  shareFullName: true,
  shareEmail: true,
  sharePhone: true,
  shareBirthday: true,
  shareAddress: true,
};

const BIRTHDAY = new Date('1990-04-17T00:00:00.000Z');

function claimedStudent(
  overrides: Partial<StudentProjectionInput> = {},
): StudentProjectionInput {
  return {
    id: 'student-1',
    firstName: 'Anna',
    lastName: 'Bakker',
    email: 'anna@example.com',
    phone: '+31612345678',
    birthday: BIRTHDAY,
    address: 'Keizersgracht 1',
    claimedAt: new Date('2026-01-01T00:00:00.000Z'),
    studentPrivacy: [ALL_FALSE],
    ...overrides,
  };
}

describe('teacherVisibleName', () => {
  it('gives a last initial when the surname is not shared', () => {
    expect(teacherVisibleName(claimedStudent(), TEACHER)).toBe('Anna b.');
  });

  it('gives the full name when shareFullName is true', () => {
    const s = claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareFullName: true }] });
    expect(teacherVisibleName(s, TEACHER)).toBe('Anna Bakker');
  });

  it('treats a missing privacy row as maximum privacy', () => {
    expect(teacherVisibleName(claimedStudent({ studentPrivacy: [] }), TEACHER)).toBe(
      'Anna b.',
    );
  });

  it('gives an unclaimed student a last initial when the surname is not shared', () => {
    expect(teacherVisibleName(claimedStudent({ claimedAt: null }), TEACHER)).toBe('Anna b.');
  });

  // Multi-row inputs. In production the nested `where: { teacherId }` on
  // `studentNameSelect` and `studentVisibilitySelect` alike keeps this list to
  // at most one row — `StudentPrivacy` is `@@unique([studentId, teacherId])` —
  // so these arrays are what an *unscoped* query would hand the function.
  //
  // Be exact about what that falsifies, because an earlier version of this
  // comment was not. Nothing in this file imports `studentNameSelect` or
  // `studentVisibilitySelect` — those names appeared only in the comment — and
  // nothing here runs a query. These are pure functions taking arrays, so what
  // they can falsify is the `find`, not the Prisma `where`. Reverting
  // `.find((p) => p.teacherId === teacherId)` to `studentPrivacy[0]` reddens
  // both tests below and both of their `projectStudentForTeacher` twins: 4 red
  // (verified). Dropping the `where` reddens nothing anywhere, because the
  // `find` picks the same row out of the larger set — see
  // `ScopedVisibilityFlags`.
  it('ignores a privacy row belonging to another teacher', () => {
    const s = claimedStudent({ studentPrivacy: [ALL_TRUE_FOR_OTHER] });
    expect(teacherVisibleName(s, TEACHER)).toBe('Anna b.');
  });

  // Both directions on purpose. The first assertion is the fail-closed one;
  // the second is the *positive* one — OTHER_TEACHER's row is permissive, so
  // this pins that the `find` still releases the full name to the teacher who
  // was granted it. A projection hard-wired to withhold would pass the rest of
  // this file and fail here.
  it('picks this teacher\'s row out of several, not the first one', () => {
    const s = claimedStudent({ studentPrivacy: [ALL_TRUE_FOR_OTHER, ALL_FALSE] });
    expect(teacherVisibleName(s, TEACHER)).toBe('Anna b.');
    expect(teacherVisibleName(s, OTHER_TEACHER)).toBe('Anna Bakker');
  });
});

describe('projectStudentForTeacher', () => {
  it('withholds every unshared field as null, with the key present', () => {
    const result = projectStudentForTeacher(claimedStudent(), TEACHER);
    expect(result).toStrictEqual({
      id: 'student-1',
      displayName: 'Anna b.',
      email: null,
      phone: null,
      birthday: null,
      address: null,
      claimedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('treats a missing privacy row as maximum privacy', () => {
    const result = projectStudentForTeacher(claimedStudent({ studentPrivacy: [] }), TEACHER);
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.birthday).toBeNull();
    expect(result.address).toBeNull();
  });

  it('projects an unclaimed student through its privacy row like any other', () => {
    const projected = projectStudentForTeacher(
      {
        id: 's1', firstName: 'Anna', lastName: 'Bergsma', email: 'anna@example.com',
        phone: '0612345678', birthday: new Date('1990-01-01'), address: 'Straat 1',
        claimedAt: null,
        studentPrivacy: [{
          teacherId: 't1', shareFullName: true, shareEmail: true,
          sharePhone: false, shareBirthday: false, shareAddress: false,
        }],
      },
      't1',
    );
    expect(projected).toMatchObject({
      displayName: 'Anna Bergsma', email: 'anna@example.com',
      phone: null, birthday: null, address: null, claimedAt: null,
    });
  });

  it('masks an unclaimed student with no privacy row', () => {
    const projected = projectStudentForTeacher(
      {
        id: 's2', firstName: 'Anna', lastName: 'Bergsma', email: 'anna@example.com',
        phone: null, birthday: null, address: null, claimedAt: null, studentPrivacy: [],
      },
      't1',
    );
    expect(projected.displayName).toBe('Anna b.');
    expect(projected.email).toBeNull();
  });

  it('releases exactly the fields whose flag is set, and no others', () => {
    const s = claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareEmail: true }] });
    const result = projectStudentForTeacher(s, TEACHER);
    expect(result.email).toBe('anna@example.com');
    expect(result.phone).toBeNull();
    expect(result.birthday).toBeNull();
    expect(result.address).toBeNull();
  });

  it('gates each field on its own flag', () => {
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, sharePhone: true }] }),
        TEACHER,
      ).phone,
    ).toBe('+31612345678');
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareBirthday: true }] }),
        TEACHER,
      ).birthday,
    ).toEqual(BIRTHDAY);
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareAddress: true }] }),
        TEACHER,
      ).address,
    ).toBe('Keizersgracht 1');
  });

  it('never emits a raw surname under any flag combination', () => {
    const shared = projectStudentForTeacher(
      claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareFullName: true }] }),
      TEACHER,
    );
    expect(Object.keys(shared)).not.toContain('lastName');
    expect(Object.keys(shared)).not.toContain('firstName');
  });

  it('never emits an income tier', () => {
    const result = projectStudentForTeacher(claimedStudent(), TEACHER);
    expect(Object.keys(result)).not.toContain('incomeTier');
  });

  it('preserves a null optional field as null when it IS shared', () => {
    const s = claimedStudent({
      phone: null,
      studentPrivacy: [{ ...ALL_FALSE, sharePhone: true }],
    });
    expect(projectStudentForTeacher(s, TEACHER).phone).toBeNull();
  });

  // The projection's half of the `find` check — `teacherVisibleName`'s two sit
  // above, with the note on what these can and cannot falsify. Same shape: an
  // unscoped row set, handed straight to a pure function.
  it('withholds every field when the only privacy row is another teacher\'s', () => {
    const s = claimedStudent({ studentPrivacy: [ALL_TRUE_FOR_OTHER] });
    expect(projectStudentForTeacher(s, TEACHER)).toStrictEqual({
      id: 'student-1',
      displayName: 'Anna b.',
      email: null,
      phone: null,
      birthday: null,
      address: null,
      claimedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('reads each teacher\'s own row when several are present', () => {
    const s = claimedStudent({ studentPrivacy: [ALL_TRUE_FOR_OTHER, ALL_FALSE] });
    expect(projectStudentForTeacher(s, TEACHER).email).toBeNull();
    expect(projectStudentForTeacher(s, OTHER_TEACHER).email).toBe('anna@example.com');
  });
});
