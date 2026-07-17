import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';

interface PageHeaderProps {
  title: string;
  /** Back-link target. Pass null on tab pages — the tab bar is the way back. */
  backHref?: string | null;
  backLabel?: string;
  /** 'display' for tab pages (28, teal), 'title' for detail pages (22, teal). */
  variant?: 'display' | 'title';
  action?: ReactNode;
}

export function PageHeader({
  title,
  backHref = '/',
  backLabel = 'Schedule',
  variant = 'title',
  action,
}: PageHeaderProps) {
  return (
    <div className="mb-6">
      {backHref !== null && (
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
        >
          <Icon name="arrow-left" size={18} />
          {backLabel}
        </Link>
      )}
      <div className="flex items-center justify-between gap-3">
        <h1 className={variant === 'display' ? 'type-display' : 'type-title'}>{title}</h1>
        {action}
      </div>
    </div>
  );
}
