'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { installStore, useInstallSupport } from '@/components/layout/install-store';
import { InstallSteps } from './install-steps';

/**
 * A row offering to add the app to the Home Screen wherever this browser can
 * install it. Records nothing and has no dismissal.
 */
export function InstallAppRow() {
  const support = useInstallSupport();
  const [open, setOpen] = useState(false);

  if (support !== 'ios-safari' && support !== 'prompt' && support !== 'manual') return null;

  function handleClick(): void {
    if (support === 'prompt' && installStore) {
      void installStore.promptInstall();
      return;
    }
    setOpen((value) => !value);
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={support === 'prompt' ? undefined : open}
        className="flex items-center gap-3 w-full min-h-14 py-2 text-left focus:outline-none focus-visible:shadow-focus"
      >
        <span className="flex-1 text-base text-ink">Add to Home Screen</span>
        <Icon
          name="chevron-right"
          size={20}
          className={`text-brown-light ${open ? 'rotate-90' : ''}`.trim()}
        />
      </button>
      {open && (
        <div className="pb-4">
          <InstallSteps variant={support === 'ios-safari' ? 'ios' : 'manual'} />
        </div>
      )}
    </div>
  );
}
