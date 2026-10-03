import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, IconSkeleton } from '@/components/ui/icon';
import { SkeletonText } from '@/components/ui/skeleton';

type HeaderVariant = 'display' | 'title';

interface PageHeaderProps {
  title: string;
  /** Back-link target. Pass null on tab pages — the tab bar is the way back. */
  backHref?: string | null;
  backLabel?: string;
  /** 'display' for tab pages (28, teal), 'title' for detail pages (22, teal). */
  variant?: HeaderVariant;
  action?: ReactNode;
}

const TITLE_STYLE: Record<HeaderVariant, 'type-display' | 'type-title'> = {
  display: 'type-display',
  title: 'type-title',
};
const BACK_SLOT = 'inline-flex items-center gap-1.5 type-label mb-2';
const BACK_ICON_SIZE = 18;

// The header's frame, shared by the page and its skeleton.
function PageHeaderFrame({ back, title, action }: { back: ReactNode; title: ReactNode; action: ReactNode }) {
  return (
    <div className="mb-6" data-layout-anchor="header">
      {back}
      <div className="flex items-center justify-between gap-3">
        {title}
        {action}
      </div>
    </div>
  );
}

export function PageHeader({ title, backHref = '/schedule', backLabel = 'Schedule', variant = 'title', action }: PageHeaderProps) {
  return (
    <PageHeaderFrame
      back={backHref !== null && (
        <Link href={backHref} className={`${BACK_SLOT} text-teal no-underline`}>
          <Icon name="arrow-left" size={BACK_ICON_SIZE} />
          {backLabel}
        </Link>
      )}
      title={<h1 className={TITLE_STYLE[variant]}>{title}</h1>}
      action={action}
    />
  );
}

interface PageHeaderSkeletonProps {
  /** Only whether it is null matters: null draws no back-link slot. */
  backHref?: string | null;
  variant?: HeaderVariant;
  action?: boolean;
}

export function PageHeaderSkeleton({ backHref = '/schedule', variant = 'title', action = false }: PageHeaderSkeletonProps) {
  return (
    <PageHeaderFrame
      back={backHref !== null && (
        <span aria-hidden="true" className={BACK_SLOT}>
          <IconSkeleton size={BACK_ICON_SIZE} />
          <SkeletonText type="type-label" width="w-20" />
        </span>
      )}
      title={<SkeletonText type={TITLE_STYLE[variant]} width="w-40" />}
      action={action ? <SkeletonText type="type-label" width="w-24" /> : undefined}
    />
  );
}
