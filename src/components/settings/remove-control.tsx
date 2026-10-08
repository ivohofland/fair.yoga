'use client';

import { useEffect, useId, useRef } from 'react';
import { Button } from '@/components/ui/button';

interface RemoveControlProps {
  /** What the trigger removes, read aloud after "Remove" ("EUR details"). */
  label: string;
  /** The confirmation question, saying what removal does to students. */
  question: string;
  confirming: boolean;
  removing: boolean;
  disabled: boolean;
  error: string;
  /** Laid out in a row: the trigger sits at the row's end and the confirmation spans below it. */
  children?: React.ReactNode;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * A text trigger, then an inline confirmation below it: nothing is sent on
 * the first tap. Opening the confirmation focuses its Remove button, which the
 * question describes; Cancel hands focus back to the trigger. A refusal shows
 * here, beside the control that failed.
 */
export function RemoveControl({ label, question, confirming, removing, disabled, error, children, onAsk, onCancel, onConfirm }: RemoveControlProps) {
  const questionId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set by Cancel, so focus returns to the trigger once it is back on the page.
  const returnFocus = useRef(false);

  // Disabled while the request is in flight, the Remove button takes focus
  // again once it settles with the confirmation still open (a refusal).
  useEffect(() => {
    if (confirming) {
      if (!removing) confirmRef.current?.focus();
      return;
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming, removing]);

  function cancel() {
    returnFocus.current = true;
    onCancel();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        {children}
        {!confirming && (
          <button
            ref={triggerRef}
            type="button"
            onClick={onAsk}
            disabled={disabled}
            className="type-label text-danger disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Remove <span className="sr-only">{label}</span>
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-col gap-2">
          <p id={questionId} className="text-sm text-brown">
            {question}
          </p>
          <div className="flex gap-3">
            <Button
              ref={confirmRef}
              type="button"
              variant="destructive"
              aria-describedby={questionId}
              onClick={onConfirm}
              disabled={disabled}
            >
              {removing ? 'Removing...' : 'Remove'}
            </Button>
            <Button type="button" variant="secondary" onClick={cancel} disabled={disabled}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
