'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A bottom sheet on a phone and a centred modal from `sm` up: the vendored
 * design system's Sheet (`docs/design_handoff_fairyoga/components/feedback/Sheet.jsx`),
 * with its ink-40% scrim and the one shadow the system allows. Escape and a
 * tap on the scrim close it. Focus moves into the sheet when it mounts and
 * back to the element that held it when it unmounts.
 */
export function Sheet({ title, onClose, children }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className="w-full max-h-[85vh] overflow-y-auto bg-cream rounded-t-sheet shadow-sheet px-5 pb-5 focus:outline-none sm:w-[min(480px,calc(100%-48px))] sm:rounded-card"
      >
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
          <div className="h-1 w-9 rounded-sm bg-border" />
        </div>
        <h2 id={titleId} className="type-subtitle pt-2 pb-3 sm:pt-5">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
