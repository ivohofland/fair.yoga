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
// in — a correctness input, not *only* a display value. `firstName` is read
// by several session-scoped lookups, but each either shows it or copies it —
// none computes with it — so it stayed where it was (#138). Deliberately not
// enumerated here: an inventory in a docblock is wrong the moment someone
// adds a call site, which is how the sentence this replaced went stale.
//
// Flat placement holds for one field. **A second cross-cutting teacher field
// is the signal to nest** — `teacher: { id, defaultTimezone, … } | null` —
// rather than to widen this branch again. Flat was chosen because ~25 files
// already read `session.teacherId` directly and nesting for a single field
// would be churn for no gain today; that trade-off flips as soon as there are
// two, and it is cheaper to write the trigger down now than to reconstruct it
// from git blame later.
//
// Freshness is a property of `validateSession`, not of this type: it is
// uncached and re-reads on every request. See the docblock there before
// adding a cache.
export type SessionUser = { sessionId: string; accountId: string } & (
  | { teacherId: string; defaultTimezone: string; studentId: string | null }
  | { teacherId: null; studentId: string }
);

/** A session guaranteed (by a guard) to carry a teacher profile. */
export type TeacherSession = SessionUser & { teacherId: string };
/** A session guaranteed (by a guard) to carry a student profile. */
export type StudentSession = SessionUser & { studentId: string };
