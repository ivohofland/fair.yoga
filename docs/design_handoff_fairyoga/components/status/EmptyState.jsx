import React from 'react';
import { Button } from '../core/Button.jsx';

/** Empty state: one subtitle + one body line + one action. No illustrations, no emoji. */
export function EmptyState({ title, body, actionLabel, onAction, style }) {
  return (
    <div style={{ padding: '40px 16px', textAlign: 'center', ...style }}>
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '18px', lineHeight: 1.4, color: 'var(--text-strong)' }}>{title}</div>
      {body && <div style={{ fontSize: '16px', lineHeight: 1.55, color: 'var(--text-body)', marginTop: '8px' }}>{body}</div>}
      {actionLabel && (
        <div style={{ marginTop: '20px' }}>
          <Button variant="secondary" onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  );
}
