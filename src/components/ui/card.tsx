import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/icon';

// Surface card: sand on cream + 1px border, radius 16, padding 20.
const CARD_SURFACE = 'bg-sand-soft border border-border rounded-card p-5';

interface CardProps {
  children: ReactNode;
  className?: string;
  href?: string;
}

// Surface card. Depth comes from the surface + border — never a shadow.
// With `href` it becomes a tappable link with the sand-hover step; without
// one it's a plain div.
export function Card({ children, className = '', href }: CardProps) {
  if (href !== undefined) {
    return (
      <Link href={href} className={`block ${CARD_SURFACE} no-underline hover:bg-sand ${className}`.trim()}>
        {children}
      </Link>
    );
  }
  return <div className={`${CARD_SURFACE} ${className}`.trim()}>{children}</div>;
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
      className={`flex items-center gap-3 ${CARD_SURFACE} no-underline hover:bg-sand ${className}`.trim()}
    >
      <div className="flex-1 min-w-0">{children}</div>
      <Icon name="chevron-right" size={20} className="text-brown-light" />
    </Link>
  );
}
