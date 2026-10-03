import Link from 'next/link';
import type { ReactNode } from 'react';
import { SkeletonText } from './skeleton';

export type ListRowDensity = 'regular' | 'relaxed';
export type ListRowDivider = 'between' | 'after-each';

export interface ListRowFrameOptions {
  /** 'relaxed' for rows carrying a title and a body line. */
  density?: ListRowDensity;
  /** 'after-each' keeps the last row's border, for a list followed by more content. */
  divider?: ListRowDivider;
  /** The row's own layout — flex/grid, gap, alignment, no-underline, opacity. */
  className?: string;
}

const DENSITY: Record<ListRowDensity, string> = { regular: 'py-2', relaxed: 'py-3' };
const DIVIDER: Record<ListRowDivider, string> = {
  between: 'border-b border-border last:border-b-0',
  'after-each': 'border-b border-border',
};

// The ≥56px directory row (docs/design-brief.md). The one place its frame is
// written; a row element that is neither a div nor a link calls this directly.
export function listRowClass({ density = 'regular', divider = 'between', className = '' }: ListRowFrameOptions = {}): string {
  return `min-h-14 ${DENSITY[density]} ${DIVIDER[divider]} ${className}`.trim();
}

interface ListRowProps extends ListRowFrameOptions {
  children: ReactNode;
  href?: string;
}

export function ListRow({ children, href, ...frame }: ListRowProps) {
  const className = listRowClass(frame);
  if (href !== undefined) {
    return <Link href={href} className={className}>{children}</Link>;
  }
  return <div className={className}>{children}</div>;
}

interface ListRowSkeletonProps extends ListRowFrameOptions {
  lines?: 1 | 2;
}

export function ListRowSkeleton({ lines = 2, className = '', ...frame }: ListRowSkeletonProps) {
  return (
    <div aria-hidden="true" className={listRowClass({ ...frame, className: `flex flex-col justify-center gap-1 ${className}`.trim() })}>
      <SkeletonText type="type-body" width="w-2/5" />
      {lines === 2 && <SkeletonText type="type-caption" width="w-3/5" />}
    </div>
  );
}
