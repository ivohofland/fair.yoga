import Link from 'next/link';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  backHref?: string;
  backLabel?: string;
  action?: ReactNode;
}

export function PageHeader({ title, backHref = '/', backLabel = 'Dashboard', action }: PageHeaderProps) {
  return (
    <div className="mb-6">
      <Link href={backHref} className="text-teal text-sm mb-2 inline-block">
        &larr; {backLabel}
      </Link>
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold">{title}</h1>
        {action}
      </div>
    </div>
  );
}
