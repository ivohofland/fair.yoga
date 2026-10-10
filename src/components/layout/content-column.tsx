import type { ReactNode } from 'react';

/**
 * The app's 640px mobile-first column. Each route group's layout applies it;
 * the root layout does not, so the landing page can lay out its own width.
 */
export function ContentColumn({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-content px-4 sm:px-6 pt-6 pb-8 flex-1 flex flex-col">
      {children}
    </div>
  );
}
