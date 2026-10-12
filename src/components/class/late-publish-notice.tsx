import type { LatePublishState } from '@/lib/late-publish';

/**
 * The warning shown when a class's first bookers would land inside its
 * cancellation window. `publish` is a draft's page, where publishing now would
 * do it; `move` is the edit form, where saving the entered start would.
 */
export function LatePublishNotice({
  action,
  state,
  minStudents,
}: {
  action: 'publish' | 'move';
  state: LatePublishState;
  minStudents: number;
}) {
  const single = minStudents === 1;
  const shortfall = single ? 'nobody books' : `fewer than ${minStudents} students book`;
  const missing = single ? 'that student' : 'the missing students';
  const verb = action === 'publish' ? 'publish' : 'save';
  const cover = `Students who book after you ${verb} can't cancel for free, and the class goes ahead however few book. If ${shortfall}, you cover what ${missing} would have paid.`;
  let text: string;
  switch (state) {
    case 'none':
      return null;
    case 'past_deadline':
      text =
        action === 'publish'
          ? "This class starts inside its cancellation deadline. Students who book after you publish can't cancel for free."
          : "The new start is inside this class's cancellation deadline. Students who book after you save can't cancel for free.";
      break;
    case 'past_check':
      text =
        action === 'publish'
          ? `This class starts inside its cancellation deadline and its auto-cancel check has passed. ${cover}`
          : `The new start is inside this class's cancellation deadline and past its auto-cancel check. ${cover}`;
      break;
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
  return (
    <p className="type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4">{text}</p>
  );
}
