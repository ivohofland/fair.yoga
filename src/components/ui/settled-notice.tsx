'use client';

import { useEffect, useRef } from 'react';

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
 *
 * `role="status"` because of how this arrives (whole-branch review F5):
 * activating a control unmounts it and inserts this in its place, so focus
 * falls to `document.body` and, with no live region on this path, a
 * screen-reader user was told nothing at all — a money-correcting action
 * reported by silence, its only exit to be re-found by traversal. This is the
 * first *polite* (`role="status"`) region in `src/`; the assertive
 * `role="alert"` ones that predate it sit beside a form's submit button and
 * announce why it refused, which is a different moment and a different
 * urgency — none of them is reachable from a mutation that succeeded. (The
 * earlier claim here, that this was the only live region anywhere in `src/`,
 * came from a grep for `role="status"` and `aria-live` that structurally
 * could not match `role="alert"`. It was false when written.) The polite
 * announcement is what replaces the disabled-but-focused control the pre-#40
 * code left behind. `focus-visible:shadow-focus` on the action is the other
 * half: the ring `ui/button.tsx` gives its own control, so tabbing back to
 * this one shows where you are. (Without `focus:outline-none` beside it —
 * this is a text-scale control with no filled surface, so the browser's own
 * outline is worth keeping as well as the ring.)
 *
 * Moving focus into the notice (#128): on mount, focus shifts to the notice's
 * action button so focus does not drop to `document.body` when the preceding
 * control unmounts.
 */
export function SettledNotice({
  label,
  actionLabel,
  onAction,
  size = 'caption',
}: SettledNoticeProps) {
  const scale = sizeClasses[size];
  const actionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    actionRef.current?.focus();
  }, []);

  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span className={`${scale} text-teal`}>{label}</span>
      <span aria-hidden="true" className={`${scale} text-teal`}>
        ·
      </span>
      <button
        ref={actionRef}
        type="button"
        onClick={onAction}
        className={`${scale} text-teal min-h-[44px] px-1 focus-visible:shadow-focus`}
      >
        {actionLabel}
      </button>
    </span>
  );
}
