/**
 * The two 400s `POST /api/announcements` answers when nobody is left to tell.
 * Neither carries a code, so the sentence is what says which audience came up
 * empty; the integration test compares against these entries, never a literal.
 */
export const NO_RECIPIENTS_MESSAGE = {
  /** A class or every student: the teacher named no one in particular. */
  audience: 'No students to notify',
  /** A chosen list: the same words whichever reason emptied it, so it is no oracle. */
  chosen: 'None of the students you chose can be reached.',
} as const;
