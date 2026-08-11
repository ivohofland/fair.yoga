type SettledSize = 'caption' | 'sm';

interface SettledNoticeProps {
  /** What happened, in the past tense: "Marked unpaid", "Accepted", "Created". */
  label: string;
  /** The control's accessible name — "Refresh", or where the failed push was going. */
  actionLabel: string;
  onAction: () => void;
  size?: SettledSize;
}

const sizeClasses: Record<SettledSize, string> = {
  caption: 'type-caption',
  sm: 'text-sm',
};

/**
 * #40. The state a control reaches when its mutation committed but the
 * `router.refresh()` / `router.push()` that should have replaced it did not —
 * both return `void`, so the caller cannot know which happened.
 *
 * Re-offering the original action would be wrong twice over: it has already
 * succeeded, and on a non-idempotent endpoint the retry earns a 4xx in red over
 * an action that worked. Leaving the control disabled — the previous answer, and
 * review finding F7's — freezes it instead. This says what happened and offers
 * the repaint that failed.
 *
 * The action is deliberately never disabled. This component only renders
 * because something else did not work; it must always be the way out.
 */
export function SettledNotice({
  label,
  actionLabel,
  onAction,
  size = 'caption',
}: SettledNoticeProps) {
  const scale = sizeClasses[size];

  return (
    <span className="inline-flex items-center gap-2">
      <span className={`${scale} text-teal`}>{label}</span>
      <span aria-hidden="true" className={`${scale} text-teal`}>
        ·
      </span>
      <button type="button" onClick={onAction} className={`${scale} text-teal min-h-[44px] px-1`}>
        {actionLabel}
      </button>
    </span>
  );
}
