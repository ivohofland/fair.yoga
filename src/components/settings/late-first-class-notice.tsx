import { formatDayHeader } from '@/lib/format';
import type { LateFirstClass } from '@/lib/late-publish';
import { shortfallSentence } from '@/components/class/late-publish-notice';

/**
 * The warning shown when a recurring class's first class starts inside its
 * cancellation deadline. `added` is a create or resume, where the class now
 * exists; `expected` is an edit, where the sweep has yet to add it, and takes
 * only `past_deadline` because the edit's answer is never `past_check`
 * (`UpdateRuleResult.lateFirstClass`, `services/rule-lifecycle.ts`).
 */
export function LateFirstClassNotice(
  props:
    | { when: 'added'; late: LateFirstClass }
    | { when: 'expected'; late: LateFirstClass & { state: 'past_deadline' } },
) {
  const date = formatDayHeader(new Date(props.late.date));
  let text: string;
  if (props.when === 'expected') {
    text = `Your first class on the new schedule, on ${date}, may be added after its cancellation deadline has passed. Students who book it then can't cancel for free.`;
  } else {
    const { late } = props;
    switch (late.state) {
      case 'past_deadline':
        text = `Your first class, on ${date}, starts inside its cancellation deadline. Students who book it can't cancel for free. You can cancel it from your schedule.`;
        break;
      case 'past_check':
        text = `Your first class, on ${date}, starts inside its cancellation deadline and past its auto-cancel check. Students who book it can't cancel for free, and the class goes ahead however few book. ${shortfallSentence(late.minStudents)} You can cancel it from your schedule.`;
        break;
      default: {
        const unreachable: never = late.state;
        return unreachable;
      }
    }
  }
  return (
    <p className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4">{text}</p>
  );
}
