import React, { useState } from 'react';
import { Icon } from '../core/Icon.jsx';

/** List row ≥56px with 1px divider. No alternating backgrounds. */
export function ListRow({ children, trailing, onClick, chevron, selected, divider = true, style }) {
  const [hover, setHover] = useState(false);
  const tappable = !!onClick;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={tappable ? 'button' : undefined}
      style={{
        minHeight: 'var(--row-height)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '8px 0',
        borderBottom: divider ? '1px solid var(--border-default)' : 'none',
        background: selected ? 'var(--surface-selected)' : tappable && hover ? 'var(--surface-card-hover)' : 'transparent',
        cursor: tappable ? 'pointer' : undefined,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {trailing}
      {chevron && <Icon name="chevron-right" size={20} style={{ color: 'var(--text-muted)' }} />}
    </div>
  );
}
