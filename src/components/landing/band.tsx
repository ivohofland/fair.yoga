import type { ReactNode } from 'react';
import { COLUMN } from './landing-links';

export const KICKER = 'text-sm font-medium text-brown';
export const HEADING = 'font-heading font-bold text-[28px] leading-[1.25]';
export const LEAD = 'type-body text-lg leading-[1.6]';

/** A full-width band under a hairline, holding one column of content. */
export function Band({
  id,
  className = '',
  bottom = 'pb-16 sm:pb-24',
  children,
}: {
  id?: string;
  className?: string;
  bottom?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="border-t border-border">
      <div className={`${COLUMN} pt-16 sm:pt-24 ${bottom} ${className}`.trim()}>{children}</div>
    </section>
  );
}
