// A session identifies an account; authorization is profile presence:
// teacher surfaces require teacherId, student surfaces studentId. Dual
// accounts carry both — there is no "active role" state.
export interface SessionUser {
  sessionId: string;
  accountId: string;
  teacherId: string | null;
  studentId: string | null;
}

/** A session guaranteed (by a guard) to carry a teacher profile. */
export type TeacherSession = SessionUser & { teacherId: string };
/** A session guaranteed (by a guard) to carry a student profile. */
export type StudentSession = SessionUser & { studentId: string };
