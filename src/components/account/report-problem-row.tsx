import { listRowClass } from '@/components/ui/list-row';

// The public CONTRIBUTING section, not the issue chooser: the chooser asks a signed-out visitor to sign in first.
const REPORT_PROBLEM_URL = 'https://github.com/ivohofland/fair.yoga/blob/main/CONTRIBUTING.md#teachers-and-students';

export function ReportProblemRow() {
  return (
    <a
      href={REPORT_PROBLEM_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={listRowClass({
        className: 'flex flex-col justify-center gap-0.5 no-underline focus:outline-none focus-visible:shadow-focus',
      })}
    >
      <span className="text-base text-ink">Report a problem</span>
      <span className="type-caption">Opens a GitHub page with our forms and email address</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
