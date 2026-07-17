import React, { useState } from 'react';
import { Icon } from './Icon.jsx';

/** Sand card, 1px border, radius 16, padding 20. Tappable cards show a chevron. */
export function Card({ children, onClick, chevron, selected, style }) {
  const [hover, setHover] = useState(false);
  const tappable = !!onClick;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role={tappable ? 'button' : undefined}
      tabIndex={tappable ? 0 : undefined}
      style={{
        background: selected ? 'var(--surface-selected)' : tappable && hover ? 'var(--surface-card-hover)' : 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-card)',
        padding: 'var(--card-padding)',
        cursor: tappable ? 'pointer' : undefined,
        display: chevron ? 'flex' : undefined,
        alignItems: chevron ? 'center' : undefined,
        gap: chevron ? '12px' : undefined,
        ...style,
      }}
    >
      {chevron ? <div style={{ flex: 1, minWidth: 0 }}>{children}</div> : children}
      {chevron && <Icon name="chevron-right" size={20} style={{ color: 'var(--text-muted)' }} />}
    </div>
  );
}
