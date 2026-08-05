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

  it('ungates a legacy unclaimed student', () => {
    expect(teacherVisibleName(claimedStudent({ claimedAt: null }), TEACHER)).toBe(
      'Anna Bakker',
    );
  });

  // The query fragments scope `studentPrivacy` with `where: { teacherId }`, so
  // in production this list holds at most one row. These two assertions are
  // what make that scope falsifiable: they hand the projection the row set a
  // dropped `where` would produce, and require it to fail closed.
  it('ignores a privacy row belonging to another teacher', () => {
    const s = claimedStudent({ studentPrivacy: [ALL_TRUE_FOR_OTHER] });
    expect(teacherVisibleName(s, TEACHER)).toBe('Anna b.');
  });

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

  it('ungates every field for a legacy unclaimed student', () => {
    const result = projectStudentForTeacher(claimedStudent({ claimedAt: null }), TEACHER);
    expect(result.email).toBe('anna@example.com');
    expect(result.phone).toBe('+31612345678');
    expect(result.birthday).toEqual(BIRTHDAY);
    expect(result.address).toBe('Keizersgracht 1');
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

  // The projection's half of the scoping check — `teacherVisibleName`'s two
  // sit above. A dropped `where: { teacherId }` in `studentVisibilitySelect`
  // hands the projection exactly this row set.
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
