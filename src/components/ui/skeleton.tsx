interface SkeletonProps {
  className?: string;
}

// Static sand block matching the layout it replaces. No shimmer, no spinner —
// loading states are quiet. Size and radius come from the className
// (e.g. "h-24 rounded-card" for a card, "h-4 w-3/5" for a text line).
export function Skeleton({ className = '' }: SkeletonProps) {
  return <div aria-hidden="true" className={`bg-sand-soft rounded-[4px] ${className}`.trim()} />;
}
