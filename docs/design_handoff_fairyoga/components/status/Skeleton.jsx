import React from 'react';

/** Sand skeleton block matching the layout it replaces. No shimmer, no spinner. */
export function Skeleton({ width = '100%', height = 16, radius = 4, style }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius: radius,
        background: 'var(--surface-card)',
        ...style,
      }}
    />
  );
}
