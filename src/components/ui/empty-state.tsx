import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
  /** A caption under everything else, read with the block rather than acted on. */
  note?: ReactNode;
}

// Empty state: one subtitle + one body line + one action, and optionally a
// note under them. No illustrations, no emoji.
export function EmptyState({ title, body, action, note }: EmptyStateProps) {
  return (
    <div className="py-10 px-4 text-center">
      <p className="type-subtitle">{title}</p>
      {body && <p className="type-body mt-2">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
      {note && <div className="mt-3">{note}</div>}
    </div>
  );
}
