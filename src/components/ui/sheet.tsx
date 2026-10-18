'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

interface SheetProps {
  title: string;
  onClose: () => void;
  /** Whether Escape and a tap on the backdrop close the sheet. */
  dismissible?: boolean;
  children: ReactNode;
}

/**
 * A bottom sheet on a phone and a centred modal from `sm` up: the vendored
 * design system's Sheet (`docs/design_handoff_fairyoga/components/feedback/Sheet.jsx`),
 * with its ink-40% scrim and the one shadow the system allows. A native
 * `<dialog>` opened with `showModal()`, so the browser traps focus, makes the
 * page behind it inert and turns Escape into `cancel`. While `dismissible`,
 * Escape and a tap on the backdrop close it, and so does a close the browser
 * makes on its own; while not, such a close is undone by opening it again.
 * The page does not scroll while it is open. Focus returns to the element
 * that held it when the sheet unmounts, if that element is still in the
 * document.
 */
export function Sheet({ title, onClose, dismissible = true, children }: SheetProps) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (node === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!node.open) node.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (node.open) node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        // The event is queued, so one can arrive after the dialog opened again; a real close leaves it shut.
        const node = dialog.current;
        if (node === null || node.open) return;
        if (dismissible) onClose();
        else node.showModal();
      }}
      onClick={(e) => {
        // The panel fills the dialog, so a click on the dialog itself is on its backdrop.
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
      className="m-0 mt-auto w-full max-w-full max-h-[85vh] overflow-y-auto p-0 bg-cream text-brown rounded-t-sheet shadow-sheet backdrop:bg-scrim sm:m-auto sm:w-[min(480px,calc(100%-48px))] sm:rounded-card"
    >
      <div className="px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="flex justify-center pt-2.5 pb-1 sm:hidden" aria-hidden="true">
          <div className="h-1 w-9 rounded-sm bg-border" />
        </div>
        <h2 id={titleId} className="type-subtitle pt-2 pb-3 sm:pt-5">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}
