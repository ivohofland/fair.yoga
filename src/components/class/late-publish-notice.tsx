import type { LatePublishState } from '@/lib/late-publish';

/** The warning shown on a draft whose publish would land inside its cancellation window. */
export function LatePublishNotice({
  state,
  minStudents,
}: {
  state: LatePublishState;
  minStudents: number;
}) {
  let text: string;
  switch (state) {
    case 'none':
      return null;
    case 'past_deadline':
      text =
        "This class starts inside its cancellation deadline. Students who book after you publish can't cancel for free.";
      break;
    case 'past_check': {
      const shortfall = minStudents === 1 ? 'nobody books' : `fewer than ${minStudents} students book`;
      text = `This class starts inside its cancellation deadline and its auto-cancel check has passed. Students who book after you publish can't cancel for free, and the class goes ahead however few book. If ${shortfall}, you cover what the missing students would have paid.`;
      break;
    }
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
  return <p className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4">{text}</p>;
}
