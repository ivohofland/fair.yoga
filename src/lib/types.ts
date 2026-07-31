// A session identifies an account; authorization is profile presence:
// teacher surfaces require teacherId, student surfaces studentId. Dual
// accounts carry both — there is no "active role" state. The union makes
// "neither profile" unrepresentable: at least one id is always a string.
//
// `defaultTimezone` sits on the teacher branch, not at the top level, so
// reading it requires having narrowed to a teacher — which every guard
// (`requireTeacherSession`, `requireTeacher`) already does. It rides along
// because `validateSession` already loads the teacher row for its GDPR
// liveness check, so this costs one column on a query that runs anyway, and
// nothing at all for student-only accounts, whose teacher relation is null.
//
// The bar for adding a field here: it must be needed to *compute* something
// on many surfaces. `defaultTimezone` decides which calendar day a teacher is
// in — a correctness input, not a display value. `firstName` is read by two
// session-scoped lookups — a profile form and a route that copies it onto a
// new student row — and neither is a computation shared across surfaces, so
// it stayed where it was, fetched separately by each (#138).
export type SessionUser = { sessionId: string; accountId: string } & (
  | { teacherId: string; defaultTimezone: string; studentId: string | null }
  | { teacherId: null; studentId: string }
);

/** A session guaranteed (by a guard) to carry a teacher profile. */
export type TeacherSession = SessionUser & { teacherId: string };
/** A session guaranteed (by a guard) to carry a student profile. */
export type StudentSession = SessionUser & { studentId: string };
