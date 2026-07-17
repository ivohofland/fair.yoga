import React, { useState } from 'react';

/** 48px input on sand, radius 12, label above, focus ring, error state. */
export function Input({ label, value, onChange, placeholder, error, helper, type = 'text', disabled, style }) {
  const [focus, setFocus] = useState(false);
  return (
    <label style={{ display: 'block', ...style }}>
      {label && (
        <div style={{ fontFamily: 'var(--font-body)', fontSize: '14px', fontWeight: 500, lineHeight: 1.4, color: 'var(--text-body)', marginBottom: '8px' }}>
          {label}
        </div>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          boxSizing: 'border-box',
          width: '100%',
          height: 'var(--control-height)',
          padding: '0 16px',
          background: error ? 'var(--danger-tint)' : 'var(--surface-card)',
          border: `1px solid ${error ? 'var(--danger)' : focus ? 'var(--color-teal)' : 'var(--border-default)'}`,
          borderRadius: 'var(--radius-input)',
          fontFamily: 'var(--font-body)',
          fontSize: '16px',
          color: 'var(--text-strong)',
          outline: 'none',
          boxShadow: focus ? '0 0 0 3px var(--color-teal-tint)' : 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      />
      {error && (
        <div style={{ fontSize: '13px', lineHeight: 1.4, color: 'var(--danger)', marginTop: '4px' }}>{error}</div>
      )}
      {!error && helper && (
        <div style={{ fontSize: '13px', lineHeight: 1.4, color: 'var(--text-muted)', marginTop: '4px' }}>{helper}</div>
      )}
    </label>
  );
}
