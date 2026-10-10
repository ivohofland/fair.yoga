import { listRowClass } from '@/components/ui/list-row';

// The repo's public Contributing tab, not the issue chooser: the chooser asks a signed-out visitor to sign in
// first, and CONTRIBUTING.md gives an email address too (pinned by this component's test).
const REPORT_PROBLEM_URL = 'https://github.com/ivohofland/fair.yoga?tab=contributing-ov-file#contributing-to-fairyoga';

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
      <span className="type-caption">Our email address and issue forms, on GitHub</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}
