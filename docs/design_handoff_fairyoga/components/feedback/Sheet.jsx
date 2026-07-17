import React from 'react';

/**
 * Bottom sheet (mobile) / centered modal (desktop). Ink-40% scrim, one soft
 * shadow (the only shadow in the system). Confirmations: two buttons, never three.
 */
export function Sheet({ open, onClose, title, children, desktop, style }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--scrim)',
        display: 'flex',
        alignItems: desktop ? 'center' : 'flex-end',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          background: 'var(--bg-page)',
          borderRadius: desktop ? 'var(--radius-card)' : 'var(--radius-sheet) var(--radius-sheet) 0 0',
          boxShadow: 'var(--shadow-sheet)',
          width: desktop ? 'min(480px, calc(100% - 48px))' : '100%',
          maxHeight: '85%',
          overflowY: 'auto',
          padding: '0 20px 20px',
          boxSizing: 'border-box',
          ...style,
        }}
      >
        {!desktop && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px' }}>
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'var(--border-default)' }} />
          </div>
        )}
        {title && (
          <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: '18px', lineHeight: 1.4, color: 'var(--text-strong)', padding: desktop ? '20px 0 12px' : '8px 0 12px' }}>
            {title}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
