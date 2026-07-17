import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

// Empty state: one subtitle + one body line + one action.
// No illustrations, no emoji.
export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="py-10 px-4 text-center">
      <p className="type-subtitle">{title}</p>
      {body && <p className="type-body mt-2">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
