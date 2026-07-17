import React, { useState } from 'react';

const styles = {
  primary: (hover, active) => ({
    background: active ? 'var(--color-teal-pressed)' : hover ? 'var(--color-teal-hover)' : 'var(--color-teal)',
    color: 'var(--color-cream)',
    border: '1.5px solid transparent',
  }),
  secondary: (hover) => ({
    background: hover ? 'var(--color-teal-tint)' : 'transparent',
    color: 'var(--color-teal)',
    border: '1.5px solid var(--color-teal)',
  }),
  destructive: (hover) => ({
    background: hover ? 'var(--danger-tint)' : 'transparent',
    color: 'var(--danger)',
    border: '1.5px solid var(--danger)',
  }),
  ghost: (hover) => ({
    background: hover ? 'var(--color-teal-tint)' : 'transparent',
    color: 'var(--color-teal)',
    border: '1.5px solid transparent',
  }),
};

/** Pill button, 48px tall. One primary per screen. Destructive is never filled. */
export function Button({ variant = 'primary', children, onClick, disabled, fullWidth, type = 'button', style }) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const [focus, setFocus] = useState(false);
  const v = (styles[variant] || styles.primary)(hover && !disabled, active && !disabled);
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        height: 'var(--control-height)',
        padding: '0 24px',
        borderRadius: 'var(--radius-button)',
        fontFamily: 'var(--font-body)',
        fontSize: '16px',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        width: fullWidth ? '100%' : undefined,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        boxShadow: focus ? '0 0 0 3px var(--color-teal-tint)' : 'none',
        outline: 'none',
        ...v,
        ...style,
      }}
    >
      {children}
    </button>
  );
}
