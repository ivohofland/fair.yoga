import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';

interface CardProps {
  children: ReactNode;
  className?: string;
}

// Surface card: sand on cream + 1px border, radius 16, padding 20.
// Depth comes from the surface + border — never a shadow.
export function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`bg-sand-soft border border-border rounded-card p-5 ${className}`.trim()}>
      {children}
    </div>
  );
}

interface CardLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

// Tappable card: sand-hover step and a trailing chevron.
export function CardLink({ href, children, className = '' }: CardLinkProps) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand ${className}`.trim()}
    >
      <div className="flex-1 min-w-0">{children}</div>
      <Icon name="chevron-right" size={20} className="text-brown-light" />
    </Link>
  );
}
