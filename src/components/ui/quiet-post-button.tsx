'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { logRequestFailure } from '@/lib/client-errors';

interface QuietPostButtonProps {
  url: string;
  /** Sent as the JSON body when given; the request carries no body otherwise. */
  body?: Record<string, unknown>;
  ariaLabel: string;
  className?: string;
  /** Names the caller in the console lines a failed request writes. */
  logTag: string;
  /** Extra fields on those console lines. */
  logContext?: Record<string, unknown>;
  children: ReactNode;
}

/**
 * `docs/design-brief.md` §2 asks for `shadow-focus` on every interactive
 * element and 50% opacity when disabled. Colour — including any hover step,
 * a defined step rather than a transition, since this design has essentially
 * no motion — is entirely the call site's own concern; the call site's
 * classes come after this base so they can override any of it.
 */
const BASE_CLASSES =
  'rounded-field focus:outline-none focus-visible:shadow-focus disabled:opacity-50';

/**
 * A quiet button that POSTs to `url` and refreshes the page on success, so
 * whatever rendered it re-renders against the stored answer. A failure is
 * logged and the button comes back for another try: nothing was recorded, and
 * there is no error UI because the action is low-stakes, not a form submission.
 */
export function QuietPostButton({ url, body, ariaLabel, className = '', logTag, logContext = {}, children }: QuietPostButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch(url, {
        method: 'POST',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      console.error(`[${logTag}] refused`, { ...logContext, status: res.status });
    } catch (err) {
      logRequestFailure(logTag, logContext, err);
    }
    setLoading(false);
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => void handleClick()}
      disabled={loading}
      className={`${BASE_CLASSES} ${className}`.trim()}
    >
      {children}
    </button>
  );
}
