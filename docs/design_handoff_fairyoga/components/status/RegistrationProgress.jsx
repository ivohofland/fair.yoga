import React from 'react';

/**
 * The signature element on class cards. 8px track; fill is danger until the
 * minimum is met, teal from min to max; ink tick at the min mark. The label
 * above right separates the live count from the configured range: the count
 * is the datum (16px, semibold, teal once viable), "/ min–max" recedes as
 * quiet 12px configuration — the bar already marks both ends spatially.
 */
export function RegistrationProgress({ registered = 0, min = 0, max = 1, style }) {
  const pct = Math.min(100, (registered / max) * 100);
  const minPct = Math.min(100, (min / max) * 100);
  const met = registered >= min;
  return (
    <div style={style}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: '7px', marginBottom: '4px' }}>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: '16px', fontWeight: 600, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: met ? 'var(--color-teal)' : 'var(--text-body)' }}>
          {registered}
        </span>
        <span style={{ fontFamily: 'var(--font-body)', fontSize: '12px', fontWeight: 400, fontVariantNumeric: 'tabular-nums', color: 'var(--text-body)' }}>
          / {min}–{max}
        </span>
      </div>
      <div style={{ position: 'relative', height: 'var(--progress-height)', background: 'var(--border-default)', borderRadius: '4px' }}>
        <div style={{ position: 'absolute', inset: '0 auto 0 0', width: pct + '%', background: met ? 'var(--color-teal)' : 'var(--danger)', borderRadius: '4px' }} />
        {min > 0 && min < max && (
          <div style={{ position: 'absolute', top: '-2px', bottom: '-2px', left: minPct + '%', width: '2px', background: 'var(--color-ink)', borderRadius: '1px' }} />
        )}
      </div>
    </div>
  );
}
