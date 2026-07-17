import React from 'react';

const VARIANTS = {
  // fill encodes time: outline = upcoming, tint = now, solid = done
  draft: { bg: 'transparent', fg: 'var(--status-draft-fg)', border: 'var(--status-draft-border)', label: 'Draft' },
  registering: { bg: 'transparent', fg: 'var(--status-open-fg)', border: 'var(--status-open-border)', label: 'Open for registration' },
  full: { bg: 'var(--status-full-bg)', fg: 'var(--status-full-fg)', label: 'Full — waitlist' },
  in_progress: { bg: 'var(--status-inprogress-bg)', fg: 'var(--status-inprogress-fg)', label: 'In progress' },
  completed: { bg: 'var(--status-completed-bg)', fg: 'var(--status-completed-fg)', label: 'Completed' },
  cancelled: { bg: 'var(--status-cancelled-bg)', fg: 'var(--status-cancelled-fg)', label: 'Cancelled' },
  below_min: { bg: 'var(--status-belowmin-bg)', fg: 'var(--status-belowmin-fg)', label: 'Below minimum' },
  waitlist: { bg: 'var(--status-waitlist-bg)', fg: 'var(--status-waitlist-fg)', label: 'Waitlist' },
  /** @deprecated payment is never a badge — use glyph + word in text color (✓ · ○ · !) */
  paid: { bg: 'var(--status-completed-bg)', fg: 'var(--status-completed-fg)', label: 'Paid' },
};

/** Status badge: radius 12, 13px medium. Color is always paired with text. */
export function StatusBadge({ status = 'registering', children, style }) {
  const v = VARIANTS[status] || VARIANTS.registering;
  return (
    <span
      style={{
        display: 'inline-block',
        background: v.bg,
        color: v.fg,
        border: `1px solid ${v.border || 'transparent'}`,
        borderRadius: 'var(--radius-badge)',
        padding: '3px 10px',
        fontFamily: 'var(--font-body)',
        fontSize: '13px',
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children || v.label}
    </span>
  );
}
