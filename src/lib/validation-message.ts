/**
 * The one spelling of a 400's validation message: every issue as
 * `path: message`, joined by `ISSUE_SEPARATOR`. `parseBody` writes it and a
 * client that maps issues back onto fields reads it, so both import it here.
 */

export const ISSUE_SEPARATOR = ', ';

export interface ValidationIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

export function formatIssues(issues: ReadonlyArray<ValidationIssue>): string {
  return issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join(ISSUE_SEPARATOR);
}
